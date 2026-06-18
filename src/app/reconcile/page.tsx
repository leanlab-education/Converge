import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { AppShell } from '@/components/app-shell'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { computeReleaseDiscrepancyStats } from '@/lib/reconciliation'
import { displayAnnotatorName } from '@/lib/generate-name'
import { Users, Gavel, ArrowRight, CheckCircle2 } from 'lucide-react'

// Static button styles (buttonVariants is client-only; this page is a server
// component, so we can't call it here).
const PRIMARY_BTN =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-all duration-200 hover:bg-primary/90'
const OUTLINE_BTN =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-medium transition-all duration-200 hover:bg-muted'

export default async function ReconcileHubPage() {
  const session = await auth()
  if (!session?.user) redirect('/login')
  const userId = session.user.id

  // --- Section 1: discrepancies to reconcile with your own partner ---
  const reconcileReleases = await prisma.teamBatchRelease.findMany({
    where: {
      status: 'RECONCILING',
      isVisible: true,
      batch: { isHidden: false },
      team: { members: { some: { userId } } },
    },
    include: {
      batch: {
        select: {
          id: true,
          name: true,
          type: true,
          projectId: true,
          project: { select: { name: true, usePseudonyms: true } },
        },
      },
      team: {
        include: {
          members: {
            include: { user: { select: { id: true, name: true, email: true } } },
            orderBy: { user: { email: 'asc' } },
          },
          dimensions: {
            include: { dimension: { select: { id: true, label: true, sortOrder: true } } },
            orderBy: { dimension: { sortOrder: 'asc' } },
          },
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  })

  const reconcileTasks = await Promise.all(
    reconcileReleases.map(async (release) => {
      const stats = await computeReleaseDiscrepancyStats({
        batchId: release.batch.id,
        batchType: release.batch.type,
        projectId: release.batch.projectId,
        memberUserIds: release.team.members.map((m) => m.userId),
        teamDimensionIds: release.team.dimensions.map((d) => d.dimensionId),
      })
      const partner = release.team.members.find((m) => m.userId !== userId)?.user ?? null
      const usePseudonyms = release.batch.project.usePseudonyms
      return {
        releaseId: release.id,
        batchId: release.batch.id,
        batchName: release.batch.name,
        projectId: release.batch.projectId,
        projectName: release.batch.project.name,
        criteria: release.team.dimensions.map((d) => d.dimension.label),
        partnerName: partner
          ? displayAnnotatorName(partner.id, partner.name, usePseudonyms)
          : null,
        discrepancyCount: stats.discrepancyCount,
        reconciledCount: stats.reconciledCount,
      }
    })
  )

  // --- Section 2: items escalated to you as an adjudicator for another group ---
  const myEscalations = await prisma.escalation.findMany({
    where: { resolvedAt: null, teamRelease: { adjudicatorId: userId } },
    include: {
      batch: {
        select: { id: true, name: true, projectId: true, project: { select: { name: true } } },
      },
      teamRelease: {
        select: {
          id: true,
          team: {
            select: {
              name: true,
              dimensions: {
                include: { dimension: { select: { label: true, sortOrder: true } } },
                orderBy: { dimension: { sortOrder: 'asc' } },
              },
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  // Group escalations by team release (one card per group/batch you adjudicate).
  const adjudicateMap = new Map<
    string,
    {
      releaseId: string
      batchName: string
      projectName: string
      teamName: string
      criteria: string[]
      count: number
    }
  >()
  for (const esc of myEscalations) {
    const key = esc.teamReleaseId
    const existing = adjudicateMap.get(key)
    if (existing) {
      existing.count++
    } else {
      adjudicateMap.set(key, {
        releaseId: esc.teamReleaseId,
        batchName: esc.batch.name,
        projectName: esc.batch.project.name,
        teamName: esc.teamRelease.team.name,
        criteria: esc.teamRelease.team.dimensions.map((d) => d.dimension.label),
        count: 1,
      })
    }
  }
  const adjudicateTasks = Array.from(adjudicateMap.values())

  const totalTasks = reconcileTasks.length + adjudicateTasks.length

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">Reconciliation</h1>
          <p className="text-sm text-muted-foreground">
            Resolve discrepancies with your partner, and adjudicate the groups you
            cover.
          </p>
        </div>

        {totalTasks === 0 ? (
          <div className="py-16 text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-success/60" />
            <h3 className="mt-4 text-lg font-medium">You&apos;re all caught up</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Nothing to reconcile or adjudicate right now. Check back after a
              double-scored batch is complete.
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {/* With your partner */}
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <Users className="size-4 text-primary" />
                <h2 className="text-sm font-semibold">With your partner</h2>
                <Badge variant="outline" className="text-[10px]">
                  {reconcileTasks.length}
                </Badge>
              </div>
              {reconcileTasks.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                  No discrepancies waiting on you and your partner.
                </p>
              ) : (
                <div className="space-y-3">
                  {reconcileTasks.map((task) => (
                    <Card
                      key={task.releaseId}
                      className="transition-all duration-200 hover:shadow-sm hover:ring-1 hover:ring-primary/10"
                    >
                      <CardHeader className="pb-2">
                        <div className="flex items-start justify-between gap-2">
                          <CardTitle className="text-base">{task.batchName}</CardTitle>
                          <Badge
                            variant="outline"
                            className="bg-status-reconciliation-bg text-status-reconciliation-text"
                          >
                            Reconciling
                          </Badge>
                        </div>
                        <CardDescription>
                          {task.projectName}
                          {task.partnerName ? ` · with ${task.partnerName}` : ''}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <p className="mb-3 text-xs text-muted-foreground">
                          {task.criteria.join(' · ')}
                        </p>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm text-muted-foreground">
                            {task.reconciledCount} of {task.discrepancyCount} resolved
                          </span>
                          <Link
                            href={`/reconcile/${task.projectId}?batchId=${task.batchId}&releaseId=${task.releaseId}`}
                            className={PRIMARY_BTN}
                          >
                            Reconcile
                            <ArrowRight className="size-3.5" />
                          </Link>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </section>

            {/* As adjudicator */}
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <Gavel className="size-4 text-status-active-text" />
                <h2 className="text-sm font-semibold">As adjudicator</h2>
                <Badge variant="outline" className="text-[10px]">
                  {adjudicateTasks.length}
                </Badge>
              </div>
              {adjudicateTasks.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                  No items escalated to you for adjudication.
                </p>
              ) : (
                <div className="space-y-3">
                  {adjudicateTasks.map((task) => (
                    <Card
                      key={task.releaseId}
                      className="transition-all duration-200 hover:shadow-sm hover:ring-1 hover:ring-primary/10"
                    >
                      <CardHeader className="pb-2">
                        <div className="flex items-start justify-between gap-2">
                          <CardTitle className="text-base">{task.batchName}</CardTitle>
                          <Badge
                            variant="outline"
                            className="bg-status-active-bg text-status-active-text"
                          >
                            {task.count} to adjudicate
                          </Badge>
                        </div>
                        <CardDescription>
                          {task.projectName} · {task.teamName}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <p className="mb-3 text-xs text-muted-foreground">
                          {task.criteria.join(' · ')}
                        </p>
                        <div className="flex justify-end">
                          <Link href="/adjudicate" className={OUTLINE_BTN}>
                            <Gavel className="size-3.5" />
                            Adjudicate
                          </Link>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </AppShell>
  )
}
