// Mock @/lib/db BEFORE importing the module under test.
import { prismaMock } from '../../test/prisma-mock'
import { describe, it, expect } from 'vitest'
import {
  buildItemCountMap,
  buildScoredCountMaps,
  countForAssignment,
  expectedDimensionIdsForAssignment,
  loadSlotMaps,
  type BatchAssignmentForScoredStats,
  type BatchAssignmentForStats,
  type ItemForStats,
  type RawScoreForStats,
} from '@/lib/evaluator-stats'

// Batch B has 50 items: 30 in slot 0, 20 in slot 1.
const slotMap = new Map([['B', new Map([[0, 30], [1, 20]])]])
const members = [{ userId: 'u0' }, { userId: 'u1' }]
const batch = { id: 'B', isDoubleScored: false, type: 'REGULAR' }

function ba(over: Partial<BatchAssignmentForStats['teamRelease']> & object, userId = 'u0'): BatchAssignmentForStats {
  return { userId, batch, teamRelease: { id: 'r', scorerUserId: null, team: { members }, ...over } }
}

describe('countForAssignment (P7 regression: single-scorer must count all items)', () => {
  it('counts each member for only their slot half when split 50/50', () => {
    expect(countForAssignment(ba({}, 'u0'), 'u0', slotMap)).toBe(30)
    expect(countForAssignment(ba({}, 'u1'), 'u1', slotMap)).toBe(20)
  })

  it('counts the named single scorer for ALL items, not half', () => {
    const single = ba({ scorerUserId: 'u0' }, 'u0')
    expect(countForAssignment(single, 'u0', slotMap)).toBe(50)
  })

  it('counts every member for all items on a double-scored release', () => {
    const dbl: BatchAssignmentForStats = {
      userId: 'u0',
      batch: { id: 'B', isDoubleScored: true, type: 'REGULAR' },
      teamRelease: { id: 'r', scorerUserId: null, team: { members } },
    }
    expect(countForAssignment(dbl, 'u0', slotMap)).toBe(50)
  })

  it('counts all items for a legacy assignment with no team release', () => {
    const legacy: BatchAssignmentForStats = { userId: 'u0', batch, teamRelease: null }
    expect(countForAssignment(legacy, 'u0', slotMap)).toBe(50)
  })
})

