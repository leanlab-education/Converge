// Local state for the reconcile hub: how the pair's selections are seeded from
// the server, what counts as an unsaved selection, and how a refetch merges
// with what the annotator has picked but not yet saved.
//
// Pure — no React, no Prisma — so the rules are unit-testable and the client
// component only wires them to state. The hub never auto-saves (the pair is
// supposed to discuss before recording), so unsaved selections are a normal
// state and must survive a refetch rather than be silently discarded.

export interface StateDiscrepancy {
  dimensionId: string
  /** Open escalation: the adjudicator will decide; the pair takes no action. */
  escalation: object | null
  /** Already resolved by the adjudicator: locked for the pair. */
  adjudication: object | null
}

export interface StateItem {
  feedbackItemId: string
  discrepancies: StateDiscrepancy[]
  agreements: { dimensionId: string; value: number }[]
}

export interface PersistedFinal {
  feedbackItemId: string
  dimensionId: string
  value: number
  notes: string | null
}

export interface ItemReconcileState {
  /** dimensionId → chosen final value (agreed cells are pre-filled). */
  scores: Record<string, number | null>
  notes: string
  /** True once the server holds everything the pair owes on this item. */
  saved: boolean
}

export interface ReconcileLocalState {
  states: Record<string, ItemReconcileState>
  /** `${feedbackItemId}::${dimensionId}` → final value the server holds. */
  persistedFinals: Record<string, number>
  /** feedbackItemId → rationale the server holds ('' when none). */
  persistedNotes: Record<string, string>
}

export function finalKey(feedbackItemId: string, dimensionId: string): string {
  return `${feedbackItemId}::${dimensionId}`
}

/** A discrepant cell the pair itself must still record (not escalated, not adjudicated). */
export function isOpenCell(d: StateDiscrepancy): boolean {
  return d.escalation == null && d.adjudication == null
}

/**
 * Seed per-item state from the server response: agreed cells are pre-filled,
 * discrepant cells restore an existing final when there is one, and an item is
 * `saved` when every discrepancy is either escalated or already has a final.
 */
export function buildItemStates(
  items: StateItem[],
  persisted: PersistedFinal[]
): ReconcileLocalState {
  const byKey = new Map<string, PersistedFinal>()
  const persistedFinals: Record<string, number> = {}
  for (const r of persisted) {
    const key = finalKey(r.feedbackItemId, r.dimensionId)
    byKey.set(key, r)
    persistedFinals[key] = r.value
  }

  const states: Record<string, ItemReconcileState> = {}
  const persistedNotes: Record<string, string> = {}
  for (const item of items) {
    const scores: Record<string, number | null> = {}
    for (const a of item.agreements) scores[a.dimensionId] = a.value
    for (const d of item.discrepancies) {
      scores[d.dimensionId] =
        byKey.get(finalKey(item.feedbackItemId, d.dimensionId))?.value ?? null
    }
    const notes =
      item.discrepancies
        .map((d) => byKey.get(finalKey(item.feedbackItemId, d.dimensionId)))
        .find((r) => r?.notes)?.notes ?? ''
    const saved = item.discrepancies.every(
      (d) =>
        d.escalation != null ||
        byKey.has(finalKey(item.feedbackItemId, d.dimensionId))
    )
    states[item.feedbackItemId] = { scores, notes, saved }
    persistedNotes[item.feedbackItemId] = notes
  }

  return { states, persistedFinals, persistedNotes }
}

/**
 * An item has unsaved work when a chosen value on an open cell differs from
 * what the server holds, or the rationale differs. Compared against the
 * persisted record rather than a "touched" flag so a freshly loaded, partially
 * reconciled item is not flagged.
 */
export function isItemDirty(
  item: StateItem,
  state: ItemReconcileState | undefined,
  persistedFinals: Record<string, number>,
  persistedNotes: Record<string, string>
): boolean {
  if (!state || state.saved) return false
  for (const d of item.discrepancies) {
    if (!isOpenCell(d)) continue
    const chosen = state.scores[d.dimensionId]
    if (chosen == null) continue
    const persisted = persistedFinals[finalKey(item.feedbackItemId, d.dimensionId)]
    if (chosen !== (persisted ?? null)) return true
  }
  const persistedNote = (persistedNotes[item.feedbackItemId] ?? '').trim()
  return state.notes.trim() !== persistedNote
}

export function dirtyItemIds(
  items: StateItem[],
  states: Record<string, ItemReconcileState>,
  persistedFinals: Record<string, number>,
  persistedNotes: Record<string, string>
): string[] {
  return items
    .filter((item) =>
      isItemDirty(item, states[item.feedbackItemId], persistedFinals, persistedNotes)
    )
    .map((item) => item.feedbackItemId)
}

/**
 * Merge a fresh server snapshot with the annotator's unsaved selections.
 *
 * The server wins wherever it holds a final (a partner or adjudicator recorded
 * it — that is what the refetch is for). Where the server holds nothing on an
 * open cell, a local unsaved pick is kept so a 409 on item 7 does not throw
 * away the values chosen on items 8 and 9. A non-empty local rationale that
 * differs from the server's is kept too; it is only ever sent on save.
 */
export function mergeLocalSelections(
  items: StateItem[],
  server: ReconcileLocalState,
  local: Record<string, ItemReconcileState>
): Record<string, ItemReconcileState> {
  const merged: Record<string, ItemReconcileState> = {}
  for (const item of items) {
    const serverState = server.states[item.feedbackItemId]
    const localState = local[item.feedbackItemId]
    if (!serverState) continue
    if (!localState) {
      merged[item.feedbackItemId] = serverState
      continue
    }

    const scores = { ...serverState.scores }
    let keptLocalPick = false
    for (const d of item.discrepancies) {
      if (!isOpenCell(d)) continue
      const key = finalKey(item.feedbackItemId, d.dimensionId)
      if (key in server.persistedFinals) continue
      const localPick = localState.scores[d.dimensionId]
      if (localPick != null) {
        scores[d.dimensionId] = localPick
        keptLocalPick = true
      }
    }

    const serverNotes = serverState.notes
    const localNotes = localState.notes
    const keepLocalNotes =
      localNotes.trim() !== '' && localNotes.trim() !== serverNotes.trim()

    merged[item.feedbackItemId] = {
      scores,
      notes: keepLocalNotes ? localNotes : serverNotes,
      saved: serverState.saved && !keptLocalPick && !keepLocalNotes,
    }
  }
  return merged
}
