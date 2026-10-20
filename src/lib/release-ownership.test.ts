import { describe, it, expect } from 'vitest'
import {
  findLegacyRuleMismatches,
  legacyOwnerUserId,
  legacySlotIndex,
  planBackfillWrites,
  planReleaseOwnership,
  resolveReleaseOwnerUserId,
  resolveUserSlotIndex,
} from '@/lib/release-ownership'

// Two annotators. By email, "a" sorts before "b", so the legacy rule makes
// a the owner / slot 0 and b slot 1. `reversed` is what the same team looks
// like after an email edit that crosses the partner's address.
const a = { userId: 'a' }
const b = { userId: 'b' }
const byEmail = [a, b]
const reversed = [b, a]

describe('legacy rule', () => {
  it('owner is members[0], slot is the member index', () => {
    expect(legacyOwnerUserId(byEmail)).toBe('a')
    expect(legacyOwnerUserId([])).toBeNull()
    expect(legacySlotIndex(byEmail, 'a')).toBe(0)
    expect(legacySlotIndex(byEmail, 'b')).toBe(1)
    expect(legacySlotIndex(byEmail, 'z')).toBeNull()
  })

  it('moves with the email order — the hazard this module removes', () => {
    expect(legacyOwnerUserId(reversed)).toBe('b')
    expect(legacySlotIndex(reversed, 'a')).toBe(1)
  })
})

describe('resolveReleaseOwnerUserId', () => {
  it('prefers the persisted owner whatever the member order says', () => {
    expect(resolveReleaseOwnerUserId('a', byEmail)).toBe('a')
    expect(resolveReleaseOwnerUserId('a', reversed)).toBe('a')
  })

  it('falls back to the legacy rule only when nothing is persisted', () => {
    expect(resolveReleaseOwnerUserId(null, byEmail)).toBe('a')
    expect(resolveReleaseOwnerUserId(undefined, reversed)).toBe('b')
    expect(resolveReleaseOwnerUserId(null, [])).toBeNull()
  })
})

describe('resolveUserSlotIndex', () => {
  const persisted = [
    { userId: 'a', slotIndex: 0 },
    { userId: 'b', slotIndex: 1 },
  ]

  it('prefers the persisted slot whatever the member order says', () => {
    expect(resolveUserSlotIndex(persisted, reversed, 'a')).toBe(0)
    expect(resolveUserSlotIndex(persisted, reversed, 'b')).toBe(1)
  })

  it('falls back to the legacy rule for a null or missing row', () => {
    expect(resolveUserSlotIndex([{ userId: 'a', slotIndex: null }], byEmail, 'a')).toBe(0)
    expect(resolveUserSlotIndex([], byEmail, 'b')).toBe(1)
    expect(resolveUserSlotIndex(undefined, byEmail, 'b')).toBe(1)
  })

  it('is null for someone with neither a row nor a membership', () => {
    expect(resolveUserSlotIndex(persisted, byEmail, 'z')).toBeNull()
  })
})

