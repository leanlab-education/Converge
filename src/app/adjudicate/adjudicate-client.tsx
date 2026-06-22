'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Loader2, Gavel, CheckCircle, AlertTriangle } from 'lucide-react'
import { AppShell } from '@/components/app-shell'
import { getScoreColor, getSelectedScoreColor } from '@/lib/scoring-utils'
import {
  getOptimalFlag,
  isAppropriateFeedbackDecision,
} from '@/lib/optimal-indicator'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EscalationCoder {
  userId: string
  name: string | null
  email: string
  value: number
  notes: string | null
}

interface Dimension {
  id: string
  key: string
  label: string
  description: string | null
  sortOrder: number
  scaleMin: number
  scaleMax: number
  scoreLabelJson: string | null
}

interface EscalationItem {
  escalationId: string
  batch: {
    id: string
    name: string
    projectId: string
    project: { id: string; name: string }
  }
  feedbackItem: {
    id: string
    studentText: string
    feedbackText: string
    activityId: string | null
    conjunctionId: string | null
    displayOrder: number | null
    optimal: string | null
  }
  dimension: Dimension
  escalatedBy: { id: string; name: string | null; email: string }
  createdAt: string
  scores: EscalationCoder[]
  reconciliationNotes: string | null
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

export function AdjudicateClient({ userName }: { userName: string }) {
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<EscalationItem[]>([])
  const [selections, setSelections] = useState<
    Record<string, { value: number | null; notes: string }>
  >({})
  const [savingId, setSavingId] = useState<string | null>(null)

  const fetchQueue = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/adjudicate')
      if (!res.ok) throw new Error('Failed to load queue')
      const data = await res.json()
      setItems(data.items || [])
      // Initialize selection state
      setSelections((prev) => {
        const next = { ...prev }
        for (const it of data.items || []) {
          if (!next[it.escalationId]) {
            next[it.escalationId] = { value: null, notes: '' }
          }
        }
        return next
      })
    } catch (err) {
      console.error('Failed to load adjudicator queue:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchQueue()
  }, [fetchQueue])

