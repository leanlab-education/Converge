import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import { prisma } from '@/lib/db'
import { Prisma } from '@/generated/prisma/client'
import { maybeCompleteReleaseReconciliation } from '@/lib/reconciliation'
import { evaluateReconciliationAccess } from '@/lib/reconciliation-access'
import {
  getExpectedReleaseDimensionIds,
  releaseNeedsReconciliation,
  syncBatchStatus,
} from '@/lib/team-batch-releases'
import { NextRequest, NextResponse } from 'next/server'

// POST /api/projects/[projectId]/batches/[batchId]/escalate
// Creates an Escalation for a single (item, dimension) pair that the pair
// couldn't resolve. Escalation is per-criterion per Amber's 2026-04-09 note:
// "each criterion is standalone." The escalation then appears in the batch
// adjudicator's /adjudicate queue.
//
// Rationale for the escalation (if any) is captured in the pair's existing
// reconciliation notes ("Why we decided what we did") — no separate reason
// field, per Amber's answer to Q5.
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
  const { releaseId, feedbackItemId, dimensionId } = body as {
    releaseId?: string
    feedbackItemId?: string
    dimensionId?: string
  }

  if (!releaseId || typeof releaseId !== 'string') {
    return NextResponse.json(
      { error: 'releaseId is required' },
      { status: 400 }
    )
  }

  const assignment = await prisma.batchAssignment.findFirst({
    where: {
      batchId,
      userId: session.user.id,
      teamReleaseId: releaseId,
    },
  })
  if (!assignment && !(await canAdminProject(session.user.id, session.user.role, projectId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const release = await prisma.teamBatchRelease.findUnique({
    where: { id: releaseId },
    include: {
      batch: {
        select: {
          id: true,
          projectId: true,
          isLocked: true,
          type: true,
          isDoubleScored: true,
        },
      },
      team: {
        include: {
          members: { select: { userId: true } },
          dimensions: { select: { dimensionId: true } },
        },
      },
    },
  })

  if (!release || release.batchId !== batchId || release.batch.projectId !== projectId) {
    return NextResponse.json({ error: 'Release not found' }, { status: 404 })
  }

  // Independent (slot-split) releases hold one raw score per cell — there is no
  // disagreement to escalate and no adjudicated final to write. Mirrors the
  // reconcile route.
  if (!releaseNeedsReconciliation(release)) {
    return NextResponse.json(
      { error: 'This release has no reconciliation step' },
      { status: 400 }
    )
  }

  const access = evaluateReconciliationAccess({
    isLocked: release.batch.isLocked,
    status: release.status,
  })
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.httpStatus })
  }

  if (!release.adjudicatorId) {
    return NextResponse.json(
      {
        error:
          'This team has no adjudicator assigned. Ask an admin to assign one before escalating.',
      },
      { status: 400 }
    )
  }

  if (!feedbackItemId || typeof feedbackItemId !== 'string') {
    return NextResponse.json(
      { error: 'feedbackItemId is required' },
      { status: 400 }
    )
  }

  if (!dimensionId || typeof dimensionId !== 'string') {
    return NextResponse.json(
      { error: 'dimensionId is required' },
      { status: 400 }
    )
  }

  // Verify the item belongs to this batch
  const item = await prisma.feedbackItem.findUnique({
    where: { id: feedbackItemId },
    select: { batchId: true },
  })
  if (!item || item.batchId !== batchId) {
    return NextResponse.json(
      { error: 'Item not found in this batch' },
      { status: 400 }
    )
  }

  // The dimension must be one THIS release scores — the team's criteria on a
  // regular batch, the whole rubric on training — not merely one that exists in
  // the project. An escalation on a criterion the pair never scored could never
  // be adjudicated against two originals. Mirrors the reconcile route.
  const projectDimensionIds =
    release.batch.type === 'TRAINING'
      ? (
          await prisma.rubricDimension.findMany({
            where: { projectId },
            select: { id: true },
          })
        ).map((dimension) => dimension.id)
      : []
  const allowedDimensionIds = new Set(
    getExpectedReleaseDimensionIds(release, projectDimensionIds)
  )
  if (!allowedDimensionIds.has(dimensionId)) {
    return NextResponse.json(
      { error: 'That criterion is not part of this release' },
      { status: 400 }
    )
  }

  // Escalating on a COMPLETE release is the edit-after-completion flow: the
  // pair revisited a final and now can't agree. The release has open work
  // again, so it must go back to RECONCILING (and the batch must follow, or
  // the "finalized batches only" export keeps shipping the old final while an
  // escalation is open). One transaction, so an open escalation can never
  // exist on a release still marked COMPLETE.
  const reopening = release.status === 'COMPLETE'
  try {
    const escalation = await prisma.$transaction(async (tx) => {
      const created = await tx.escalation.create({
        data: {
          batchId,
          teamReleaseId: releaseId,
          feedbackItemId,
          dimensionId,
          escalatedById: session.user.id,
        },
      })
      if (reopening) {
        await tx.teamBatchRelease.update({
          where: { id: releaseId },
          data: { status: 'RECONCILING' },
        })
      }
      return created
    })
    if (reopening) {
      await syncBatchStatus(batchId)
    }
    return NextResponse.json(escalation, { status: 201 })
  } catch (err) {
    // Unique constraint violation → already escalated
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      return NextResponse.json(
        { error: 'This criterion has already been escalated' },
        { status: 409 }
      )
    }
    throw err
  }
}

