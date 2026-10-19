import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { redirect } from 'next/navigation'
import { EvaluateClient } from './evaluate-client'
import { canAdminProject } from '@/lib/authorization'
import { evaluateScoringOpen } from '@/lib/score-write-scope'

export default async function EvaluatePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ batchId?: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect('/login')

  const { projectId } = await params
  const { batchId } = await searchParams

  const isAdmin = await canAdminProject(session.user.id, session.user.role, projectId)

  // Scoring is always one batch at a time: without a batch the screen would
  // mix batch types and releases that are not open. Annotators pick a batch on
  // the project page, admins on the Batches tab.
  const fallback = isAdmin
    ? `/admin/${projectId}?tab=batches`
    : `/projects/${projectId}`
  if (!batchId) redirect(fallback)

  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    select: {
      projectId: true,
      type: true,
      status: true,
      isHidden: true,
      isLocked: true,
      assignments: {
        where: { userId: session.user.id },
        select: { teamRelease: { select: { isVisible: true, status: true } } },
      },
    },
  })
  if (!batch || batch.projectId !== projectId) redirect(fallback)

  // The same rule PUT /api/scores enforces: only an assignment on an open
  // release may score. An admin without one previews the screen read-only; an
  // annotator without one has nothing to do here.
  const scoringOpen = evaluateScoringOpen({
    batch,
    assignment: batch.assignments[0] ?? null,
  }).ok
  if (!scoringOpen && !isAdmin) redirect(fallback)

  return (
    <EvaluateClient
      projectId={projectId}
      userName={session.user.name || session.user.email || 'Annotator'}
      batchId={batchId}
      batchType={batch.type}
      readOnly={!scoringOpen}
    />
  )
}
