import { describe, it, expect } from 'vitest'
import {
  isStaleFinal,
  isValidExpectedFinal,
  StaleFinalError,
  STALE_FINAL_MESSAGE,
} from '@/lib/reconcile-write-guard'

describe('isStaleFinal', () => {
  it('a client that saw no final is stale once the server holds one (partner recorded it)', () => {
    expect(isStaleFinal(null, 2)).toBe(true)
  })

  it('a client that saw a final is stale once the server holds a different one', () => {
    expect(isStaleFinal(2, 3)).toBe(true)
  })

  it('a client that saw a final is stale if the server no longer holds one (re-opened)', () => {
    expect(isStaleFinal(2, null)).toBe(true)
  })

  it('matches are fresh: none/none and same/same', () => {
    expect(isStaleFinal(null, null)).toBe(false)
    expect(isStaleFinal(2, 2)).toBe(false)
  })

  it('an omitted expectedFinal opts out of the check', () => {
    expect(isStaleFinal(undefined, 2)).toBe(false)
    expect(isStaleFinal(undefined, null)).toBe(false)
  })
})

describe('isValidExpectedFinal', () => {
  it('accepts a number, null, or absent; rejects anything else', () => {
    expect(isValidExpectedFinal(2)).toBe(true)
    expect(isValidExpectedFinal(null)).toBe(true)
    expect(isValidExpectedFinal(undefined)).toBe(true)
    expect(isValidExpectedFinal('2')).toBe(false)
    expect(isValidExpectedFinal({})).toBe(false)
    expect(isValidExpectedFinal(true)).toBe(false)
  })
})

describe('StaleFinalError', () => {
  it('carries the user-facing message', () => {
    const err = new StaleFinalError()
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('StaleFinalError')
    expect(err.message).toBe(STALE_FINAL_MESSAGE)
  })
})
