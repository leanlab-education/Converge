import type { Prisma } from '@/generated/prisma/client'

/**
 * Scope rules for ReleaseCriterionUnlock — the admin "re-open one criterion"
 * toggle. See the model comment in schema.prisma.
 *
 * An unlock is either pair-wide (`userId === null`, the double-scored case) or
 * narrowed to a single annotator (`userId` set, the independent/non-double case
 * where each member owns half the batch by slotIndex).
 *
 * Every read path that surfaces re-opened work to an annotator — the project
 * page's "Revise" task, the /revise screen, and the revise write route — goes
 * through here so a scoped unlock can't leak to the partner in one place and not
 * another.
 */

export interface UnlockScope {
  userId: string | null
}

/** True when this re-open lets `userId` revise. */
export function unlockAppliesToUser(unlock: UnlockScope, userId: string): boolean {
  return unlock.userId === null || unlock.userId === userId
}

/**
 * Prisma filter for "unlocks this annotator may act on". Use inside a
 * `criterionUnlocks: { some: ... }` or as a top-level `releaseCriterionUnlock`
 * where clause.
 */
export function unlockVisibleToUserWhere(
  userId: string
): Prisma.ReleaseCriterionUnlockWhereInput {
  return { OR: [{ userId: null }, { userId }] }
}

/**
 * Human-readable scope for admin UI, e.g. "Both annotators" or "Luofan".
 * `nameByUserId` is looked up rather than embedded so callers control
 * pseudonym vs real-name display.
 */
export function describeUnlockScope(
  unlock: UnlockScope,
  nameByUserId: (userId: string) => string
): string {
  return unlock.userId === null ? 'Both annotators' : nameByUserId(unlock.userId)
}
