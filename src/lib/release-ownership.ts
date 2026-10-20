/**
 * Release ownership — the two facts about a team release that used to be
 * re-derived from live email order on every read and are now persisted:
 *
 *   - the **release owner** (`TeamBatchRelease.ownerUserId`): the team member
 *     whose `userId` every reconciled / adjudicated final (`Score.isReconciled`)
 *     for the release is stored under;
 *   - each annotator's **slot** (`BatchAssignment.slotIndex`): which half of a
 *     slot-split (non-double-scored REGULAR) release they score, matched against
 *     `FeedbackItem.slotIndex`.
 *
 * Legacy rule, still the fallback while a row's value is null: order the team's
 * members by email ascending; members[0] is the owner and each member's slot is
 * its index in that order. Nothing in the app changes an email, but one was
 * renamed by hand in September 2026, and a rename that crossed the partner's
 * email would have hidden every existing final and swapped the pair's halves
 * (audit 2026-10-19, follow-up 1). Persisting both values once, when the
 * assignments are written, makes the email order irrelevant from then on.
 *
 * Pure (no Prisma) so the sync in team-batch-releases.ts, the read helpers, and
 * scripts/backfill-release-ownership.ts share one rule and one test suite.
 */

export interface OwnershipMember {
  userId: string
}

export interface PersistedAssignment {
  userId: string
  slotIndex: number | null
}

/** Legacy rule: the member with the lowest email. `members` must be email-asc. */
export function legacyOwnerUserId(membersEmailAsc: OwnershipMember[]): string | null {
  return membersEmailAsc[0]?.userId ?? null
}

/** Legacy rule: the member's index in email-asc order; null for a non-member. */
export function legacySlotIndex(
  membersEmailAsc: OwnershipMember[],
  userId: string
): number | null {
  const idx = membersEmailAsc.findIndex((m) => m.userId === userId)
  return idx === -1 ? null : idx
}

/** The persisted owner when there is one, else the legacy rule. */
export function resolveReleaseOwnerUserId(
  persistedOwnerUserId: string | null | undefined,
  membersEmailAsc: OwnershipMember[]
): string | null {
  return persistedOwnerUserId ?? legacyOwnerUserId(membersEmailAsc)
}

/**
 * The user's persisted slot when their assignment row carries one, else the
 * legacy rule. Callers decide first whether the release splits at all
 * (isSlotSplitRelease); this only answers "which slot".
 */
export function resolveUserSlotIndex(
  persistedAssignments: PersistedAssignment[] | undefined,
  membersEmailAsc: OwnershipMember[],
  userId: string
): number | null {
  const persisted = persistedAssignments?.find((a) => a.userId === userId)?.slotIndex
  if (persisted != null) return persisted
  return legacySlotIndex(membersEmailAsc, userId)
}

export interface OwnershipPlanInput {
  persistedOwnerUserId: string | null | undefined
  /**
   * Keep a persisted owner who is no longer on the team. The sync passes true
   * when finals already live under that user on this batch (moving the owner
   * would hide them); the backfill passes true unconditionally because it must
   * never overwrite a non-null value.
   */
  keepOwnerIfNotMember: boolean
  membersEmailAsc: OwnershipMember[]
  /** Who gets a BatchAssignment row, email-asc (getExpectedReleaseUserIds). */
  expectedUserIds: string[]
  isSlotSplit: boolean
  existingAssignments: PersistedAssignment[]
}

export interface OwnershipPlan {
  ownerUserId: string | null
  /** One entry per expected user. Null when the release does not split. */
  slotIndexByUserId: Map<string, number | null>
}

/**
 * What a (re)sync of a release's assignments should write.
 *
 *   - Owner: the persisted owner is kept while they are still a member (or
 *     `keepOwnerIfNotMember`); otherwise the legacy rule applies. On a release
 *     with nothing persisted this is exactly members[0] by email, so the first
 *     write reproduces today's data.
 *   - Slots (slot-split releases only): every expected user who already holds a
 *     valid, unique persisted slot keeps it; the rest take the unused slots in
 *     email-asc order. With nothing persisted that is index-by-email, the legacy
 *     rule. With one member replaced before scoring, the newcomer takes the
 *     departed member's slot regardless of where their email sorts, so the
 *     continuing member's half does not move.
 */
