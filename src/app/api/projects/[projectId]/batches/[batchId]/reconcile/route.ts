import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import { prisma } from '@/lib/db'
import { maybeCompleteReleaseReconciliation } from '@/lib/reconciliation'
import {
  getExpectedReleaseDimensionIds,
  getReleaseOwnerUserId,
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

  if (release.status !== 'RECONCILING') {
    return NextResponse.json(
      { error: 'Release must be in RECONCILING status' },
      { status: 400 }
    )
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

  let reconciledCount = 0
  const releaseUserIds = release.team.members.map((member) => member.userId)

  // (item, dimension) pairs an adjudicator has already resolved are final — the
  // pair must never overwrite them. The UI locks these, but enforce server-side
  // too so a stale client can't clobber an adjudicator's decision.
  const resolvedEscalations = await prisma.escalation.findMany({
    where: { teamReleaseId: releaseId, resolvedAt: { not: null } },
    select: { feedbackItemId: true, dimensionId: true },
  })
  const adjudicatedKeys = new Set(
    resolvedEscalations.map((e) => `${e.feedbackItemId}::${e.dimensionId}`)
  )

  for (const item of items) {
    for (const score of item.scores) {
      if (adjudicatedKeys.has(`${item.feedbackItemId}::${score.dimensionId}`)) {
        continue
      }
      const originals = await prisma.score.findMany({
        where: {
          feedbackItemId: item.feedbackItemId,
          dimensionId: score.dimensionId,
          userId: { in: releaseUserIds },
          isReconciled: false,
        },
        select: { id: true },
      })

      const reconciledFrom = originals.map((o) => o.id).join(',')

      await prisma.score.upsert({
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
        },
        create: {
          feedbackItemId: item.feedbackItemId,
          userId: ownerUserId,
          dimensionId: score.dimensionId,
          value: score.value,
          isReconciled: true,
          reconciledFrom,
          notes: item.notes || null,
        },
      })

      reconciledCount++
    }
  }

  await maybeCompleteReleaseReconciliation(releaseId)

  return NextResponse.json({ saved: true, reconciledCount })
}
