// Compare-and-set guard for reconcile saves.
//
// The reconcile route runs in a serializable transaction, which only catches
// writes that physically overlap. A SEQUENTIAL stale write slips through:
// partner A saves item 7 = 2; B's screen still shows the cell unsaved; B saves
// 3 a minute later and silently replaces A's final (and `reconciledById`).
// So the client sends, per score, the final it last saw (`expectedFinal`, null
// when none) and the route refuses the save when the server's current final
// differs. Pure so the rule is unit-tested apart from the route.

export const STALE_FINAL_MESSAGE =
  'Your partner already recorded a different value for this item. Refreshing to show the latest scores.'

/** Thrown inside the transaction so the whole save rolls back untouched. */
export class StaleFinalError extends Error {
  constructor() {
    super(STALE_FINAL_MESSAGE)
    this.name = 'StaleFinalError'
  }
}

/**
 * True when the client's view of a cell is out of date.
 *
 * `expectedFinal` undefined → the caller opted out of the check (last write
 * wins). null → the client saw no final. A number → the final it saw.
 */
export function isStaleFinal(
  expectedFinal: number | null | undefined,
  existingFinalValue: number | null
): boolean {
  if (expectedFinal === undefined) return false
  return expectedFinal !== existingFinalValue
}

/** Request-shape check: `expectedFinal`, when present, is a number or null. */
export function isValidExpectedFinal(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || typeof value === 'number'
}
