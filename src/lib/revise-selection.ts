// Which re-opened criterion the /revise screen edits.
//
// An admin can re-open more than one criterion on the same release. The Revise
// cards on the project page link to a specific one (`dimensionId=`), but an
// old bookmark may name none, and an admin may have closed the one a link
// points at. The screen then falls back to the first-opened unlock and says so
// — it must never silently open the wrong criterion's editor.

export interface ReviseUnlock {
  dimensionId: string
  label: string
}

export type ReviseFallbackReason =
  /** No dimension requested and more than one criterion is open. */
  | 'ambiguous'
  /** The requested dimension is not (or no longer) re-opened for this annotator. */
  | 'not-found'

export interface ReviseSelection {
  unlock: ReviseUnlock
  fallback: { reason: ReviseFallbackReason; requestedDimensionId: string | null } | null
}

/**
 * Pick the unlock to edit. `unlocks` is ordered oldest-first (the fallback).
 * Returns null when there is nothing to revise.
 */
export function selectReviseUnlock(
  unlocks: ReviseUnlock[],
  requestedDimensionId: string | null | undefined
): ReviseSelection | null {
  const first = unlocks[0]
  if (!first) return null

  if (requestedDimensionId) {
    const match = unlocks.find((u) => u.dimensionId === requestedDimensionId)
    if (match) return { unlock: match, fallback: null }
    return {
      unlock: first,
      fallback: { reason: 'not-found', requestedDimensionId },
    }
  }

  if (unlocks.length === 1) return { unlock: first, fallback: null }
  return {
    unlock: first,
    fallback: { reason: 'ambiguous', requestedDimensionId: null },
  }
}

/** Banner copy for a fallback, naming the criterion actually being edited. */
export function describeReviseFallback(selection: ReviseSelection): string | null {
  if (!selection.fallback) return null
  const shown = selection.unlock.label
  if (selection.fallback.reason === 'not-found') {
    return `The criterion this link pointed to is no longer re-opened for you. Showing “${shown}” instead — check the project page for your other re-opened criteria.`
  }
  return `More than one criterion is re-opened for you on this batch. Showing “${shown}” — open the others from the project page.`
}
