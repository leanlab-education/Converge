'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ChevronRight, Eye, EyeOff, Loader2, Plus } from 'lucide-react'
import { batchStatusColors, batchStatusLabels } from '@/lib/status-colors'
import { cn } from '@/lib/utils'
import { TeamAvatar, UserAvatar } from '@/components/user-avatar'
import { displayAnnotatorName } from '@/lib/generate-name'

interface DimensionIRR {
  dimensionId: string
  dimensionLabel: string
  agreementPct: number | null
  agreedPairs: number
  totalPairs: number
}

interface TeamReleaseRow {
  id: string
  teamId: string
  teamName: string
  isVisible: boolean
  status: string
  scorerUserId: string | null
  adjudicatorId: string | null
  scorer: { id: string; email: string; name: string | null } | null
  members: { id: string; email: string; name: string | null }[]
  dimensions: { id: string; label: string }[]
  progressPct: number
  irr?: {
    isApplicable: boolean
    isReady: boolean
    agreementPct: number | null
    agreedPairs: number
    totalPairs: number
    perDimension: DimensionIRR[]
  } | null
}

interface BatchRangeRow {
  id: string
  startFeedbackId: string
  endFeedbackId: string
  itemCount: number
}

interface BatchRow {
  id: string
  name: string
  activityId: string | null
  conjunctionId: string | null
  status: string
  itemCount: number
  progressPct: number
  discrepancyCount?: number
  reconciledCount?: number
  irrSummary?: {
    applicableTeamCount: number
    computedTeamCount: number
    readyTeamCount: number
    averageAgreementPct: number | null
    lowestAgreementPct: number | null
    perDimension: DimensionIRR[]
  } | null
  type: string
  isDoubleScored: boolean
  canEditBatchType?: boolean
  isHidden?: boolean
  ranges: BatchRangeRow[]
  teamReleases: TeamReleaseRow[]
}

interface EvaluatorOption {
  userId: string
  user: { id: string; name: string | null; email: string }
}

interface Props {
  projectId: string
  evaluators: EvaluatorOption[]
  batches: BatchRow[]
  onBatchesChange: (options?: { silent?: boolean }) => void | Promise<void>
  batchesLoading: boolean
  usePseudonyms?: boolean
}

function getIrrColorClass(pct: number | null) {
  if (pct == null) return 'text-muted-foreground'
  if (pct >= 80) return 'text-score-high-text'
  if (pct >= 70) return 'text-status-active-text'
  return 'text-destructive'
}

const BATCH_GRID_COLS = '44px 1fr 84px 124px 78px 160px'

