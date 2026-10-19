'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
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
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  ChevronLeft,
  ChevronRight,
  CheckCircle,
  Clock,
  Loader2,
  AlertTriangle,
  ArrowLeft,
  Eye,
  FileText,
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
import { QUILL_FEEDBACK_RUBRIC } from '@/lib/rubric-templates'
import {
  SAVE_FAILED_MESSAGE,
  ScoreAutosave,
  buildScorePayload,
  combinePersistResults,
  persistResultFromResponse,
  scoreSnapshot,
  type AutosaveStatus,
  type PersistResult,
  type ScoreSavePayload,
} from '@/lib/score-autosave'
import {
  hydrateItemScores,
  isFullyScored,
  type HydrationScoreRow,
  type ItemScoreState,
} from '@/lib/score-hydration'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RubricDimension {
  id: string
  key: string
  label: string
  description: string | null
  sortOrder: number
  scaleMin: number
  scaleMax: number
  scoreLabelJson: string | null
  guidanceJson: string | null
}

interface FeedbackItem {
  id: string
  activityId: string | null
  conjunctionId: string | null
  studentText: string
  feedbackText: string
  optimal: string | null
  displayOrder: number | null
}

interface ProjectData {
  id: string
  name: string
  rubric: RubricDimension[]
}

interface RubricContentBlock {
  type: 'paragraph' | 'bullet' | 'label'
  text: string
}

