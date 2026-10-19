// What the reconcile hub shows once the pair has worked through the list.
//
// The completion state is the SERVER's call (`TeamBatchRelease.status`), never
// a count derived on the client: `maybeCompleteReleaseReconciliation` only sets
// COMPLETE when every discrepancy has a final AND there are zero open
// escalations, so a pair that escalated everything is still RECONCILING even
// though they have nothing left to click. Deriving "done" from local state is
// exactly the shape of the Batch 65 incident (a client-side "Complete" that
// disagreed with the server), so this module takes the server's status and
// escalation count as inputs and only uses local state to decide whether the
// pair still has an item to record.

import { isOpenCell, type ItemReconcileState, type StateItem } from './reconcile-item-state'

export type ReconcileOutcome =
  /** The last fetch failed; nothing on screen can be trusted. */
  | { kind: 'error'; message: string }
  /** The server returned no discrepant items and the release is COMPLETE. */
  | { kind: 'no-discrepancies' }
  /** The pair still owes a final on at least one item. */
  | { kind: 'in-progress'; pendingItemIds: string[] }
  /** The server says COMPLETE. */
  | { kind: 'complete' }
  /** Nothing left for the pair, but open escalations keep the release RECONCILING. */
  | {
      kind: 'awaiting-adjudicator'
      openEscalationCount: number
      /** Items (in list order) that carry at least one open escalation. */
      itemIds: string[]
    }
  /** Nothing left for the pair and no open escalations, yet not COMPLETE (transient). */
  | { kind: 'finalizing' }

export interface ReconcileOutcomeInput {
  /** `TeamBatchRelease.status` as last reported by the server; null before the first load. */
  releaseStatus: string | null
  items: StateItem[]
  itemStates: Record<string, ItemReconcileState>
  /** Open escalations on this release as last reported by the server. */
  openEscalationCount: number
  fetchError: string | null
}

/** Items the pair itself must still record: an unsaved item with an open cell. */
export function pendingItemIds(
  items: StateItem[],
  itemStates: Record<string, ItemReconcileState>
): string[] {
  return items
    .filter(
      (item) =>
        !itemStates[item.feedbackItemId]?.saved &&
        item.discrepancies.some(isOpenCell)
    )
    .map((item) => item.feedbackItemId)
}

export function deriveReconcileOutcome(input: ReconcileOutcomeInput): ReconcileOutcome {
  if (input.fetchError != null) {
    return { kind: 'error', message: input.fetchError }
  }

  const isComplete = input.releaseStatus === 'COMPLETE'

  if (input.items.length === 0) {
    return isComplete ? { kind: 'no-discrepancies' } : { kind: 'finalizing' }
  }

  const pending = pendingItemIds(input.items, input.itemStates)
  if (pending.length > 0) {
    return { kind: 'in-progress', pendingItemIds: pending }
  }

  if (isComplete) return { kind: 'complete' }

  if (input.openEscalationCount > 0) {
    return {
      kind: 'awaiting-adjudicator',
      openEscalationCount: input.openEscalationCount,
      itemIds: input.items
        .filter((item) => item.discrepancies.some((d) => d.escalation != null))
        .map((item) => item.feedbackItemId),
    }
  }

  return { kind: 'finalizing' }
}
