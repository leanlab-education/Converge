import { describe, it, expect } from 'vitest'
import { countForAssignment, type BatchAssignmentForStats } from '@/lib/evaluator-stats'

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
