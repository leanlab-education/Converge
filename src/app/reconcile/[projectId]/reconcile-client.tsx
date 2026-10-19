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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
  Gavel,
  Lock,
  Pencil,
  RefreshCw,
  Hourglass,
} from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import {
  buildNavWindow,
  getScaleOptions,
  getScoreColor,
  getSelectedScoreColor,
  getUnselectedOptionColor,
} from '@/lib/scoring-utils'
import {
  getOptimalFlag,
  isAppropriateFeedbackDecision,
} from '@/lib/optimal-indicator'
import {
  buildItemStates,
  dirtyItemIds,
  finalKey,
  isOpenCell,
  mergeLocalSelections,
  type ItemReconcileState,
  type PersistedFinal,
} from '@/lib/reconcile-item-state'
import { deriveReconcileOutcome, pendingItemIds } from '@/lib/reconcile-outcome'

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
  // Set when the adjudicator has already resolved this criterion. The pair sees
  // it locked with the adjudicator's final value — they cannot override it.
  adjudication: {
    resolvedByName: string | null
    resolvedByEmail: string
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
  isLocked: boolean
  releaseStatus: string
  openEscalationCount?: number
  reconciledScores: PersistedFinal[]
  summary: {
    totalItems: number
    discrepantItems: number
    totalDiscrepancies: number
    totalDimensionPairs: number
    reconciledCount: number
  }
}

interface ReconcileSaveResponse {
  saved: boolean
  reconciledCount: number
  releaseStatus?: string
  openEscalationCount?: number
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

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    return body.error || fallback
  } catch {
    return fallback
  }
}

