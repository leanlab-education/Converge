import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { isGlobalAdmin, getAdminProjectIds } from '@/lib/authorization'
import { maybeCompleteReleaseReconciliation } from '@/lib/reconciliation'
import { getReleaseOwnerUserId } from '@/lib/team-batch-releases'
import { NextRequest, NextResponse } from 'next/server'

// GET /api/adjudicate
// Lists all open (unresolved) escalations across every batch where the
// current user is the adjudicator. Used by the /adjudicate queue view.
// Admins can also see all open escalations across the system.
export async function GET(_request: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const globalAdmin = isGlobalAdmin(session.user.role)
  const adminProjectIds = globalAdmin ? [] : await getAdminProjectIds(session.user.id)

  const escalations = await prisma.escalation.findMany({
    where: {
      resolvedAt: null,
      ...(globalAdmin
        ? {}
        : adminProjectIds.length > 0
          ? { OR: [{ teamRelease: { adjudicatorId: session.user.id } }, { batch: { projectId: { in: adminProjectIds } } }] }
          : { teamRelease: { adjudicatorId: session.user.id } }),
    },
    include: {
      batch: {
        select: {
          id: true,
          name: true,
          projectId: true,
          project: { select: { id: true, name: true } },
        },
      },
      teamRelease: {
        include: {
          team: {
            include: {
              members: {
                include: {
                  user: { select: { id: true, name: true, email: true } },
                },
                orderBy: { user: { email: 'asc' } },
              },
            },
          },
        },
      },
      feedbackItem: {
        select: {
          id: true,
          studentText: true,
          feedbackText: true,
          activityId: true,
          conjunctionId: true,
          displayOrder: true,
          // Quill ground-truth flag — shown to the adjudicator when the
          // escalated criterion is Appropriate Feedback Decision.
          optimal: true,
        },
      },
      dimension: {
        select: {
          id: true,
          key: true,
          label: true,
          description: true,
          sortOrder: true,
          scaleMin: true,
          scaleMax: true,
          scoreLabelJson: true,
        },
      },
      escalatedBy: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  if (escalations.length === 0) {
    return NextResponse.json({ items: [] })
  }

  // For each escalation, pull the two coders' original scores + notes on
  // that (item, dimension), plus the pair's current reconciliation notes
  // (on the isReconciled Score row, if any).
  const itemIds = Array.from(new Set(escalations.map((e) => e.feedbackItemId)))
  const dimensionIds = Array.from(new Set(escalations.map((e) => e.dimensionId)))

  const originalScores = await prisma.score.findMany({
    where: {
      feedbackItemId: { in: itemIds },
      dimensionId: { in: dimensionIds },
      isReconciled: false,
    },
    include: {
      user: { select: { id: true, name: true, email: true } },
    },
  })

  const scoresByKey = new Map<
    string,
    {
      userId: string
      name: string | null
      email: string
      value: number
      notes: string | null
    }[]
  >()
  for (const s of originalScores) {
    const matchingEscalations = escalations.filter(
      (esc) => esc.feedbackItemId === s.feedbackItemId && esc.dimensionId === s.dimensionId
    )
    for (const esc of matchingEscalations) {
      const releaseUserIds = new Set(
        esc.teamRelease.team.members.map((member) => member.userId)
      )
      if (!releaseUserIds.has(s.user.id)) continue
      const key = `${esc.teamReleaseId}::${s.feedbackItemId}::${s.dimensionId}`
      if (!scoresByKey.has(key)) scoresByKey.set(key, [])
      scoresByKey.get(key)!.push({
        userId: s.user.id,
        name: s.user.name,
        email: s.user.email,
        value: s.value,
        notes: s.notes,
      })
    }
  }

  // Reconciliation notes — the pair's "Why we decided" text, stored on
  // isReconciled Score rows (one per dimension they DID resolve).
  const reconciledScores = await prisma.score.findMany({
    where: {
      feedbackItemId: { in: itemIds },
      isReconciled: true,
    },
    select: { feedbackItemId: true, userId: true, notes: true },
  })
  const reconciliationNotesByItem = new Map<string, string>()
  for (const esc of escalations) {
    const ownerUserId = getReleaseOwnerUserId(esc.teamRelease)
    if (!ownerUserId) continue
    const note = reconciledScores.find(
      (score) =>
        score.feedbackItemId === esc.feedbackItemId &&
        score.userId === ownerUserId &&
        score.notes &&
        score.notes.trim()
    )?.notes
    if (note) {
      reconciliationNotesByItem.set(
        `${esc.teamReleaseId}::${esc.feedbackItemId}`,
        note
      )
    }
  }

  const items = escalations.map((esc) => {
    const key = `${esc.teamReleaseId}::${esc.feedbackItemId}::${esc.dimensionId}`
    const scores = scoresByKey.get(key) || []
    return {
      escalationId: esc.id,
      batch: esc.batch,
      releaseId: esc.teamReleaseId,
      teamName: esc.teamRelease.team.name,
      feedbackItem: esc.feedbackItem,
      dimension: esc.dimension,
      escalatedBy: esc.escalatedBy,
      createdAt: esc.createdAt,
      scores,
      reconciliationNotes:
        reconciliationNotesByItem.get(
          `${esc.teamReleaseId}::${esc.feedbackItemId}`
        ) || null,
    }
  })

  return NextResponse.json({ items })
}

// POST /api/adjudicate
// Resolve one or more escalations. Writes an isReconciled Score row for
// each resolved (item, dimension) and marks the Escalation row resolved.
export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { resolutions } = body as {
    resolutions?: {
      escalationId: string
      value: number
      notes?: string
    }[]
  }

  if (!Array.isArray(resolutions) || resolutions.length === 0) {
    return NextResponse.json(
      { error: 'resolutions array is required' },
      { status: 400 }
    )
  }

  const ids = resolutions.map((r) => r.escalationId)
  const escalations = await prisma.escalation.findMany({
    where: { id: { in: ids }, resolvedAt: null },
    include: {
      batch: { select: { id: true, projectId: true, isLocked: true } },
      teamRelease: {
        include: {
          team: {
            include: {
              members: {
                select: { userId: true },
                orderBy: { user: { email: 'asc' } },
              },
            },
          },
        },
      },
      dimension: { select: { scaleMin: true, scaleMax: true } },
    },
  })

  if (escalations.length !== resolutions.length) {
    return NextResponse.json(
      { error: 'One or more escalations not found or already resolved' },
      { status: 400 }
    )
  }

  const globalAdmin = isGlobalAdmin(session.user.role)
  const postAdminProjectIds = globalAdmin ? null : new Set(await getAdminProjectIds(session.user.id))
  for (const esc of escalations) {
    const isAdminForThis = globalAdmin || (postAdminProjectIds?.has(esc.batch.projectId) ?? false)
    if (!isAdminForThis && esc.teamRelease.adjudicatorId !== session.user.id) {
      return NextResponse.json(
        { error: 'You are not the adjudicator for this team' },
        { status: 403 }
      )
    }
    if (esc.batch.isLocked) {
      return NextResponse.json(
        { error: 'This batch has been locked by an admin and can no longer be edited.' },
        { status: 423 }
      )
    }
    if (
      esc.teamRelease.status !== 'RECONCILING' &&
      esc.teamRelease.status !== 'COMPLETE'
    ) {
      return NextResponse.json(
        { error: 'Release is not in a reconcilable status' },
        { status: 400 }
      )
    }
  }

  // Validate each value against the dimension scale
  const escById = new Map(escalations.map((e) => [e.id, e]))
  for (const r of resolutions) {
    const esc = escById.get(r.escalationId)!
    if (
      typeof r.value !== 'number' ||
      r.value < esc.dimension.scaleMin ||
      r.value > esc.dimension.scaleMax
    ) {
      return NextResponse.json(
        {
          error: `Score must be ${esc.dimension.scaleMin}-${esc.dimension.scaleMax}`,
        },
        { status: 400 }
      )
    }
  }

  const now = new Date()
  for (const r of resolutions) {
    const esc = escById.get(r.escalationId)!
    const ownerUserId = getReleaseOwnerUserId(esc.teamRelease)
    if (!ownerUserId) {
      return NextResponse.json(
        { error: 'Release has no scorer ownership context' },
        { status: 400 }
      )
    }
    const releaseUserIds = esc.teamRelease.team.members.map((member) => member.userId)

    const originals = await prisma.score.findMany({
      where: {
        feedbackItemId: esc.feedbackItemId,
        dimensionId: esc.dimensionId,
        userId: { in: releaseUserIds },
        isReconciled: false,
      },
      select: { id: true },
    })
    const reconciledFrom = originals.map((o) => o.id).join(',')

    await prisma.$transaction([
      prisma.score.upsert({
        where: {
          feedbackItemId_userId_dimensionId_isReconciled: {
            feedbackItemId: esc.feedbackItemId,
            userId: ownerUserId,
            dimensionId: esc.dimensionId,
            isReconciled: true,
          },
        },
        update: {
          value: r.value,
          reconciledFrom,
          notes: r.notes?.trim() || null,
          scoredAt: now,
        },
        create: {
          feedbackItemId: esc.feedbackItemId,
          userId: ownerUserId,
          dimensionId: esc.dimensionId,
          value: r.value,
          isReconciled: true,
          reconciledFrom,
          notes: r.notes?.trim() || null,
        },
      }),
      prisma.escalation.update({
        where: { id: esc.id },
        data: { resolvedById: session.user!.id, resolvedAt: now },
      }),
    ])

    await maybeCompleteReleaseReconciliation(esc.teamReleaseId)
  }

  return NextResponse.json({ resolved: resolutions.length })
}
