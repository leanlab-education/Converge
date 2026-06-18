'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { ArrowLeft, ArrowRight, Layers, Users, Gavel, CheckCircle2 } from 'lucide-react'
import { AppShell } from '@/components/app-shell'

interface BatchInfo {
  id: string
  releaseId: string | null
  name: string
  status: string
  itemCount: number
  scoredCount: number
}

interface ReconcileTask {
  releaseId: string
  batchId: string
  batchName: string
  criteria: string[]
  partnerName: string | null
  discrepancyCount: number
  reconciledCount: number
}

interface AdjudicateTask {
  releaseId: string
  batchName: string
  teamName: string
  criteria: string[]
  count: number
}

interface Project {
  id: string
  name: string
  description: string | null
}

export function EvaluatorProjectPage({
  project,
  batches,
  reconcileTasks,
  adjudicateTasks,
}: {
  project: Project
  batches: BatchInfo[]
  reconcileTasks: ReconcileTask[]
  adjudicateTasks: AdjudicateTask[]
  userName: string
}) {
  const router = useRouter()
  const [tab, setTab] = useState<'batches' | 'reconciliation'>('batches')

  const totalItems = batches.reduce((sum, b) => sum + b.itemCount, 0)
  const totalScored = batches.reduce((sum, b) => sum + b.scoredCount, 0)
  const overallPct = totalItems > 0 ? Math.round((totalScored / totalItems) * 100) : 0
  const reconciliationCount = reconcileTasks.length + adjudicateTasks.length

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="mb-6">
          <button
            onClick={() => router.push('/')}
            className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            My Projects
          </button>
          <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
          {project.description && (
            <p className="mt-1 text-sm text-muted-foreground">{project.description}</p>
          )}
          {totalItems > 0 && (
            <div className="mt-4 flex items-center gap-3">
              <Progress value={overallPct} className="flex-1" />
              <span className="text-sm text-muted-foreground">
                {totalScored}/{totalItems} scored
              </span>
            </div>
          )}
        </div>

        {/* Tabs: scoring batches vs. reconciliation work */}
        <div className="mb-5 flex items-center gap-1 border-b border-border">
          <TabButton
            active={tab === 'batches'}
            onClick={() => setTab('batches')}
            label="Batches"
          />
          <TabButton
            active={tab === 'reconciliation'}
            onClick={() => setTab('reconciliation')}
            label="Reconciliation"
            count={reconciliationCount}
          />
        </div>

        {tab === 'batches' ? (
          batches.length === 0 ? (
            <div className="py-12 text-center">
              <Layers className="mx-auto h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-medium">No batches assigned</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                You haven&apos;t been assigned to any batches yet. Check back soon.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {batches.map((batch) => {
                const batchPct =
                  batch.itemCount > 0
                    ? Math.round((batch.scoredCount / batch.itemCount) * 100)
                    : 0
                const batchComplete = batchPct === 100
                const isScoring = batch.status === 'SCORING'
                const isReconciling = batch.status === 'RECONCILING'

                return (
                  <Card key={batch.id} className="transition-all duration-200 hover:shadow-sm hover:ring-1 hover:ring-primary/10">
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-base">{batch.name}</CardTitle>
                        <Badge
                          variant="outline"
                          className={
                            batchComplete
                              ? 'bg-status-complete-bg text-status-complete-text'
                              : isScoring
                                ? 'bg-status-active-bg text-status-active-text'
                                : isReconciling
                                  ? 'bg-status-reconciliation-bg text-status-reconciliation-text'
                                  : 'text-muted-foreground'
                          }
                        >
                          {batchComplete ? 'Complete' : isReconciling ? 'Reconciling' : isScoring ? 'Open' : 'Not Open'}
                        </Badge>
                      </div>
                      <CardDescription>
                        {batch.scoredCount} of {batch.itemCount} items scored
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center gap-3">
                        <Progress value={batchPct} className="flex-1" />
                        {isReconciling ? (
                          <Button
                            size="sm"
                            onClick={() => setTab('reconciliation')}
                          >
                            Reconcile
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant={batchComplete ? 'outline' : 'default'}
                            disabled={!isScoring || batchComplete}
                            onClick={() =>
                              router.push(`/evaluate/${project.id}?batchId=${batch.id}`)
                            }
                          >
                            {batchComplete
                              ? 'Done'
                              : !isScoring
                                ? 'Not Open'
                                : batch.scoredCount > 0
                                  ? 'Continue'
                                  : 'Start'}
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )
        ) : reconciliationCount === 0 ? (
          <div className="py-16 text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-success/60" />
            <h3 className="mt-4 text-lg font-medium">Nothing to reconcile</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Discrepancies show up here once you and your partner finish a
              double-scored batch, along with anything escalated to you to adjudicate.
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {/* With your partner */}
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <Users className="size-4 text-primary" />
                <h2 className="text-sm font-semibold">With your partner</h2>
                <Badge variant="outline" className="text-[10px]">{reconcileTasks.length}</Badge>
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
                          <Badge variant="outline" className="bg-status-reconciliation-bg text-status-reconciliation-text">
                            Reconciling
                          </Badge>
                        </div>
                        <CardDescription>
                          {task.partnerName ? `with ${task.partnerName}` : 'Double-scored'}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <p className="mb-3 text-xs text-muted-foreground">{task.criteria.join(' · ')}</p>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm text-muted-foreground">
                            {task.reconciledCount} of {task.discrepancyCount} resolved
                          </span>
                          <Button
                            size="sm"
                            onClick={() =>
                              router.push(
                                `/reconcile/${project.id}?batchId=${task.batchId}&releaseId=${task.releaseId}`
                              )
                            }
                          >
                            Reconcile
                            <ArrowRight className="size-3.5" />
                          </Button>
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
                <Badge variant="outline" className="text-[10px]">{adjudicateTasks.length}</Badge>
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
                          <Badge variant="outline" className="bg-status-active-bg text-status-active-text">
                            {task.count} to adjudicate
                          </Badge>
                        </div>
                        <CardDescription>{task.teamName}</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <p className="mb-3 text-xs text-muted-foreground">{task.criteria.join(' · ')}</p>
                        <div className="flex justify-end">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => router.push('/adjudicate')}
                          >
                            <Gavel className="size-3.5" />
                            Adjudicate
                          </Button>
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

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  label: string
  count?: number
}) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-200 ${
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      {label}
      {count !== undefined && count > 0 && (
        <Badge variant="outline" className="text-[10px]">{count}</Badge>
      )}
    </button>
  )
}
