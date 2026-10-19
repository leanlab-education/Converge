/**
 * Builds the scoring screen's per-item state from the raw scores the server
 * already holds for this annotator.
 *
 * Only raw rows (`isReconciled: false`) may feed it. Reconciled finals are
 * stored under the release owner's userId, so before 2026-10 the owner's
 * hydration saw both their raw row and the pair's final for every reconciled
 * criterion; the final was later in scoredAt order, won the merge, and seeded
 * the notes with "Auto-reconciled (scores matched)". In the revise flow that
 * final was then written back as the owner's RAW score, destroying the IRR
 * data. GET /api/scores now returns raw rows only; this module ignores a
 * reconciled row regardless, so a change on either side cannot reopen that.
 */

export interface DimensionScore {
  dimensionId: string
  value: number | null
}

export interface ItemScoreState {
  scores: DimensionScore[]
  notes: string
  startedAt: string | null
  /** Every criterion has a value and the server holds all of them. */
  saved: boolean
}

export interface HydrationScoreRow {
  feedbackItemId: string
  dimensionId: string
  value: number
  notes?: string | null
  startedAt?: string | null
  isReconciled?: boolean
}

export function emptyItemScoreState(rubric: { id: string }[]): ItemScoreState {
  return {
    scores: rubric.map((dim) => ({ dimensionId: dim.id, value: null })),
    notes: '',
    startedAt: null,
    saved: false,
  }
}

/** True when every criterion in the item's rubric has a value. */
export function isFullyScored(state: Pick<ItemScoreState, 'scores'>): boolean {
  return state.scores.length > 0 && state.scores.every((s) => s.value !== null)
}

/**
 * One state per item id, in `rubric` order, filled from `rows`. Rows for
 * other items, criteria outside `rubric`, or reconciled finals are ignored.
 * Notes come from the first raw row that has any; `startedAt` is the earliest
 * recorded. An item is `saved` when every rubric criterion has a value.
 */
export function hydrateItemScores(
  itemIds: string[],
  rubric: { id: string }[],
  rows: HydrationScoreRow[]
): Record<string, ItemScoreState> {
  const states: Record<string, ItemScoreState> = {}
  for (const id of itemIds) states[id] = emptyItemScoreState(rubric)

  for (const row of rows) {
    if (row.isReconciled) continue
    const state = states[row.feedbackItemId]
    if (!state) continue
    const dimScore = state.scores.find((s) => s.dimensionId === row.dimensionId)
    if (!dimScore) continue

    dimScore.value = row.value
    if (row.notes && !state.notes) state.notes = row.notes
    if (row.startedAt && (!state.startedAt || row.startedAt < state.startedAt)) {
      state.startedAt = row.startedAt
    }
  }

  for (const state of Object.values(states)) {
    state.saved = isFullyScored(state)
  }
  return states
}