function countEscalatedCells(items: DiscrepantItem[]): number {
  return items.reduce(
    (sum, item) => sum + item.discrepancies.filter((d) => d.escalation != null).length,
    0
  )
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
  userId,
}: {
  projectId: string
  batchId: string
  releaseId: string
  batchName: string
  userName: string
  userId: string
}) {
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [items, setItems] = useState<DiscrepantItem[]>([])
  const [summary, setSummary] = useState<DiscrepancyResponse['summary'] | null>(null)
  const [hasAdjudicator, setHasAdjudicator] = useState(false)
  const [isLocked, setIsLocked] = useState(false)
  // The server's view of the release, refreshed on every load and every save.
  // The end-of-list screen branches on THESE, never on a locally derived count
  // (see src/lib/reconcile-outcome.ts).
  const [releaseStatus, setReleaseStatus] = useState<string | null>(null)
  const [openEscalationCount, setOpenEscalationCount] = useState(0)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [itemStates, setItemStates] = useState<Record<string, ItemReconcileState>>({})
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  // Shown after a save was refused because the server had moved on (partner
  // or adjudicator wrote first, or an admin locked the batch) and the screen
  // was re-synced. Survives the refetch; dismissed by the user or the next save.
  const [syncNotice, setSyncNotice] = useState<string | null>(null)
  // What the server holds, keyed `${feedbackItemId}::${dimensionId}` (finals)
  // and by feedbackItemId (rationale). Distinct from the local (possibly
  // unsaved) selection in itemStates: the concede-or-escalate rule and the
  // unsaved-selection guard both compare against these, and every save sends
  // them as `expectedFinal` so a stale write is refused server-side.
  const [persistedFinals, setPersistedFinals] = useState<Record<string, number>>({})
  const [persistedNotes, setPersistedNotes] = useState<Record<string, string>>({})
  const [escalatingDimId, setEscalatingDimId] = useState<string | null>(null)
  // A failed escalate/withdraw, shown inline under that criterion.
  const [actionError, setActionError] = useState<{
    feedbackItemId: string
    dimensionId: string
    message: string
  } | null>(null)
  // When the pair re-opens a fully-reconciled batch to correct a score, they
  // bypass the "all done" summary screen via this flag.
  const [reviewMode, setReviewMode] = useState(false)
  // A pending edit to an already-saved item, awaiting confirmation. Holds the
  // score change so we can apply it once the user confirms the warning.
  const [pendingEdit, setPendingEdit] = useState<{
    dimensionId: string
    value: number
  } | null>(null)
  // A pending selection of the user's OWN original score on a first-recording
  // discrepancy, awaiting the "did you and your partner agree?" confirmation.
  const [pendingSelfOriginal, setPendingSelfOriginal] = useState<{
    dimensionId: string
    value: number
  } | null>(null)
  // "Leave without saving?" — the Dashboard buttons route through this when
  // any item has an unsaved selection.
  const [pendingLeave, setPendingLeave] = useState(false)

  // Fetch discrepancies on mount, and again after a save conflict so the
  // client re-syncs with what a partner (or adjudicator) changed concurrently.
  // Unsaved selections on other items survive the refetch (mergeLocalSelections).
  const fetchDiscrepancies = useCallback(async () => {
    setFetchError(null)
    try {
      const res = await fetch(
        `/api/projects/${projectId}/batches/${batchId}/discrepancies?releaseId=${releaseId}`
      )
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, 'Failed to load discrepancies'))
      }
      const data: DiscrepancyResponse = await res.json()
      setItems(data.items)
      setSummary(data.summary)
      setHasAdjudicator(data.hasAdjudicator)
      setIsLocked(data.isLocked)
      setReleaseStatus(data.releaseStatus ?? null)
      setOpenEscalationCount(
        data.openEscalationCount ?? countEscalatedCells(data.items)
      )

      const server = buildItemStates(data.items, data.reconciledScores ?? [])
      setPersistedFinals(server.persistedFinals)
      setPersistedNotes(server.persistedNotes)
      setItemStates((prev) => mergeLocalSelections(data.items, server, prev))
      // A refetch can shrink the list (e.g. a partner resolved an item) —
      // keep the index in range.
      setCurrentIndex((i) => Math.max(0, Math.min(i, data.items.length - 1)))
    } catch (err) {
      console.error('Failed to load discrepancies:', err)
      setFetchError(
        err instanceof Error ? err.message : 'Failed to load discrepancies'
      )
    } finally {
      setLoading(false)
    }
  }, [projectId, batchId, releaseId])

  useEffect(() => {
    fetchDiscrepancies()
  }, [fetchDiscrepancies])

  const currentItem = items[currentIndex] ?? null
  const currentState = currentItem ? itemStates[currentItem.feedbackItemId] : null

  // Items with a selection or rationale the server does not hold yet.
  const dirtyIds = dirtyItemIds(items, itemStates, persistedFinals, persistedNotes)
  const dirtySet = new Set(dirtyIds)
  const hasDirty = dirtyIds.length > 0
  const currentIsDirty = currentItem != null && dirtySet.has(currentItem.feedbackItemId)

  // Items the pair itself still owes a final on.
  const pendingSet = new Set(pendingItemIds(items, itemStates))

  const outcome = deriveReconcileOutcome({
    releaseStatus,
    items,
    itemStates,
    openEscalationCount,
    fetchError,
  })

  // The server moved on under us (partner/adjudicator wrote first, or an admin
  // locked the batch) and the screen was re-synced. Rendered wherever the
  // re-sync may have landed us — the editor or an end-of-list screen.
  const syncNoticeBanner = syncNotice ? (
    <div
      role="status"
      className="flex w-full items-start justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-left text-xs text-muted-foreground"
    >
      <div className="flex items-start gap-2">
        <RefreshCw className="mt-0.5 size-3.5 shrink-0 text-primary" />
        <span>{syncNotice}</span>
      </div>
      <button
        type="button"
        onClick={() => setSyncNotice(null)}
        className="shrink-0 font-medium text-foreground underline underline-offset-2 transition-all duration-200 hover:text-primary"
      >
        Dismiss
      </button>
    </div>
  ) : null

  // Reload / tab close while a selection is unsaved: ask the browser to warn.
  // (No auto-save here on purpose — the pair is supposed to discuss first.)
  useEffect(() => {
    if (!hasDirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Chrome/Edge < 119 only show the prompt when returnValue is set.
      event.returnValue = true
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hasDirty])

  function handleBackToDashboard() {
    if (hasDirty) {
      setPendingLeave(true)
      return
    }
    router.push('/')
  }

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

  // A dimension is "done" if it has a final value, has been escalated (pending
  // adjudication), or was already resolved by the adjudicator (locked). In all
  // three cases the pair has no outstanding action on it.
  const allDiscrepanciesScored = currentItem
    ? currentItem.discrepancies.every(
        (d) =>
          d.escalation != null ||
          d.adjudication != null ||
          currentState?.scores[d.dimensionId] != null
      )
    : false

  // Apply a final-score change. Setting `saved: false` re-opens the item so the
  // "Save & Continue" button re-enables — this is how an edit to an already-
  // reconciled item gets persisted.
  function applyFinalScore(dimensionId: string, value: number) {
    if (!currentItem) return
    setItemStates((prev) => ({
      ...prev,
      [currentItem.feedbackItemId]: {
        ...prev[currentItem.feedbackItemId],
        scores: {
          ...prev[currentItem.feedbackItemId].scores,
          [dimensionId]: value,
        },
        saved: false,
      },
    }))
    setSaveStatus('idle')
    setSaveError(null)
  }

  function handleFinalScoreChange(dimensionId: string, value: number) {
    if (!currentItem || isLocked) return
    // No-op if the value didn't actually change.
    if (currentState?.scores[dimensionId] === value) return
    // Warn before changing a score the pair already agreed on and saved.
    if (currentState?.saved) {
      setPendingEdit({ dimensionId, value })
      return
    }
    // Concede-or-escalate confirmation (Luofan 2026-07-29; softened to a
    // confirm on 2026-08-17): recording your OWN original as the final on the
    // first pass means the pair agreed your score was right. It's allowed, but
    // confirm it's deliberate — this is the speed bump that catches silent
    // self-reconciles and 2-point-scale misclicks. Only the first recording is
    // gated (once a final is persisted, editing is free); admins outside the
    // pair have no "own original" so they skip it.
    const disc = currentItem.discrepancies.find(
      (d) => d.dimensionId === dimensionId
    )
    const myOriginal =
      disc?.evaluatorA.userId === userId
        ? disc.evaluatorA.value
        : disc?.evaluatorB.userId === userId
          ? disc.evaluatorB.value
          : null
    const alreadyPersisted =
      persistedFinals[finalKey(currentItem.feedbackItemId, dimensionId)] != null
    if (!alreadyPersisted && myOriginal != null && value === myOriginal) {
      setPendingSelfOriginal({ dimensionId, value })
      return
    }
    applyFinalScore(dimensionId, value)
  }

  function handleNotesChange(notes: string) {
    if (!currentItem || isLocked) return
    setItemStates((prev) => ({
      ...prev,
      [currentItem.feedbackItemId]: {
        ...prev[currentItem.feedbackItemId],
        notes,
        // Editing the rationale on a saved item re-opens it for re-saving.
        saved: false,
      },
    }))
  }

  // Escalate a single criterion to the adjudicator. Per Amber's 2026-04-09
  // answer: escalation is per-criterion, and the reason/rationale lives in
  // the existing reconciliation notes box (no separate reason prompt).
  async function handleEscalate(dimensionId: string) {
    if (!currentItem) return
    const feedbackItemId = currentItem.feedbackItemId
    setEscalatingDimId(dimensionId)
    setActionError(null)
    try {
      const res = await fetch(
        `/api/projects/${projectId}/batches/${batchId}/escalate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ releaseId, feedbackItemId, dimensionId }),
        }
      )
      if (!res.ok) {
        setActionError({
          feedbackItemId,
          dimensionId,
          message: await readErrorMessage(res, 'Failed to escalate'),
        })
        return
      }
      const created: { id: string } = await res.json()

      // Reflect escalation in local state without a full refetch
      setItems((prev) =>
        prev.map((it) =>
          it.feedbackItemId === feedbackItemId
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
        [feedbackItemId]: {
          ...prev[feedbackItemId],
          scores: {
            ...prev[feedbackItemId].scores,
            [dimensionId]: null,
          },
        },
      }))
      setOpenEscalationCount((c) => c + 1)
    } catch (err) {
      console.error('Escalate failed:', err)
      setActionError({
        feedbackItemId,
        dimensionId,
        message: 'Could not reach the server to escalate. Check your connection and try again.',
      })
    } finally {
      setEscalatingDimId(null)
    }
  }

  async function handleWithdrawEscalation(dimensionId: string) {
    if (!currentItem) return
    const feedbackItemId = currentItem.feedbackItemId
    setEscalatingDimId(dimensionId)
    setActionError(null)
    try {
      const res = await fetch(
        `/api/projects/${projectId}/batches/${batchId}/escalate?releaseId=${releaseId}&feedbackItemId=${feedbackItemId}&dimensionId=${dimensionId}`,
        { method: 'DELETE' }
      )
      if (!res.ok) {
        setActionError({
          feedbackItemId,
          dimensionId,
          message: await readErrorMessage(res, 'Failed to withdraw escalation'),
        })
        return
      }
      setItems((prev) =>
        prev.map((it) =>
          it.feedbackItemId === feedbackItemId
            ? {
                ...it,
                discrepancies: it.discrepancies.map((d) =>
                  d.dimensionId === dimensionId ? { ...d, escalation: null } : d
                ),
              }
            : it
        )
      )
      // The cell is the pair's again. Restore whatever final the server holds
      // for it (usually none) and re-open the item: its next pick must go
      // through the first-recording confirmation, not the "change an already-
      // reconciled score?" warning meant for persisted finals.
      const restored =
        persistedFinals[finalKey(feedbackItemId, dimensionId)] ?? null
      setItemStates((prev) => ({
        ...prev,
        [feedbackItemId]: {
          ...prev[feedbackItemId],
          scores: {
            ...prev[feedbackItemId].scores,
            [dimensionId]: restored,
          },
          saved: false,
        },
      }))
      setOpenEscalationCount((c) => Math.max(0, c - 1))
    } catch (err) {
      console.error('Withdraw escalation failed:', err)
      setActionError({
        feedbackItemId,
        dimensionId,
        message: 'Could not reach the server to withdraw. Check your connection and try again.',
      })
    } finally {
      setEscalatingDimId(null)
    }
  }

  async function handleSaveAndContinue() {
    if (!currentItem || !currentState || !allDiscrepanciesScored) return
    const feedbackItemId = currentItem.feedbackItemId

    setSaving(true)
    setSaveStatus('saving')
    setSaveError(null)

    try {
      // Build scores array: all dimensions (agreed + resolved discrepancies).
      // Escalated AND adjudicator-resolved dimensions are intentionally excluded
      // — the adjudicator owns the reconciled Score row for those, and the pair
      // must not overwrite it. Each score carries the final this screen last
      // saw (`expectedFinal`), so the server refuses the save if a partner has
      // recorded something else since.
      const lockedDimIds = new Set(
        currentItem.discrepancies
          .filter((d) => d.escalation != null || d.adjudication != null)
          .map((d) => d.dimensionId)
      )
      const scores = Object.entries(currentState.scores)
        .filter(([dimensionId, v]) => v != null && !lockedDimIds.has(dimensionId))
        .map(([dimensionId, value]) => ({
          dimensionId,
          value: value!,
          expectedFinal: persistedFinals[finalKey(feedbackItemId, dimensionId)] ?? null,
        }))

      const res = await fetch(
        `/api/projects/${projectId}/batches/${batchId}/reconcile`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            releaseId,
            items: [
              {
                feedbackItemId,
                scores,
                notes: currentState.notes || undefined,
              },
            ],
          }),
        }
      )

      if (!res.ok) {
        const message = await readErrorMessage(res, 'Failed to save')
        // Rule rejections (403), stale/concurrent writes (409), and batch
        // locks (423) mean the server has moved on — re-sync with it (unsaved
        // selections on other items survive) and say what happened.
        if ([403, 409, 423].includes(res.status)) {
          setSyncNotice(message)
          setSaveStatus('idle')
          await fetchDiscrepancies()
          return
        }
        setSaveError(message)
        setSaveStatus('error')
        return
      }

      const data: ReconcileSaveResponse = await res.json()

      // Mark as saved
      setItemStates((prev) => ({
        ...prev,
        [feedbackItemId]: {
          ...prev[feedbackItemId],
          saved: true,
        },
      }))
      // The saved values are now the persisted finals — the concession rule,
      // the unsaved guard and the next save's expectedFinal all key off these.
      setPersistedFinals((prev) => {
        const next = { ...prev }
        for (const s of scores) {
          next[finalKey(feedbackItemId, s.dimensionId)] = s.value
        }
        return next
      })
      setPersistedNotes((prev) => ({ ...prev, [feedbackItemId]: currentState.notes }))
      // Server truth after this save: did the release complete?
      if (data.releaseStatus) setReleaseStatus(data.releaseStatus)
      if (typeof data.openEscalationCount === 'number') {
        setOpenEscalationCount(data.openEscalationCount)
      }
      setSyncNotice(null)
      setSaveStatus('saved')

      // Advance to the next item the pair still owes a final on
      const nextPending = items.findIndex(
        (item, i) =>
          i > currentIndex &&
          !itemStates[item.feedbackItemId]?.saved &&
          item.discrepancies.some(isOpenCell)
      )
      if (nextPending !== -1) {
        setTimeout(() => setCurrentIndex(nextPending), 300)
      }
    } catch (err) {
      console.error('Save failed:', err)
      setSaveError('Could not reach the server. Check your connection and try again.')
      setSaveStatus('error')
    } finally {
      setSaving(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Loading / end-of-list states — branched on the server's view of the release
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <AppShell defaultCollapsed>
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        </div>
      </AppShell>
    )
  }

  if (outcome.kind === 'error') {
    return (
      <AppShell defaultCollapsed>
        <div className="flex flex-1 items-center justify-center py-20">
          <Card className="max-w-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="size-5" />
                Couldn&apos;t load this batch
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{outcome.message}</p>
              <div className="mt-4 flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setLoading(true)
                    fetchDiscrepancies()
                  }}
                >
                  <RefreshCw className="mr-1 size-4" />
                  Retry
                </Button>
                <Button variant="ghost" onClick={handleBackToDashboard}>
                  Return to Dashboard
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </AppShell>
    )
  }

  // No discrepancies - all scores matched (and the server confirms COMPLETE)
  if (outcome.kind === 'no-discrepancies') {
    return (
      <AppShell defaultCollapsed>
        <div className="mx-auto flex max-w-lg flex-col items-center justify-center gap-4 py-20 text-center">
          <CheckCircle className="size-16 text-success" />
          <h2 className="text-xl font-semibold">No Discrepancies Found</h2>
          <p className="text-sm text-muted-foreground">
            All scores in this batch match between evaluators. No reconciliation needed.
          </p>
          <Button onClick={handleBackToDashboard}>Return to Dashboard</Button>
        </div>
      </AppShell>
    )
  }

  // The server says COMPLETE — show the completion summary, with an escape
  // hatch back into editing (unless an admin has locked the batch). reviewMode
  // bypasses this.
  if (outcome.kind === 'complete' && !reviewMode) {
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
          {syncNoticeBanner}
          {isLocked ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <Lock className="size-3.5 shrink-0" />
              This batch has been locked by an admin. Scores can no longer be changed.
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Need to change a final score? You can edit it until an admin locks
              the batch.
            </p>
          )}
          <div className="flex items-center gap-2">
            {!isLocked && (
              <Button
                variant="outline"
                onClick={() => {
                  setCurrentIndex(0)
                  setReviewMode(true)
                }}
              >
                <Pencil className="mr-1 size-4" />
                Edit reconciled scores
              </Button>
            )}
            <Button onClick={handleBackToDashboard}>Return to Dashboard</Button>
          </div>
        </div>
      </AppShell>
    )
  }

  // Nothing left for the pair, but open escalations keep the release
  // RECONCILING. Say so — this is NOT complete until the adjudicator rules.
  if (outcome.kind === 'awaiting-adjudicator' && !reviewMode) {
    const n = outcome.openEscalationCount
    return (
      <AppShell defaultCollapsed>
        <div className="mx-auto flex max-w-lg flex-col items-center justify-center gap-4 py-20 text-center">
          <Hourglass className="size-16 text-primary" />
          <h2 className="text-xl font-semibold">Waiting on the adjudicator</h2>
          <p className="text-sm text-muted-foreground">
            You and your partner have recorded everything you can.{' '}
            <span className="font-medium text-foreground">
              {n} {n === 1 ? 'criterion is' : 'criteria are'} waiting on the adjudicator
            </span>
            . This batch will show as complete once {n === 1 ? 'it is' : 'they are'} resolved.
          </p>
          {syncNoticeBanner}
          {outcome.itemIds.length > 0 && (
            <ul className="flex w-full flex-col gap-1.5 text-left">
              {outcome.itemIds.map((id) => {
                const idx = items.findIndex((it) => it.feedbackItemId === id)
                const item = items[idx]
                if (!item) return null
                const labels = item.discrepancies
                  .filter((d) => d.escalation != null)
                  .map((d) => d.dimensionLabel)
                return (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => {
                        setCurrentIndex(idx)
                        setReviewMode(true)
                      }}
                      className="flex w-full items-center justify-between gap-3 rounded-lg bg-muted/30 px-3 py-2 text-sm transition-all duration-200 hover:bg-muted/60"
                    >
                      <span className="flex items-center gap-2">
                        <Flag className="size-3.5 shrink-0 text-primary" />
                        Item {idx + 1}
                        {item.activityId && (
                          <span className="text-xs text-muted-foreground">
                            · Activity {item.activityId}
                          </span>
                        )}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {labels.join(', ')}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          <div className="flex items-center gap-2">
            {!isLocked && (
              <Button
                variant="outline"
                onClick={() => {
                  setCurrentIndex(0)
                  setReviewMode(true)
                }}
              >
                <Pencil className="mr-1 size-4" />
                Review items
              </Button>
            )}
            <Button onClick={handleBackToDashboard}>Return to Dashboard</Button>
          </div>
        </div>
      </AppShell>
    )
  }

  // Nothing left for the pair, nothing escalated, but the server hasn't marked
  // the release COMPLETE (yet). Neutral — don't claim a completion the server
  // hasn't confirmed.
  if (outcome.kind === 'finalizing' && !reviewMode) {
    return (
      <AppShell defaultCollapsed>
        <div className="mx-auto flex max-w-lg flex-col items-center justify-center gap-4 py-20 text-center">
          <Scale className="size-16 text-muted-foreground" />
          <h2 className="text-xl font-semibold">Nothing left for you here</h2>
          <p className="text-sm text-muted-foreground">
            Every discrepancy has a final score and nothing is waiting on the
            adjudicator. The batch will finalize shortly.
          </p>
          {syncNoticeBanner}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setLoading(true)
                fetchDiscrepancies()
              }}
            >
              <RefreshCw className="mr-1 size-4" />
              Check again
            </Button>
            {!isLocked && items.length > 0 && (
              <Button
                variant="outline"
                onClick={() => {
                  setCurrentIndex(0)
                  setReviewMode(true)
                }}
              >
                <Pencil className="mr-1 size-4" />
                Edit reconciled scores
              </Button>
            )}
            <Button onClick={handleBackToDashboard}>Return to Dashboard</Button>
          </div>
        </div>
      </AppShell>
    )
  }

  // reviewMode with an empty list has nothing to edit.
  if (!currentItem) {
    return (
      <AppShell defaultCollapsed>
        <div className="mx-auto flex max-w-lg flex-col items-center justify-center gap-4 py-20 text-center">
          <Scale className="size-16 text-muted-foreground" />
          <h2 className="text-xl font-semibold">Nothing to edit</h2>
          <Button onClick={handleBackToDashboard}>Return to Dashboard</Button>
        </div>
      </AppShell>
    )
  }

  const pendingCount = pendingSet.size

  return (
    <AppShell defaultCollapsed>
      {/* Sticky header with navigation */}
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 px-4 py-3 backdrop-blur-lg supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex max-w-7xl flex-col gap-3">
          {/* Top row: back + project info + progress */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="sm" onClick={handleBackToDashboard}>
                <ArrowLeft className="mr-1 size-4" />
                Dashboard
              </Button>
              <span className="text-sm font-medium">{batchName}</span>
              {isLocked ? (
                <Badge variant="outline" className="bg-muted text-muted-foreground">
                  <Lock className="mr-1 size-3" />
                  Locked
                </Badge>
              ) : reviewMode ? (
                <Badge
                  variant="outline"
                  className="bg-status-complete-bg text-status-complete-text"
                >
                  <Pencil className="mr-1 size-3" />
                  Editing reconciled
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="bg-status-reconciliation-bg text-status-reconciliation-text"
                >
                  Reconciling
                </Badge>
              )}
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Scale className="size-3.5" />
              <span>
                {items.length - pendingCount} of {items.length} items reconciled
                {openEscalationCount > 0 && (
                  <> · {openEscalationCount} escalated</>
                )}
                {hasDirty && (
                  <span className="text-foreground">
                    {' '}· {dirtyIds.length} unsaved
                  </span>
                )}
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
              {buildNavWindow(currentIndex, items.length, 5).map((entry, i) => {
                if (entry === '...') {
                  return (
                    <span key={`ellipsis-${i}`} className="px-1 text-xs text-muted-foreground">
                      ...
                    </span>
                  )
                }
                const index = entry as number
                const navItem = items[index]
                const navIsDirty = navItem ? dirtySet.has(navItem.feedbackItemId) : false
                const navIsPending = navItem ? pendingSet.has(navItem.feedbackItemId) : false
                return (
                  <span key={entry} className="relative">
                    <button
                      onClick={() => setCurrentIndex(index)}
                      aria-label={`Item ${index + 1}${navIsDirty ? ' (unsaved selection)' : ''}`}
                      title={navIsDirty ? 'Unsaved selection' : undefined}
                      className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium transition-all duration-200 ${
                        index === currentIndex
                          ? 'bg-nav-current-bg text-nav-current-text ring-2 ring-nav-current-ring'
                          : !navIsPending
                            ? 'bg-nav-scored-bg text-nav-scored-text'
                            : 'bg-nav-unscored-bg text-nav-unscored-text hover:opacity-80'
                      }`}
                    >
                      {index + 1}
                    </button>
                    {navIsDirty && (
                      <span
                        aria-hidden
                        className="pointer-events-none absolute -right-0.5 -top-0.5 size-2 rounded-full bg-status-reconciliation-text ring-2 ring-background"
                      />
                    )}
                  </span>
                )
              })}
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

      {isLocked && (
        <div className="border-b border-border bg-muted/40 px-4 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center gap-2 text-xs text-muted-foreground">
            <Lock className="size-3.5 shrink-0" />
            <span>
              This batch has been locked by an admin. Final scores are frozen and
              can no longer be changed.
            </span>
          </div>
        </div>
      )}

      {/* Split pane: left (content) + right (reconciliation) */}
      <main className="mx-auto flex w-full max-w-7xl flex-1 gap-6 p-4 lg:p-6">
        {/* Left column: student response + feedback */}
        <div className="flex w-full flex-col gap-4 lg:w-1/2">
          {currentItem.activityId && (
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
                    const flag = getOptimalFlag(currentItem.optimal)
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
                {currentItem.studentText}
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
                {currentItem.feedbackText}
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
              {syncNoticeBanner}

              {/* Discrepant dimensions - need manual resolution */}
              {currentItem.discrepancies.map((disc) => {
                const scoreLabels = parseScoreLabels(disc.scoreLabelJson)
                const finalValue = currentState?.scores[disc.dimensionId] ?? null
                const isAdjudicated = disc.adjudication != null
                const isEscalated = disc.escalation != null
                const isEscalatingThis = escalatingDimId === disc.dimensionId
                const thisActionError =
                  actionError &&
                  actionError.feedbackItemId === currentItem.feedbackItemId &&
                  actionError.dimensionId === disc.dimensionId
                    ? actionError.message
                    : null

                const scaleOptions = getScaleOptions(disc.scaleMin, disc.scaleMax)

                return (
                  <div key={disc.dimensionId} className="flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                      {isAdjudicated ? (
                        <Gavel className="size-3.5 text-primary" />
                      ) : isEscalated ? (
                        <Flag className="size-3.5 text-primary" />
                      ) : (
                        <AlertTriangle className="size-3.5 text-warning" />
                      )}
                      <Label className="text-base font-bold text-foreground">
                        {disc.dimensionLabel}
                      </Label>
                      {isAdjudicated ? (
                        <Badge
                          variant="outline"
                          className="border-primary/30 bg-primary/10 text-[10px] text-primary"
                        >
                          Resolved by adjudicator
                        </Badge>
                      ) : isEscalated ? (
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

                    {/* Locked (adjudicator resolved) OR escalated OR picker */}
                    {isAdjudicated ? (
                      <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Gavel className="size-3.5 shrink-0 text-primary" />
                          <span>
                            Final score set by the adjudicator
                            {disc.adjudication?.resolvedByName
                              ? ` (${disc.adjudication.resolvedByName})`
                              : ''}
                            . This decision is final.
                          </span>
                        </div>
                        {finalValue != null && (
                          <span
                            className={`inline-flex shrink-0 rounded-lg border-2 px-2.5 py-1 text-xs font-medium ${getSelectedScoreColor(
                              finalValue,
                              disc.scaleMin,
                              disc.scaleMax
                            )}`}
                          >
                            {scoreLabels[finalValue]?.label ?? finalValue}
                          </span>
                        )}
                      </div>
                    ) : isEscalated ? (
                      <div className="flex items-center justify-between rounded-lg bg-primary/5 px-3 py-2 text-xs">
                        <span className="text-muted-foreground">
                          Waiting on adjudicator to resolve.
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 gap-1 px-2 text-xs"
                          disabled={isEscalatingThis || isLocked}
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
                                  disabled={isLocked}
                                  onClick={() =>
                                    handleFinalScoreChange(disc.dimensionId, val)
                                  }
                                  className={`rounded-xl border-2 px-4 py-3 text-left text-sm font-medium transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50 ${
                                    isSelected
                                      ? getSelectedScoreColor(
                                          val,
                                          disc.scaleMin,
                                          disc.scaleMax
                                        )
                                      : `${getUnselectedOptionColor()} hover:shadow-md`
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
                          disabled={isEscalatingThis || !hasAdjudicator || isLocked}
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

                    {thisActionError && (
                      <p
                        role="alert"
                        className="flex items-center gap-1.5 text-xs text-destructive"
                      >
                        <AlertTriangle className="size-3 shrink-0" />
                        {thisActionError}
                      </p>
                    )}
                  </div>
                )
              })}

              {/* Agreed dimensions - read-only */}
              {currentItem.agreements.length > 0 && (
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
              {currentItem.coders.some((c) => c.notes && c.notes.trim()) && (
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
                  disabled={isLocked}
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
                      <span>Save failed{saveError ? ` — ${saveError}` : ''}</span>
                    </>
                  )}
                  {saveStatus === 'idle' && currentIsDirty && (
                    <>
                      <span
                        aria-hidden
                        className="size-2 rounded-full bg-status-reconciliation-text"
                      />
                      <span>Unsaved — selections are recorded when you save</span>
                    </>
                  )}
                </div>
              </div>

              {/* Save & Continue button */}
              <Button
                onClick={handleSaveAndContinue}
                disabled={
                  isLocked ||
                  !allDiscrepanciesScored ||
                  saving ||
                  currentState?.saved
                }
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
                ) : saveStatus === 'error' ? (
                  'Retry save'
                ) : (
                  'Save & Continue'
                )}
              </Button>
            </CardContent>
          </Card>
        </div>
      </main>

      {/* Warn before changing a final score the pair already reconciled. */}
      <Dialog
        open={pendingEdit != null}
        onOpenChange={(open) => {
          if (!open) setPendingEdit(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-warning" />
              Change an already-reconciled score?
            </DialogTitle>
            <DialogDescription>
              You and your partner already reconciled this item. Changing the
              final score will overwrite the value you saved. This is fine if you
              meant to revise it — just confirm you want to change it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingEdit(null)}>
              Keep current score
            </Button>
            <Button
              onClick={() => {
                if (pendingEdit) {
                  applyFinalScore(pendingEdit.dimensionId, pendingEdit.value)
                }
                setPendingEdit(null)
              }}
            >
              Yes, change it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm before recording your OWN original as the final score. This is
          the concede-or-escalate speed bump: allowed, but only after you and
          your partner have agreed your score was right. */}
      <Dialog
        open={pendingSelfOriginal != null}
        onOpenChange={(open) => {
          if (!open) setPendingSelfOriginal(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-warning" />
              Record your own original score?
            </DialogTitle>
            <DialogDescription>
              This is the score you originally gave. Only record it as the final
              if you and your partner discussed the discrepancy and agreed your
              score was right. If you haven&apos;t discussed it, cancel — your
              partner can record it, or you can escalate to the adjudicator.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingSelfOriginal(null)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (pendingSelfOriginal) {
                  applyFinalScore(
                    pendingSelfOriginal.dimensionId,
                    pendingSelfOriginal.value
                  )
                }
                setPendingSelfOriginal(null)
              }}
            >
              Yes, we agreed
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Leaving with unsaved selections. Nothing here auto-saves: a final is
          only recorded on "Save & Continue". */}
      <Dialog
        open={pendingLeave}
        onOpenChange={(open) => {
          if (!open) setPendingLeave(false)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-warning" />
              Leave without saving?
            </DialogTitle>
            <DialogDescription>
              {dirtyIds.length === 1
                ? 'One item has'
                : `${dirtyIds.length} items have`}{' '}
              a final score or rationale you picked but haven&apos;t saved.
              Selections are only recorded when you click Save &amp; Continue —
              if you leave now, they will be lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingLeave(false)}>
              Stay
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setPendingLeave(false)
                router.push('/')
              }}
            >
              Leave anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  )
}
