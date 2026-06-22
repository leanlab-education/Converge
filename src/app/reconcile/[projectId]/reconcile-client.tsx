'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  ChevronLeft,
  ChevronRight,
  CheckCircle,
  Loader2,
  AlertTriangle,
  ArrowLeft,
  Scale,
  Flag,
  Undo2,
} from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import {
  buildNavWindow,
  getScoreColor,
  getSelectedScoreColor,
} from '@/lib/scoring-utils'
import {
  getOptimalFlag,
  isAppropriateFeedbackDecision,
} from '@/lib/optimal-indicator'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EvaluatorScore {
  userId: string
  name: string | null
  email: string
  value: number
  scoreId: string
}

interface Discrepancy {
  dimensionId: string
  dimensionLabel: string
  dimensionKey: string
  sortOrder: number
  scaleMin: number
  scaleMax: number
  scoreLabelJson: string | null
  evaluatorA: EvaluatorScore
  evaluatorB: EvaluatorScore
  escalation: {
    id: string
    escalatedByName: string | null
    escalatedByEmail: string
  } | null
}

interface Agreement {
  dimensionId: string
  dimensionLabel: string
  value: number
}

interface ItemCoder {
  userId: string
  name: string | null
  email: string
  notes: string | null
}

interface DiscrepantItem {
  feedbackItemId: string
  studentText: string
  feedbackText: string
  optimal: string | null
  activityId: string | null
  conjunctionId: string | null
  displayOrder: number | null
  coders: ItemCoder[]
  discrepancies: Discrepancy[]
  agreements: Agreement[]
}

interface DiscrepancyResponse {
  items: DiscrepantItem[]
  hasAdjudicator: boolean
  summary: {
    totalItems: number
    discrepantItems: number
    totalDiscrepancies: number
    totalDimensionPairs: number
    reconciledCount: number
  }
}

// Per-item reconciliation state
interface ItemReconcileState {
  scores: Record<string, number | null> // dimensionId → final value
  notes: string
  saved: boolean
}

