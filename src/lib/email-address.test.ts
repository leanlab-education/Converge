import { describe, expect, it } from 'vitest'
import { isValidEmail, normalizeEmail, parseEmail } from './email-address'

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Jane.Doe@Example.COM ')).toBe('jane.doe@example.com')
  })

  it('is idempotent', () => {
    const once = normalizeEmail('Jane@Example.com')
    expect(normalizeEmail(once)).toBe(once)
  })
})

describe('isValidEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(isValidEmail('jane@example.com')).toBe(true)
    expect(isValidEmail('first.last+tag@sub.example.org')).toBe(true)
  })

  it('rejects values with no @, no domain dot, or whitespace', () => {
    expect(isValidEmail('')).toBe(false)
    expect(isValidEmail('jane')).toBe(false)
    expect(isValidEmail('jane@example')).toBe(false)
    expect(isValidEmail('jane doe@example.com')).toBe(false)
    expect(isValidEmail('@example.com')).toBe(false)
    expect(isValidEmail('jane@')).toBe(false)
  })
})

describe('parseEmail', () => {
  it('returns the normalized address for a valid string', () => {
    expect(parseEmail(' Jane@Example.com ')).toBe('jane@example.com')
  })

  it('returns null for non-strings and malformed values', () => {
    expect(parseEmail(undefined)).toBeNull()
    expect(parseEmail(null)).toBeNull()
    expect(parseEmail(42)).toBeNull()
    expect(parseEmail({ email: 'jane@example.com' })).toBeNull()
    expect(parseEmail('')).toBeNull()
    expect(parseEmail('   ')).toBeNull()
    expect(parseEmail('Jane Doe')).toBeNull()
  })
})