// DELETE — withdraw a per-dimension escalation. Only the original escalator
// or an admin can withdraw, and only while the escalation is still unresolved.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; batchId: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { projectId, batchId } = await params
  const releaseId = request.nextUrl.searchParams.get('releaseId')
  const feedbackItemId = request.nextUrl.searchParams.get('feedbackItemId')
  const dimensionId = request.nextUrl.searchParams.get('dimensionId')
  if (!releaseId || !feedbackItemId || !dimensionId) {
    return NextResponse.json(
      {
        error:
          'releaseId, feedbackItemId, and dimensionId query params are required',
      },
      { status: 400 }
    )
  }

  const release = await prisma.teamBatchRelease.findUnique({
    where: { id: releaseId },
    include: {
      batch: {
        select: { projectId: true, isLocked: true },
      },
    },
  })
  if (!release || release.batchId !== batchId || release.batch.projectId !== projectId) {
    return NextResponse.json({ error: 'Release not found' }, { status: 404 })
  }

  // Withdrawing changes the release's open work, so it is a reconciliation
  // write like any other: refused on a locked batch (423) or outside a
  // reconcilable status (400).
  const access = evaluateReconciliationAccess({
    isLocked: release.batch.isLocked,
    status: release.status,
  })
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.httpStatus })
  }

  const escalation = await prisma.escalation.findUnique({
    where: {
      teamReleaseId_feedbackItemId_dimensionId: {
        teamReleaseId: releaseId,
        feedbackItemId,
        dimensionId,
      },
    },
    select: { id: true, escalatedById: true, resolvedAt: true },
  })
  if (!escalation) {
    return NextResponse.json({ error: 'Escalation not found' }, { status: 404 })
  }
  if (escalation.resolvedAt) {
    return NextResponse.json(
      { error: 'Cannot withdraw a resolved escalation' },
      { status: 400 }
    )
  }
  if (
    escalation.escalatedById !== session.user.id &&
    !(await canAdminProject(session.user.id, session.user.role, projectId))
  ) {
    return NextResponse.json(
      { error: 'Only the escalator (or an admin) can withdraw an escalation' },
      { status: 403 }
    )
  }

  await prisma.escalation.delete({ where: { id: escalation.id } })

  // This may have been the last thing keeping the release open: an escalation
  // blocks completion, and once every other discrepancy is reconciled nothing
  // else will ever re-check. Idempotent; no-ops while work remains.
  await maybeCompleteReleaseReconciliation(releaseId)

  return NextResponse.json({ withdrawn: true })
}
