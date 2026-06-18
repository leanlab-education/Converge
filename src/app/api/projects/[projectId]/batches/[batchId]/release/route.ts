import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import { prisma } from '@/lib/db'
import { syncBatchStatus } from '@/lib/team-batch-releases'
import { NextRequest, NextResponse } from 'next/server'

// POST /api/projects/[projectId]/batches/[batchId]/release
// Batch-level publish control. { release: true } makes every team release
// visible to its annotators (DRAFT → SCORING) and un-hides the batch.
// { release: false } pulls it back to draft (visible SCORING releases → hidden
// DRAFT). Releases already in RECONCILING/COMPLETE are left untouched so an
// in-progress reconciliation can't be yanked out from under a pair.
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

  const { release } = (await request.json()) as { release?: boolean }
  if (typeof release !== 'boolean') {
    return NextResponse.json(
      { error: 'release (boolean) is required' },
      { status: 400 }
    )
  }

  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    select: {
      id: true,
      projectId: true,
      teamReleases: { select: { id: true, status: true } },
    },
  })

  if (!batch || batch.projectId !== projectId) {
    return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
  }

  if (batch.teamReleases.length === 0) {
    return NextResponse.json(
      { error: 'This batch has no teams assigned yet, so there is nothing to release.' },
      { status: 400 }
    )
  }

  if (release) {
    await prisma.$transaction([
      prisma.batch.update({
        where: { id: batchId },
        data: { isHidden: false },
      }),
      ...batch.teamReleases.map((r) =>
        prisma.teamBatchRelease.update({
          where: { id: r.id },
          data: {
            isVisible: true,
            ...(r.status === 'DRAFT' ? { status: 'SCORING' } : {}),
          },
        })
      ),
    ])
  } else {
    // Only pull back releases that haven't started reconciling yet.
    const pullable = batch.teamReleases.filter(
      (r) => r.status === 'SCORING' || r.status === 'DRAFT'
    )
    await prisma.$transaction(
      pullable.map((r) =>
        prisma.teamBatchRelease.update({
          where: { id: r.id },
          data: { isVisible: false, status: 'DRAFT' },
        })
      )
    )
  }

  await syncBatchStatus(batchId)

  return NextResponse.json({ success: true })
}
