import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import { prisma } from '@/lib/db'
import { Prisma } from '@/generated/prisma/client'
import { evaluateReconciliationAccess } from '@/lib/reconciliation-access'
import { maybeCompleteReleaseReconciliation } from '@/lib/reconciliation'
import {
  getExpectedReleaseDimensionIds,
  getReleaseOwnerUserId,
  releaseNeedsReconciliation,
} from '@/lib/team-batch-releases'
import { NextRequest, NextResponse } from 'next/server'

// POST /api/projects/[projectId]/batches/[batchId]/reconcile
// Accepts reconciled scores for one team release.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; batchId: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { projectId, batchId } = await params
  const body = await request.json()
  const { releaseId, items } = body as {
    releaseId?: string
    items: {
      feedbackItemId: string
      scores: { dimensionId: string; value: number }[]
      notes?: string
    }[]
  }

  if (!releaseId) {
    return NextResponse.json({ error: 'releaseId is required' }, { status: 400 })
  }

  if (!(await canAdminProject(session.user.id, session.user.role, projectId))) {
    const assignment = await prisma.batchAssignment.findFirst({
      where: {
        batchId,
        userId: session.user.id,
        teamReleaseId: releaseId,
      },
      select: { id: true },
    })
    if (!assignment) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const release = await prisma.teamBatchRelease.findUnique({
    where: { id: releaseId },
    include: {
      batch: {
        select: {
          id: true,
          projectId: true,
          type: true,
          isDoubleScored: true,
          isLocked: true,
        },
      },
      team: {
        include: {
          members: {
            select: { userId: true },
            orderBy: { user: { email: 'asc' } },
          },
          dimensions: {
            select: { dimensionId: true },
          },
        },
      },
    },
  })

  if (
    !release ||
    release.batchId !== batchId ||
    release.batch.projectId !== projectId
  ) {
    return NextResponse.json({ error: 'Release not found' }, { status: 404 })
  }

  // Slot-split (non-double-scored regular) releases never reconcile — each item
  // has exactly one raw score, which IS the final at export time. A reconciled
  // row written here would silently override it, so reject outright.
  // (Fable review finding 7, 2026-08-11)
  if (!releaseNeedsReconciliation(release)) {
    return NextResponse.json(
      { error: 'This release has no reconciliation step' },
      { status: 400 }
    )
  }

  // Edits allowed while RECONCILING or after auto-completion (COMPLETE), until
  // an admin locks the batch — lock takes precedence. (Amber 2026-06-30)
  const access = evaluateReconciliationAccess({
    isLocked: release.batch.isLocked,
    status: release.status,
  })
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.httpStatus })
  }

  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json(
      { error: 'items array is required' },
      { status: 400 }
    )
  }

  const ownerUserId = getReleaseOwnerUserId(release)
  if (!ownerUserId) {
    return NextResponse.json(
      { error: 'Release has no scorer ownership context' },
      { status: 400 }
    )
  }

  const projectDimensionIds =
    release.batch.type === 'TRAINING'
      ? (
          await prisma.rubricDimension.findMany({
            where: { projectId },
            select: { id: true, scaleMin: true, scaleMax: true },
          })
        )
      : []
  const allowedDimensionIds = new Set(
    getExpectedReleaseDimensionIds(
      release,
      projectDimensionIds.map((dimension) => dimension.id)
    )
  )

  const dimensions = await prisma.rubricDimension.findMany({
    where: { projectId },
    select: { id: true, scaleMin: true, scaleMax: true },
  })
  const dimMap = new Map(dimensions.map((d) => [d.id, d]))

  for (const item of items) {
    if (!item.feedbackItemId || !Array.isArray(item.scores)) {
      return NextResponse.json(
        { error: 'Each item needs feedbackItemId and scores array' },
        { status: 400 }
      )
    }

    const feedbackItem = await prisma.feedbackItem.findUnique({
      where: { id: item.feedbackItemId },
      select: { batchId: true },
    })
    if (!feedbackItem || feedbackItem.batchId !== batchId) {
      return NextResponse.json(
        { error: `Item ${item.feedbackItemId} not in this batch` },
        { status: 400 }
      )
    }

    for (const score of item.scores) {
      if (!allowedDimensionIds.has(score.dimensionId)) {
        return NextResponse.json(
          { error: `Dimension ${score.dimensionId} is not part of this release` },
          { status: 400 }
        )
      }
      const dim = dimMap.get(score.dimensionId)
      if (!dim) {
        return NextResponse.json(
          { error: `Invalid dimension: ${score.dimensionId}` },
          { status: 400 }
        )
      }
      if (score.value < dim.scaleMin || score.value > dim.scaleMax) {
        return NextResponse.json(
          { error: `Score must be ${dim.scaleMin}-${dim.scaleMax}` },
          { status: 400 }
        )
      }
    }
  }

  const releaseUserIds = release.team.members.map((member) => member.userId)
  const userId = session.user.id

  // Everything below runs in ONE serializable transaction: the adjudicated-keys
  // snapshot, the pre-pass that gathers originals/existing finals, and the
  // writes. Serializable keeps concurrent partner edits from interleaving — a
  // conflicting concurrent save aborts (P2034) → 409, and any failure rolls
  // back with nothing partially applied. (Fable review, 2026-08-11)
  let reconciledCount = 0
  try {
    reconciledCount = await prisma.$transaction(
      async (tx) => {
        // (item, dimension) pairs an adjudicator has already resolved are final
        // — the pair must never overwrite them. The UI locks these, but enforce
        // server-side too so a stale client can't clobber an adjudicator's
        // decision.
        const resolvedEscalations = await tx.escalation.findMany({
          where: { teamReleaseId: releaseId, resolvedAt: { not: null } },
          select: { feedbackItemId: true, dimensionId: true },
        })
        const adjudicatedKeys = new Set(
          resolvedEscalations.map((e) => `${e.feedbackItemId}::${e.dimensionId}`)
        )

        // Pre-pass: fetch originals + existing finals for every (item,
        // dimension) so the write loop can stamp reconciledFrom and detect
        // whether the final value actually changed (for reconciledById
        // attribution). Recording your own original on a discrepancy is allowed;
        // the reconcile UI shows a "did you and your partner agree?" confirmation
        // for that case, but it is not server-enforced. (2026-08-17)
        const writeContext = new Map<
          string,
          {
            originals: { id: string; userId: string; value: number }[]
            existingFinalValue: number | null
          }
        >()
        for (const item of items) {
          for (const score of item.scores) {
            const key = `${item.feedbackItemId}::${score.dimensionId}`
            if (adjudicatedKeys.has(key)) continue

            const originals = await tx.score.findMany({
              where: {
                feedbackItemId: item.feedbackItemId,
                dimensionId: score.dimensionId,
                userId: { in: releaseUserIds },
                isReconciled: false,
              },
              select: { id: true, userId: true, value: true },
            })
            const existingFinal = await tx.score.findUnique({
              where: {
                feedbackItemId_userId_dimensionId_isReconciled: {
                  feedbackItemId: item.feedbackItemId,
                  userId: ownerUserId,
                  dimensionId: score.dimensionId,
                  isReconciled: true,
                },
              },
              select: { value: true },
            })
            writeContext.set(key, {
              originals,
              existingFinalValue: existingFinal?.value ?? null,
            })
          }
        }

        let count = 0
        for (const item of items) {
          for (const score of item.scores) {
            const context = writeContext.get(
              `${item.feedbackItemId}::${score.dimensionId}`
            )
            if (!context) continue // adjudicated — the pair must not overwrite

            const reconciledFrom = context.originals.map((o) => o.id).join(',')
            // Attribution: stamp reconciledById only when this save actually
            // changes the final value. A no-op resave (e.g. a notes edit
            // re-sending unchanged values) must not relabel someone else's
            // decision as the resaver's. (Fable review, 2026-08-11)
            const valueChanged = score.value !== context.existingFinalValue

            await tx.score.upsert({
              where: {
                feedbackItemId_userId_dimensionId_isReconciled: {
                  feedbackItemId: item.feedbackItemId,
                  userId: ownerUserId,
                  dimensionId: score.dimensionId,
                  isReconciled: true,
                },
              },
              update: {
                value: score.value,
                reconciledFrom,
                notes: item.notes || null,
                scoredAt: new Date(),
                ...(valueChanged ? { reconciledById: userId } : {}),
              },
              create: {
                feedbackItemId: item.feedbackItemId,
                userId: ownerUserId,
                dimensionId: score.dimensionId,
                value: score.value,
                isReconciled: true,
                reconciledFrom,
                notes: item.notes || null,
                reconciledById: userId,
              },
            })

            count++
          }
        }
        return count
      },
      { isolationLevel: 'Serializable' }
    )
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2034'
    ) {
      return NextResponse.json(
        {
          error:
            'This item was just updated by someone else (likely your partner). Reload to see the latest scores, then try again.',
        },
        { status: 409 }
      )
    }
    throw err
  }

  await maybeCompleteReleaseReconciliation(releaseId)

  return NextResponse.json({ saved: true, reconciledCount })
}
