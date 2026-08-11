// The "concede or escalate" rule for pair reconciliation. (Luofan, 2026-07-29)
//
// When a pair disagrees on a criterion, the annotator recording the final score
// may NOT record their own original value — resolving a discrepancy yourself
// always means conceding to your partner. If you still believe your original
// score is right, your partner records it (a concession for them), or you
// escalate to the adjudicator. This makes the two silent failure modes
// impossible to express:
//   1. The second scorer "reconciling" an item by re-picking their own value
//      out of habit, with no discussion — the partner never learns.
//   2. A plain misclick on a 2-point scale: the only selectable option is the
//      one that isn't yours.
//
// The rule intentionally does NOT fire when:
//   - The pair agreed on the value (no discrepancy — agreed dimensions are
//     re-sent on every save).
//   - A final is already recorded (existingFinal != null). Only the FIRST
//     recording of a discrepancy is constrained: Luofan's failure modes are
//     accidents (habit-clicks, misclicks), and once a final exists, going back
//     in is a deliberate correction — including correcting an accidental
//     concession back to your own original (her scenario 2). reconciledById
//     records who made every change, so deliberate flips are visible, not
//     silent. (Taylor, 2026-08-11.) This also covers no-op resaves.
//   - The submitter didn't score this (item, dimension) at all (admins, or an
//     annotator outside the pair): no original, nothing to reassert.
//
// Pure — no Prisma — so the rule is unit-testable in isolation and enforced
// identically wherever it's needed. Mirrors reconciliation-access.ts in shape.

export const CONCESSION_BLOCKED_MESSAGE =
  'You cannot resolve a discrepancy by re-selecting your own original score. Either your partner records it after you discuss, or escalate to the adjudicator.'

export type ConcessionCheck =
  | { ok: true }
  | { ok: false; httpStatus: 403; error: string }

export function evaluateConcessionRule(input: {
  /** Final value being submitted for this (item, dimension). */
  submittedValue: number
  /** The submitter's own original (raw, pre-reconciliation) score, if any. */
  submitterOriginal: number | null
  /** The partner's original score, if any. */
  partnerOriginal: number | null
  /** The already-saved reconciled value for this (item, dimension), if any. */
  existingFinal: number | null
}): ConcessionCheck {
  const { submittedValue, submitterOriginal, partnerOriginal, existingFinal } =
    input

  const isDiscrepancy =
    submitterOriginal != null &&
    partnerOriginal != null &&
    submitterOriginal !== partnerOriginal

  if (
    isDiscrepancy &&
    submittedValue === submitterOriginal &&
    existingFinal == null
  ) {
    return { ok: false, httpStatus: 403, error: CONCESSION_BLOCKED_MESSAGE }
  }
  return { ok: true }
}
