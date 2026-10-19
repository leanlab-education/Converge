import { describe, it, expect } from 'vitest'
import {
  emptyItemScoreState,
  hydrateItemScores,
  isFullyScored,
  type HydrationScoreRow,
} from '@/lib/score-hydration'

const RUBRIC = [{ id: 'd1' }, { id: 'd2' }]
const ITEMS = ['i1', 'i2']

function raw(
  feedbackItemId: string,
  dimensionId: string,
  value: number,
  over: Partial<HydrationScoreRow> = {}
): HydrationScoreRow {
  return { feedbackItemId, dimensionId, value, notes: null, isReconciled: false, ...over }
}

describe('hydrateItemScores', () => {
  it('starts every item empty, in rubric order, unsaved', () => {
    const states = hydrateItemScores(ITEMS, RUBRIC, [])
    expect(Object.keys(states)).toEqual(ITEMS)
    expect(states.i1).toEqual(emptyItemScoreState(RUBRIC))
    expect(states.i1.scores.map((s) => s.dimensionId)).toEqual(['d1', 'd2'])
    expect(states.i1.saved).toBe(false)
  })

  it('fills values from raw rows and marks an item saved only when every criterion has one', () => {
    const states = hydrateItemScores(ITEMS, RUBRIC, [
      raw('i1', 'd1', 1),
      raw('i1', 'd2', 0),
      raw('i2', 'd1', 1),
    ])
    expect(states.i1.scores).toEqual([
      { dimensionId: 'd1', value: 1 },
      { dimensionId: 'd2', value: 0 },
    ])
    expect(states.i1.saved).toBe(true)
    expect(states.i2.scores).toEqual([
      { dimensionId: 'd1', value: 1 },
      { dimensionId: 'd2', value: null },
    ])
    expect(states.i2.saved).toBe(false)
  })

  it('never lets a reconciled row win, whatever its position, and never seeds notes from one', () => {
    // The owner's raw score was 0; the pair's final (stored under the owner's
    // userId, later in scoredAt order) was 1 with the auto-reconcile note.
    const states = hydrateItemScores(ITEMS, RUBRIC, [
      raw('i1', 'd1', 0),
      raw('i1', 'd1', 1, { isReconciled: true, notes: 'Auto-reconciled (scores matched)' }),
      raw('i1', 'd2', 1, { isReconciled: true, notes: 'Pair rationale' }),
    ])
    expect(states.i1.scores).toEqual([
      { dimensionId: 'd1', value: 0 },
      { dimensionId: 'd2', value: null },
    ])
    expect(states.i1.notes).toBe('')
    expect(states.i1.saved).toBe(false)
  })

  it('ignores rows for items not on screen and criteria outside the rubric', () => {
    const states = hydrateItemScores(ITEMS, RUBRIC, [
      raw('elsewhere', 'd1', 1, { notes: 'not mine' }),
      raw('i1', 'd9', 1, { notes: 'other team criterion' }),
    ])
    expect(states.i1).toEqual(emptyItemScoreState(RUBRIC))
    expect(states).not.toHaveProperty('elsewhere')
  })

  it('takes notes from the first raw row that has any', () => {
    const states = hydrateItemScores(ITEMS, RUBRIC, [
      raw('i1', 'd1', 1, { notes: '' }),
      raw('i1', 'd2', 1, { notes: 'first' }),
      raw('i2', 'd1', 1, { notes: 'a' }),
      raw('i2', 'd2', 1, { notes: 'b' }),
    ])
    expect(states.i1.notes).toBe('first')
    expect(states.i2.notes).toBe('a')
  })

  it('keeps the earliest startedAt across the item rows', () => {
    const states = hydrateItemScores(ITEMS, RUBRIC, [
      raw('i1', 'd1', 1, { startedAt: '2026-10-19T10:05:00.000Z' }),
      raw('i1', 'd2', 1, { startedAt: '2026-10-19T10:01:00.000Z' }),
      raw('i2', 'd1', 1, { startedAt: null }),
    ])
    expect(states.i1.startedAt).toBe('2026-10-19T10:01:00.000Z')
    expect(states.i2.startedAt).toBeNull()
  })

  it('treats a missing isReconciled as raw (older payloads)', () => {
    const states = hydrateItemScores(ITEMS, RUBRIC, [
      { feedbackItemId: 'i1', dimensionId: 'd1', value: 1 },
    ])
    expect(states.i1.scores[0].value).toBe(1)
  })
})

describe('isFullyScored', () => {
  it('requires a value for every criterion and at least one criterion', () => {
    expect(isFullyScored({ scores: [{ dimensionId: 'd1', value: 0 }] })).toBe(true)
    expect(
      isFullyScored({
        scores: [
          { dimensionId: 'd1', value: 1 },
          { dimensionId: 'd2', value: null },
        ],
      })
    ).toBe(false)
    expect(isFullyScored({ scores: [] })).toBe(false)
  })
})
