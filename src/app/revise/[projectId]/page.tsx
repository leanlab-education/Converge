import { auth } from '@/lib/auth'
import { unlockVisibleToUserWhere } from '@/lib/criterion-unlocks'
import { prisma } from '@/lib/db'
import { redirect } from 'next/navigation'
import { EvaluateClient } from '../../evaluate/[projectId]/evaluate-client'

// Annotator "re-score one re-opened criterion" flow. Reachable only when an admin
// has opened a ReleaseCriterionUnlock that applies to this annotator on this
// batch — pair-wide, or scoped to them by name (independent batches).
// This reuses the normal scoring screen (EvaluateClient) in "revise mode": it
// looks and behaves exactly like the original scoring session — numbered nav,
// notes, auto-save, Continue/auto-advance — except the rubric is filtered to the
// single re-opened criterion and saves route through the revise endpoint.
export default async function RevisePage({
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
  if (!batchId) redirect('/')

  // Find the caller's release on this batch that has at least one open criterion
  // unlock applying to them. The membership + unlock together are the
  // authorization; unlocks scoped to a different annotator don't count.
  const unlockWhere = unlockVisibleToUserWhere(session.user.id)
  const release = await prisma.teamBatchRelease.findFirst({
    where: {
      batchId,
      team: { members: { some: { userId: session.user.id } } },
      criterionUnlocks: { some: unlockWhere },
    },
    include: {
      batch: { select: { projectId: true, name: true, type: true } },
      criterionUnlocks: {
        where: unlockWhere,
        select: { dimensionId: true },
        orderBy: { openedAt: 'asc' },
      },
    },
  })

  if (!release || release.batch.projectId !== projectId) redirect('/')

  // One criterion at a time for now (Task Aligned Revision).
  const unlock = release.criterionUnlocks[0]
  if (!unlock) redirect('/')

  return (
    <EvaluateClient
      projectId={projectId}
      userName={session.user.name || session.user.email || 'Annotator'}
      batchId={batchId}
      batchType={release.batch.type}
      reviseDimensionId={unlock.dimensionId}
      reviseBatchName={release.batch.name}
    />
  )
}
