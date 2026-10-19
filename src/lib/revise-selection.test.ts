import { describe, it, expect } from 'vitest'
import { describeReviseFallback, selectReviseUnlock } from '@/lib/revise-selection'

const anchored = { dimensionId: 'dim-anchored', label: 'Anchored' }
const manageable = { dimensionId: 'dim-manageable', label: 'Manageable' }

describe('selectReviseUnlock', () => {
  it('returns null when nothing is re-opened', () => {
    expect(selectReviseUnlock([], 'dim-anchored')).toBeNull()
    expect(selectReviseUnlock([], undefined)).toBeNull()
  })

  it('opens the requested criterion even when it is not the first-opened one', () => {
    // "Revise Anchored" must not open Manageable just because Manageable was
    // re-opened first.
    expect(selectReviseUnlock([manageable, anchored], 'dim-anchored')).toEqual({
      unlock: anchored,
      fallback: null,
    })
  })

  it('with one unlock and no request there is nothing ambiguous', () => {
    expect(selectReviseUnlock([manageable], undefined)).toEqual({
      unlock: manageable,
      fallback: null,
    })
    expect(selectReviseUnlock([manageable], null)).toEqual({
      unlock: manageable,
      fallback: null,
    })
  })

  it('with several unlocks and no request, falls back to the first and flags it', () => {
    expect(selectReviseUnlock([manageable, anchored], undefined)).toEqual({
      unlock: manageable,
      fallback: { reason: 'ambiguous', requestedDimensionId: null },
    })
  })

  it('a request for a criterion that is not re-opened falls back to the first and says which was asked', () => {
    expect(selectReviseUnlock([manageable, anchored], 'dim-closed')).toEqual({
      unlock: manageable,
      fallback: { reason: 'not-found', requestedDimensionId: 'dim-closed' },
    })
  })

  it('an empty-string request behaves like no request', () => {
    expect(selectReviseUnlock([manageable], '')).toEqual({ unlock: manageable, fallback: null })
  })
})

describe('describeReviseFallback', () => {
  it('is silent when the requested criterion was found', () => {
    expect(describeReviseFallback({ unlock: anchored, fallback: null })).toBeNull()
  })

  it('names the criterion actually shown in both fallback cases', () => {
    const notFound = describeReviseFallback({
      unlock: manageable,
      fallback: { reason: 'not-found', requestedDimensionId: 'dim-closed' },
    })
    expect(notFound).toContain('“Manageable”')
    expect(notFound).toContain('no longer re-opened')

    const ambiguous = describeReviseFallback({
      unlock: manageable,
      fallback: { reason: 'ambiguous', requestedDimensionId: null },
    })
    expect(ambiguous).toContain('“Manageable”')
    expect(ambiguous).toContain('More than one criterion')
  })
})
