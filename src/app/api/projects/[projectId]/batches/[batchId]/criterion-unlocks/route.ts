import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import { prisma } from '@/lib/db'
import { maybeCompleteReleaseReconciliation } from '@/lib/reconciliation'
import {
  getExpectedReleaseUserIds,
  releaseNeedsReconciliation,
} from '@/lib/team-batch-releases'
import { NextRequest, NextResponse } from 'next/server'

// Admin-managed per-(release, criterion) re-open toggles. Presence of a row lets
// the scoped annotator(s) go back and revise their individual scores for just
// that one criterion on an already closed/reconciling batch. The optional
// `userId` narrows the re-open to a single annotator — see
// ReleaseCriterionUnlock in schema.prisma.

async function loadReleaseForBatch(
  releaseId: string,
  batchId: string,
  projectId: string
) {
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
          dimensions: { select: { dimensionId: true } },
          members: {
            select: { userId: true },
            orderBy: { user: { email: 'asc' } },
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
    return null
  }
  return release
}

// GET — list current unlocks for this batch (all releases).
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; batchId: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { projectId, batchId } = await params
  if (!(await canAdminProject(session.user.id, session.user.role, projectId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const unlocks = await prisma.releaseCriterionUnlock.findMany({
    where: { teamRelease: { batchId } },
    select: {
      id: true,
      teamReleaseId: true,
      dimensionId: true,
      userId: true,
      openedAt: true,
      dimension: { select: { label: true } },
    },
  })
  return NextResponse.json(unlocks)
}

// POST — open a criterion for re-scoring.
// Body: { releaseId, dimensionId, userId? } — userId narrows the re-open to one
// annotator; omit (or null) to open it for everyone assigned to the release.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; batchId: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { projectId, batchId } = await params
  if (!(await canAdminProject(session.user.id, session.user.role, projectId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { releaseId, dimensionId, userId } = (await request.json()) as {
    releaseId?: string
    dimensionId?: string
    userId?: string | null
  }
  if (!releaseId || !dimensionId) {
    return NextResponse.json(
      { error: 'releaseId and dimensionId are required' },
      { status: 400 }
    )
  }

  const release = await loadReleaseForBatch(releaseId, batchId, projectId)
  if (!release) {
    return NextResponse.json({ error: 'Release not found' }, { status: 404 })
  }
  if (release.batch.isLocked) {
    return NextResponse.json(
      { error: 'Unlock the batch before re-opening a criterion.' },
      { status: 423 }
    )
  }
  // Only criteria the team actually scores can be re-opened.
  const teamDimensionIds = new Set(release.team.dimensions.map((d) => d.dimensionId))
  if (!teamDimensionIds.has(dimensionId)) {
    return NextResponse.json(
      { error: 'That criterion is not part of this team.' },
      { status: 400 }
    )
  }

  // A scoped re-open must name someone who actually scored this release —
  // otherwise it would open a criterion for an annotator with no items.
  const scopedUserId = userId || null
  if (scopedUserId && !getExpectedReleaseUserIds(release).includes(scopedUserId)) {
    return NextResponse.json(
      { error: 'That annotator is not assigned to score this batch.' },
      { status: 400 }
    )
  }

  const unlock = await prisma.releaseCriterionUnlock.upsert({
    where: {
      teamReleaseId_dimensionId: { teamReleaseId: releaseId, dimensionId },
    },
    // Re-targeting an already-open criterion (e.g. "both" → just Luofan) updates
    // the scope in place rather than stacking rows.
    update: { userId: scopedUserId, openedById: session.user.id },
    create: {
      teamReleaseId: releaseId,
      dimensionId,
      userId: scopedUserId,
      openedById: session.user.id,
    },
  })

  // Move the release into RECONCILING so the reconcile hub is reachable while the
  // pair revises. (COMPLETE releases are otherwise settled.) Idempotent.
  // Independent (non-double-scored) releases never reconcile — there is no hub to
  // reach and no discrepancy to re-settle — so they stay COMPLETE while open.
  if (release.status === 'COMPLETE' && releaseNeedsReconciliation(release)) {
    await prisma.teamBatchRelease.update({
      where: { id: releaseId },
      data: { status: 'RECONCILING' },
    })
  }

  return NextResponse.json({ opened: true, unlock }, { status: 201 })
}

// DELETE — re-close a criterion. Body: { releaseId, dimensionId }.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; batchId: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { projectId, batchId } = await params
  if (!(await canAdminProject(session.user.id, session.user.role, projectId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { releaseId, dimensionId } = (await request.json()) as {
    releaseId?: string
    dimensionId?: string
  }
  if (!releaseId || !dimensionId) {
    return NextResponse.json(
      { error: 'releaseId and dimensionId are required' },
      { status: 400 }
    )
  }

  const release = await loadReleaseForBatch(releaseId, batchId, projectId)
  if (!release) {
    return NextResponse.json({ error: 'Release not found' }, { status: 404 })
  }

  await prisma.releaseCriterionUnlock.deleteMany({
    where: { teamReleaseId: releaseId, dimensionId },
  })

  // Settle the release now that revisions are closed — completes it if every
  // discrepancy is resolved.
  await maybeCompleteReleaseReconciliation(releaseId)

  return NextResponse.json({ closed: true })
}
