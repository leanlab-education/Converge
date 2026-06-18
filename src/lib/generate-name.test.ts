import { describe, it, expect } from 'vitest'
import { generateName, displayAnnotatorName } from '@/lib/generate-name'

describe('generateName', () => {
  it('returns a two-word "Adjective Noun" string', () => {
    const name = generateName('user-123')
    expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
    expect(name.split(' ')).toHaveLength(2)
  })

  it('capitalizes both words', () => {
    const [adj, noun] = generateName('seed-abc').split(' ')
    expect(adj[0]).toBe(adj[0].toUpperCase())
    expect(noun[0]).toBe(noun[0].toUpperCase())
  })

  it('is deterministic for the same seed', () => {
    expect(generateName('abc123')).toBe(generateName('abc123'))
    expect(generateName('the-same-id')).toBe(generateName('the-same-id'))
  })

  it('produces different names for different seeds (generally)', () => {
    const a = generateName('user-1')
    const b = generateName('user-2')
    const c = generateName('user-3')
    // At least one of these should differ — hashing distinct seeds
    expect(new Set([a, b, c]).size).toBeGreaterThan(1)
  })

  it('handles an empty seed without throwing', () => {
    const name = generateName('')
    expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
    // empty string hashes to 0 → first adjective + first noun
    expect(name).toBe('Amber Anchor')
  })

  it('handles long and unicode seeds', () => {
    expect(() => generateName('x'.repeat(10000))).not.toThrow()
    const u = generateName('héllo-wörld-🎉')
    expect(u).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
  })
})

describe('displayAnnotatorName', () => {
  it('returns the real name when usePseudonyms is false', () => {
    expect(displayAnnotatorName('id-1', 'Amber Wang', false)).toBe('Amber Wang')
  })

  it('returns "Unknown" when usePseudonyms is false and name is null', () => {
    expect(displayAnnotatorName('id-1', null, false)).toBe('Unknown')
  })

  it('returns "Unknown" when usePseudonyms is false and name is undefined', () => {
    expect(displayAnnotatorName('id-1', undefined, false)).toBe('Unknown')
  })

  it('returns "Unknown" when usePseudonyms is false and name is empty string', () => {
    expect(displayAnnotatorName('id-1', '', false)).toBe('Unknown')
  })

  it('returns "pseudonym (name)" when usePseudonyms is true and name present', () => {
    const pseudo = generateName('id-1')
    expect(displayAnnotatorName('id-1', 'Amber Wang', true)).toBe(`${pseudo} (Amber Wang)`)
  })

  it('returns bare pseudonym when usePseudonyms is true and name is null', () => {
    const pseudo = generateName('id-1')
    expect(displayAnnotatorName('id-1', null, true)).toBe(pseudo)
  })

  it('returns bare pseudonym when usePseudonyms is true and name is empty string', () => {
    const pseudo = generateName('id-1')
    expect(displayAnnotatorName('id-1', '', true)).toBe(pseudo)
  })

  it('defaults usePseudonyms to true when omitted', () => {
    const pseudo = generateName('id-99')
    expect(displayAnnotatorName('id-99', 'Real Person')).toBe(`${pseudo} (Real Person)`)
    expect(displayAnnotatorName('id-99', null)).toBe(pseudo)
  })

  it('derives the pseudonym deterministically from the id, not the name', () => {
    // Same id, different names → same pseudonym prefix
    const a = displayAnnotatorName('same-id', 'Alice', true)
    const b = displayAnnotatorName('same-id', 'Bob', true)
    expect(a.split(' (')[0]).toBe(b.split(' (')[0])
    expect(a.split(' (')[0]).toBe(generateName('same-id'))
  })

  it('uses different pseudonyms for different ids', () => {
    const a = displayAnnotatorName('id-a', null, true)
    const b = displayAnnotatorName('id-b', null, true)
    expect(a).toBe(generateName('id-a'))
    expect(b).toBe(generateName('id-b'))
  })
})
