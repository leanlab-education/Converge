import { auth } from '@/lib/auth'
import { unlockVisibleToUserWhere } from '@/lib/criterion-unlocks'
import { prisma } from '@/lib/db'
import { reReconcileReleaseItem } from '@/lib/reconciliation'
import { getReleaseItemScope } from '@/lib/team-batch-releases'
import { NextRequest, NextResponse } from 'next/server'

// POST /api/projects/[projectId]/batches/[batchId]/revise
// An annotator revises their OWN individual (raw) score for a single criterion
// that an admin has re-opened for them on this batch (ReleaseCriterionUnlock —
// either pair-wide or scoped to this one annotator). Only the unlocked criterion
// can be written; on a double-scored batch the change re-derives reconciliation
// for that one dimension. Other criteria are never touched.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; batchId: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { projectId, batchId } = await params
  const { feedbackItemId, dimensionId, value, notes } = (await request.json()) as {
    feedbackItemId?: string
    dimensionId?: string
    value?: number
    notes?: string
  }
  if (!feedbackItemId || !dimensionId || typeof value !== 'number') {
    return NextResponse.json(
      { error: 'feedbackItemId, dimensionId and numeric value are required' },
      { status: 400 }
    )
  }

  // The batch must not be admin-locked.
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    select: { projectId: true, isLocked: true },
  })
  if (!batch || batch.projectId !== projectId) {
    return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
  }
  if (batch.isLocked) {
    return NextResponse.json(
      { error: 'This batch has been locked by an admin and can no longer be edited.' },
      { status: 423 }
    )
  }

  // Find the release for THIS user's team on this batch that has an active unlock
  // for this dimension which applies to them. This single query is the
  // authorization: the user must be a member of a team whose release for this
  // batch has re-opened this criterion, either pair-wide or for them by name.
  const release = await prisma.teamBatchRelease.findFirst({
    where: {
      batchId,
      team: { members: { some: { userId: session.user.id } } },
      criterionUnlocks: {
        some: { dimensionId, ...unlockVisibleToUserWhere(session.user.id) },
      },
    },
    select: {
      id: true,
      scorerUserId: true,
      batch: { select: { id: true, type: true, isDoubleScored: true } },
      team: {
        select: {
          dimensions: { select: { dimensionId: true } },
          members: {
            select: { userId: true },
            orderBy: { user: { email: 'asc' } },
          },
        },
      },
    },
  })
  if (!release) {
    return NextResponse.json(
      { error: 'This criterion is not open for you to revise on this batch.' },
      { status: 403 }
    )
  }

  // Defense in depth: the dimension must belong to the team (it always will,
  // since unlocks are validated on creation, but never trust the client).
  if (!release.team.dimensions.some((d) => d.dimensionId === dimensionId)) {
    return NextResponse.json(
      { error: 'That criterion is not part of your team.' },
      { status: 400 }
    )
  }

  // Validate the item is in this batch and the value is within the rubric scale.
  const [item, dimension] = await Promise.all([
    prisma.feedbackItem.findUnique({
      where: { id: feedbackItemId },
      select: { batchId: true, slotIndex: true },
    }),
    prisma.rubricDimension.findUnique({
      where: { id: dimensionId },
      select: { projectId: true, scaleMin: true, scaleMax: true },
    }),
  ])
  if (!item || item.batchId !== batchId) {
    return NextResponse.json({ error: 'Item is not in this batch' }, { status: 400 })
  }

  // The annotator may only revise items they were actually assigned. This matters
  // on an independent (non-double-scored) batch, where the pair splits the items
  // by slotIndex and each item×criterion holds exactly ONE score: writing outside
  // your slot would add a second raw score and break the "final = the lone raw
  // score" rule every export depends on.
  const itemScope = getReleaseItemScope(release, session.user.id)
  if (
    itemScope.mode === 'none' ||
    (itemScope.mode === 'slot' && item.slotIndex !== itemScope.slotIndex)
  ) {
    return NextResponse.json(
      { error: 'That item is not assigned to you on this batch.' },
      { status: 403 }
    )
  }
  if (!dimension || dimension.projectId !== projectId) {
    return NextResponse.json({ error: 'Invalid criterion' }, { status: 400 })
  }
  if (value < dimension.scaleMin || value > dimension.scaleMax) {
    return NextResponse.json(
      { error: `Score must be between ${dimension.scaleMin} and ${dimension.scaleMax}` },
      { status: 400 }
    )
  }

  // Look at the annotator's current raw score so we only re-derive reconciliation
  // when the value actually changed. This is important: the scoring screen
  // auto-saves on navigation, so an unchanged re-save must NOT disturb an
  // existing (possibly manually reconciled) item.
  const existing = await prisma.score.findUnique({
    where: {
      feedbackItemId_userId_dimensionId_isReconciled: {
        feedbackItemId,
        userId: session.user.id,
        dimensionId,
        isReconciled: false,
      },
    },
    select: { value: true },
  })
  const valueChanged = !existing || existing.value !== value

  // Overwrite the annotator's own raw score (Amber: no per-edit history needed —
  // the revised value simply becomes their score).
  await prisma.score.upsert({
    where: {
      feedbackItemId_userId_dimensionId_isReconciled: {
        feedbackItemId,
        userId: session.user.id,
        dimensionId,
        isReconciled: false,
      },
    },
    update: {
      value,
      ...(valueChanged ? { scoredAt: new Date() } : {}),
      ...(notes !== undefined ? { notes: notes || null } : {}),
    },
    create: {
      feedbackItemId,
      userId: session.user.id,
      dimensionId,
      value,
      notes: notes ?? 'Revised (criterion re-opened)',
    },
  })

  // Only re-settle reconciliation when the score actually changed — an unchanged
  // re-save (e.g. from navigation auto-save) leaves existing reconciliations
  // untouched. Independent (non-double-scored regular) releases never reconcile:
  // the revised raw score IS the final score, so there is nothing to re-derive.
  const releaseReconciles =
    release.batch.type === 'TRAINING' || release.batch.isDoubleScored
  if (valueChanged && releaseReconciles) {
    await reReconcileReleaseItem(release.id, feedbackItemId, dimensionId)
  }

  return NextResponse.json({ saved: true })
}
