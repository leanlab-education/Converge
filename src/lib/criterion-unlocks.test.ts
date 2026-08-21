import { describe, it, expect } from 'vitest'
import {
  describeUnlockScope,
  unlockAppliesToUser,
  unlockVisibleToUserWhere,
} from '@/lib/criterion-unlocks'

const LUOFAN = 'user-luofan'
const ABI = 'user-abi'

describe('unlockAppliesToUser', () => {
  it('pair-wide unlock (null userId) applies to any member', () => {
    expect(unlockAppliesToUser({ userId: null }, LUOFAN)).toBe(true)
    expect(unlockAppliesToUser({ userId: null }, ABI)).toBe(true)
  })

  it('scoped unlock applies only to the named annotator', () => {
    expect(unlockAppliesToUser({ userId: LUOFAN }, LUOFAN)).toBe(true)
    expect(unlockAppliesToUser({ userId: LUOFAN }, ABI)).toBe(false)
  })
})

describe('unlockVisibleToUserWhere', () => {
  it('matches pair-wide and own-scoped unlocks, nothing else', () => {
    // Pin the exact filter shape: every read path (project page task, /revise
    // page, revise write route) relies on this OR to keep a scoped unlock from
    // leaking to the partner.
    expect(unlockVisibleToUserWhere(LUOFAN)).toEqual({
      OR: [{ userId: null }, { userId: LUOFAN }],
    })
  })
})

describe('describeUnlockScope', () => {
  const names = (id: string) => (id === LUOFAN ? 'Luofan' : 'Someone')

  it('labels pair-wide unlocks', () => {
    expect(describeUnlockScope({ userId: null }, names)).toBe('Both annotators')
  })

  it('names the scoped annotator', () => {
    expect(describeUnlockScope({ userId: LUOFAN }, names)).toBe('Luofan')
  })
})