function parseScoreLabels(
  json: string | null
): Record<number, { label: string; description?: string }> {
  if (!json) return {}
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReconcileClient({
  projectId,
  batchId,
  releaseId,
  batchName,
  userName,
}: {
  projectId: string
  batchId: string
  releaseId: string
  batchName: string
  userName: string
}) {
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<DiscrepantItem[]>([])
  const [summary, setSummary] = useState<DiscrepancyResponse['summary'] | null>(null)
  const [hasAdjudicator, setHasAdjudicator] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [itemStates, setItemStates] = useState<Record<string, ItemReconcileState>>({})
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [escalatingDimId, setEscalatingDimId] = useState<string | null>(null)

  // Fetch discrepancies on mount
  useEffect(() => {
    async function fetchDiscrepancies() {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/batches/${batchId}/discrepancies?releaseId=${releaseId}`
        )
        if (!res.ok) throw new Error('Failed to fetch discrepancies')
        const data: DiscrepancyResponse = await res.json()
        setItems(data.items)
        setSummary(data.summary)
        setHasAdjudicator(data.hasAdjudicator)

        // Initialize state for each item - pre-fill agreed dimensions
        const states: Record<string, ItemReconcileState> = {}
        for (const item of data.items) {
          const scores: Record<string, number | null> = {}
          // Agreed dimensions are auto-filled
          for (const a of item.agreements) {
            scores[a.dimensionId] = a.value
          }
          // Discrepant dimensions start empty
          for (const d of item.discrepancies) {
            scores[d.dimensionId] = null
          }
          states[item.feedbackItemId] = { scores, notes: '', saved: false }
        }
        setItemStates(states)
      } catch (err) {
        console.error('Failed to load discrepancies:', err)
      } finally {
        setLoading(false)
      }
    }
    fetchDiscrepancies()
  }, [projectId, batchId, releaseId])

  const currentItem = items[currentIndex] ?? null
  const currentState = currentItem ? itemStates[currentItem.feedbackItemId] : null

  // Show the Quill "optimal" indicator only when this reconciliation involves
  // the Appropriate Feedback Decision criterion (i.e. the pair was assigned it).
  const showOptimalFlag = currentItem
    ? currentItem.discrepancies.some((d) =>
        isAppropriateFeedbackDecision({
          key: d.dimensionKey,
          label: d.dimensionLabel,
        })
      ) ||
      currentItem.agreements.some((a) =>
        isAppropriateFeedbackDecision({ label: a.dimensionLabel })
      )
    : false

  // A dimension is "done" if it has a final value OR has been escalated.
  // Escalated dimensions will be resolved by the adjudicator; the pair
  // can still save their progress on the rest of the item.
  const allDiscrepanciesScored = currentItem
    ? currentItem.discrepancies.every(
        (d) =>
          d.escalation != null || currentState?.scores[d.dimensionId] != null
      )
    : false

  const resolvedCount = Object.values(itemStates).filter((s) => s.saved).length

  const handleFinalScoreChange = useCallback(
    (dimensionId: string, value: number) => {
      if (!currentItem) return
      setItemStates((prev) => ({
        ...prev,
        [currentItem.feedbackItemId]: {
          ...prev[currentItem.feedbackItemId],
          scores: {
            ...prev[currentItem.feedbackItemId].scores,
            [dimensionId]: value,
          },
        },
      }))
      setSaveStatus('idle')
    },
    [currentItem]
  )

  const handleNotesChange = useCallback(
    (notes: string) => {
      if (!currentItem) return
      setItemStates((prev) => ({
        ...prev,
        [currentItem.feedbackItemId]: {
          ...prev[currentItem.feedbackItemId],
          notes,
        },
      }))
    },
    [currentItem]
  )

  // Escalate a single criterion to the adjudicator. Per Amber's 2026-04-09
  // answer: escalation is per-criterion, and the reason/rationale lives in
  // the existing reconciliation notes box (no separate reason prompt).
  const handleEscalate = useCallback(
    async (dimensionId: string) => {
      if (!currentItem) return
      setEscalatingDimId(dimensionId)
      try {
        const res = await fetch(
          `/api/projects/${projectId}/batches/${batchId}/escalate`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              releaseId,
              feedbackItemId: currentItem.feedbackItemId,
              dimensionId,
            }),
          }
        )
        if (!res.ok) {
          const err = await res.json()
          alert(err.error || 'Failed to escalate')
          return
        }
        const created: {
          id: string
        } = await res.json()

        // Reflect escalation in local state without a full refetch
        setItems((prev) =>
          prev.map((it) =>
            it.feedbackItemId === currentItem.feedbackItemId
              ? {
                  ...it,
                  discrepancies: it.discrepancies.map((d) =>
                    d.dimensionId === dimensionId
                      ? {
                          ...d,
                          escalation: {
                            id: created.id,
                            escalatedByName: userName,
                            escalatedByEmail: '',
                          },
                        }
                      : d
                  ),
                }
              : it
          )
        )
        // Clear any selected final value for this dimension since the
        // adjudicator will decide instead.
        setItemStates((prev) => ({
          ...prev,
          [currentItem.feedbackItemId]: {
            ...prev[currentItem.feedbackItemId],
            scores: {
              ...prev[currentItem.feedbackItemId].scores,
              [dimensionId]: null,
            },
          },
        }))
      } finally {
        setEscalatingDimId(null)
      }
    },
    [currentItem, projectId, batchId, releaseId, userName]
  )

  const handleWithdrawEscalation = useCallback(
    async (dimensionId: string) => {
      if (!currentItem) return
      setEscalatingDimId(dimensionId)
      try {
        const res = await fetch(
          `/api/projects/${projectId}/batches/${batchId}/escalate?releaseId=${releaseId}&feedbackItemId=${currentItem.feedbackItemId}&dimensionId=${dimensionId}`,
          { method: 'DELETE' }
        )
        if (!res.ok) {
          const err = await res.json()
          alert(err.error || 'Failed to withdraw escalation')
          return
        }
        setItems((prev) =>
          prev.map((it) =>
            it.feedbackItemId === currentItem.feedbackItemId
              ? {
                  ...it,
                  discrepancies: it.discrepancies.map((d) =>
                    d.dimensionId === dimensionId
                      ? { ...d, escalation: null }
                      : d
                  ),
                }
              : it
          )
        )
      } finally {
        setEscalatingDimId(null)
      }
    },
    [currentItem, projectId, batchId, releaseId]
  )

  const handleSaveAndContinue = useCallback(async () => {
    if (!currentItem || !currentState || !allDiscrepanciesScored) return

    setSaving(true)
    setSaveStatus('saving')

    try {
      // Build scores array: all dimensions (agreed + resolved discrepancies).
      // Escalated dimensions are intentionally excluded — the adjudicator
      // will write their own reconciled Score row for those.
      const escalatedDimIds = new Set(
        currentItem.discrepancies
          .filter((d) => d.escalation != null)
          .map((d) => d.dimensionId)
      )
      const scores = Object.entries(currentState.scores)
        .filter(([dimensionId, v]) => v != null && !escalatedDimIds.has(dimensionId))
        .map(([dimensionId, value]) => ({ dimensionId, value: value! }))

      const res = await fetch(
        `/api/projects/${projectId}/batches/${batchId}/reconcile`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            releaseId,
            items: [
              {
                feedbackItemId: currentItem.feedbackItemId,
                scores,
                notes: currentState.notes || undefined,
              },
            ],
          }),
        }
      )

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to save')
      }

      // Mark as saved
      setItemStates((prev) => ({
        ...prev,
        [currentItem.feedbackItemId]: {
          ...prev[currentItem.feedbackItemId],
          saved: true,
        },
      }))
      setSaveStatus('saved')

      // Advance to next unresolved item
      const nextUnresolved = items.findIndex(
        (item, i) =>
          i > currentIndex && !itemStates[item.feedbackItemId]?.saved
      )
      if (nextUnresolved !== -1) {
        setTimeout(() => setCurrentIndex(nextUnresolved), 300)
      }
    } catch (err) {
      console.error('Save failed:', err)
      setSaveStatus('error')
    } finally {
      setSaving(false)
    }
  }, [currentItem, currentState, allDiscrepanciesScored, projectId, batchId, releaseId, items, currentIndex, itemStates])

  // Loading state
  if (loading) {
    return (
      <AppShell defaultCollapsed>
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        </div>
      </AppShell>
    )
  }

  // No discrepancies - all scores matched
  if (items.length === 0) {
    return (
      <AppShell defaultCollapsed>
        <div className="mx-auto flex max-w-lg flex-col items-center justify-center gap-4 py-20 text-center">
          <CheckCircle className="size-16 text-success" />
          <h2 className="text-xl font-semibold">No Discrepancies Found</h2>
          <p className="text-sm text-muted-foreground">
            All scores in this batch match between evaluators. No reconciliation needed.
          </p>
          <Button onClick={() => router.push('/')}>Return to Dashboard</Button>
        </div>
      </AppShell>
    )
  }

  // All resolved
  if (resolvedCount === items.length) {
    return (
      <AppShell defaultCollapsed>
        <div className="mx-auto flex max-w-lg flex-col items-center justify-center gap-4 py-20 text-center">
          <CheckCircle className="size-16 text-success" />
          <h2 className="text-xl font-semibold">Reconciliation Complete</h2>
          <p className="text-sm text-muted-foreground">
            All {items.length} discrepant items have been reconciled.
            {summary && (
              <> ({summary.totalDiscrepancies} discrepancies resolved)</>
            )}
          </p>
          <Button onClick={() => router.push('/')}>Return to Dashboard</Button>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell defaultCollapsed>
      {/* Sticky header with navigation */}
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 px-4 py-3 backdrop-blur-lg supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex max-w-7xl flex-col gap-3">
          {/* Top row: back + project info + progress */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push('/')}
              >
                <ArrowLeft className="mr-1 size-4" />
                Dashboard
              </Button>
              <span className="text-sm font-medium">{batchName}</span>
              <Badge
                variant="outline"
                className="bg-status-reconciliation-bg text-status-reconciliation-text"
              >
                Reconciling
              </Badge>
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Scale className="size-3.5" />
              <span>
                {resolvedCount} of {items.length} items reconciled
              </span>
            </div>
          </div>

          {/* Navigation circles */}
          <div className="flex items-center justify-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={currentIndex === 0}
              onClick={() => setCurrentIndex((i) => i - 1)}
            >
              <ChevronLeft className="size-4" />
            </Button>

            <div className="flex gap-1">
              {buildNavWindow(currentIndex, items.length, 5).map((entry, i) =>
                entry === '...' ? (
                  <span key={`ellipsis-${i}`} className="px-1 text-xs text-muted-foreground">
                    ...
                  </span>
                ) : (
                  <button
                    key={entry}
                    onClick={() => setCurrentIndex(entry as number)}
                    className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium transition-all duration-200 ${
                      entry === currentIndex
                        ? 'bg-nav-current-bg text-nav-current-text ring-2 ring-nav-current-ring'
                        : itemStates[items[entry as number]?.feedbackItemId]?.saved
                          ? 'bg-nav-scored-bg text-nav-scored-text'
                          : 'bg-nav-unscored-bg text-nav-unscored-text hover:opacity-80'
                    }`}
                  >
                    {(entry as number) + 1}
                  </button>
                )
              )}
            </div>

            <Button
              variant="outline"
              size="icon-sm"
              disabled={currentIndex === items.length - 1}
              onClick={() => setCurrentIndex((i) => i + 1)}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      {/* Split pane: left (content) + right (reconciliation) */}
      <main className="mx-auto flex w-full max-w-7xl flex-1 gap-6 p-4 lg:p-6">
        {/* Left column: student response + feedback */}
        <div className="flex w-full flex-col gap-4 lg:w-1/2">
          {currentItem?.activityId && (
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Activity</CardDescription>
                <CardTitle className="text-base">
                  Activity {currentItem.activityId}
                  {currentItem.conjunctionId && (
                    <span className="ml-2 text-sm font-normal text-muted-foreground">
                      ({currentItem.conjunctionId})
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
            </Card>
          )}

          <Card className="border-content-student-border bg-content-student-bg">
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-content-student-text">Student Response</CardTitle>
                {showOptimalFlag &&
                  (() => {
                    const flag = getOptimalFlag(currentItem?.optimal)
                    if (!flag) return null
                    const { Icon } = flag
                    return (
                      <Badge
                        variant="outline"
                        className={`${flag.className} transition-all duration-200`}
                      >
                        <Icon />
                        {flag.label}
                      </Badge>
                    )
                  })()}
              </div>
            </CardHeader>
            <CardContent>
              <div className="whitespace-pre-wrap text-sm leading-relaxed text-content-student-text/80">
                {currentItem?.studentText}
              </div>
            </CardContent>
          </Card>

          <Card className="border-content-feedback-border bg-content-feedback-bg">
            <CardHeader>
              <CardTitle className="text-content-feedback-text">
                Feedback to Evaluate
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="whitespace-pre-wrap text-sm leading-relaxed text-content-feedback-text/80">
                {currentItem?.feedbackText}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Vertical divider on desktop */}
        <div className="hidden w-px self-stretch bg-border lg:block" />

        {/* Right column: reconciliation scoring */}
        <div className="flex w-full flex-col gap-4 lg:w-1/2">
          <Card>
            <CardHeader>
              <CardTitle>Reconcile Scores</CardTitle>
              <CardDescription>
                Review both evaluators&apos; scores and select the final agreed-upon value
                for each discrepant dimension.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              {/* Discrepant dimensions - need manual resolution */}
              {currentItem?.discrepancies.map((disc) => {
                const scoreLabels = parseScoreLabels(disc.scoreLabelJson)
                const finalValue = currentState?.scores[disc.dimensionId] ?? null
                const isEscalated = disc.escalation != null
                const isEscalatingThis = escalatingDimId === disc.dimensionId

                const scaleOptions: number[] = []
                for (let v = disc.scaleMin; v <= disc.scaleMax; v++) {
                  scaleOptions.push(v)
                }

                return (
                  <div key={disc.dimensionId} className="flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                      {isEscalated ? (
                        <Flag className="size-3.5 text-primary" />
                      ) : (
                        <AlertTriangle className="size-3.5 text-warning" />
                      )}
                      <Label className="text-sm font-semibold text-foreground">
                        {disc.dimensionLabel}
                      </Label>
                      {isEscalated ? (
                        <Badge
                          variant="outline"
                          className="border-primary/30 bg-primary/10 text-[10px] text-primary"
                        >
                          Escalated to adjudicator
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="border-warning/30 bg-warning/10 text-[10px] text-warning"
                        >
                          Discrepancy
                        </Badge>
                      )}
                    </div>

                    {/* Both evaluators' scores side by side */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-lg border border-border bg-muted/50 p-3">
                        <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                          {disc.evaluatorA.name || disc.evaluatorA.email}
                        </div>
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-flex rounded-lg border-2 px-2.5 py-1 text-xs font-medium ${getScoreColor(
                              disc.evaluatorA.value,
                              disc.scaleMin,
                              disc.scaleMax
                            )}`}
                          >
                            {scoreLabels[disc.evaluatorA.value]?.label ??
                              disc.evaluatorA.value}
                          </span>
                        </div>
                      </div>

                      <div className="rounded-lg border border-border bg-muted/50 p-3">
                        <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                          {disc.evaluatorB.name || disc.evaluatorB.email}
                        </div>
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-flex rounded-lg border-2 px-2.5 py-1 text-xs font-medium ${getScoreColor(
                              disc.evaluatorB.value,
                              disc.scaleMin,
                              disc.scaleMax
                            )}`}
                          >
                            {scoreLabels[disc.evaluatorB.value]?.label ??
                              disc.evaluatorB.value}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Final score selection OR escalated state */}
                    {isEscalated ? (
                      <div className="flex items-center justify-between rounded-lg bg-primary/5 px-3 py-2 text-xs">
                        <span className="text-muted-foreground">
                          Waiting on adjudicator to resolve.
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 gap-1 px-2 text-xs"
                          disabled={isEscalatingThis}
                          onClick={() => handleWithdrawEscalation(disc.dimensionId)}
                        >
                          {isEscalatingThis ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <>
                              <Undo2 className="size-3" />
                              Withdraw
                            </>
                          )}
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div>
                          <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                            Final Score
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {scaleOptions.map((val) => {
                              const label = scoreLabels[val]
                              const isSelected = finalValue === val
                              return (
                              <button
                                  key={val}
                                  onClick={() =>
                                    handleFinalScoreChange(disc.dimensionId, val)
                                  }
                                  className={`rounded-xl border-2 px-4 py-3 text-left text-sm font-medium transition-all duration-200 ${
                                    isSelected
                                      ? getSelectedScoreColor(
                                          val,
                                          disc.scaleMin,
                                          disc.scaleMax
                                        )
                                      : `${getScoreColor(val, disc.scaleMin, disc.scaleMax)} hover:shadow-md`
                                  }`}
                                >
                                  {label && (
                                    <span className="block leading-tight">
                                      {label.label}
                                    </span>
                                  )}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1 self-start px-2 text-xs"
                          disabled={isEscalatingThis || !hasAdjudicator}
                          title={
                            !hasAdjudicator
                              ? 'An admin must assign an adjudicator to this batch before you can escalate.'
                              : undefined
                          }
                          onClick={() => handleEscalate(disc.dimensionId)}
                        >
                          {isEscalatingThis ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <>
                              <Flag className="size-3" />
                              Need Adjudicator
                            </>
                          )}
                        </Button>
                      </>
                    )}
                  </div>
                )
              })}

              {/* Agreed dimensions - read-only */}
              {currentItem && currentItem.agreements.length > 0 && (
                <div className="border-t pt-4">
                  <div className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Agreed Scores (no action needed)
                  </div>
                  <div className="flex flex-col gap-2">
                    {currentItem.agreements.map((a) => (
                      <div
                        key={a.dimensionId}
                        className="flex items-center justify-between rounded-lg bg-muted/30 px-3 py-2"
                      >
                        <div className="flex items-center gap-2">
                          <CheckCircle className="size-3.5 text-success" />
                          <span className="text-sm">{a.dimensionLabel}</span>
                        </div>
                        <span className="text-sm font-semibold">{a.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Coders' original notes (read-only) — only shown when present.
                  Added per 2026-04-09 meeting: helps the pair remember why
                  they scored the way they did when reconciling later. */}
              {currentItem &&
                currentItem.coders.some((c) => c.notes && c.notes.trim()) && (
                  <div className="border-t pt-4">
                    <div className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Coder Notes
                    </div>
                    <div className="flex flex-col gap-2">
                      {currentItem.coders
                        .filter((c) => c.notes && c.notes.trim())
                        .map((coder) => (
                          <div
                            key={coder.userId}
                            className="rounded-lg bg-muted/30 px-3 py-2"
                          >
                            <div className="mb-1 text-xs font-medium text-muted-foreground">
                              {coder.name || coder.email}
                            </div>
                            <div className="whitespace-pre-wrap text-sm text-foreground">
                              {coder.notes}
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>
                )}

              {/* Reconciliation notes — the pair's final rationale. Ships in
                  the export alongside the reconciled score. */}
              <div className="border-t pt-4">
                <Label className="text-sm font-semibold text-foreground">
                  Why we decided what we did{' '}
                  <span className="font-normal text-muted-foreground">
                    (optional)
                  </span>
                </Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  Brief rationale for the final scores. Included with the
                  reconciled scores in the export.
                </p>
                <Textarea
                  placeholder="e.g. Agreed it was unclear because the feedback points to a problem but not a usable next step..."
                  value={currentState?.notes ?? ''}
                  onChange={(e) => handleNotesChange(e.target.value)}
                  className="mt-2 text-sm"
                  rows={3}
                />
              </div>

              {/* Save status */}
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  {saveStatus === 'saving' && (
                    <>
                      <Loader2 className="size-3 animate-spin" />
                      <span>Saving...</span>
                    </>
                  )}
                  {saveStatus === 'saved' && (
                    <>
                      <CheckCircle className="size-3 text-success" />
                      <span>Saved</span>
                    </>
                  )}
                  {saveStatus === 'error' && (
                    <>
                      <AlertTriangle className="size-3 text-destructive" />
                      <span>Save failed</span>
                    </>
                  )}
                </div>
              </div>

              {/* Save & Continue button */}
              <Button
                onClick={handleSaveAndContinue}
                disabled={!allDiscrepanciesScored || saving || currentState?.saved}
                className="w-full"
              >
                {saving ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Saving...
                  </>
                ) : currentState?.saved ? (
                  <>
                    <CheckCircle className="mr-2 size-4" />
                    Reconciled
                  </>
                ) : (
                  'Save & Continue'
                )}
              </Button>
            </CardContent>
          </Card>
        </div>
      </main>
    </AppShell>
  )
}
