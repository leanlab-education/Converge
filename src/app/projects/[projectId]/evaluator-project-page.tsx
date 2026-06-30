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
import { ArrowRight, Layers, Scale, Users, Gavel, CheckCircle2 } from 'lucide-react'
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
  // 'RECONCILING' = action needed; 'COMPLETE' = already reconciled, editable
  // until an admin locks the batch.
  status: string
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
  const [section, setSection] = useState<'scoring' | 'reconciliation'>('scoring')
  const [reconcileSub, setReconcileSub] = useState<'team' | 'adjudicator'>('team')

  const totalItems = batches.reduce((sum, b) => sum + b.itemCount, 0)
  const totalScored = batches.reduce((sum, b) => sum + b.scoredCount, 0)
  const overallPct = totalItems > 0 ? Math.round((totalScored / totalItems) * 100) : 0
  // Only releases still actively reconciling count as pending work; completed
  // (editable) ones are shown but don't drive the "to do" badge/banner.
  const pendingReconcileCount = reconcileTasks.filter(
    (t) => t.status === 'RECONCILING'
  ).length
  const reconciliationCount = pendingReconcileCount + adjudicateTasks.length

  return (
    <AppShell
      projectContext={{
        id: project.id,
        name: project.name,
        activeTab: section,
        onTabChange: (tab) => setSection(tab as 'scoring' | 'reconciliation'),
        hideGlobalNav: true,
        subNav: [
          { value: 'scoring', label: 'Scoring', icon: <Layers className="size-3.5 shrink-0" /> },
          {
            value: 'reconciliation',
            label: 'Reconciliation',
            icon: <Scale className="size-3.5 shrink-0" />,
            badge: reconciliationCount,
          },
        ],
      }}
    >
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
        {section === 'scoring' ? (
          <>
            <div className="mb-6">
              <h1 className="text-2xl font-bold tracking-tight">Scoring</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Score your assigned batches for {project.name}.
              </p>
              {totalItems > 0 && (
                <div className="mt-4 flex items-center gap-3">
                  <Progress value={overallPct} className="flex-1" />
                  <span className="text-sm text-muted-foreground">
                    {totalScored}/{totalItems} scored
                  </span>
                </div>
              )}
            </div>

            {reconciliationCount > 0 && (
              <button
                onClick={() => setSection('reconciliation')}
                className="mb-5 flex w-full items-center justify-between gap-3 rounded-xl border border-status-reconciliation-text/20 bg-status-reconciliation-bg/60 px-4 py-3 text-left transition-all duration-200 hover:bg-status-reconciliation-bg"
              >
                <div className="flex items-center gap-2.5">
                  <Scale className="size-4 shrink-0 text-status-reconciliation-text" />
                  <span className="text-sm font-medium text-foreground">
                    You have{' '}
                    {[
                      pendingReconcileCount > 0 ? `${pendingReconcileCount} to reconcile` : null,
                      adjudicateTasks.length > 0 ? `${adjudicateTasks.length} to adjudicate` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-status-reconciliation-text">
                  Go to Reconciliation
                  <ArrowRight className="size-3.5" />
                </span>
              </button>
            )}

            {batches.length === 0 ? (
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
                              isReconciling
                                ? 'bg-status-reconciliation-bg text-status-reconciliation-text'
                                : batchComplete
                                  ? 'bg-status-complete-bg text-status-complete-text'
                                  : isScoring
                                    ? 'bg-status-active-bg text-status-active-text'
                                    : 'text-muted-foreground'
                            }
                          >
                            {isReconciling ? 'Reconciling' : batchComplete ? 'Complete' : isScoring ? 'Open' : 'Not Open'}
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
                            <Button size="sm" onClick={() => setSection('reconciliation')}>
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
            )}
          </>
        ) : (
          <>
            <div className="mb-5">
              <h1 className="text-2xl font-bold tracking-tight">Reconciliation</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Resolve discrepancies with your partner, and adjudicate the groups
                you cover.
              </p>
            </div>

            {/* Sub-tabs: your own team vs. adjudicating for another */}
            <div className="mb-5 flex items-center gap-1 border-b border-border">
              <SubTab
                active={reconcileSub === 'team'}
                onClick={() => setReconcileSub('team')}
                icon={<Users className="size-3.5" />}
                label="Your team"
                count={reconcileTasks.length}
              />
              <SubTab
                active={reconcileSub === 'adjudicator'}
                onClick={() => setReconcileSub('adjudicator')}
                icon={<Gavel className="size-3.5" />}
                label="As adjudicator"
                count={adjudicateTasks.length}
              />
            </div>

            {reconcileSub === 'team' ? (
              reconcileTasks.length === 0 ? (
                <EmptyReconcile
                  message="No discrepancies waiting on you and your partner. They show up here once you both finish a double-scored batch."
                />
              ) : (
                <div className="space-y-3">
                  {reconcileTasks.map((task) => {
                    const isReconciled = task.status === 'COMPLETE'
                    return (
                    <Card
                      key={task.releaseId}
                      className="transition-all duration-200 hover:shadow-sm hover:ring-1 hover:ring-primary/10"
                    >
                      <CardHeader className="pb-2">
                        <div className="flex items-start justify-between gap-2">
                          <CardTitle className="text-base">{task.batchName}</CardTitle>
                          {isReconciled ? (
                            <Badge variant="outline" className="bg-status-complete-bg text-status-complete-text">
                              Reconciled
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="bg-status-reconciliation-bg text-status-reconciliation-text">
                              Reconciling
                            </Badge>
                          )}
                        </div>
                        <CardDescription>
                          {task.partnerName ? `with ${task.partnerName}` : 'Double-scored'}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <p className="mb-3 text-xs text-muted-foreground">{task.criteria.join(' · ')}</p>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm text-muted-foreground">
                            {isReconciled
                              ? `All ${task.discrepancyCount} resolved`
                              : `${task.reconciledCount} of ${task.discrepancyCount} resolved`}
                          </span>
                          <Button
                            size="sm"
                            variant={isReconciled ? 'outline' : 'default'}
                            onClick={() =>
                              router.push(
                                `/reconcile/${project.id}?batchId=${task.batchId}&releaseId=${task.releaseId}`
                              )
                            }
                          >
                            {isReconciled ? 'Review / Edit' : 'Reconcile'}
                            <ArrowRight className="size-3.5" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                    )
                  })}
                </div>
              )
            ) : adjudicateTasks.length === 0 ? (
              <EmptyReconcile message="Nothing escalated to you for adjudication. When a pair can't agree on a criterion you cover, it lands here." />
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
                        <Button size="sm" variant="outline" onClick={() => router.push('/adjudicate')}>
                          <Gavel className="size-3.5" />
                          Adjudicate
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  )
}

function SubTab({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  count: number
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
      {icon}
      {label}
      {count > 0 && (
        <Badge variant="outline" className="text-[10px]">{count}</Badge>
      )}
    </button>
  )
}

function EmptyReconcile({ message }: { message: string }) {
  return (
    <div className="py-12 text-center">
      <CheckCircle2 className="mx-auto h-10 w-10 text-success/60" />
      <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground">{message}</p>
    </div>
  )
}
