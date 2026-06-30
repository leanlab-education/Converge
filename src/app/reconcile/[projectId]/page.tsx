import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { redirect } from 'next/navigation'
import { ReconcileClient } from './reconcile-client'
import { canAdminProject } from '@/lib/authorization'

export default async function ReconcilePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ batchId?: string; releaseId?: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect('/login')

  const { projectId } = await params
  const { batchId, releaseId } = await searchParams

  if (!batchId || !releaseId) redirect('/')

  const release = await prisma.teamBatchRelease.findUnique({
    where: { id: releaseId },
    include: {
      batch: {
        select: { id: true, projectId: true, name: true },
      },
    },
  })

  // Allow entering while actively reconciling OR after the release auto-completed
  // (so the pair can revisit and correct a final score). Writes are still gated
  // server-side by the batch lock; the client renders read-only when locked.
  if (
    !release ||
    release.batchId !== batchId ||
    release.batch.projectId !== projectId ||
    (release.status !== 'RECONCILING' && release.status !== 'COMPLETE')
  ) {
    redirect('/')
  }

  if (!(await canAdminProject(session.user.id, session.user.role, projectId))) {
    const assignment = await prisma.batchAssignment.findFirst({
      where: {
        batchId,
        userId: session.user.id,
        teamReleaseId: releaseId,
      },
    })
    if (!assignment) redirect('/')
  }

  return (
    <ReconcileClient
      projectId={projectId}
      batchId={batchId}
      releaseId={releaseId}
      batchName={release.batch.name}
      userName={session.user.name || session.user.email || 'Annotator'}
    />
  )
}
