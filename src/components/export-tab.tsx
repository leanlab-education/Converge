'use client'

// Export tab.
//
// The three score tables differ along two axes (row grain, raw vs final), so
// they are presented as one question with three answers rather than three cards
// with separately-floating filters — the previous layout put Activity /
// Conjunction above three cards while only two of them honoured it.
//
// Scope controls live *inside* the block they govern. The Discrepancy Report is
// a different kind of artifact (a per-criterion QA comparison scoped to paired
// batches), so it keeps its own section below the divider.

import { useCallback, useEffect, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import {
  BATCH_COLUMNS,
  DISCREPANCY_COLUMNS,
  ITEM_COLUMNS,
  SCORER_COLUMNS,
  SCORER_TRAILING_COLUMNS,
  isItemGrain,
  type ExportKind,
} from '@/lib/export'

interface BatchOption {
  id: string
  name: string
  status: string
  type: string
  isDoubleScored: boolean
  activityId: string | null
  conjunctionId: string | null
}

/** Value of the discrepancy batch picker when the aggregate is selected. */
const ALL_DOUBLE_SCORED = '__all-double-scored__'

const BATCH_STATUS_LABEL: Record<string, string> = {
  SCORING: 'Scoring',
  RECONCILING: 'Reconciling',
  COMPLETE: 'Complete',
}

interface ExportTabProps {
  projectId: string
  rubricLabels: string[]
  batches: BatchOption[]
}

type ScoreTableKind = Extract<
  ExportKind,
  'final-by-item' | 'final-by-scorer' | 'raw-by-scorer'
>

const KIND_OPTIONS: {
  value: ScoreTableKind
  title: string
  description: string
}[] = [
  {
    value: 'final-by-item',
    title: 'Final scores — one row per feedback item',
    description:
      'Every criterion collapsed into a single row per Feedback_ID. The shape to hand off for analysis.',
  },
  {
    value: 'final-by-scorer',
    title: 'Final scores — one row per scoring team',
    description:
      'Each team’s final value for its own criteria. A double-scored pair’s agreed value appears once, not once per annotator.',
  },
  {
    value: 'raw-by-scorer',
    title: 'All raw scores — one row per scorer',
    description:
      'Every score exactly as entered, before reconciliation. The shape to use for inter-rater reliability.',
  },
]

export function ExportTab({
  projectId,
  rubricLabels,
  batches,
}: ExportTabProps) {
  const [kind, setKind] = useState<ScoreTableKind>('final-by-item')
  const [activityId, setActivityId] = useState('')
  const [conjunctionId, setConjunctionId] = useState('')
  const [completeItemsOnly, setCompleteItemsOnly] = useState(false)
  const [finalizedBatchesOnly, setFinalizedBatchesOnly] = useState(false)
  // Discrepancy report selection: the aggregate by default, since that is the
  // file that gets handed off; a single batch is still one click away.
  const [discrepancySelection, setDiscrepancySelection] =
    useState(ALL_DOUBLE_SCORED)
  const [discrepancyCompleteOnly, setDiscrepancyCompleteOnly] = useState(false)


  // The completeness toggles describe a *finished* set of scores, which only
  // has a defined meaning once the row is one item. Rather than silently
  // ignoring them on the scorer-grain exports, they're disabled there.
  const completenessAvailable = isItemGrain(kind)

  const buildParams = useCallback(() => {
    const params = new URLSearchParams({ projectId, type: kind })
    if (activityId) params.set('activityId', activityId)
    if (conjunctionId) params.set('conjunctionId', conjunctionId)
    if (completenessAvailable && completeItemsOnly)
      params.set('completeItemsOnly', '1')
    if (completenessAvailable && finalizedBatchesOnly)
      params.set('finalizedBatchesOnly', '1')
    return params
  }, [
    projectId,
    kind,
    activityId,
    conjunctionId,
    completenessAvailable,
    completeItemsOnly,
    finalizedBatchesOnly,
  ])

  const selectionKey = buildParams().toString()
  const summaryReady = useExportSummary(selectionKey)

  function handleDownload() {
    window.open(`/api/export?${buildParams().toString()}`, '_blank')
  }

  const activityIds = [
    ...new Set(batches.map((b) => b.activityId).filter(Boolean) as string[]),
  ].sort()
  const conjunctionIds = [
    ...new Set(
      batches
        .filter((b) => (activityId ? b.activityId === activityId : true))
        .map((b) => b.conjunctionId)
        .filter(Boolean) as string[]
    ),
  ].sort()

  const columns = isItemGrain(kind)
    ? [...ITEM_COLUMNS, ...BATCH_COLUMNS, ...rubricLabels]
    : [
        ...ITEM_COLUMNS,
        ...SCORER_COLUMNS,
        ...BATCH_COLUMNS,
        ...rubricLabels,
        ...SCORER_TRAILING_COLUMNS,
      ]

  // Only paired batches can have discrepancies: double-scored regular batches
  // and training batches (where every team member scores every item). An
  // independent regular batch has one score per cell, so it never appears.
  const doubleScoredBatches = batches.filter(
    (b) => b.type === 'REGULAR' && b.isDoubleScored && b.status !== 'DRAFT'
  )
  const trainingBatches = batches.filter(
    (b) => b.type === 'TRAINING' && b.status !== 'DRAFT'
  )
  const completeDoubleScoredCount = doubleScoredBatches.filter(
    (b) => b.status === 'COMPLETE'
  ).length

  const isAggregate = discrepancySelection === ALL_DOUBLE_SCORED
  const discrepancyParams = new URLSearchParams({
    projectId,
    type: 'discrepancies',
  })
  if (isAggregate) {
    discrepancyParams.set('batches', 'all-double-scored')
    if (discrepancyCompleteOnly) discrepancyParams.set('completeBatchesOnly', '1')
  } else {
    discrepancyParams.set('batchId', discrepancySelection)
  }
  const discrepancyKey = discrepancyParams.toString()
  const hasPairedBatches =
    doubleScoredBatches.length > 0 || trainingBatches.length > 0
  const discrepancySummary = useExportSummary(
    hasPairedBatches ? discrepancyKey : null
  )

  return (
    <div className="space-y-10">
      {/* ================= Score tables ================= */}
      <section className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold">Export Data</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Download scores as a CSV for analysis or handoff.
          </p>
        </div>

        {/* ---- What to export ---- */}
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">What to export</legend>
          <RadioGroup
            value={kind}
            onValueChange={(value) => setKind(value as ScoreTableKind)}
            className="gap-2"
          >
            {KIND_OPTIONS.map((option) => {
              const selected = kind === option.value
              return (
                <label
                  key={option.value}
                  htmlFor={`export-kind-${option.value}`}
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-all duration-200',
                    selected
                      ? 'border-primary/40 bg-accent/40 ring-1 ring-primary/10'
                      : 'border-border hover:bg-accent/20'
                  )}
                >
                  <RadioGroupItem
                    id={`export-kind-${option.value}`}
                    value={option.value}
                    className="mt-0.5"
                  />
                  <span className="space-y-0.5">
                    <span className="block text-sm font-medium leading-snug">
                      {option.title}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                </label>
              )
            })}
          </RadioGroup>
        </fieldset>

        {/* ---- Scope ---- */}
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Scope</legend>

          <div className="flex flex-wrap items-center gap-3">
            <select
              aria-label="Filter by activity"
              className="flex h-8 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm transition-all duration-200"
              value={activityId}
              onChange={(e) => {
                setActivityId(e.target.value)
                setConjunctionId('')
              }}
            >
              <option value="">All activities</option>
              {activityIds.map((id) => (
                <option key={id} value={id}>
                  Activity {id}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter by conjunction"
              className="flex h-8 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm transition-all duration-200"
              value={conjunctionId}
              onChange={(e) => setConjunctionId(e.target.value)}
            >
              <option value="">All conjunctions</option>
              {conjunctionIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>

            {(activityId || conjunctionId) && (
              <button
                type="button"
                onClick={() => {
                  setActivityId('')
                  setConjunctionId('')
                }}
                className="text-xs text-muted-foreground transition-all duration-200 hover:text-foreground"
              >
                Clear filters
              </button>
            )}
          </div>

          <div className="space-y-2">
            <ScopeToggle
              id="complete-items-only"
              checked={completenessAvailable && completeItemsOnly}
              disabled={!completenessAvailable}
              onChange={setCompleteItemsOnly}
              label="Only items with a full set of scores"
              hint={`Every one of the ${rubricLabels.length} criteria has a final value.`}
              disabledHint="Available when exporting one row per feedback item."
            />
            <ScopeToggle
              id="finalized-batches-only"
              checked={completenessAvailable && finalizedBatchesOnly}
              disabled={!completenessAvailable}
              onChange={setFinalizedBatchesOnly}
              label="Only fully finalized batches"
              hint="Every team finished scoring, every discrepancy is reconciled, and every escalation is adjudicated."
              disabledHint="Available when exporting one row per feedback item."
            />
          </div>
        </fieldset>

        {/* ---- What's in the file ---- */}
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <p className="text-xs font-medium">Columns in this file</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {columns.join(', ')}
          </p>
          {isItemGrain(kind) && (
            <p className="mt-2 text-xs text-muted-foreground">
              Training batches are excluded — every team scores the same items,
              so one item has one final value per team and cannot collapse to a
              single row. Use either per-scorer export for training data.
            </p>
          )}
          {kind === 'final-by-scorer' && (
            <p className="mt-2 text-xs text-muted-foreground">
              On a reconciled row,{' '}
              <span className="font-medium text-foreground">
                Evaluator_Email
              </span>{' '}
              is the team&apos;s first member alphabetically and{' '}
              <span className="font-medium text-foreground">Scoring_Role</span>{' '}
              always reads &ldquo;Scorer A&rdquo; — they identify the team, not
              who chose the value. Group by team, not by annotator.
            </p>
          )}
        </div>

        {/* ---- Summary + action ---- */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4">
          <ExportSummaryLine summary={summaryReady} />
          <Button
            onClick={handleDownload}
            disabled={summaryReady?.error === null && summaryReady.rowCount === 0}
            className="transition-all duration-200"
          >
            <Download className="mr-2 h-4 w-4" />
            Download CSV
          </Button>
        </div>
      </section>

      <Separator />

      {/* ================= Discrepancy report ================= */}
      <section className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold">Discrepancy Report</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            A QA view of where two annotators disagreed, one row per criterion,
            with each scorer&apos;s value and notes, the final score the pair
            landed on, how it was resolved, and the reconciliation rationale.
          </p>
        </div>

        {!hasPairedBatches ? (
          <p className="text-sm italic text-muted-foreground">
            No double-scored or training batches have been released yet.
          </p>
        ) : (
          <>
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Batches</legend>
              <div className="flex flex-wrap items-center gap-3">
                <select
                  aria-label="Batches for discrepancy report"
                  className="flex h-8 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm transition-all duration-200"
                  value={discrepancySelection}
                  onChange={(e) => setDiscrepancySelection(e.target.value)}
                >
                  <option value={ALL_DOUBLE_SCORED}>
                    All double-scored batches ({doubleScoredBatches.length})
                  </option>
                  {doubleScoredBatches.length > 0 && (
                    <optgroup label="Double-scored">
                      {doubleScoredBatches.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name} · {BATCH_STATUS_LABEL[b.status] ?? b.status}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {trainingBatches.length > 0 && (
                    <optgroup label="Training">
                      {trainingBatches.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name} · {BATCH_STATUS_LABEL[b.status] ?? b.status}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>

              <ScopeToggle
                id="discrepancy-complete-only"
                checked={isAggregate && discrepancyCompleteOnly}
                disabled={!isAggregate}
                onChange={setDiscrepancyCompleteOnly}
                label="Only completed batches"
                hint={`Every discrepancy reconciled or adjudicated. ${completeDoubleScoredCount} of ${doubleScoredBatches.length} double-scored ${doubleScoredBatches.length === 1 ? 'batch is' : 'batches are'} complete.`}
                disabledHint="Available when exporting all double-scored batches."
              />
            </fieldset>

            <div className="rounded-lg border border-border bg-muted/30 p-4">
              <p className="text-xs font-medium">Columns in this file</p>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                {[...ITEM_COLUMNS, ...DISCREPANCY_COLUMNS].join(', ')}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Final_Score</span>{' '}
                is the value the pair recorded (or the adjudicator, when
                escalated).{' '}
                <span className="font-medium text-foreground">Resolution</span>{' '}
                reads Reconciled, Adjudicated, Escalated (awaiting the
                adjudicator), or Unresolved (no final yet). Rows where the two
                annotators agreed are not included.
                {isAggregate &&
                  ' Training batches are excluded from the aggregate; pick one from the list to export it on its own.'}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4">
              <ExportSummaryLine summary={discrepancySummary} />
              <Button
                variant="outline"
                disabled={
                  discrepancySummary?.error === null &&
                  discrepancySummary.rowCount === 0
                }
                onClick={() => {
                  window.open(`/api/export?${discrepancyKey}`, '_blank')
                }}
                className="transition-all duration-200"
              >
                <Download className="mr-2 h-4 w-4" />
                Download CSV
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

function ScopeToggle({
  id,
  checked,
  disabled,
  onChange,
  label,
  hint,
  disabledHint,
}: {
  id: string
  checked: boolean
  disabled: boolean
  onChange: (next: boolean) => void
  label: string
  hint: string
  disabledHint: string
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex items-start gap-2.5',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
      )}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-input accent-primary transition-all duration-200"
      />
      <span className="space-y-0.5">
        <span className="block text-sm leading-snug">{label}</span>
        <span className="block text-xs text-muted-foreground">
          {disabled ? disabledHint : hint}
        </span>
      </span>
    </label>
  )
}

interface ExportSummary {
  key: string
  rowCount: number
  columnCount: number
  error: string | null
}

/**
 * Row/column count for an export selection, from `/api/export/count`.
 *
 * The result is keyed by the selection it describes, so "still calculating"
 * is derived from whether the stored result matches the current selection
 * rather than tracked as its own state. Returns null while calculating, or
 * when there is no selection to describe.
 */
function useExportSummary(selectionKey: string | null): ExportSummary | null {
  const [summary, setSummary] = useState<ExportSummary | null>(null)

  useEffect(() => {
    if (!selectionKey) return
    let cancelled = false

    fetch(`/api/export/count?${selectionKey}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        return res.json()
      })
      .then((data) => {
        if (cancelled) return
        setSummary({
          key: selectionKey,
          rowCount: data.rowCount,
          columnCount: data.columnCount,
          error: null,
        })
      })
      .catch(() => {
        if (cancelled) return
        setSummary({
          key: selectionKey,
          rowCount: 0,
          columnCount: 0,
          error: 'Could not calculate row count',
        })
      })

    return () => {
      cancelled = true
    }
  }, [selectionKey])

  return selectionKey && summary?.key === selectionKey ? summary : null
}

function ExportSummaryLine({ summary }: { summary: ExportSummary | null }) {
  return (
    <p className="text-sm text-muted-foreground" aria-live="polite">
      {!summary ? (
        <span className="flex items-center gap-2">
          <Loader2 className="h-3 w-3 animate-spin" />
          Calculating…
        </span>
      ) : summary.error ? (
        <span className="text-destructive">{summary.error}</span>
      ) : (
        <>
          <span className="font-medium text-foreground">
            {summary.rowCount.toLocaleString()}
          </span>{' '}
          {summary.rowCount === 1 ? 'row' : 'rows'} · {summary.columnCount}{' '}
          columns
        </>
      )}
    </p>
  )
}