  async function handleResolve(escalationId: string) {
    const sel = selections[escalationId]
    if (!sel || sel.value == null) return
    setSavingId(escalationId)
    try {
      const res = await fetch('/api/adjudicate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resolutions: [
            {
              escalationId,
              value: sel.value,
              notes: sel.notes || undefined,
            },
          ],
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        alert(err.error || 'Failed to resolve escalation')
        return
      }
      // Remove the resolved item from the queue without a full refetch
      setItems((prev) => prev.filter((it) => it.escalationId !== escalationId))
      setSelections((prev) => {
        const next = { ...prev }
        delete next[escalationId]
        return next
      })
    } finally {
      setSavingId(null)
    }
  }

  if (loading) {
    return (
      <AppShell>
        <div className="flex flex-1 items-center justify-center py-20">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="mb-6 flex items-center gap-3">
          <Gavel className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Adjudicator Queue
            </h1>
            <p className="text-sm text-muted-foreground">
              {userName}, resolve items the reconciling pair couldn&apos;t agree on.
            </p>
          </div>
        </div>

        {items.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-16">
              <CheckCircle className="size-8 text-success" />
              <p className="text-sm font-medium">No items waiting for adjudication.</p>
              <p className="text-xs text-muted-foreground">
                When a pair escalates a criterion, it will appear here.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {items.map((item) => {
              const sel = selections[item.escalationId] || {
                value: null,
                notes: '',
              }
              const scoreLabels = parseScoreLabels(
                item.dimension.scoreLabelJson
              )
              const scaleOptions: number[] = []
              for (
                let v = item.dimension.scaleMin;
                v <= item.dimension.scaleMax;
                v++
              ) {
                scaleOptions.push(v)
              }
              const isSaving = savingId === item.escalationId

              return (
                <Card key={item.escalationId}>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <CardTitle className="text-base">
                          {item.dimension.label}
                        </CardTitle>
                        <CardDescription className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-medium text-foreground">
                            {item.batch.project.name}
                          </span>
                          <span>·</span>
                          <span>{item.batch.name}</span>
                          {item.feedbackItem.activityId && (
                            <>
                              <span>·</span>
                              <span>Activity {item.feedbackItem.activityId}</span>
                            </>
                          )}
                          {item.feedbackItem.conjunctionId && (
                            <>
                              <span>·</span>
                              <span>{item.feedbackItem.conjunctionId}</span>
                            </>
                          )}
                        </CardDescription>
                      </div>
                      <Badge
                        variant="outline"
                        className="shrink-0 border-primary/30 bg-primary/10 text-[10px] text-primary"
                      >
                        Escalated by {item.escalatedBy.name || item.escalatedBy.email}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* Student text + feedback (read-only context) */}
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="rounded-lg bg-content-student-bg p-3">
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                            Student Response
                          </div>
                          {isAppropriateFeedbackDecision(item.dimension) &&
                            (() => {
                              const flag = getOptimalFlag(
                                item.feedbackItem.optimal
                              )
                              if (!flag) return null
                              const { Icon } = flag
                              return (
                                <Badge
                                  variant="outline"
                                  className={`${flag.className} shrink-0 transition-all duration-200`}
                                >
                                  <Icon />
                                  {flag.label}
                                </Badge>
                              )
                            })()}
                        </div>
                        <div className="whitespace-pre-wrap text-sm">
                          {item.feedbackItem.studentText}
                        </div>
                      </div>
                      <div className="rounded-lg bg-content-feedback-bg p-3">
                        <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                          Feedback
                        </div>
                        <div className="whitespace-pre-wrap text-sm">
                          {item.feedbackItem.feedbackText}
                        </div>
                      </div>
                    </div>

                    {/* Both coders' scores + notes */}
                    <div className="grid gap-3 md:grid-cols-2">
                      {item.scores.map((coder) => (
                        <div
                          key={coder.userId}
                          className="rounded-lg border border-border bg-muted/40 p-3"
                        >
                          <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                            {coder.name || coder.email}
                          </div>
                          <div className="flex items-center gap-2">
                            <span
                              className={`inline-flex rounded-lg border-2 px-2.5 py-1 text-xs font-medium ${getScoreColor(
                                coder.value,
                                item.dimension.scaleMin,
                                item.dimension.scaleMax
                              )}`}
                            >
                              {scoreLabels[coder.value]?.label ?? coder.value}
                            </span>
                          </div>
                          {coder.notes && coder.notes.trim() && (
                            <div className="mt-2 whitespace-pre-wrap rounded bg-background/60 p-2 text-xs text-foreground">
                              {coder.notes}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Pair's "why we decided" notes (if any) */}
                    {item.reconciliationNotes && (
                      <div className="rounded-lg bg-muted/30 p-3">
                        <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                          Pair&apos;s reconciliation notes
                        </div>
                        <div className="whitespace-pre-wrap text-xs">
                          {item.reconciliationNotes}
                        </div>
                      </div>
                    )}

                    {/* Final score picker */}
                    <div>
                      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <Gavel className="size-3.5" />
                        Your final score
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {scaleOptions.map((val) => {
                          const label = scoreLabels[val]
                          const isSelected = sel.value === val
                          return (
                            <button
                              key={val}
                              onClick={() =>
                                setSelections((prev) => ({
                                  ...prev,
                                  [item.escalationId]: {
                                    ...(prev[item.escalationId] || {
                                      notes: '',
                                    }),
                                    value: val,
                                  },
                                }))
                              }
                              className={`rounded-xl border-2 px-4 py-3 text-left text-sm font-medium transition-all duration-200 ${
                                isSelected
                                  ? getSelectedScoreColor(
                                      val,
                                      item.dimension.scaleMin,
                                      item.dimension.scaleMax
                                    )
                                  : `${getScoreColor(val, item.dimension.scaleMin, item.dimension.scaleMax)} hover:shadow-md`
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

                    {/* Adjudicator notes */}
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">
                        Adjudicator notes (optional)
                      </Label>
                      <Textarea
                        value={sel.notes}
                        onChange={(e) =>
                          setSelections((prev) => ({
                            ...prev,
                            [item.escalationId]: {
                              ...(prev[item.escalationId] || { value: null }),
                              notes: e.target.value,
                            },
                          }))
                        }
                        placeholder="Why this is the final call. Saved with the reconciled score."
                        className="mt-1 text-sm"
                        rows={2}
                      />
                    </div>

                    <div className="flex justify-end">
                      <Button
                        disabled={sel.value == null || isSaving}
                        onClick={() => handleResolve(item.escalationId)}
                      >
                        {isSaving ? (
                          <>
                            <Loader2 className="mr-2 size-4 animate-spin" />
                            Resolving…
                          </>
                        ) : (
                          <>
                            <Gavel className="mr-2 size-4" />
                            Resolve
                          </>
                        )}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}

        {items.length > 0 && (
          <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
            <AlertTriangle className="size-3.5" />
            Each resolved criterion writes a reconciled Score row. Originals
            stay intact for audit.
          </div>
        )}
      </div>
    </AppShell>
  )
}
