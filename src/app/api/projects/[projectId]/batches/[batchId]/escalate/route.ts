import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import { prisma } from '@/lib/db'
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
        select: { projectId: true, isLocked: true },
      },
    },
  })

  if (!release || release.batchId !== batchId || release.batch.projectId !== projectId) {
    return NextResponse.json({ error: 'Release not found' }, { status: 404 })
  }

  if (release.batch.isLocked) {
    return NextResponse.json(
      { error: 'This batch has been locked by an admin and can no longer be edited.' },
      { status: 423 }
    )
  }

  if (release.status !== 'RECONCILING' && release.status !== 'COMPLETE') {
    return NextResponse.json(
      { error: 'Release is not in a reconcilable status to escalate' },
      { status: 400 }
    )
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
    select: { batchId: true, projectId: true },
  })
  if (!item || item.batchId !== batchId) {
    return NextResponse.json(
      { error: 'Item not found in this batch' },
      { status: 400 }
    )
  }

  // Verify dimension belongs to the project
  const dimension = await prisma.rubricDimension.findUnique({
    where: { id: dimensionId },
    select: { projectId: true },
  })
  if (!dimension || dimension.projectId !== item.projectId) {
    return NextResponse.json(
      { error: 'Invalid dimension for this project' },
      { status: 400 }
    )
  }

  try {
    const escalation = await prisma.escalation.create({
      data: {
        batchId,
        teamReleaseId: releaseId,
        feedbackItemId,
        dimensionId,
        escalatedById: session.user.id,
      },
    })
    return NextResponse.json(escalation, { status: 201 })
  } catch (err) {
    // Unique constraint violation → already escalated
    if (err instanceof Error && err.message.includes('Unique constraint')) {
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
        select: { projectId: true },
      },
    },
  })
  if (!release || release.batchId !== batchId || release.batch.projectId !== projectId) {
    return NextResponse.json({ error: 'Release not found' }, { status: 404 })
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
  return NextResponse.json({ withdrawn: true })
}
