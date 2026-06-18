'use client'

import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import {
  AlertTriangle, ArrowRight, BarChart3, CheckCircle2,
  FileText, Layers,
} from 'lucide-react'
import { UserAvatar } from '@/components/user-avatar'
import { displayAnnotatorName } from '@/lib/generate-name'
import { batchStatusColors, batchStatusLabels } from '@/lib/status-colors'

// ---------------------------------------------------------------------------
// Types (minimal subset of what we need from project-detail-client)
// ---------------------------------------------------------------------------

interface RubricDimension { id: string }

interface Project {
  id: string
  _count: { feedbackItems: number; evaluators: number }
  rubric: RubricDimension[]
}

interface EvaluatorRow {
  id: string
  user: { id: string; name: string | null; email: string }
  assignedCount: number
  completedCount: number
  lastScoredAt: string | null
}

interface IrrPerDimension {
  dimensionId: string
  dimensionLabel: string
  agreementPct: number | null
  agreedPairs: number
  totalPairs: number
}

interface IrrSummary {
  averageAgreementPct: number | null
  lowestAgreementPct: number | null
  perDimension?: IrrPerDimension[]
}

interface BatchRow {
  id: string
  name: string
  activityId: string | null
  status: string
  progressPct: number
  type: string
  isDoubleScored: boolean
  irrSummary?: IrrSummary | null
}

