// Mock @/lib/db BEFORE importing the module under test.
import { prismaMock } from '../../test/prisma-mock'
import { describe, it, expect } from 'vitest'
import {
  buildFullyScoredItemIds,
  buildItemCountMap,
  buildScoredCountMaps,
  countForAssignment,
  createExpectedScoreFilter,
  expectedDimensionIdsForAssignment,
  isVisibleToAnnotator,
  loadAdminProjectStats,
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

// ---------------------------------------------------------------------------
// Expected-scorer predicate: which raw scores are candidates for "the" score of
// an (item × criterion). Shared by the Overview count and the export.
// ---------------------------------------------------------------------------

describe('createExpectedScoreFilter', () => {
  const splitItems: ItemForStats[] = [
    { id: 'i1', batchId: 'B', slotIndex: 0 },
    { id: 'i2', batchId: 'B', slotIndex: 1 },
    { id: 'u1x', batchId: null, slotIndex: null },
  ]

  it('accepts a score by the assigned scorer on an owed criterion inside their slot', () => {
    const a0 = scoredBa({ userId: 'u0', batch: { isDoubleScored: false } })
    const a1 = scoredBa({ userId: 'u1', batch: { isDoubleScored: false } })
    const isExpected = createExpectedScoreFilter([a0, a1], projectDims, splitItems)
    expect(isExpected(raw('u0', 'i1', 'd1'))).toBe(true)
    expect(isExpected(raw('u1', 'i2', 'd2'))).toBe(true)
  })

  it('rejects a partner scoring outside their slot on an independent batch', () => {
    const a0 = scoredBa({ userId: 'u0', batch: { isDoubleScored: false } })
    const a1 = scoredBa({ userId: 'u1', batch: { isDoubleScored: false } })
    const isExpected = createExpectedScoreFilter([a0, a1], projectDims, splitItems)
    expect(isExpected(raw('u0', 'i2', 'd1'))).toBe(false)
    expect(isExpected(raw('u1', 'i1', 'd1'))).toBe(false)
  })

  it('rejects a criterion the scorer’s team does not own', () => {
    const isExpected = createExpectedScoreFilter([scoredBa()], projectDims, ITEMS)
    expect(isExpected(raw('u0', 'i1', 'd3'))).toBe(false)
  })

  it('rejects anyone without an assignment on the batch (e.g. an admin)', () => {
    const isExpected = createExpectedScoreFilter([scoredBa()], projectDims, ITEMS)
    expect(isExpected(raw('admin', 'i1', 'd1'))).toBe(false)
  })

  it('rejects scores on unknown or unbatched items', () => {
    const isExpected = createExpectedScoreFilter([scoredBa()], projectDims, splitItems)
    expect(isExpected(raw('u0', 'ghost', 'd1'))).toBe(false)
    expect(isExpected(raw('u0', 'u1x', 'd1'))).toBe(false)
  })

  it('accepts both members on every item of a double-scored or training batch', () => {
    const dbl = [scoredBa({ userId: 'u0' }), scoredBa({ userId: 'u1' })]
    const isExpected = createExpectedScoreFilter(dbl, projectDims, splitItems)
    expect(isExpected(raw('u0', 'i2', 'd1'))).toBe(true)
    expect(isExpected(raw('u1', 'i1', 'd2'))).toBe(true)
    const training = [scoredBa({ userId: 'u0', batch: { type: 'TRAINING', isDoubleScored: false } })]
    expect(createExpectedScoreFilter(training, projectDims, splitItems)(raw('u0', 'i2', 'd4'))).toBe(true)
  })

  it('accepts only the named scorer on a single-scorer release', () => {
    const named = [
      scoredBa({ userId: 'u0', batch: { isDoubleScored: false }, teamRelease: { scorerUserId: 'u0' } }),
    ]
    const isExpected = createExpectedScoreFilter(named, projectDims, splitItems)
    expect(isExpected(raw('u0', 'i2', 'd1'))).toBe(true) // all items, not a slot half
    expect(isExpected(raw('u1', 'i1', 'd1'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Overview "Scored": every owed criterion has a score from an expected scorer.
// ---------------------------------------------------------------------------

describe('buildFullyScoredItemIds', () => {
  // Two teams on batch B: team 1 (u0,u1) owns d1,d2; team 2 (u2,u3) owns d3,d4.
  const team2 = [{ userId: 'u2' }, { userId: 'u3' }]
  const TEAM2_DIMS = [{ dimensionId: 'd3' }, { dimensionId: 'd4' }]
  function team2Ba(userId: string, batch: Partial<BatchAssignmentForScoredStats['batch']> = {}) {
    return scoredBa({ userId, batch, teamRelease: { id: 'r2', team: { members: team2, dimensions: TEAM2_DIMS } } })
  }
  const twoTeamsDouble = [scoredBa({ userId: 'u0' }), scoredBa({ userId: 'u1' }), team2Ba('u2'), team2Ba('u3')]

  function fully(assignments: BatchAssignmentForScoredStats[], scores: RawScoreForStats[], items = ITEMS) {
    return [...buildFullyScoredItemIds(assignments, projectDims, items, scores)].sort()
  }

  it('does not count an item with only some of its criteria scored (the old any-score proxy did)', () => {
    expect(fully(twoTeamsDouble, [raw('u0', 'i1', 'd1')])).toEqual([])
    // Team 1 complete, team 2 untouched: still owed d3/d4.
    expect(fully(twoTeamsDouble, [raw('u0', 'i1', 'd1'), raw('u0', 'i1', 'd2')])).toEqual([])
  })

  it('counts an item once every owed criterion has a score from at least one expected scorer', () => {
    const scores = [
      raw('u0', 'i1', 'd1'),
      raw('u1', 'i1', 'd2'), // d2 came from the partner — one expected scorer suffices
      raw('u3', 'i1', 'd3'),
      raw('u2', 'i1', 'd4'),
    ]
    expect(fully(twoTeamsDouble, scores)).toEqual(['i1'])
  })

  it('ignores stray scores from people with no assignment and from criteria another team owns', () => {
    const scores = [
      raw('u0', 'i1', 'd1'),
      raw('u0', 'i1', 'd2'),
      raw('admin', 'i1', 'd3'), // not assigned
      raw('u0', 'i1', 'd4'), // team 1 does not own d4
    ]
    expect(fully(twoTeamsDouble, scores)).toEqual([])
  })

  it('only looks at the slot member’s scores on an independent batch', () => {
    const indep = [
      scoredBa({ userId: 'u0', batch: { isDoubleScored: false } }),
      scoredBa({ userId: 'u1', batch: { isDoubleScored: false } }),
    ]
    const splitItems: ItemForStats[] = [
      { id: 'i1', batchId: 'B', slotIndex: 0 },
      { id: 'i2', batchId: 'B', slotIndex: 1 },
    ]
    const scores = [
      raw('u0', 'i1', 'd1'),
      raw('u0', 'i1', 'd2'),
      // u0 also scored i2, which is u1's — must not make i2 count.
      raw('u0', 'i2', 'd1'),
      raw('u0', 'i2', 'd2'),
    ]
    expect(fully(indep, scores, splitItems)).toEqual(['i1'])
  })

  it('never counts an item whose batch has no assignments', () => {
    expect(fully([], [raw('u0', 'i1', 'd1'), raw('u0', 'i1', 'd2')])).toEqual([])
    // OTHER batch has no assignments even though B does.
    expect(fully([scoredBa()], [raw('u0', 'o1', 'd1'), raw('u0', 'o1', 'd2')])).toEqual([])
  })

  it('requires every project criterion on a TRAINING batch', () => {
    const training = [scoredBa({ userId: 'u0', batch: { type: 'TRAINING', isDoubleScored: false } })]
    const three = ['d1', 'd2', 'd3'].map((d) => raw('u0', 'i1', d))
    expect(fully(training, three)).toEqual([])
    expect(fully(training, [...three, raw('u0', 'i1', 'd4')])).toEqual(['i1'])
  })
})

describe('isVisibleToAnnotator', () => {
  it('hides assignments on hidden batches and on unreleased team releases', () => {
    expect(isVisibleToAnnotator({ batch: { isHidden: false }, teamRelease: { isVisible: true } })).toBe(true)
    expect(isVisibleToAnnotator({ batch: { isHidden: false }, teamRelease: null })).toBe(true)
    expect(isVisibleToAnnotator({ batch: { isHidden: true }, teamRelease: { isVisible: true } })).toBe(false)
    expect(isVisibleToAnnotator({ batch: { isHidden: false }, teamRelease: { isVisible: false } })).toBe(false)
  })
})

describe('loadAdminProjectStats', () => {
  it('counts per-user progress over visible assignments only, but owes criteria from every assignment', async () => {
    // Batch B (visible) and batch H (hidden) both double-scored by u0/u1 on d1,d2.
    const visibleBa = {
      userId: 'u0',
      teamRelease: { id: 'r', scorerUserId: null, isVisible: true, team: { members, dimensions: TEAM_DIMS } },
      batch: { id: 'B', projectId: PROJECT, isDoubleScored: true, type: 'REGULAR', isHidden: false },
    }
    const hiddenBa = {
      ...visibleBa,
      teamRelease: { ...visibleBa.teamRelease, id: 'rh' },
      batch: { ...visibleBa.batch, id: 'H', isHidden: true },
    }
    prismaMock.batchAssignment.findMany.mockResolvedValue([visibleBa, hiddenBa] as never)
    prismaMock.rubricDimension.findMany.mockResolvedValue(
      PROJECT_DIMS.map((id) => ({ id, projectId: PROJECT })) as never
    )
    prismaMock.feedbackItem.findMany.mockResolvedValue([
      { id: 'i1', batchId: 'B', slotIndex: null },
      { id: 'i2', batchId: 'B', slotIndex: null },
      { id: 'h1', batchId: 'H', slotIndex: null },
    ] as never)
    prismaMock.score.findMany.mockResolvedValue([
      raw('u0', 'i1', 'd1'),
      raw('u0', 'i1', 'd2'),
      raw('u0', 'h1', 'd1'),
      raw('u0', 'h1', 'd2'),
    ] as never)

    const stats = await loadAdminProjectStats(PROJECT)

    // Assigned/Completed exclude the hidden batch: 2 assigned, 1 complete — not 3/2.
    expect(stats.progressByUser.get('u0')).toEqual({ assignedCount: 2, completedCount: 1 })
    // The Overview still counts the hidden batch's fully scored item.
    expect(stats.fullyScoredItemCount).toBe(2)
  })

  it('returns zeros without loading items or scores when the project has no assignments', async () => {
    prismaMock.batchAssignment.findMany.mockResolvedValue([] as never)
    const stats = await loadAdminProjectStats(PROJECT)
    expect(stats.fullyScoredItemCount).toBe(0)
    expect(stats.progressByUser.size).toBe(0)
    expect(prismaMock.score.findMany).not.toHaveBeenCalled()
  })
})