describe('planReleaseOwnership', () => {
  const split = (over: Partial<Parameters<typeof planReleaseOwnership>[0]> = {}) =>
    planReleaseOwnership({
      persistedOwnerUserId: null,
      keepOwnerIfNotMember: false,
      membersEmailAsc: byEmail,
      expectedUserIds: ['a', 'b'],
      isSlotSplit: true,
      existingAssignments: [],
      ...over,
    })

  it('first write reproduces the legacy rule exactly', () => {
    const plan = split()
    expect(plan.ownerUserId).toBe('a')
    expect(Array.from(plan.slotIndexByUserId.entries())).toEqual([
      ['a', 0],
      ['b', 1],
    ])
  })

  it('writes null slots for a release that does not split, but still an owner', () => {
    const plan = split({ isSlotSplit: false })
    expect(plan.ownerUserId).toBe('a')
    expect(Array.from(plan.slotIndexByUserId.entries())).toEqual([
      ['a', null],
      ['b', null],
    ])
  })

  it('a single-scorer release only plans the named scorer', () => {
    const plan = split({ isSlotSplit: false, expectedUserIds: ['b'] })
    expect(plan.ownerUserId).toBe('a') // owner is members[0] regardless of scorer
    expect(Array.from(plan.slotIndexByUserId.entries())).toEqual([['b', null]])
  })

  it('keeps the persisted owner after the email order flips', () => {
    const plan = split({ persistedOwnerUserId: 'a', membersEmailAsc: reversed, expectedUserIds: ['b', 'a'] })
    expect(plan.ownerUserId).toBe('a')
  })

  it('keeps persisted slots after the email order flips', () => {
    const plan = split({
      membersEmailAsc: reversed,
      expectedUserIds: ['b', 'a'],
      existingAssignments: [
        { userId: 'a', slotIndex: 0 },
        { userId: 'b', slotIndex: 1 },
      ],
    })
    expect(plan.slotIndexByUserId.get('a')).toBe(0)
    expect(plan.slotIndexByUserId.get('b')).toBe(1)
  })

  it('re-derives the owner when they left the team and nothing says to keep them', () => {
    const plan = split({ persistedOwnerUserId: 'gone' })
    expect(plan.ownerUserId).toBe('a')
  })

  it('keeps a departed owner when told to (finals live under them)', () => {
    const plan = split({ persistedOwnerUserId: 'gone', keepOwnerIfNotMember: true })
    expect(plan.ownerUserId).toBe('gone')
  })

  it('a member swapped in before scoring takes the departed member’s slot', () => {
    // b left, c joined; c's email sorts before a. Legacy would make c slot 0
    // and move a to slot 1. The plan keeps a at 0 and gives c the free slot.
    const plan = split({
      persistedOwnerUserId: 'a',
      membersEmailAsc: [{ userId: 'c' }, a],
      expectedUserIds: ['c', 'a'],
      existingAssignments: [
        { userId: 'a', slotIndex: 0 },
        { userId: 'b', slotIndex: 1 },
      ],
    })
    expect(plan.ownerUserId).toBe('a')
    expect(plan.slotIndexByUserId.get('a')).toBe(0)
    expect(plan.slotIndexByUserId.get('c')).toBe(1)
  })

  it('fills a null slot next to a persisted one without colliding', () => {
    const plan = split({
      existingAssignments: [
        { userId: 'a', slotIndex: 1 },
        { userId: 'b', slotIndex: null },
      ],
    })
    expect(plan.slotIndexByUserId.get('a')).toBe(1)
    expect(plan.slotIndexByUserId.get('b')).toBe(0)
  })

  it('treats a duplicated or out-of-range persisted slot as unpersisted', () => {
    const dup = split({
      existingAssignments: [
        { userId: 'a', slotIndex: 0 },
        { userId: 'b', slotIndex: 0 },
      ],
    })
    expect(dup.slotIndexByUserId.get('a')).toBe(0)
    expect(dup.slotIndexByUserId.get('b')).toBe(1)

    const range = split({ existingAssignments: [{ userId: 'a', slotIndex: 7 }] })
    expect(range.slotIndexByUserId.get('a')).toBe(0)
    expect(range.slotIndexByUserId.get('b')).toBe(1)
  })
})