interface OverviewTabProps {
  project: Project
  scoredItemCount: number
  evaluators: EvaluatorRow[]
  batches: BatchRow[]
  projectId: string
  onNavigateToTab: (tab: string) => void
  onImportData: () => void
  usePseudonyms: boolean
  onTogglePseudonyms: (value: boolean) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function getIrrColorClass(pct: number | null): string {
  if (pct == null) return 'text-muted-foreground'
  if (pct >= 80) return 'text-score-high-text'
  if (pct >= 70) return 'text-status-active-text'
  return 'text-destructive'
}

function ColoredStatCard({
  label, value, sub, icon: Icon, accent,
}: {
  label: string
  value: string | number
  sub?: string
  icon: React.ElementType
  accent: 'primary' | 'success' | 'reconciling' | 'setup'
}) {
  const accentMap = {
    primary:     { bg: 'bg-primary/10',                 icon: 'text-primary' },
    success:     { bg: 'bg-status-active-bg',            icon: 'text-status-active-text' },
    reconciling: { bg: 'bg-status-reconciliation-bg',    icon: 'text-status-reconciliation-text' },
    setup:       { bg: 'bg-status-setup-bg',             icon: 'text-status-setup-text' },
  }
  const { bg, icon: iconColor } = accentMap[accent]
  return (
    <Card className="transition-all duration-200 hover:shadow-sm">
      <CardContent className="pt-3 pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</p>
            <p className="text-xl font-bold mt-0.5 text-foreground">{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-0">{sub}</p>}
          </div>
          <div className={`shrink-0 rounded-lg p-1.5 ${bg}`}>
            <Icon className={`h-3.5 w-3.5 ${iconColor}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function ClickableAlert({
  type, title, body, linkLabel, onClick,
}: {
  type: 'error' | 'warning'
  title: string
  body: string
  linkLabel: string
  onClick: () => void
}) {
  const isError = type === 'error'
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
      className={`
        group flex items-start justify-between gap-4 rounded-lg border px-4 py-3.5 cursor-pointer
        transition-all duration-200 hover:shadow-sm
        ${isError
          ? 'border-destructive/30 bg-destructive/5 hover:border-destructive/50'
          : 'border-status-setup-text/25 bg-status-setup-bg hover:border-status-setup-text/40'}
      `}
    >
      <div className="flex items-start gap-3 min-w-0">
        <AlertTriangle className={`h-4 w-4 mt-0.5 shrink-0 ${isError ? 'text-destructive' : 'text-status-setup-text'}`} />
        <div className="min-w-0">
          <p className={`text-sm font-medium ${isError ? 'text-destructive' : 'text-status-setup-text'}`}>{title}</p>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{body}</p>
        </div>
      </div>
      <div className={`
        flex items-center gap-1 shrink-0 text-xs font-medium whitespace-nowrap transition-all duration-200
        ${isError ? 'text-destructive/70 group-hover:text-destructive' : 'text-status-setup-text/70 group-hover:text-status-setup-text'}
      `}>
        {linkLabel}
        <ArrowRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function OverviewTab({
  project,
  scoredItemCount,
  evaluators,
  batches,
  onNavigateToTab,
  usePseudonyms,
  onTogglePseudonyms,
}: OverviewTabProps) {
  const totalItems = project._count.feedbackItems
  const completionPct = totalItems > 0 ? Math.round((scoredItemCount / totalItems) * 100) : 0
  const activeBatchCount = batches.filter(b => b.status === 'SCORING' || b.status === 'RECONCILING').length

  const lowIrrBatches = batches.filter(b =>
    b.status === 'RECONCILING' &&
    b.type === 'REGULAR' &&
    b.isDoubleScored &&
    b.irrSummary?.averageAgreementPct != null &&
    b.irrSummary.averageAgreementPct < 80
  )

  const stalledAnnotators = evaluators.filter(ev => {
    const pct = ev.assignedCount > 0 ? Math.round((ev.completedCount / ev.assignedCount) * 100) : 0
    return pct < 50 && ev.assignedCount > 0
  })

  // Global per-criterion IRR: pair-weighted exact-match agreement summed across
  // every double-scored batch (Σ agreed / Σ total per criterion). Ordered by the
  // project's rubric order.
  const dimOrder = new Map(project.rubric.map((d, i) => [d.id, i]))
  const globalDimAgg = new Map<string, { label: string; agreed: number; total: number }>()
  for (const batch of batches) {
    for (const dim of batch.irrSummary?.perDimension ?? []) {
      const entry = globalDimAgg.get(dim.dimensionId) ?? {
        label: dim.dimensionLabel,
        agreed: 0,
        total: 0,
      }
      entry.agreed += dim.agreedPairs
      entry.total += dim.totalPairs
      globalDimAgg.set(dim.dimensionId, entry)
    }
  }
  const globalIrrRows = Array.from(globalDimAgg.entries())
    .sort((a, b) => (dimOrder.get(a[0]) ?? 99) - (dimOrder.get(b[0]) ?? 99))
    .map(([dimensionId, e]) => ({
      dimensionId,
      label: e.label,
      agreedPairs: e.agreed,
      totalPairs: e.total,
      agreementPct: e.total > 0 ? Math.round((e.agreed / e.total) * 100) : null,
    }))
  const hasGlobalIrr = globalIrrRows.some((r) => r.totalPairs > 0)

  const STATUS_ORDER: Record<string, number> = { RECONCILING: 0, SCORING: 1, COMPLETE: 2, DRAFT: 3 }
  const activeBatchRows = [...batches]
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 4) - (STATUS_ORDER[b.status] ?? 4))
    .slice(0, 8)

  return (
    <div className="space-y-6">

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ColoredStatCard label="Total Items"    value={totalItems.toLocaleString()} icon={FileText}     accent="primary" />
        <ColoredStatCard label="Scored"         value={scoredItemCount.toLocaleString()} sub={`of ${totalItems.toLocaleString()}`} icon={CheckCircle2} accent="success" />
        <ColoredStatCard label="Completion"     value={`${completionPct}%`}             icon={BarChart3}   accent="reconciling" />
        <ColoredStatCard label="Active Batches" value={activeBatchCount}                sub="scoring or reconciling" icon={Layers} accent="setup" />
      </div>

      {/* Needs Attention */}
      {(lowIrrBatches.length > 0 || stalledAnnotators.length > 0) && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Needs Attention</h3>
          {lowIrrBatches.length > 0 && (
            <ClickableAlert
              type="error"
              title={`${lowIrrBatches.length} ${lowIrrBatches.length === 1 ? 'batch has' : 'batches have'} IRR below 80%`}
              body={`${lowIrrBatches.map(b => b.name).join(', ')} ${lowIrrBatches.length === 1 ? 'is' : 'are'} in reconciliation with low agreement`}
              linkLabel="View in Batches"
              onClick={() => onNavigateToTab('batches')}
            />
          )}
          {stalledAnnotators.length > 0 && (
            <ClickableAlert
              type="warning"
              title={`${stalledAnnotators.length} ${stalledAnnotators.length === 1 ? 'annotator' : 'annotators'} below 50% completion`}
              body={stalledAnnotators.map(a => displayAnnotatorName(a.user.id, a.user.name, usePseudonyms)).join(', ') + ' may be falling behind'}
              linkLabel="View Annotators"
              onClick={() => onNavigateToTab('evaluators')}
            />
          )}
        </div>
      )}

      {/* Batches + Annotators side by side */}
      <div className="grid grid-cols-[3fr_2fr] gap-4 items-stretch">

        {/* Batch overview */}
        <Card className="group transition-all duration-200 hover:shadow-sm hover:ring-1 hover:ring-primary/10">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-sm font-semibold">Batches</CardTitle>
                <CardDescription>{batches.length} total · {activeBatchCount} active</CardDescription>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs gap-1 text-muted-foreground h-7 group-hover:text-foreground transition-colors"
                onClick={() => onNavigateToTab('batches')}
              >
                View all <ArrowRight className="h-3 w-3 transition-transform duration-200 group-hover:translate-x-0.5" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pb-5">
            {activeBatchRows.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No batches yet.</p>
            ) : (
              <div className="divide-y divide-border">
                {activeBatchRows.map((batch) => {
                  const irrPct = batch.irrSummary?.averageAgreementPct ?? null
                  const irrLow = irrPct !== null && irrPct < 80
                  return (
                    <div
                      key={batch.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => onNavigateToTab('batches')}
                      onKeyDown={(e) => e.key === 'Enter' && onNavigateToTab('batches')}
                      className="flex items-center gap-3 py-2.5 hover:bg-muted/30 -mx-2 px-2 rounded transition-colors cursor-pointer"
                    >
                      <span className="text-sm font-medium text-foreground w-24 shrink-0 truncate">{batch.name}</span>
                      {batch.activityId && (
                        <span className="text-xs text-muted-foreground w-10 shrink-0">{batch.activityId}</span>
                      )}
                      <Badge className={`text-xs font-medium shrink-0 ${batchStatusColors[batch.status] ?? ''}`}>
                        {batchStatusLabels[batch.status] ?? batch.status}
                      </Badge>
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <Progress value={batch.progressPct} className="h-1.5 flex-1" />
                        <span className="text-xs text-muted-foreground w-7 text-right shrink-0">{batch.progressPct}%</span>
                      </div>
                      {irrPct !== null ? (
                        <span className={`text-xs font-medium shrink-0 w-10 text-right ${irrLow ? 'text-destructive' : 'text-success'}`}>
                          {irrLow && <AlertTriangle className="inline h-3 w-3 mr-0.5 -mt-0.5" />}
                          {Math.round(irrPct)}%
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground shrink-0 w-10 text-right">—</span>
                      )}
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/30 shrink-0" />
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Annotator progress */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-sm font-semibold">Annotator Progress</CardTitle>
                <CardDescription>{evaluators.length} annotators</CardDescription>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs gap-1 text-muted-foreground h-7"
                onClick={() => onNavigateToTab('evaluators')}
              >
                View all <ArrowRight className="h-3 w-3" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pb-4 space-y-3">
            {evaluators.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No annotators yet.</p>
            ) : (
              evaluators.map((ev) => {
                const pct = ev.assignedCount > 0
                  ? Math.round((ev.completedCount / ev.assignedCount) * 100)
                  : 0
                const low = pct < 50 && ev.assignedCount > 0
                return (
                  <div key={ev.id} className="flex items-center gap-3">
                    <UserAvatar name={ev.user.id} size={28} />
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-baseline mb-1">
                        <span className="text-sm font-medium truncate text-foreground">{displayAnnotatorName(ev.user.id, ev.user.name, usePseudonyms)}</span>
                        <span className={`text-xs font-semibold ml-2 shrink-0 ${low ? 'text-destructive' : 'text-muted-foreground'}`}>
                          {pct}%
                        </span>
                      </div>
                      <Progress value={pct} className={`h-1.5 ${low ? '[&>div]:bg-destructive' : ''}`} />
                    </div>
                    {low && <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" />}
                  </div>
                )
              })
            )}
          </CardContent>
        </Card>

      </div>

      {/* Global IRR by criterion */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">IRR by criterion</CardTitle>
          <CardDescription>
            Exact-match agreement across all double-scored batches
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-5">
          {!hasGlobalIrr ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No IRR data yet. Per-criterion IRR appears once annotator pairs
              score a double-scored or training batch.
            </p>
          ) : (
            <div className="space-y-3">
              {globalIrrRows.map((row) => (
                <div key={row.dimensionId} className="flex items-center gap-3">
                  <span className="text-sm font-medium text-foreground w-56 shrink-0 truncate">
                    {row.label}
                  </span>
                  <Progress value={row.agreementPct ?? 0} className="h-1.5 flex-1" />
                  <span className="text-xs text-muted-foreground w-14 text-right shrink-0 tabular-nums">
                    {row.totalPairs > 0 ? `${row.agreedPairs}/${row.totalPairs}` : '—'}
                  </span>
                  <span
                    className={`text-xs font-semibold w-10 text-right shrink-0 ${getIrrColorClass(row.agreementPct)}`}
                  >
                    {row.agreementPct !== null ? `${row.agreementPct}%` : '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Project Settings */}
      <div className="border-t border-border pt-6">
        <h3 className="text-sm font-semibold text-foreground mb-3">Project Settings</h3>
        <div className="flex items-center justify-between rounded-lg border border-border bg-background px-4 py-3">
          <div>
            <p className="text-sm font-medium">Annotator pseudonyms</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Show generated names (e.g. &ldquo;Rustic Panda&rdquo;) instead of real names. Keeps annotators anonymous to each other.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={usePseudonyms}
            onClick={() => onTogglePseudonyms(!usePseudonyms)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              usePseudonyms ? 'bg-primary' : 'bg-muted'
            }`}
          >
            <span
              className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform duration-200 ${
                usePseudonyms ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  )
}
