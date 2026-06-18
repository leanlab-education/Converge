import { describe, it, expect } from 'vitest'
import {
  getExpectedReleaseDimensionIds,
  getReleaseOwnerUserId,
  getExpectedScoresPerItemPerDimension,
  releaseNeedsReconciliation,
  getReleaseUserSlotIndex,
} from '@/lib/team-batch-releases'

// Helpers under test are pure (no DB). The ReleaseWithContext shape accepts
// batch metadata either nested under `batch` (the Prisma include shape) or
// flattened as `batchType`/`isDoubleScored` (the convenience shape). We exercise
// both, plus members ordered email-asc (members[0] is the lowest email).

const members = [{ userId: 'u0' }, { userId: 'u1' }]
const teamDims = { dimensions: [{ dimensionId: 'd1' }, { dimensionId: 'd2' }] }
const projectDims = ['d1', 'd2', 'd3', 'd4']

// Flattened-shape fixtures.
const split = {
  id: 'r',
  team: { members, ...teamDims },
  scorerUserId: null,
  batchType: 'REGULAR',
  isDoubleScored: false,
}
const single = {
  id: 'r',
  team: { members, ...teamDims },
  scorerUserId: 'u0',
  batchType: 'REGULAR',
  isDoubleScored: false,
}
const dbl = {
  id: 'r',
  team: { members, ...teamDims },
  scorerUserId: null,
  batchType: 'REGULAR',
  isDoubleScored: true,
}
const training = {
  id: 'r',
  team: { members, ...teamDims },
  scorerUserId: null,
  batchType: 'TRAINING',
  isDoubleScored: false,
}

describe('getExpectedReleaseDimensionIds', () => {
  it('TRAINING releases score every project dimension', () => {
    expect(getExpectedReleaseDimensionIds(training, projectDims)).toEqual(projectDims)
  })

  it('non-TRAINING releases score only the team dimensions', () => {
    expect(getExpectedReleaseDimensionIds(split, projectDims)).toEqual(['d1', 'd2'])
    expect(getExpectedReleaseDimensionIds(dbl, projectDims)).toEqual(['d1', 'd2'])
    expect(getExpectedReleaseDimensionIds(single, projectDims)).toEqual(['d1', 'd2'])
  })

  it('reads batch.type from the nested batch shape', () => {
    const nestedTraining = {
      id: 'r',
      team: { members, ...teamDims },
      scorerUserId: null,
      batch: { id: 'b', isDoubleScored: false, type: 'TRAINING' },
    }
    expect(getExpectedReleaseDimensionIds(nestedTraining, projectDims)).toEqual(
      projectDims
    )
  })

  it('returns empty array when a non-TRAINING team has no dimensions', () => {
    const noDims = { id: 'r', team: { members }, scorerUserId: null, batchType: 'REGULAR' }
    expect(getExpectedReleaseDimensionIds(noDims, projectDims)).toEqual([])
  })

  it('TRAINING returns project dims even when the team has its own dims', () => {
    expect(getExpectedReleaseDimensionIds(training, [])).toEqual([])
  })
})

describe('getReleaseOwnerUserId', () => {
  it('returns the first member (lowest email, email-asc ordering)', () => {
    expect(getReleaseOwnerUserId(split)).toBe('u0')
  })

  it('returns the sole member for a single-member team', () => {
    const solo = { id: 'r', team: { members: [{ userId: 'only' }] }, scorerUserId: null }
    expect(getReleaseOwnerUserId(solo)).toBe('only')
  })

  it('returns null when the team has no members', () => {
    const empty = { id: 'r', team: { members: [] }, scorerUserId: null }
    expect(getReleaseOwnerUserId(empty)).toBeNull()
  })

  it('does not depend on batch metadata', () => {
    expect(getReleaseOwnerUserId(training)).toBe('u0')
    expect(getReleaseOwnerUserId(single)).toBe('u0')
  })
})