export function planReleaseOwnership(input: OwnershipPlanInput): OwnershipPlan {
  const persistedOwner = input.persistedOwnerUserId ?? null
  const ownerIsMember =
    persistedOwner !== null &&
    input.membersEmailAsc.some((m) => m.userId === persistedOwner)
  const ownerUserId =
    persistedOwner !== null && (ownerIsMember || input.keepOwnerIfNotMember)
      ? persistedOwner
      : legacyOwnerUserId(input.membersEmailAsc)

  const slotIndexByUserId = new Map<string, number | null>()
  if (!input.isSlotSplit) {
    for (const userId of input.expectedUserIds) slotIndexByUserId.set(userId, null)
    return { ownerUserId, slotIndexByUserId }
  }

  const slotCount = input.expectedUserIds.length
  const taken = new Set<number>()
  const pending: string[] = []
  for (const userId of input.expectedUserIds) {
    const persisted =
      input.existingAssignments.find((a) => a.userId === userId)?.slotIndex ?? null
    if (
      persisted !== null &&
      Number.isInteger(persisted) &&
      persisted >= 0 &&
      persisted < slotCount &&
      !taken.has(persisted)
    ) {
      slotIndexByUserId.set(userId, persisted)
      taken.add(persisted)
    } else {
      pending.push(userId)
    }
  }
  for (const userId of pending) {
    let slot = 0
    while (taken.has(slot)) slot++
    slotIndexByUserId.set(userId, slot)
    taken.add(slot)
  }
  return { ownerUserId, slotIndexByUserId }
}

// ---------------------------------------------------------------------------
// Backfill support (scripts/backfill-release-ownership.ts)
// ---------------------------------------------------------------------------

export interface OwnershipReleaseSnapshot {
  id: string
  ownerUserId: string | null
  membersEmailAsc: OwnershipMember[]
  expectedUserIds: string[]
  isSlotSplit: boolean
  assignments: PersistedAssignment[]
}

export interface BackfillWrites {
  /** Set when the release has no owner yet and one can be derived. */
  ownerUserId: string | null
  /** Assignments whose slotIndex is null and should become this value. */
  slotIndexByUserId: Map<string, number>
  /** Non-null persisted values the plan disagrees with. Reported, never written. */
  conflicts: OwnershipMismatch[]
}

/**
 * Fill-nulls-only view of planReleaseOwnership: writes for every null owner or
 * slot, and nothing for a value that is already set. Running it twice yields
 * no writes the second time, which is what makes the backfill idempotent.
 */
export function planBackfillWrites(release: OwnershipReleaseSnapshot): BackfillWrites {
  const plan = planReleaseOwnership({
    persistedOwnerUserId: release.ownerUserId,
    keepOwnerIfNotMember: true,
    membersEmailAsc: release.membersEmailAsc,
    expectedUserIds: release.expectedUserIds,
    isSlotSplit: release.isSlotSplit,
    existingAssignments: release.assignments,
  })

  const conflicts: OwnershipMismatch[] = []
  const slotIndexByUserId = new Map<string, number>()
  for (const assignment of release.assignments) {
    if (!plan.slotIndexByUserId.has(assignment.userId)) continue // not an expected user
    const planned = plan.slotIndexByUserId.get(assignment.userId) ?? null
    if (assignment.slotIndex === null) {
      if (planned !== null) slotIndexByUserId.set(assignment.userId, planned)
    } else if (planned !== assignment.slotIndex) {
      conflicts.push({
        releaseId: release.id,
        kind: 'slot',
        userId: assignment.userId,
        persisted: assignment.slotIndex,
        derived: planned,
      })
    }
  }

  return {
    ownerUserId:
      release.ownerUserId === null && plan.ownerUserId !== null ? plan.ownerUserId : null,
    slotIndexByUserId,
    conflicts,
  }
}

export interface OwnershipMismatch {
  releaseId: string
  kind: 'owner' | 'slot'
  userId: string | null
  persisted: string | number | null
  derived: string | number | null
}

/**
 * Persisted values that differ from what the legacy email rule derives today.
 * Right after the backfill this must be empty for every release and assignment,
 * because the legacy rule is exactly what was written. A later, deliberate email
 * change is allowed to create mismatches — that is the point of persisting — so
 * this is the backfill's acceptance check, not an invariant.
 *
 * Null values are not mismatches; the script counts those separately.
 */
export function findLegacyRuleMismatches(
  release: Omit<OwnershipReleaseSnapshot, 'expectedUserIds'>
): OwnershipMismatch[] {
  const mismatches: OwnershipMismatch[] = []
  const derivedOwner = legacyOwnerUserId(release.membersEmailAsc)
  if (release.ownerUserId !== null && release.ownerUserId !== derivedOwner) {
    mismatches.push({
      releaseId: release.id,
      kind: 'owner',
      userId: null,
      persisted: release.ownerUserId,
      derived: derivedOwner,
    })
  }
  if (!release.isSlotSplit) return mismatches
  for (const assignment of release.assignments) {
    if (assignment.slotIndex === null) continue
    const derived = legacySlotIndex(release.membersEmailAsc, assignment.userId)
    if (derived !== assignment.slotIndex) {
      mismatches.push({
        releaseId: release.id,
        kind: 'slot',
        userId: assignment.userId,
        persisted: assignment.slotIndex,
        derived,
      })
    }
  }
  return mismatches
}
