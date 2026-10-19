import { auth } from '@/lib/auth'
import { unlockVisibleToUserWhere } from '@/lib/criterion-unlocks'
import { prisma } from '@/lib/db'
import { describeReviseFallback, selectReviseUnlock } from '@/lib/revise-selection'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Info, Lock } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { buttonVariants } from '@/components/ui/button'
import { EvaluateClient } from '../../evaluate/[projectId]/evaluate-client'

// Annotator "re-score one re-opened criterion" flow. Reachable only when an admin
// has opened a ReleaseCriterionUnlock that applies to this annotator on this
// batch — pair-wide, or scoped to them by name (independent batches).
// This reuses the normal scoring screen (EvaluateClient) in "revise mode": it
// looks and behaves exactly like the original scoring session — numbered nav,
// notes, auto-save, Continue/auto-advance — except the rubric is filtered to the
// single re-opened criterion and saves route through the revise endpoint.
//
// `dimensionId` names WHICH re-opened criterion to edit; the project page's
// Revise cards always send it. Without it (old bookmark) or when it names a
// criterion that is no longer open, the first-opened unlock is shown with a
// notice saying so — never a silent switch to a different criterion.
export default async function RevisePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ batchId?: string; dimensionId?: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect('/login')

  const { projectId } = await params
  const { batchId, dimensionId } = await searchParams
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
      batch: { select: { projectId: true, name: true, type: true, isLocked: true } },
      criterionUnlocks: {
        where: unlockWhere,
        select: { dimensionId: true, dimension: { select: { label: true } } },
        orderBy: { openedAt: 'asc' },
      },
    },
  })

  if (!release || release.batch.projectId !== projectId) redirect('/')

  const selection = selectReviseUnlock(
    release.criterionUnlocks.map((u) => ({
      dimensionId: u.dimensionId,
      label: u.dimension.label,
    })),
    dimensionId
  )
  if (!selection) redirect('/')

  // A locked batch refuses every revise save with 423, so an editor here would
  // only ever show "Save failed". Say why instead.
  if (release.batch.isLocked) {
    return (
      <AppShell defaultCollapsed>
        <div className="mx-auto flex max-w-lg flex-col items-center justify-center gap-4 py-20 text-center">
          <Lock className="size-12 text-muted-foreground" />
          <h2 className="text-xl font-semibold">This batch is locked</h2>
          <p className="text-sm text-muted-foreground">
            An admin has locked{' '}
            <span className="font-medium text-foreground">{release.batch.name}</span>.
            Scores are frozen, so “{selection.unlock.label}” can no longer be revised.
          </p>
          <Link
            href={`/projects/${projectId}`}
            className={`${buttonVariants({ variant: 'default' })} transition-all duration-200`}
          >
            Back to project
          </Link>
        </div>
      </AppShell>
    )
  }

  const fallbackNotice = describeReviseFallback(selection)

  return (
    <>
      <EvaluateClient
        projectId={projectId}
        userName={session.user.name || session.user.email || 'Annotator'}
        batchId={batchId}
        batchType={release.batch.type}
        reviseDimensionId={selection.unlock.dimensionId}
        reviseBatchName={release.batch.name}
      />
      {fallbackNotice && (
        <div
          role="status"
          className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4"
        >
          <div className="pointer-events-auto flex max-w-xl items-start gap-2 rounded-lg border border-border bg-background/95 px-3 py-2 text-xs text-muted-foreground shadow-lg backdrop-blur-lg supports-[backdrop-filter]:bg-background/80">
            <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
            <span>{fallbackNotice}</span>
          </div>
        </div>
      )}
    </>
  )
}
