// Shared access rules for editing reconciliation/adjudication outcomes.
//
// Two concepts that used to be conflated under the COMPLETE status are now
// separate:
//   - A release is reconcilable while it is actively RECONCILING OR after it
//     auto-completed (COMPLETE) — a pair can revisit and correct a final score
//     they already agreed on.
//   - A batch is *locked* (Batch.isLocked) once an admin freezes it. A locked
//     batch can never be edited, regardless of release status.
//
// Centralized here so every write path (reconcile, discrepancies load,
// escalate, adjudicate, score) enforces the same rule, and so the rule can be
// unit-tested in isolation.

export const BATCH_LOCKED_MESSAGE =
  'This batch has been locked by an admin and can no longer be edited.'

export const NOT_RECONCILABLE_MESSAGE =
  'Release is not in a reconcilable status'

// Release statuses during which reconciled scores may still be written/edited.
export const RECONCILABLE_STATUSES = ['RECONCILING', 'COMPLETE'] as const

export function isReconcilableStatus(status: string | null | undefined): boolean {
  return (
    status === 'RECONCILING' || status === 'COMPLETE'
  )
}

export type ReconciliationAccess =
  | { ok: true }
  | { ok: false; reason: 'locked'; httpStatus: 423; error: string }
  | { ok: false; reason: 'status'; httpStatus: 400; error: string }

/**
 * Decide whether a reconciliation write is allowed for a given batch lock state
 * and release status. Lock takes precedence over status — a locked batch is
 * frozen even mid-reconciliation.
 */
export function evaluateReconciliationAccess(input: {
  isLocked: boolean
  status: string | null | undefined
}): ReconciliationAccess {
  if (input.isLocked) {
    return {
      ok: false,
      reason: 'locked',
      httpStatus: 423,
      error: BATCH_LOCKED_MESSAGE,
    }
  }
  if (!isReconcilableStatus(input.status)) {
    return {
      ok: false,
      reason: 'status',
      httpStatus: 400,
      error: NOT_RECONCILABLE_MESSAGE,
    }
  }
  return { ok: true }
}