describe('getExpectedScoresPerItemPerDimension', () => {
  it('TRAINING expects one score per member', () => {
    expect(getExpectedScoresPerItemPerDimension(training)).toBe(2)
  })

  it('TRAINING with a single member expects 1', () => {
    const soloTraining = {
      id: 'r',
      team: { members: [{ userId: 'u0' }], ...teamDims },
      scorerUserId: null,
      batchType: 'TRAINING',
      isDoubleScored: false,
    }
    expect(getExpectedScoresPerItemPerDimension(soloTraining)).toBe(1)
  })

  it('double-scored regular expects 2', () => {
    expect(getExpectedScoresPerItemPerDimension(dbl)).toBe(2)
  })

  it('double-scored with fewer than 2 members falls back to member count', () => {
    const soloDbl = {
      id: 'r',
      team: { members: [{ userId: 'u0' }], ...teamDims },
      scorerUserId: null,
      batchType: 'REGULAR',
      isDoubleScored: true,
    }
    expect(getExpectedScoresPerItemPerDimension(soloDbl)).toBe(1)
  })

  it('single-scored regular (split) expects 1', () => {
    expect(getExpectedScoresPerItemPerDimension(split)).toBe(1)
    expect(getExpectedScoresPerItemPerDimension(single)).toBe(1)
  })

  it('regular with no members expects 0', () => {
    const noMembers = {
      id: 'r',
      team: { members: [] },
      scorerUserId: null,
      batchType: 'REGULAR',
      isDoubleScored: false,
    }
    expect(getExpectedScoresPerItemPerDimension(noMembers)).toBe(0)
  })

  it('TRAINING takes precedence over isDoubleScored when both could apply', () => {
    const threeMemberTraining = {
      id: 'r',
      team: { members: [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }] },
      scorerUserId: null,
      batchType: 'TRAINING',
      isDoubleScored: true,
    }
    // TRAINING branch wins: members.length, not the double-scored cap of 2.
    expect(getExpectedScoresPerItemPerDimension(threeMemberTraining)).toBe(3)
  })

  it('reads metadata from the nested batch shape', () => {
    const nestedDbl = {
      id: 'r',
      team: { members },
      scorerUserId: null,
      batch: { id: 'b', isDoubleScored: true, type: 'REGULAR' },
    }
    expect(getExpectedScoresPerItemPerDimension(nestedDbl)).toBe(2)
  })
})

describe('releaseNeedsReconciliation', () => {
  it('is true for TRAINING and double-scored releases', () => {
    expect(releaseNeedsReconciliation(training)).toBe(true)
    expect(releaseNeedsReconciliation(dbl)).toBe(true)
  })

  it('is false for single-scored regular (split or named scorer)', () => {
    expect(releaseNeedsReconciliation(split)).toBe(false)
    expect(releaseNeedsReconciliation(single)).toBe(false)
  })

  it('reads metadata from the nested batch shape', () => {
    const nestedDbl = {
      id: 'r',
      team: { members },
      scorerUserId: null,
      batch: { id: 'b', isDoubleScored: true, type: 'REGULAR' },
    }
    const nestedSplit = {
      id: 'r',
      team: { members },
      scorerUserId: null,
      batch: { id: 'b', isDoubleScored: false, type: 'REGULAR' },
    }
    expect(releaseNeedsReconciliation(nestedDbl)).toBe(true)
    expect(releaseNeedsReconciliation(nestedSplit)).toBe(false)
  })
})

describe('getReleaseUserSlotIndex', () => {
  it('returns the email-asc index for members on a slot-split release', () => {
    expect(getReleaseUserSlotIndex(split, 'u0')).toBe(0)
    expect(getReleaseUserSlotIndex(split, 'u1')).toBe(1)
  })

  it('returns null for a non-member on a slot-split release', () => {
    expect(getReleaseUserSlotIndex(split, 'outsider')).toBeNull()
  })

  it('returns null for a single-scorer release (not split)', () => {
    expect(getReleaseUserSlotIndex(single, 'u0')).toBeNull()
    expect(getReleaseUserSlotIndex(single, 'u1')).toBeNull()
  })

  it('returns null for double-scored and training releases (not split)', () => {
    expect(getReleaseUserSlotIndex(dbl, 'u0')).toBeNull()
    expect(getReleaseUserSlotIndex(training, 'u0')).toBeNull()
  })

  it('returns null when the team has fewer than 2 members (no split)', () => {
    const soloSplit = {
      id: 'r',
      team: { members: [{ userId: 'u0' }] },
      scorerUserId: null,
      batchType: 'REGULAR',
      isDoubleScored: false,
    }
    expect(getReleaseUserSlotIndex(soloSplit, 'u0')).toBeNull()
  })
})