describe('planBackfillWrites', () => {
  const snapshot = (over: Partial<Parameters<typeof planBackfillWrites>[0]> = {}) => ({
    id: 'r',
    ownerUserId: null,
    membersEmailAsc: byEmail,
    expectedUserIds: ['a', 'b'],
    isSlotSplit: true,
    assignments: [
      { userId: 'a', slotIndex: null },
      { userId: 'b', slotIndex: null },
    ],
    ...over,
  })

  it('on an untouched release writes the legacy rule into every null', () => {
    const writes = planBackfillWrites(snapshot())
    expect(writes.ownerUserId).toBe('a')
    expect(Array.from(writes.slotIndexByUserId.entries())).toEqual([
      ['a', 0],
      ['b', 1],
    ])
    expect(writes.conflicts).toEqual([])
  })

  it('is a no-op once everything is persisted (idempotent)', () => {
    const writes = planBackfillWrites(
      snapshot({
        ownerUserId: 'a',
        assignments: [
          { userId: 'a', slotIndex: 0 },
          { userId: 'b', slotIndex: 1 },
        ],
      })
    )
    expect(writes.ownerUserId).toBeNull()
    expect(writes.slotIndexByUserId.size).toBe(0)
    expect(writes.conflicts).toEqual([])
  })

  it('never overwrites a persisted owner, even one the legacy rule disagrees with', () => {
    const writes = planBackfillWrites(snapshot({ ownerUserId: 'b' }))
    expect(writes.ownerUserId).toBeNull()
  })

  it('never overwrites a persisted owner who is no longer a member', () => {
    const writes = planBackfillWrites(snapshot({ ownerUserId: 'gone' }))
    expect(writes.ownerUserId).toBeNull()
  })

  it('fills only the null slot when the partner already has one', () => {
    const writes = planBackfillWrites(
      snapshot({
        ownerUserId: 'a',
        assignments: [
          { userId: 'a', slotIndex: 1 },
          { userId: 'b', slotIndex: null },
        ],
      })
    )
    expect(Array.from(writes.slotIndexByUserId.entries())).toEqual([['b', 0]])
  })

  it('writes no slots for a release that does not split', () => {
    const writes = planBackfillWrites(snapshot({ isSlotSplit: false }))
    expect(writes.ownerUserId).toBe('a')
    expect(writes.slotIndexByUserId.size).toBe(0)
  })

  it('ignores assignment rows for users the release no longer expects', () => {
    const writes = planBackfillWrites(
      snapshot({ assignments: [{ userId: 'a', slotIndex: null }, { userId: 'stale', slotIndex: null }] })
    )
    expect(Array.from(writes.slotIndexByUserId.keys())).toEqual(['a'])
  })

  it('reports a corrupt duplicate slot as a conflict and leaves it alone', () => {
    const writes = planBackfillWrites(
      snapshot({
        assignments: [
          { userId: 'a', slotIndex: 0 },
          { userId: 'b', slotIndex: 0 },
        ],
      })
    )
    expect(writes.slotIndexByUserId.size).toBe(0)
    expect(writes.conflicts).toEqual([
      { releaseId: 'r', kind: 'slot', userId: 'b', persisted: 0, derived: 1 },
    ])
  })
})

describe('findLegacyRuleMismatches', () => {
  it('is empty right after a backfill (persisted == legacy rule)', () => {
    expect(
      findLegacyRuleMismatches({
        id: 'r',
        ownerUserId: 'a',
        membersEmailAsc: byEmail,
        isSlotSplit: true,
        assignments: [
          { userId: 'a', slotIndex: 0 },
          { userId: 'b', slotIndex: 1 },
        ],
      })
    ).toEqual([])
  })

  it('ignores nulls (those are counted separately, not mismatches)', () => {
    expect(
      findLegacyRuleMismatches({
        id: 'r',
        ownerUserId: null,
        membersEmailAsc: byEmail,
        isSlotSplit: true,
        assignments: [{ userId: 'a', slotIndex: null }],
      })
    ).toEqual([])
  })

  it('reports owner and slot drift after an email edit crosses the partner', () => {
    expect(
      findLegacyRuleMismatches({
        id: 'r',
        ownerUserId: 'a',
        membersEmailAsc: reversed,
        isSlotSplit: true,
        assignments: [
          { userId: 'a', slotIndex: 0 },
          { userId: 'b', slotIndex: 1 },
        ],
      })
    ).toEqual([
      { releaseId: 'r', kind: 'owner', userId: null, persisted: 'a', derived: 'b' },
      { releaseId: 'r', kind: 'slot', userId: 'a', persisted: 0, derived: 1 },
      { releaseId: 'r', kind: 'slot', userId: 'b', persisted: 1, derived: 0 },
    ])
  })

  it('does not check slots on a release that does not split', () => {
    expect(
      findLegacyRuleMismatches({
        id: 'r',
        ownerUserId: 'a',
        membersEmailAsc: byEmail,
        isSlotSplit: false,
        assignments: [{ userId: 'a', slotIndex: 1 }],
      })
    ).toEqual([])
  })
})
