import { describe, it, expect } from 'vitest'
import {
  evaluateScoreWrite,
  evaluateScoreWriteScope,
  evaluateScoringOpen,
  BATCH_NOT_OPEN_MESSAGE,
  NOT_ASSIGNED_MESSAGE,
  NOT_YOUR_CRITERION_MESSAGE,
  RELEASE_NOT_OPEN_MESSAGE,
  UNBATCHED_ITEM_MESSAGE,
  WRONG_SLOT_MESSAGE,
  type ScopeAssignment,
  type ScopeBatch,
  type ScopeRelease,
} from '@/lib/score-write-scope'
import { BATCH_LOCKED_MESSAGE } from '@/lib/reconciliation-access'

// Team of two (u0 sorts first by email → slot 0, u1 → slot 1) scoring two of
// the project's four criteria.
const MEMBERS = [{ userId: 'u0' }, { userId: 'u1' }]
const TEAM_DIMS = [{ dimensionId: 'd1' }, { dimensionId: 'd2' }]
const PROJECT_DIMS = ['d1', 'd2', 'd3', 'd4']

function release(
  over: Partial<Omit<ScopeRelease, 'batch'>> & {
    batch?: Partial<ScopeRelease['batch']>
  } = {}
): ScopeRelease {
  return {
    id: 'r1',
    scorerUserId: null,
    isVisible: true,
    status: 'SCORING',
    team: { members: MEMBERS, dimensions: TEAM_DIMS },
    ...over,
    batch: { type: 'REGULAR', isDoubleScored: false, ...over.batch },
  }
}

function assigned(rel: ScopeRelease | null = release()): ScopeAssignment {
  return { teamRelease: rel }
}

const openBatch: ScopeBatch = { status: 'SCORING', isHidden: false, isLocked: false }

function item(slotIndex: number | null, batchId: string | null = 'B') {
  return { batchId, slotIndex }
}

function scope(
  over: Partial<Parameters<typeof evaluateScoreWriteScope>[0]> = {}
) {
  return evaluateScoreWriteScope({
    item: item(0),
    assignment: assigned(),
    userId: 'u0',
    dimensionIds: ['d1'],
    projectDimensionIds: PROJECT_DIMS,
    ...over,
  })
}

function refusal(result: ReturnType<typeof evaluateScoreWriteScope>) {
  if (result.ok) throw new Error('expected a refusal')
  return result
}

describe('evaluateScoringOpen', () => {
  it('allows an assignment on a visible SCORING release of an open batch', () => {
    expect(evaluateScoringOpen({ batch: openBatch, assignment: assigned() })).toEqual({ ok: true })
  })

  it('refuses a locked batch for everyone with 423, before looking at the assignment', () => {
    const result = refusal(
      evaluateScoringOpen({ batch: { ...openBatch, isLocked: true }, assignment: null })
    )
    expect(result).toMatchObject({ reason: 'locked', httpStatus: 423, error: BATCH_LOCKED_MESSAGE })
  })

  it('refuses a caller with no BatchAssignment — there is no admin bypass', () => {
    const result = refusal(evaluateScoringOpen({ batch: openBatch, assignment: null }))
    expect(result).toMatchObject({ reason: 'unassigned', httpStatus: 403, error: NOT_ASSIGNED_MESSAGE })
  })

  it('refuses a hidden batch even with an assignment', () => {
    const result = refusal(
      evaluateScoringOpen({ batch: { ...openBatch, isHidden: true }, assignment: assigned() })
    )
    expect(result).toMatchObject({ reason: 'hidden', httpStatus: 403, error: BATCH_NOT_OPEN_MESSAGE })
  })

  it('refuses a release that is not visible or not SCORING', () => {
    for (const rel of [release({ isVisible: false }), release({ status: 'RECONCILING' }), release({ status: 'COMPLETE' })]) {
      const result = refusal(evaluateScoringOpen({ batch: openBatch, assignment: assigned(rel) }))
      expect(result).toMatchObject({ reason: 'release-closed', httpStatus: 403, error: RELEASE_NOT_OPEN_MESSAGE })
    }
  })

  it('judges a legacy teamless assignment by the batch status', () => {
    expect(evaluateScoringOpen({ batch: openBatch, assignment: assigned(null) })).toEqual({ ok: true })
    const result = refusal(
      evaluateScoringOpen({ batch: { ...openBatch, status: 'RECONCILING' }, assignment: assigned(null) })
    )
    expect(result).toMatchObject({ reason: 'batch-closed', httpStatus: 403, error: BATCH_NOT_OPEN_MESSAGE })
  })
})