describe('buildItemCountMap', () => {
  it('counts items per (batch, slot) and skips unbatched items', () => {
    const map = buildItemCountMap([
      { id: 'i1', batchId: 'B', slotIndex: 0 },
      { id: 'i2', batchId: 'B', slotIndex: 0 },
      { id: 'i3', batchId: 'B', slotIndex: 1 },
      { id: 'i4', batchId: 'C', slotIndex: null },
      { id: 'i5', batchId: null, slotIndex: null },
    ])
    expect(map.get('B')).toEqual(new Map([[0, 2], [1, 1]]))
    expect(map.get('C')).toEqual(new Map([[null, 1]]))
    expect(map.size).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Scored-item counting: an item is scored only when EVERY expected criterion
// has a raw score (Batch 65 / F4287: one of two criteria saved read as 55/55).
// ---------------------------------------------------------------------------

const PROJECT = 'p1'
// The project rubric has four criteria; the team covers two of them.
const PROJECT_DIMS = ['d1', 'd2', 'd3', 'd4']
const TEAM_DIMS = [{ dimensionId: 'd1' }, { dimensionId: 'd2' }]
const projectDims = new Map([[PROJECT, PROJECT_DIMS]])

// Four items in batch B (no slot split by default) plus one in another batch.
const ITEMS: ItemForStats[] = [
  { id: 'i1', batchId: 'B', slotIndex: null },
  { id: 'i2', batchId: 'B', slotIndex: null },
  { id: 'i3', batchId: 'B', slotIndex: null },
  { id: 'i4', batchId: 'B', slotIndex: null },
  { id: 'o1', batchId: 'OTHER', slotIndex: null },
]

function scoredBa(
  over: {
    userId?: string
    batch?: Partial<BatchAssignmentForScoredStats['batch']>
    teamRelease?: Partial<NonNullable<BatchAssignmentForScoredStats['teamRelease']>> | null
  } = {}
): BatchAssignmentForScoredStats {
  const teamRelease =
    over.teamRelease === null
      ? null
      : {
          id: 'r',
          scorerUserId: null,
          team: { members, dimensions: TEAM_DIMS },
          ...over.teamRelease,
        }
  return {
    userId: over.userId ?? 'u0',
    batch: { id: 'B', projectId: PROJECT, isDoubleScored: true, type: 'REGULAR', ...over.batch },
    teamRelease,
  }
}

function raw(userId: string, feedbackItemId: string, dimensionId: string): RawScoreForStats {
  return { userId, feedbackItemId, dimensionId }
}

function scoredCount(
  assignments: BatchAssignmentForScoredStats[],
  scores: RawScoreForStats[],
  userId = 'u0',
  items: ItemForStats[] = ITEMS
): number {
  const maps = buildScoredCountMaps(assignments, projectDims, items, scores)
  const ba = assignments.find((a) => a.userId === userId)!
  return countForAssignment(ba, userId, maps.get(userId) ?? new Map())
}

describe('expectedDimensionIdsForAssignment', () => {
  it("is the team's criteria on a REGULAR release", () => {
    expect(expectedDimensionIdsForAssignment(scoredBa(), PROJECT_DIMS)).toEqual(['d1', 'd2'])
  })

  it('is every project criterion on a TRAINING release', () => {
    expect(
      expectedDimensionIdsForAssignment(scoredBa({ batch: { type: 'TRAINING' } }), PROJECT_DIMS)
    ).toEqual(PROJECT_DIMS)
  })

  it('is every project criterion for a teamless assignment', () => {
    expect(expectedDimensionIdsForAssignment(scoredBa({ teamRelease: null }), PROJECT_DIMS)).toEqual(
      PROJECT_DIMS
    )
  })
})

describe('buildScoredCountMaps', () => {
  it('counts an item once every expected criterion has a raw score', () => {
    const a = scoredBa()
    expect(
      scoredCount([a], [raw('u0', 'i1', 'd1'), raw('u0', 'i1', 'd2'), raw('u0', 'i2', 'd1'), raw('u0', 'i2', 'd2')])
    ).toBe(2)
  })

  it('does NOT count an item with only one of two criteria saved (Batch 65 / F4287)', () => {
    const a = scoredBa()
    // i1 fully scored, i2 missing d2 → 1, not 2.
    expect(scoredCount([a], [raw('u0', 'i1', 'd1'), raw('u0', 'i1', 'd2'), raw('u0', 'i2', 'd1')])).toBe(1)
  })

  it('ignores the partner’s scores when counting a user', () => {
    const a0 = scoredBa({ userId: 'u0' })
    const a1 = scoredBa({ userId: 'u1' })
    const scores = [raw('u0', 'i1', 'd1'), raw('u1', 'i1', 'd1'), raw('u1', 'i1', 'd2')]
    expect(scoredCount([a0, a1], scores, 'u0')).toBe(0)
    expect(scoredCount([a0, a1], scores, 'u1')).toBe(1)
  })

  it('ignores raw scores on criteria the user is not expected to score', () => {
    const a = scoredBa()
    // d3 is a project criterion but not one of the team's — it can't stand in for d2.
    expect(scoredCount([a], [raw('u0', 'i1', 'd1'), raw('u0', 'i1', 'd3')])).toBe(0)
  })

  it('requires every project criterion on a TRAINING batch', () => {
    const a = scoredBa({ batch: { type: 'TRAINING', isDoubleScored: false } })
    const twoOfFour = [raw('u0', 'i1', 'd1'), raw('u0', 'i1', 'd2')]
    expect(scoredCount([a], twoOfFour)).toBe(0)
    const allFour = [...twoOfFour, raw('u0', 'i1', 'd3'), raw('u0', 'i1', 'd4')]
    expect(scoredCount([a], allFour)).toBe(1)
  })

  it('requires every project criterion for a teamless assignment', () => {
    const a = scoredBa({ teamRelease: null, batch: { isDoubleScored: false } })
    expect(scoredCount([a], [raw('u0', 'i1', 'd1'), raw('u0', 'i1', 'd2'), raw('u0', 'i1', 'd3')])).toBe(0)
    expect(
      scoredCount([a], [raw('u0', 'i1', 'd1'), raw('u0', 'i1', 'd2'), raw('u0', 'i1', 'd3'), raw('u0', 'i1', 'd4')])
    ).toBe(1)
  })

  it('counts only the user’s own slot on a slot-split (non-double regular) batch', () => {
    const a0 = scoredBa({ userId: 'u0', batch: { isDoubleScored: false } })
    const a1 = scoredBa({ userId: 'u1', batch: { isDoubleScored: false } })
    const splitItems: ItemForStats[] = [
      { id: 'i1', batchId: 'B', slotIndex: 0 },
      { id: 'i2', batchId: 'B', slotIndex: 0 },
      { id: 'i3', batchId: 'B', slotIndex: 1 },
      { id: 'i4', batchId: 'B', slotIndex: 1 },
    ]
    const scores = [
      // u0 fully scored both slot-0 items (their half) …
      raw('u0', 'i1', 'd1'),
      raw('u0', 'i1', 'd2'),
      raw('u0', 'i2', 'd1'),
      raw('u0', 'i2', 'd2'),
      // … and one slot-1 item that belongs to u1's half (must not count for u0).
      raw('u0', 'i3', 'd1'),
      raw('u0', 'i3', 'd2'),
      // u1 half-scored one slot-1 item.
      raw('u1', 'i4', 'd1'),
    ]
    expect(scoredCount([a0, a1], scores, 'u0', splitItems)).toBe(2)
    expect(scoredCount([a0, a1], scores, 'u1', splitItems)).toBe(0)
  })

  it('never counts anything for an assignment that expects no criteria', () => {
    const a = scoredBa({ teamRelease: { team: { members, dimensions: [] } } })
    expect(scoredCount([a], [raw('u0', 'i1', 'd1')])).toBe(0)
  })

  it('skips scores on batches outside the assignments', () => {
    const a = scoredBa()
    expect(scoredCount([a], [raw('u0', 'o1', 'd1'), raw('u0', 'o1', 'd2')])).toBe(0)
  })

  it('skips scores on items it was not given', () => {
    const a = scoredBa()
    expect(scoredCount([a], [raw('u0', 'ghost', 'd1'), raw('u0', 'ghost', 'd2')])).toBe(0)
  })
})

describe('loadSlotMaps', () => {
  it('fetches only raw (unreconciled) scores for the assigned users and returns both maps', async () => {
    prismaMock.rubricDimension.findMany.mockResolvedValue(
      PROJECT_DIMS.map((id) => ({ id, projectId: PROJECT })) as never
    )
    prismaMock.feedbackItem.findMany.mockResolvedValue(ITEMS.slice(0, 2) as never)
    prismaMock.score.findMany.mockResolvedValue([
      raw('u0', 'i1', 'd1'),
      raw('u0', 'i1', 'd2'),
      raw('u0', 'i2', 'd1'),
    ] as never)

    const a = scoredBa()
    const { itemCountByBatchSlot, scoredCountByUser } = await loadSlotMaps([a])

    expect(countForAssignment(a, 'u0', itemCountByBatchSlot)).toBe(2)
    expect(countForAssignment(a, 'u0', scoredCountByUser.get('u0')!)).toBe(1)

    // Reconciled finals are stored under the release owner's userId and must
    // not be mistaken for that user's own scoring.
    expect(prismaMock.score.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          feedbackItem: { batchId: { in: ['B'] } },
          userId: { in: ['u0'] },
          isReconciled: false,
        },
      })
    )
  })

  it('returns empty maps without querying when there are no assignments', async () => {
    const { itemCountByBatchSlot, scoredCountByUser } = await loadSlotMaps([])
    expect(itemCountByBatchSlot.size).toBe(0)
    expect(scoredCountByUser.size).toBe(0)
    expect(prismaMock.score.findMany).not.toHaveBeenCalled()
    expect(prismaMock.feedbackItem.findMany).not.toHaveBeenCalled()
  })
})
