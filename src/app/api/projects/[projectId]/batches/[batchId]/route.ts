import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import { assignBatchSlots } from '@/lib/batch-slots'
import { prisma } from '@/lib/db'
import {
  ensureTeamReleasesForBatch,
  syncBatchAssignmentsForRelease,
  syncBatchStatus,
} from '@/lib/team-batch-releases'
import { NextRequest, NextResponse } from 'next/server'

export async function PATCH(
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
  const body = await request.json()
  const { status, isHidden, type, isDoubleScored } = body as {
    status?: string
    isHidden?: boolean
    type?: 'REGULAR' | 'TRAINING'
    isDoubleScored?: boolean
  }

  if (
    status === undefined &&
    isHidden === undefined &&
    type === undefined &&
    isDoubleScored === undefined
  ) {
    return NextResponse.json(
      {
        error: 'status, isHidden, type, or isDoubleScored is required',
      },
      { status: 400 }
    )
  }

  if (status !== undefined) {
    return NextResponse.json(
      {
        error:
          'Batch status is now derived from team release statuses and cannot be edited directly',
      },
      { status: 400 }
    )
  }

  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    select: {
      id: true,
      status: true,
      projectId: true,
      type: true,
      isDoubleScored: true,
      teamReleases: { select: { id: true } },
    },
  })

  if (!batch || batch.projectId !== projectId) {
    return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
  }

  if (type !== undefined && type !== 'REGULAR' && type !== 'TRAINING') {
    return NextResponse.json({ error: 'Invalid batch type' }, { status: 400 })
  }

  const nextType = type ?? batch.type
  const nextIsDoubleScored =
    nextType === 'TRAINING' ? false : (isDoubleScored ?? batch.isDoubleScored)

  const modeIsChanging =
    nextType !== batch.type || nextIsDoubleScored !== batch.isDoubleScored

  if (modeIsChanging) {
    const scoreCount = await prisma.score.count({
      where: {
        feedbackItem: { batchId },
      },
    })

    if (scoreCount > 0) {
      return NextResponse.json(
        { error: 'Cannot change batch type after scoring has begun' },
        { status: 400 }
      )
    }
  }

  const updated = await prisma.batch.update({
    where: { id: batchId },
    data: {
      ...(isHidden !== undefined ? { isHidden } : {}),
      ...(modeIsChanging
        ? {
            type: nextType,
            isDoubleScored: nextIsDoubleScored,
          }
        : {}),
    },
  })

  if (modeIsChanging) {
    if (nextType === 'REGULAR' && !nextIsDoubleScored) {
      await assignBatchSlots(batchId)
    } else {
      await prisma.feedbackItem.updateMany({
        where: { batchId },
        data: { slotIndex: null },
      })
    }

    // Back-fill releases for any team that lacks one (e.g. a batch created
    // before its teams existed), then re-sync assignments for all releases.
    await ensureTeamReleasesForBatch(batchId)
    const releases = await prisma.teamBatchRelease.findMany({
      where: { batchId },
      select: { id: true },
    })
    for (const release of releases) {
      await syncBatchAssignmentsForRelease(release.id)
    }
    await syncBatchStatus(batchId)
  }

  return NextResponse.json(updated)
}

export async function DELETE(
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

  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    select: { status: true, projectId: true },
  })

  if (!batch || batch.projectId !== projectId) {
    return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
  }

  if (batch.status !== 'DRAFT') {
    return NextResponse.json(
      { error: 'Only DRAFT batches can be deleted' },
      { status: 400 }
    )
  }

  await prisma.batch.delete({ where: { id: batchId } })

  return NextResponse.json({ success: true })
}