describe('evaluateScoreWriteScope: where the caller may write', () => {
  it('refuses an item that is in no batch', () => {
    const result = refusal(scope({ item: item(null, null) }))
    expect(result).toMatchObject({ reason: 'unbatched', httpStatus: 403, error: UNBATCHED_ITEM_MESSAGE })
  })

  it('refuses a caller with no assignment on the batch', () => {
    const result = refusal(scope({ assignment: null }))
    expect(result).toMatchObject({ reason: 'unassigned', error: NOT_ASSIGNED_MESSAGE })
  })

  describe('slot-split release (non-double-scored REGULAR, two members)', () => {
    it('allows each member their own slot', () => {
      expect(scope({ userId: 'u0', item: item(0) })).toEqual({ ok: true })
      expect(scope({ userId: 'u1', item: item(1) })).toEqual({ ok: true })
    })

    it("refuses the teammate's slot", () => {
      expect(refusal(scope({ userId: 'u0', item: item(1) }))).toMatchObject({
        reason: 'wrong-slot',
        httpStatus: 403,
        error: WRONG_SLOT_MESSAGE,
      })
      expect(refusal(scope({ userId: 'u1', item: item(0) }))).toMatchObject({ reason: 'wrong-slot' })
    })

    it('refuses an item with no slot at all (it belongs to neither half)', () => {
      expect(refusal(scope({ item: item(null) }))).toMatchObject({ reason: 'wrong-slot' })
    })

    it('refuses someone with an assignment row who is not on the team', () => {
      expect(refusal(scope({ userId: 'stranger' }))).toMatchObject({ reason: 'unassigned' })
    })
  })

  describe('single named scorer (legacy scorerUserId)', () => {
    const single = release({ scorerUserId: 'u1' })
    it('lets the named scorer write any item', () => {
      expect(scope({ assignment: assigned(single), userId: 'u1', item: item(0) })).toEqual({ ok: true })
      expect(scope({ assignment: assigned(single), userId: 'u1', item: item(null) })).toEqual({ ok: true })
    })
    it('refuses the other member', () => {
      expect(refusal(scope({ assignment: assigned(single), userId: 'u0' }))).toMatchObject({ reason: 'unassigned' })
    })
  })

  it('lets both members write every item on a double-scored release', () => {
    const dbl = assigned(release({ batch: { isDoubleScored: true } }))
    expect(scope({ assignment: dbl, userId: 'u0', item: item(1) })).toEqual({ ok: true })
    expect(scope({ assignment: dbl, userId: 'u1', item: item(0) })).toEqual({ ok: true })
    expect(scope({ assignment: dbl, userId: 'u1', item: item(null) })).toEqual({ ok: true })
  })

  it('lets every member write every item on a TRAINING release', () => {
    const training = assigned(release({ batch: { type: 'TRAINING' } }))
    expect(scope({ assignment: training, userId: 'u0', item: item(1) })).toEqual({ ok: true })
    expect(scope({ assignment: training, userId: 'u1', item: item(0) })).toEqual({ ok: true })
  })
})

describe('evaluateScoreWriteScope: which criteria the caller may write', () => {
  it("refuses a criterion outside the team's on a REGULAR batch", () => {
    const result = refusal(scope({ dimensionIds: ['d1', 'd3'] }))
    expect(result).toMatchObject({
      reason: 'not-your-criterion',
      httpStatus: 403,
      error: NOT_YOUR_CRITERION_MESSAGE,
    })
  })

  it("allows the team's criteria on a REGULAR batch", () => {
    expect(scope({ dimensionIds: ['d1', 'd2'] })).toEqual({ ok: true })
  })

  it('allows every project criterion on a TRAINING batch', () => {
    const training = assigned(release({ batch: { type: 'TRAINING' } }))
    expect(scope({ assignment: training, dimensionIds: PROJECT_DIMS })).toEqual({ ok: true })
  })

  it('allows a notes-only save (no criteria) when the item is in scope', () => {
    expect(scope({ dimensionIds: [] })).toEqual({ ok: true })
    expect(refusal(scope({ dimensionIds: [], item: item(1) }))).toMatchObject({ reason: 'wrong-slot' })
  })

  it('allows a legacy teamless assignment every item and every criterion', () => {
    const teamless = assigned(null)
    expect(scope({ assignment: teamless, item: item(1), dimensionIds: PROJECT_DIMS })).toEqual({ ok: true })
    expect(scope({ assignment: teamless, item: item(null), dimensionIds: ['d4'] })).toEqual({ ok: true })
  })

  it('checks the slot before the criteria', () => {
    expect(refusal(scope({ item: item(1), dimensionIds: ['d3'] }))).toMatchObject({ reason: 'wrong-slot' })
  })
})

describe('evaluateScoreWrite (the full route check)', () => {
  const base = {
    item: item(0),
    batch: openBatch,
    assignment: assigned(),
    userId: 'u0',
    dimensionIds: ['d1'],
    projectDimensionIds: PROJECT_DIMS,
  }

  it('passes a scoped write on an open release', () => {
    expect(evaluateScoreWrite(base)).toEqual({ ok: true })
  })

  it('refuses an unbatched item before anything else', () => {
    expect(refusal(evaluateScoreWrite({ ...base, item: item(null, null), batch: null }))).toMatchObject({
      reason: 'unbatched',
    })
  })

  it('reports openness problems before scope problems', () => {
    const locked = evaluateScoreWrite({
      ...base,
      batch: { ...openBatch, isLocked: true },
      item: item(1),
      dimensionIds: ['d3'],
    })
    expect(refusal(locked)).toMatchObject({ reason: 'locked', httpStatus: 423 })
    const unassigned = evaluateScoreWrite({ ...base, assignment: null, item: item(1) })
    expect(refusal(unassigned)).toMatchObject({ reason: 'unassigned' })
  })

  it('then applies slot and criterion scope', () => {
    expect(refusal(evaluateScoreWrite({ ...base, item: item(1) }))).toMatchObject({ reason: 'wrong-slot' })
    expect(refusal(evaluateScoreWrite({ ...base, dimensionIds: ['d4'] }))).toMatchObject({
      reason: 'not-your-criterion',
    })
  })
})
