import { describe, it, expect } from 'vitest'
import {
  getReleaseItemScope,
  getExpectedReleaseUserIds,
  isSlotSplitRelease,
  usesSingleScorer,
} from '@/lib/team-batch-releases'

// Smoke test that also confirms the test infra can import a module that pulls
// in @/lib/db (Prisma) without a live connection.
const members = [{ userId: 'u0' }, { userId: 'u1' }]
const base = { id: 'r', team: { members } }
const split = { ...base, scorerUserId: null, batchType: 'REGULAR', isDoubleScored: false }
const single = { ...base, scorerUserId: 'u0', batchType: 'REGULAR', isDoubleScored: false }
const dbl = { ...base, scorerUserId: null, batchType: 'REGULAR', isDoubleScored: true }
const training = { ...base, scorerUserId: null, batchType: 'TRAINING', isDoubleScored: false }

describe('getReleaseItemScope', () => {
  it('splits items by slot for a non-double regular release', () => {
    expect(getReleaseItemScope(split, 'u0')).toEqual({ mode: 'slot', slotIndex: 0 })
    expect(getReleaseItemScope(split, 'u1')).toEqual({ mode: 'slot', slotIndex: 1 })
    expect(getReleaseItemScope(split, 'outsider')).toEqual({ mode: 'none' })
  })

  it('gives the named scorer all items and the partner none', () => {
    expect(getReleaseItemScope(single, 'u0')).toEqual({ mode: 'all' })
    expect(getReleaseItemScope(single, 'u1')).toEqual({ mode: 'none' })
  })

  it('gives every member all items for double-scored and training', () => {
    expect(getReleaseItemScope(dbl, 'u0')).toEqual({ mode: 'all' })
    expect(getReleaseItemScope(dbl, 'u1')).toEqual({ mode: 'all' })
    expect(getReleaseItemScope(training, 'u0')).toEqual({ mode: 'all' })
  })
})

describe('assignment + split helpers', () => {
  it('assigns only the named scorer when single-scorer', () => {
    expect(getExpectedReleaseUserIds(single)).toEqual(['u0'])
    expect(getExpectedReleaseUserIds(split)).toEqual(['u0', 'u1'])
  })

  it('is not slot-split when a single scorer is named', () => {
    expect(isSlotSplitRelease(single)).toBe(false)
    expect(isSlotSplitRelease(split)).toBe(true)
    expect(usesSingleScorer(single)).toBe(true)
    expect(usesSingleScorer(split)).toBe(false)
  })
})