interface RubricDimensionGuidance {
  prompt: string
  meets: RubricContentBlock[]
  doesNotMeet: RubricContentBlock[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function parseGuidance(
  json: string | null
): RubricDimensionGuidance | null {
  if (!json) return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

// Build a windowed list of indices + ellipsis markers for navigation
// e.g. [0, '...', 44, 45, 46, 47, 48, '...', 2099]
// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface TeamInfo {
  teamId: string
  teamName: string
  dimensionIds: string[]
  dimensions: { id: string; key: string; label: string; sortOrder: number }[]
  partner: { id: string; name: string | null; email: string } | null
}

export function EvaluateClient({
  projectId,
  userName,
  batchId,
  batchType,
  readOnly = false,
  reviseDimensionId,
  reviseBatchName,
}: {
  projectId: string
  userName: string
  batchId: string
  batchType?: string
  // The viewer has no open assignment on this batch (an admin previewing):
  // show the items and criteria, record nothing. The server refuses such
  // writes anyway; this keeps the screen honest about it.
  readOnly?: boolean
  // When set, this is the "re-open one criterion" flow: the rubric is filtered
  // to just this dimension and saves are routed through the revise endpoint
  // (which allows editing a closed/reconciling batch). Everything else — the
  // numbered nav, notes, auto-save, Continue/auto-advance — is the normal
  // scoring UI, so it feels identical to the original scoring session.
  reviseDimensionId?: string
  reviseBatchName?: string
}) {
  const router = useRouter()

  // Data
  const [project, setProject] = useState<ProjectData | null>(null)
  const [fullRubric, setFullRubric] = useState<RubricDimension[]>([])
  const [items, setItems] = useState<FeedbackItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Navigation
  const [currentIndex, setCurrentIndex] = useState(0)
  // When every item is scored we show a completion screen; "Review Scores"
  // flips this so the scoring UI re-renders and the annotator can page back
  // through finished items (P13).
  const [reviewing, setReviewing] = useState(false)

  // Per-item scoring state, keyed by feedbackItem id
  const [itemScores, setItemScores] = useState<Record<string, ItemScoreState>>(
    {}
  )

  // UI & saving
  const [saving, setSaving] = useState(false) // explicit Continue in progress
  const [leaving, setLeaving] = useState(false) // flushing before dashboard
  // Save status per item, so an item whose save failed after the annotator
  // moved on still reports it when they come back (and in the header).
  const [statusByItem, setStatusByItem] = useState<
    Record<string, { status: AutosaveStatus; message?: string }>
  >({})

  // Timing
  const interactedRef = useRef(false)

  // Auto-save. The scheduler owns the debounce timers and the request queue
  // (see src/lib/score-autosave.ts for why: Batch 65 / F4287). It lives
  // outside React's effect lifecycle so navigating away cannot cancel a
  // pending save, and it re-sends anything changed while a request is out.
  const persistRef = useRef<
    (payload: { feedbackItemId: string } & ScoreSavePayload) => Promise<PersistResult>
  >(async () => ({ ok: false, message: SAVE_FAILED_MESSAGE, terminal: false }))
  const [autosave] = useState(
    () =>
      new ScoreAutosave<ScoreSavePayload>({
        debounceMs: 1000,
        persist: (itemId, payload) =>
          persistRef.current({ feedbackItemId: itemId, ...payload }),
        onStatus: (itemId, status, message) => {
          setStatusByItem((prev) => {
            const current = prev[itemId]
            if (current?.status === status && current?.message === message) {
              return prev
            }
            return { ...prev, [itemId]: { status, message } }
          })
          // The server now holds everything for this item. If that is a value
          // for every criterion, the item is scored — however the annotator
          // left it (arrows, numbered circles, closing the tab), not only via
          // Continue. Nav, progress and the completion screen all read `saved`.
          if (status === 'saved') {
            setItemScores((prev) => {
              const state = prev[itemId]
              if (!state || state.saved || !isFullyScored(state)) return prev
              return { ...prev, [itemId]: { ...state, saved: true } }
            })
          }
        },
      })
  )

  // ---------------------------------------------------------------------------
  // Fetch data
  // ---------------------------------------------------------------------------

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)

      const [projectRes, itemsRes, teamRes] = await Promise.all([
        fetch(`/api/projects/${projectId}`),
        fetch(`/api/feedback-items?projectId=${projectId}&batchId=${batchId}`),
        fetch(`/api/my-team?projectId=${projectId}`),
      ])

      if (!projectRes.ok) {
        throw new Error(
          `Failed to load project: ${projectRes.status} ${projectRes.statusText}`
        )
      }
      if (!itemsRes.ok) {
        throw new Error(
          `Failed to load feedback items: ${itemsRes.status} ${itemsRes.statusText}`
        )
      }

      const projectData: ProjectData = await projectRes.json()
      const itemsData: FeedbackItem[] = await itemsRes.json()

      // Fetch team info for criteria filtering
      let team: TeamInfo | null = null
      if (teamRes.ok) {
        team = await teamRes.json()
      }

      // Preserve the full project rubric for the reference drawer, even when
      // team-scored batches only expose a subset for active scoring.
      const allRubric = [...projectData.rubric].sort(
        (a, b) => a.sortOrder - b.sortOrder
      )
      setFullRubric(allRubric)

      // Sort rubric by sortOrder
      projectData.rubric = allRubric

      // Filter rubric to only the evaluator's team dimensions
      // UNLESS this is a training batch (show all criteria)
      const isTraining = batchType === 'TRAINING'
      if (team && !isTraining) {
        const teamDimIds = new Set(team.dimensionIds)
        projectData.rubric = projectData.rubric.filter((d) =>
          teamDimIds.has(d.id)
        )
      }

      // Revise mode: expose ONLY the single re-opened criterion for scoring.
      if (reviseDimensionId) {
        projectData.rubric = allRubric.filter((d) => d.id === reviseDimensionId)
      }

      // Sort items by displayOrder (nulls last), then by id for stable ordering
      itemsData.sort((a, b) => {
        const aOrd = a.displayOrder ?? Number.MAX_SAFE_INTEGER
        const bOrd = b.displayOrder ?? Number.MAX_SAFE_INTEGER
        if (aOrd !== bOrd) return aOrd - bOrd
        return a.id.localeCompare(b.id)
      })

      // Hydrate from the raw scores the server holds for this annotator on
      // this batch. The route returns raw rows only and hydrateItemScores
      // ignores a reconciled row regardless, so a pair's final can never show
      // up (or be re-saved) as the annotator's own score.
      let existingScores: HydrationScoreRow[] = []
      try {
        const existingRes = await fetch(
          `/api/scores?projectId=${projectId}&batchId=${batchId}`
        )
        if (existingRes.ok) existingScores = await existingRes.json()
      } catch {
        // Non-critical — just means we start fresh
      }
      const initialScores = hydrateItemScores(
        itemsData.map((item) => item.id),
        projectData.rubric,
        existingScores
      )

      // Tell the scheduler what the server already holds, so merely opening
      // an already-scored item does not re-send it (which would also re-stamp
      // its scoredAt).
      autosave.reset()
      for (const [itemId, state] of Object.entries(initialScores)) {
        if (state.scores.some((s) => s.value !== null)) {
          autosave.markSaved(itemId, scoreSnapshot(state))
        }
      }

      // Items and their scores must land in the same render: arriving at the
      // first item reads its saved state once, so it has to be there already.
      setProject(projectData)
      setItems(itemsData)
      setItemScores(initialScores)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }, [projectId, batchId, batchType, reviseDimensionId, autosave])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const currentItem = items[currentIndex] ?? null
  const currentScoreState = currentItem ? itemScores[currentItem.id] : null

  // ---------------------------------------------------------------------------
  // Arriving at an item
  // ---------------------------------------------------------------------------

  // Whether the item was already complete when the annotator arrived at it.
  // Drives the button label: "Continue" on a first pass (even once auto-save
  // has caught up with the last criterion), "Update & Continue" when revisiting
  // a scored item. Read through a ref so arriving — not every score change —
  // is what sets it.
  const itemScoresRef = useRef(itemScores)
  useEffect(() => {
    itemScoresRef.current = itemScores
  }, [itemScores])
  const [savedOnArrival, setSavedOnArrival] = useState(false)
  useEffect(() => {
    interactedRef.current = false
    setSavedOnArrival(
      currentItem ? (itemScoresRef.current[currentItem.id]?.saved ?? false) : false
    )
  }, [currentItem])
  const scoredCount = Object.values(itemScores).filter((s) => s.saved).length
  const totalCount = items.length
  const allComplete = totalCount > 0 && scoredCount === totalCount
  const progressPercent = totalCount > 0 ? (scoredCount / totalCount) * 100 : 0

  const allDimensionsScored =
    currentScoreState?.scores.every((s) => s.value !== null) ?? false

  // Persist one item's scores. In revise mode, saves go to the revise endpoint
  // (which allows editing a closed/reconciling batch and only re-derives
  // reconciliation when a value actually changed); otherwise the normal
  // /api/scores upsert. The result carries the server's reason on failure and
  // whether retrying could help (a 403/404/423 cannot be fixed by resending).
  //
  // `keepalive` lets a request flushed on beforeunload finish even if the
  // annotator confirms leaving; a plain fetch is cancelled with the page.
  const persistItemScores = useCallback(
    async (payload: {
      feedbackItemId: string
      scores: { dimensionId: string; value: number }[]
      notes?: string
      startedAt?: string
    }): Promise<PersistResult> => {
      if (reviseDimensionId) {
        const results = await Promise.all(
          payload.scores.map((s) =>
            fetch(`/api/projects/${projectId}/batches/${batchId}/revise`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              keepalive: true,
              body: JSON.stringify({
                feedbackItemId: payload.feedbackItemId,
                dimensionId: s.dimensionId,
                value: s.value,
                notes: payload.notes,
              }),
            }).then(persistResultFromResponse)
          )
        )
        return combinePersistResults(results)
      }
      const res = await fetch('/api/scores', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          feedbackItemId: payload.feedbackItemId,
          scores: payload.scores,
          notes: payload.notes,
          startedAt: payload.startedAt,
        }),
      })
      return persistResultFromResponse(res)
    },
    [reviseDimensionId, batchId, projectId]
  )

  useEffect(() => {
    persistRef.current = persistItemScores
  }, [persistItemScores])

  // ---------------------------------------------------------------------------
  // Auto-save: hand every local change to the scheduler (1s debounce)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (readOnly || !currentItem || !currentScoreState) return
    // A save carries only scored criteria; with none there is nothing to send.
    if (!currentScoreState.scores.some((s) => s.value !== null)) return
    autosave.update(
      currentItem.id,
      buildScorePayload(currentScoreState),
      scoreSnapshot(currentScoreState)
    )
  }, [readOnly, currentItem, currentScoreState, autosave])

  // Reload / tab close while something is unsaved: send every dirty item now,
  // concurrently (the serialized queue would only get its first keepalive
  // request out before the page is gone) and ask the browser to warn.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!autosave.isDirty()) return
      void autosave.flushAllNow()
      event.preventDefault()
      // Chrome/Edge < 119 only show the prompt when returnValue is set.
      event.returnValue = true
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [autosave])

  // Client-side navigation (sidebar links) never fires beforeunload, so send
  // whatever is pending as the screen goes away. The requests outlive the
  // component.
  useEffect(() => {
    return () => {
      void autosave.flushAll()
    }
  }, [autosave])

  const currentStatus = currentItem ? statusByItem[currentItem.id] : undefined
  const saveStatus: AutosaveStatus = currentStatus?.status ?? 'idle'
  const saveMessage = currentStatus?.message
  const failedIndexes = items.flatMap((item, i) =>
    statusByItem[item.id]?.status === 'error' ? [i] : []
  )

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  // Every way off an item goes through here so its pending debounce is sent
  // first. The flush is not awaited: the scheduler keeps the request alive
  // regardless of which item is on screen, and that item's status (plus the
  // header warning) reports the outcome.
  function goToItem(index: number) {
    if (currentItem) void autosave.flush(currentItem.id)
    setCurrentIndex(index)
  }

  async function handleBackToDashboard() {
    setLeaving(true)
    const ok = await autosave.flushAll()
    // Leave when everything persisted, or when what failed can never persist
    // (the server rejected it for good, so there is nothing left to retry).
    if (ok || !autosave.isDirty()) {
      router.push('/')
      return
    }
    // Stay, on the item whose save failed, so it can be retried.
    setLeaving(false)
    const failedIndex = items.findIndex((item) => autosave.isDirty(item.id))
    if (failedIndex !== -1) setCurrentIndex(failedIndex)
  }

  // ---------------------------------------------------------------------------
  // Score handlers
  // ---------------------------------------------------------------------------

  function handleScoreChange(dimensionId: string, value: number) {
    if (readOnly || !currentItem) return

    // Mark first interaction time
    if (!interactedRef.current) {
      interactedRef.current = true
      setItemScores((prev) => ({
        ...prev,
        [currentItem.id]: {
          ...prev[currentItem.id],
          startedAt: prev[currentItem.id].startedAt ?? new Date().toISOString(),
        },
      }))
    }

    setItemScores((prev) => ({
      ...prev,
      [currentItem.id]: {
        ...prev[currentItem.id],
        saved: false,
        scores: prev[currentItem.id].scores.map((s) =>
          s.dimensionId === dimensionId ? { ...s, value } : s
        ),
      },
    }))
  }

  function handleNotesChange(notes: string) {
    if (readOnly || !currentItem) return
    setItemScores((prev) => ({
      ...prev,
      [currentItem.id]: {
        ...prev[currentItem.id],
        notes,
      },
    }))
  }

  // ---------------------------------------------------------------------------
  // Save & Continue
  // ---------------------------------------------------------------------------

  async function handleContinue() {
    if (readOnly || !currentItem || !currentScoreState || !allDimensionsScored) {
      return
    }

    setSaving(true)
    try {
      // Explicit save: always sent (with timing data), queued behind any
      // auto-save already in flight for this item rather than skipped.
      const ok = await autosave.save(
        currentItem.id,
        buildScorePayload({
          ...currentScoreState,
          startedAt: currentScoreState.startedAt ?? new Date().toISOString(),
        }),
        scoreSnapshot(currentScoreState)
      )
      // On failure the status chip shows "Save failed" with a Retry.
      if (!ok) return

      // Mark saved
      setItemScores((prev) => ({
        ...prev,
        [currentItem.id]: {
          ...prev[currentItem.id],
          saved: true,
        },
      }))

      // Auto-advance to next unscored item
      const nextUnscoredIndex = items.findIndex(
        (item, i) => i > currentIndex && !itemScores[item.id]?.saved
      )
      if (nextUnscoredIndex !== -1) {
        setCurrentIndex(nextUnscoredIndex)
      } else if (currentIndex < items.length - 1) {
        setCurrentIndex(currentIndex + 1)
      }
    } finally {
      setSaving(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Loading / error states
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <AppShell defaultCollapsed>
        <div className="flex min-h-screen items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Loading evaluation...</p>
          </div>
        </div>
      </AppShell>
    )
  }

  if (error) {
    return (
      <AppShell defaultCollapsed>
        <div className="flex min-h-screen items-center justify-center">
          <Card className="max-w-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="size-5" />
                Error
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button
                className="mt-4"
                variant="outline"
                onClick={() => {
                  setError(null)
                  fetchData()
                }}
              >
                Try Again
              </Button>
            </CardContent>
          </Card>
        </div>
      </AppShell>
    )
  }

  if (!project || items.length === 0) {
    return (
      <AppShell defaultCollapsed>
        <div className="flex min-h-screen items-center justify-center">
          <Card className="max-w-md">
            <CardHeader>
              <CardTitle>No Items to Evaluate</CardTitle>
              <CardDescription>
                There are no feedback items assigned to you for this project.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={handleBackToDashboard}>
                Return to Dashboard
              </Button>
            </CardContent>
          </Card>
        </div>
      </AppShell>
    )
  }

  // ---------------------------------------------------------------------------
  // Completion screen
  // ---------------------------------------------------------------------------

  // Revise mode always lands directly in the scoring UI: every item is already
  // scored, so the "All Items Scored" completion screen would otherwise block it.
  // A read-only preview has nothing to complete.
  if (allComplete && !reviewing && !reviseDimensionId && !readOnly) {
    return (
      <AppShell defaultCollapsed>
        <div className="flex min-h-screen items-center justify-center">
          <Card className="max-w-lg text-center">
            <CardHeader>
              <div className="mx-auto mb-2 flex size-16 items-center justify-center rounded-full bg-success/10">
                <CheckCircle className="size-8 text-success" />
              </div>
              <CardTitle className="text-xl">All Items Scored!</CardTitle>
              <CardDescription>
                You have completed scoring all {totalCount} feedback items for{' '}
                <span className="font-medium text-foreground">
                  {project.name}
                </span>
                .
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 sm:flex-row sm:justify-center">
              <Button
                variant="outline"
                onClick={() => {
                  setReviewing(true)
                  setCurrentIndex(0)
                }}
              >
                Review Scores
              </Button>
              <Button onClick={handleBackToDashboard} disabled={leaving}>
                {leaving && <Loader2 className="size-4 animate-spin" />}
                Return to Dashboard
              </Button>
            </CardContent>
          </Card>
        </div>
      </AppShell>
    )
  }

  // ---------------------------------------------------------------------------
  // Main scoring interface
  // ---------------------------------------------------------------------------

  const rubric = project.rubric

  // The Quill "optimal" indicator is only relevant to the Appropriate Feedback
  // Decision criterion, so only surface it to annotators actually assigned that
  // criterion (rubric is already filtered to the annotator's assigned criteria;
  // training batches and admins see all criteria, so it shows for them too).
  const showOptimalFlag = rubric.some(isAppropriateFeedbackDecision)

  return (
    <AppShell defaultCollapsed>
      <div className="flex min-h-screen flex-col">

      {/* Evaluation sub-header */}
      <header className="sticky top-0 z-10 border-b bg-background/95 px-4 py-3 shadow-sm backdrop-blur lg:top-0 supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex max-w-7xl flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleBackToDashboard}
                disabled={leaving}
                title="Back to Dashboard"
              >
                {leaving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ArrowLeft className="size-4" />
                )}
              </Button>
              <h1 className="text-lg font-semibold text-foreground">
                {project.name}
              </h1>
            </div>
            <Badge variant="secondary">{userName}</Badge>
          </div>

          {reviseDimensionId && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm">
              <Badge
                variant="outline"
                className="border-warning/40 bg-warning/10 text-warning"
              >
                Re-opened for revision
              </Badge>
              <span className="text-muted-foreground">
                {reviseBatchName ? `${reviseBatchName} — ` : ''}editing only{' '}
                <span className="font-medium text-foreground">
                  {project.rubric[0]?.label}
                </span>
              </span>
            </div>
          )}

          {readOnly && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
              <Badge variant="outline">
                <Eye className="size-3" />
                Preview — read only
              </Badge>
              <span className="text-muted-foreground">
                You are not assigned to score this batch, so nothing on this
                screen is recorded.
              </span>
            </div>
          )}

          {/* Progress bar */}
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-muted-foreground">
              {scoredCount} / {totalCount} scored
            </span>
            <div className="flex-1">
              <Progress value={progressPercent} />
            </div>
          </div>

          {/* Items whose last save failed, wherever the annotator is now */}
          {failedIndexes.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-destructive">
              <AlertTriangle className="size-3.5" />
              <span>Not saved yet:</span>
              {failedIndexes.map((index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => goToItem(index)}
                  className="rounded-md px-1.5 py-0.5 font-medium underline-offset-2 transition-all duration-200 hover:bg-destructive/10 hover:underline"
                >
                  item {index + 1}
                </button>
              ))}
              <span>Open the item to retry.</span>
            </div>
          )}

          {/* Navigation */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={currentIndex === 0}
              onClick={() => goToItem(currentIndex - 1)}
            >
              <ChevronLeft className="size-4" />
            </Button>

            <div className="flex flex-1 items-center justify-center gap-1">
              {buildNavWindow(currentIndex, items.length, 5).map((entry, i) =>
                entry === '...' ? (
                  <span key={`ellipsis-${i}`} className="px-1 text-sm text-muted-foreground">…</span>
                ) : (
                  <button
                    key={entry}
                    onClick={() => goToItem(entry as number)}
                    className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium transition-all duration-200 ${
                      entry === currentIndex
                        ? 'bg-nav-current-bg text-nav-current-text ring-2 ring-nav-current-ring'
                        : statusByItem[items[entry as number]?.id]?.status === 'error'
                          ? 'bg-nav-unscored-bg text-destructive ring-2 ring-destructive/60 hover:opacity-80'
                          : itemScores[items[entry as number]?.id]?.saved
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
              onClick={() => goToItem(currentIndex + 1)}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      {/* Split pane: left (content) + right (rubric) */}
      <main className="mx-auto flex w-full max-w-7xl flex-1 gap-6 p-4 lg:p-6">
        {/* Left column: activity + student response + feedback */}
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

        {/* Right column: rubric scoring */}
        <div className="flex w-full flex-col gap-4 lg:w-1/2">
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle>Score This Feedback</CardTitle>
                  <CardDescription>
                    {readOnly
                      ? 'The criteria annotators score this batch against.'
                      : 'Rate each criterion below. All criteria must be scored before continuing.'}
                  </CardDescription>
                </div>
                <Dialog>
                  <DialogTrigger
                    render={<Button variant="outline" size="sm" />}
                  >
                    <FileText className="size-4" />
                    View Full Rubric
                  </DialogTrigger>
                  <DialogContent
                    className="top-0 right-0 left-auto h-screen w-full max-w-2xl translate-x-0 translate-y-0 gap-0 rounded-none border-l p-0 sm:max-w-2xl"
                    showCloseButton
                  >
                    <DialogHeader className="border-b px-6 py-5">
                      <DialogTitle>Full Rubric</DialogTitle>
                      <DialogDescription>
                        Reference all rubric criteria and their answer-option
                        definitions while you score.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="flex-1 overflow-y-auto px-6 py-5">
                      <div className="mb-5 rounded-xl border bg-muted/30 p-4 text-sm">
                        <div className="font-medium text-foreground">
                          Rubric {QUILL_FEEDBACK_RUBRIC.version}
                        </div>
                        <div className="mt-2 space-y-1 text-muted-foreground">
                          <p>Student work:</p>
                          <p>Teacher feedback:</p>
                        </div>
                      </div>
                      <div className="space-y-4">
                        {fullRubric.map((dim) => {
                          const scoreLabels = parseScoreLabels(dim.scoreLabelJson)
                          const guidance = parseGuidance(dim.guidanceJson)
                          const scaleOptions = getScaleOptions(
                            dim.scaleMin,
                            dim.scaleMax
                          )

                          return (
                            <Card key={dim.id}>
                              <CardHeader className="pb-3">
                                <CardTitle className="text-base">
                                  {dim.label}
                                </CardTitle>
                                {(guidance?.prompt || dim.description) && (
                                  <CardDescription>
                                    {guidance?.prompt || dim.description}
                                  </CardDescription>
                                )}
                              </CardHeader>
                              <CardContent className="grid gap-3 lg:grid-cols-2">
                                {scaleOptions.map((val) => {
                                  const label = scoreLabels[val]
                                  const content =
                                    val === dim.scaleMin
                                      ? guidance?.doesNotMeet
                                      : guidance?.meets
                                  if (!label) return null

                                  return (
                                    <div
                                      key={`${dim.id}-${val}`}
                                      className={`rounded-xl border px-4 py-3 ${getScoreColor(
                                        val,
                                        dim.scaleMin,
                                        dim.scaleMax
                                      )}`}
                                    >
                                      <div className="text-sm font-semibold">
                                        {label.label}
                                      </div>
                                      {content && content.length > 0 && (
                                        <div className="mt-3 space-y-2 text-sm leading-relaxed">
                                          {content.map((block, index) => {
                                            if (block.type === 'label') {
                                              return (
                                                <div
                                                  key={`${dim.id}-${val}-${index}`}
                                                  className="text-xs font-semibold uppercase tracking-wide text-foreground/80"
                                                >
                                                  {block.text}
                                                </div>
                                              )
                                            }

                                            if (block.type === 'bullet') {
                                              return (
                                                <div
                                                  key={`${dim.id}-${val}-${index}`}
                                                  className="flex items-start gap-2"
                                                >
                                                  <span className="mt-1 size-1.5 shrink-0 rounded-full bg-current" />
                                                  <span>{block.text}</span>
                                                </div>
                                              )
                                            }

                                            return (
                                              <p
                                                key={`${dim.id}-${val}-${index}`}
                                              >
                                                {block.text}
                                              </p>
                                            )
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}
                              </CardContent>
                            </Card>
                          )
                        })}
                      </div>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              {rubric.map((dim) => {
                const scoreLabels = parseScoreLabels(dim.scoreLabelJson)
                const currentValue =
                  currentScoreState?.scores.find(
                    (s) => s.dimensionId === dim.id
                  )?.value ?? null

                const scaleOptions = getScaleOptions(dim.scaleMin, dim.scaleMax)

                return (
                  <div key={dim.id} className="flex flex-col gap-2">
                    <div>
                      <Label className="text-sm font-semibold text-foreground">
                        {dim.label}
                      </Label>
                      {dim.description && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {dim.description}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {scaleOptions.map((val) => {
                        const label = scoreLabels[val]
                        const isSelected = currentValue === val
                        return (
                          <button
                            key={val}
                            type="button"
                            disabled={readOnly}
                            onClick={() => handleScoreChange(dim.id, val)}
                            className={`rounded-xl border-2 px-4 py-3 text-left text-sm font-medium transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-60 ${
                              isSelected
                                ? getSelectedScoreColor(
                                    val,
                                    dim.scaleMin,
                                    dim.scaleMax
                                  )
                                : `${getUnselectedOptionColor()} ${readOnly ? '' : 'hover:shadow-md'}`
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

                    {currentValue !== null && scoreLabels[currentValue] && (
                      <p className="text-xs italic text-muted-foreground">
                        {scoreLabels[currentValue].description}
                      </p>
                    )}

                  </div>
                )
              })}

              {!readOnly && (
                <>
                  {/* Notes */}
                  <div className="border-t pt-4">
                    <Label className="text-sm font-semibold text-foreground">
                      Notes (optional)
                    </Label>
                    <Textarea
                      placeholder="Any additional notes about this feedback item..."
                      value={currentScoreState?.notes ?? ''}
                      onChange={(e) => handleNotesChange(e.target.value)}
                      className="mt-2 text-sm"
                      rows={3}
                    />
                  </div>

                  {/* Save status + timing indicator */}
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
                          <span>{saveMessage ?? SAVE_FAILED_MESSAGE}</span>
                          <button
                            type="button"
                            onClick={() =>
                              currentItem && void autosave.flush(currentItem.id)
                            }
                            className="font-medium text-foreground underline underline-offset-2 transition-all duration-200 hover:text-primary"
                          >
                            Retry
                          </button>
                        </>
                      )}
                      {saveStatus === 'rejected' && (
                        <>
                          <AlertTriangle className="size-3 text-warning" />
                          <span>
                            Not saved
                            {saveMessage ? ` — ${saveMessage}` : ''}
                          </span>
                        </>
                      )}
                    </div>
                    {currentScoreState?.startedAt && (
                      <div className="flex items-center gap-1.5">
                        <Clock className="size-3" />
                        <span>
                          Started{' '}
                          {new Date(
                            currentScoreState.startedAt
                          ).toLocaleTimeString()}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Continue button */}
                  <Button
                    className="w-full"
                    size="lg"
                    disabled={!allDimensionsScored || saving}
                    onClick={handleContinue}
                  >
                    {saving ? (
                      <>
                        <Loader2 className="size-4 animate-spin" />
                        Saving...
                      </>
                    ) : savedOnArrival ? (
                      <>
                        <CheckCircle className="size-4" />
                        Update & Continue
                      </>
                    ) : (
                      'Continue'
                    )}
                  </Button>

                  {!allDimensionsScored && (
                    <p className="text-center text-xs text-muted-foreground">
                      Score all {rubric.length} criteria to continue
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
      </div>
    </AppShell>
  )
}