export function BatchCreator({
  projectId,
  evaluators,
  batches,
  onBatchesChange,
  batchesLoading,
  usePseudonyms = true,
}: Props) {
  const [localBatches, setLocalBatches] = useState<BatchRow[]>(batches)
  const [filterActivity, setFilterActivity] = useState('')
  const [filterConjunction, setFilterConjunction] = useState('')
  const [expandedBatches, setExpandedBatches] = useState<Set<string>>(new Set())

  useEffect(() => {
    setLocalBatches(batches)
  }, [batches])

  const batchActivityIds = useMemo(
    () => [...new Set(localBatches.map((batch) => batch.activityId).filter(Boolean) as string[])].sort(),
    [localBatches]
  )
  const batchConjunctionIds = useMemo(
    () =>
      [
        ...new Set(
          localBatches
            .filter((batch) => (filterActivity ? batch.activityId === filterActivity : true))
            .map((batch) => batch.conjunctionId)
            .filter(Boolean) as string[]
        ),
      ].sort(),
    [localBatches, filterActivity]
  )

  const filteredBatches = localBatches.filter((batch) => {
    if (filterActivity && batch.activityId !== filterActivity) return false
    if (filterConjunction && batch.conjunctionId !== filterConjunction) return false
    return true
  })

  function toggleExpanded(batchId: string) {
    setExpandedBatches((previous) => {
      const next = new Set(previous)
      if (next.has(batchId)) next.delete(batchId)
      else next.add(batchId)
      return next
    })
  }

  async function handleBatchTypeChange(
    batchId: string,
    mode: 'TRAINING' | 'REGULAR_DOUBLE' | 'REGULAR_SINGLE'
  ) {
    const previousBatches = localBatches
    const patch =
      mode === 'TRAINING'
        ? { type: 'TRAINING' as const, isDoubleScored: false }
        : {
            type: 'REGULAR' as const,
            isDoubleScored: mode === 'REGULAR_DOUBLE',
          }

    setLocalBatches((current) =>
      current.map((batch) =>
        batch.id === batchId ? { ...batch, ...patch } : batch
      )
    )

    try {
      const response = await fetch(`/api/projects/${projectId}/batches/${batchId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })

      if (response.ok) {
        await onBatchesChange({ silent: true })
      } else {
        const payload = await response.json().catch(() => null)
        setLocalBatches(previousBatches)
        alert(payload?.error || 'Failed to update batch type')
      }
    } catch (error) {
      setLocalBatches(previousBatches)
      console.error('Failed to update batch type:', error)
      alert('Something went wrong while updating the batch type.')
    }
  }

  async function handleReleaseBatch(batchId: string, release: boolean) {
    if (
      !release &&
      !confirm('Unpublish this batch? It will be hidden from annotators and returned to draft.')
    ) {
      return
    }
    try {
      const response = await fetch(
        `/api/projects/${projectId}/batches/${batchId}/release`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ release }),
        }
      )
      if (response.ok) {
        await onBatchesChange()
      } else {
        const payload = await response.json().catch(() => null)
        alert(payload?.error || 'Failed to update batch release status')
      }
    } catch (error) {
      console.error('Failed to update batch release status:', error)
      alert('Something went wrong while updating the batch release status.')
    }
  }

  async function handleDeleteBatch(batchId: string) {
    if (!confirm('Delete this batch? Items will return to the unbatched pool.')) return
    try {
      const response = await fetch(`/api/projects/${projectId}/batches/${batchId}`, {
        method: 'DELETE',
      })
      if (response.ok) {
        await onBatchesChange()
      }
    } catch (error) {
      console.error('Failed to delete batch:', error)
    }
  }

  async function handleUpdateTeamRelease(
    batchId: string,
    releaseId: string,
    patch: { isVisible?: boolean; scorerUserId?: string | null; adjudicatorId?: string | null }
  ) {
    const previousBatches = localBatches
    setLocalBatches((current) =>
      current.map((batch) =>
        batch.id !== batchId
          ? batch
          : {
              ...batch,
              teamReleases: batch.teamReleases.map((release) =>
                release.id !== releaseId ? release : { ...release, ...patch }
              ),
            }
      )
    )

    try {
      const response = await fetch(
        `/api/projects/${projectId}/batches/${batchId}/releases/${releaseId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        }
      )
      if (response.ok) {
        await onBatchesChange({ silent: true })
      } else {
        setLocalBatches(previousBatches)
      }
    } catch (error) {
      setLocalBatches(previousBatches)
      console.error('Failed to update team release:', error)
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Batches</h2>
          <p className="text-sm text-muted-foreground">
            Create batches from feedback ID ranges, then release them to teams on your schedule.
          </p>
        </div>
        <Link
          href={`/admin/${projectId}/batches/new`}
          className={cn(buttonVariants({ variant: 'default' }), 'rounded-xl')}
        >
          <Plus className="mr-2 h-4 w-4" />
          Create Batch
        </Link>
      </div>

      {/* Filters */}
      {localBatches.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">Filter:</span>
          <select
            className="h-9 rounded-xl border border-border/70 bg-background px-3 text-sm transition-all duration-200 hover:border-border focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            value={filterActivity}
            onChange={(event) => {
              setFilterActivity(event.target.value)
              setFilterConjunction('')
            }}
          >
            <option value="">All activities</option>
            {batchActivityIds.map((activityId) => (
              <option key={activityId} value={activityId}>
                Activity {activityId}
              </option>
            ))}
          </select>
          <select
            className="h-9 rounded-xl border border-border/70 bg-background px-3 text-sm transition-all duration-200 hover:border-border focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            value={filterConjunction}
            onChange={(event) => setFilterConjunction(event.target.value)}
          >
            <option value="">All conjunctions</option>
            {batchConjunctionIds.map((conjunctionId) => (
              <option key={conjunctionId} value={conjunctionId}>
                {conjunctionId}
              </option>
            ))}
          </select>
          {(filterActivity || filterConjunction) && (
            <span className="text-xs text-muted-foreground">
              {filteredBatches.length} of {localBatches.length} batches
            </span>
          )}
        </div>
      )}

      {/* Batch list */}
      {batchesLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : localBatches.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No batches created yet. Use the full-screen builder to create your first batch from feedback ID ranges.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          {/* Column headers */}
          <div
            className="grid items-center border-b border-border/60 bg-muted/30 px-3 py-2"
            style={{ gridTemplateColumns: BATCH_GRID_COLS }}
          >
            <span />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Batch</span>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Type</span>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Status</span>
            <span className="text-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">IRR</span>
            <span className="pl-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Progress</span>
          </div>

          {filteredBatches.map((batch, index) => {
            const isExpanded = expandedBatches.has(batch.id)
            const isComplete = batch.status === 'COMPLETE'
            const assignmentLabel =
              batch.type === 'TRAINING'
                ? 'Training'
                : batch.isDoubleScored
                  ? 'Double'
                  : 'Single'
            const assignmentBadgeClass =
              batch.type === 'TRAINING'
                ? 'bg-status-active-bg text-status-active-text'
                : batch.isDoubleScored
                  ? 'bg-score-high-bg text-score-high-text'
                  : 'bg-muted text-muted-foreground'
            const irrSummary = batch.irrSummary
            const avgIrr = irrSummary?.averageAgreementPct ?? null
            const lowIrr = irrSummary?.lowestAgreementPct ?? null
            const isIrrEligible = batch.type === 'REGULAR' && batch.isDoubleScored
            const hasIrr = isIrrEligible && (irrSummary?.applicableTeamCount ?? 0) > 0
            const batchModeValue =
              batch.type === 'TRAINING'
                ? 'TRAINING'
                : batch.isDoubleScored
                  ? 'REGULAR_DOUBLE'
                  : 'REGULAR_SINGLE'

            // Release state: a batch is "released" when every team release is
            // visible to annotators. Per-team toggles can leave it partial.
            const releaseCount = batch.teamReleases.length
            const visibleReleaseCount = batch.teamReleases.filter(
              (r) => r.isVisible
            ).length
            const isReleased =
              releaseCount > 0 && visibleReleaseCount === releaseCount
            const isPartiallyReleased =
              visibleReleaseCount > 0 && visibleReleaseCount < releaseCount

            return (
              <div
                key={batch.id}
                className={cn(
                  index > 0 ? 'border-t border-border/60' : '',
                  isComplete ? 'opacity-60' : ''
                )}
              >
                {/* Collapsed row */}
                <div
                  className="grid cursor-pointer items-center px-3 py-2.5 transition-colors duration-150 hover:bg-muted/40"
                  style={{ gridTemplateColumns: BATCH_GRID_COLS }}
                  onClick={() => toggleExpanded(batch.id)}
                >
                  <div className="flex items-center">
                    <ChevronRight
                      className={cn(
                        'h-3.5 w-3.5 text-muted-foreground/60 transition-transform duration-200',
                        isExpanded && 'rotate-90'
                      )}
                    />
                  </div>

                  <div className="min-w-0 pr-3">
                    <span className="truncate text-sm font-medium">{batch.name}</span>
                  </div>

                  <div>
                    <Badge className={cn(assignmentBadgeClass, 'text-[10px]')}>
                      {assignmentLabel}
                    </Badge>
                  </div>

                  <div>
                    <Badge className={cn(batchStatusColors[batch.status] || '', 'text-[10px]')}>
                      {batchStatusLabels[batch.status] || batch.status}
                    </Badge>
                  </div>

                  <div className="text-center">
                    {hasIrr ? (
                      <>
                        <div className={cn('text-sm font-bold leading-tight', getIrrColorClass(avgIrr))}>
                          {avgIrr != null ? `${avgIrr}%` : '—'}
                        </div>
                        {lowIrr != null && (
                          <div className={cn('text-[10px] leading-tight', getIrrColorClass(lowIrr))}>
                            low {lowIrr}%
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-sm text-muted-foreground/30">—</span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 pl-2 pr-1">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all duration-300',
                          isComplete ? 'bg-muted-foreground/40' : 'bg-primary'
                        )}
                        style={{ width: `${batch.progressPct}%` }}
                      />
                    </div>
                    <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
                      {batch.progressPct}%
                    </span>
                  </div>
                </div>

                {/* Expanded content */}
                {isExpanded && (
                  <div className="space-y-3 border-t border-border/50 bg-muted/20 px-4 py-3">
                    {/* Release / publish control */}
                    <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background px-3 py-2.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold">
                            {isReleased
                              ? 'Released'
                              : isPartiallyReleased
                                ? 'Partially released'
                                : 'Draft'}
                          </span>
                          <span
                            className={cn(
                              'size-1.5 rounded-full',
                              isReleased
                                ? 'bg-score-high-solid'
                                : isPartiallyReleased
                                  ? 'bg-status-active-text'
                                  : 'bg-muted-foreground/40'
                            )}
                          />
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          {isReleased
                            ? 'Visible to annotators — they can score this batch.'
                            : isPartiallyReleased
                              ? `Visible to ${visibleReleaseCount} of ${releaseCount} teams. Release the rest to publish to everyone.`
                              : 'Hidden from annotators. Release to make it available for scoring.'}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {!isReleased && (
                          <Button
                            size="sm"
                            className="h-8 rounded-lg text-xs"
                            disabled={releaseCount === 0}
                            onClick={() => handleReleaseBatch(batch.id, true)}
                          >
                            <Eye className="size-3.5" />
                            {isPartiallyReleased ? 'Release to all teams' : 'Release batch'}
                          </Button>
                        )}
                        {(isReleased || isPartiallyReleased) && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => handleReleaseBatch(batch.id, false)}
                          >
                            <EyeOff className="size-3.5" />
                            Unpublish
                          </Button>
                        )}
                      </div>
                    </div>

                    {batch.canEditBatchType && (
                      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5">
                        <div className="min-w-0">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            Batch Type
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            Editable until scoring starts.
                          </p>
                        </div>
                        <select
                          className="h-8 rounded-lg border border-border/70 bg-background px-2 text-xs transition-all duration-200 hover:border-border"
                          value={batchModeValue}
                          onChange={(event) =>
                            handleBatchTypeChange(
                              batch.id,
                              event.target.value as
                                | 'TRAINING'
                                | 'REGULAR_DOUBLE'
                                | 'REGULAR_SINGLE'
                            )
                          }
                        >
                          <option value="TRAINING">Training</option>
                          <option value="REGULAR_DOUBLE">Double-scored</option>
                          <option value="REGULAR_SINGLE">Single-scored</option>
                        </select>
                        {!isIrrEligible && (
                          <span className="text-[11px] text-muted-foreground">
                            IRR only applies to double-scored batches.
                          </span>
                        )}
                      </div>
                    )}

                    {/* Batch-level IRR breakdown by criterion */}
                    {hasIrr && (irrSummary?.perDimension.length ?? 0) > 0 && (
                      <div className="rounded-xl border border-border bg-background px-3 py-2.5">
                        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          IRR by criterion
                        </p>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                          {irrSummary!.perDimension.map((dim) => (
                            <div
                              key={dim.dimensionId}
                              className="flex items-center justify-between gap-2 text-[11px]"
                            >
                              <span className="truncate text-muted-foreground" title={dim.dimensionLabel}>
                                {dim.dimensionLabel}
                              </span>
                              <span
                                className={cn(
                                  'shrink-0 font-bold tabular-nums',
                                  getIrrColorClass(dim.agreementPct)
                                )}
                                title={`${dim.agreedPairs}/${dim.totalPairs} agreed`}
                              >
                                {dim.agreementPct != null ? `${dim.agreementPct}%` : '—'}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {batch.teamReleases.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
                        No team assignments found for this batch.
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        {batch.teamReleases.map((release) => (
                          <div
                            key={release.id}
                            className="rounded-xl border border-border bg-background px-3 py-2.5"
                          >
                            {/* Team header: avatar + generated name + IRR */}
                            <div className="mb-2 flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <TeamAvatar name={release.teamId} size={26} />
                                <span className="text-xs font-semibold truncate capitalize">
                                  {release.teamName}
                                </span>
                              </div>
                              {release.irr?.isApplicable && (
                                <span className={cn('text-sm font-bold leading-none shrink-0', getIrrColorClass(release.irr.agreementPct))}>
                                  {release.irr.agreementPct != null ? `${release.irr.agreementPct}%` : '—'}
                                </span>
                              )}
                            </div>
                            {/* Member avatars with generated names */}
                            <div className="flex flex-wrap gap-1.5 mb-2">
                              {release.members.map((m) => (
                                <div key={m.id} className="flex items-center gap-1">
                                  <UserAvatar name={m.id} size={18} />
                                  <span className="text-[10px] text-muted-foreground capitalize">
                                    {displayAnnotatorName(m.id, m.name, usePseudonyms)}
                                  </span>
                                </div>
                              ))}
                            </div>
                            {/* Criteria, with per-criterion IRR once scores exist */}
                            {release.irr?.isApplicable &&
                            release.irr.perDimension.length > 0 ? (
                              <div className="mb-2 space-y-0.5">
                                {release.irr.perDimension.map((dim) => (
                                  <div
                                    key={dim.dimensionId}
                                    className="flex items-center justify-between gap-2 text-[10px]"
                                  >
                                    <span className="truncate text-muted-foreground/60" title={dim.dimensionLabel}>
                                      {dim.dimensionLabel}
                                    </span>
                                    <span
                                      className={cn(
                                        'shrink-0 font-semibold tabular-nums',
                                        getIrrColorClass(dim.agreementPct)
                                      )}
                                      title={`${dim.agreedPairs}/${dim.totalPairs} agreed`}
                                    >
                                      {dim.agreementPct != null ? `${dim.agreementPct}%` : '—'}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="mb-2 truncate text-[10px] text-muted-foreground/60">
                                {batch.type === 'TRAINING'
                                  ? 'All criteria'
                                  : release.dimensions.map((d) => d.label).join(', ')}
                              </div>
                            )}
                            {/* Footer: status + visible toggle */}
                            <div className="flex items-center justify-between">
                              <Badge className={cn(batchStatusColors[release.status] || '', 'text-[10px]')}>
                                {batchStatusLabels[release.status] || release.status}
                              </Badge>
                              <button
                                onClick={() =>
                                  handleUpdateTeamRelease(batch.id, release.id, {
                                    isVisible: !release.isVisible,
                                  })
                                }
                                className={cn(
                                  'flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-all duration-200',
                                  release.isVisible
                                    ? 'bg-primary/10 text-primary ring-1 ring-primary/20 hover:bg-primary/15'
                                    : 'bg-muted text-muted-foreground ring-1 ring-border hover:bg-muted/80'
                                )}
                              >
                                {release.isVisible
                                  ? <Eye className="size-2.5" />
                                  : <EyeOff className="size-2.5" />
                                }
                                {release.isVisible ? 'Visible' : 'Hidden'}
                              </button>
                            </div>
                            {/* Per-team adjudicator — tiebreaker for this team's escalated discrepancies */}
                            {batch.type === 'REGULAR' && batch.isDoubleScored && (
                              <div className="mt-2 flex items-center gap-1.5 border-t border-border/40 pt-2 text-[10px]">
                                <span className="shrink-0 text-muted-foreground">Adjudicator:</span>
                                <select
                                  className="h-6 min-w-0 flex-1 rounded-md border border-border/70 bg-background px-1.5 text-[10px] transition-all duration-200 hover:border-border"
                                  value={release.adjudicatorId ?? ''}
                                  onChange={(event) =>
                                    handleUpdateTeamRelease(batch.id, release.id, {
                                      adjudicatorId: event.target.value || null,
                                    })
                                  }
                                >
                                  <option value="">— None —</option>
                                  {evaluators.map((evaluator) => (
                                    <option key={evaluator.user.id} value={evaluator.user.id}>
                                      {evaluator.user.name || evaluator.user.email}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {batch.status === 'DRAFT' && (
                      <div className="flex justify-end">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 rounded-lg px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => handleDeleteBatch(batch.id)}
                        >
                          Delete batch
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
