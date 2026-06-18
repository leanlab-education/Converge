import { describe, it, expect } from 'vitest'
import { parseFeedbackId, compareFeedbackIds } from '@/lib/feedback-id'

describe('parseFeedbackId', () => {
  it('splits a prefix and trailing number', () => {
    expect(parseFeedbackId('F123')).toEqual({ prefix: 'f', numeric: 123, raw: 'f123' })
  })

  it('lowercases and trims', () => {
    expect(parseFeedbackId('  Resp42 ')).toEqual({ prefix: 'resp', numeric: 42, raw: 'resp42' })
  })

  it('returns null numeric when there is no trailing number', () => {
    expect(parseFeedbackId('abc')).toEqual({ prefix: 'abc', numeric: null, raw: 'abc' })
  })
})

describe('compareFeedbackIds', () => {
  it('orders numerically within the same prefix (F2 before F10)', () => {
    expect(compareFeedbackIds('F2', 'F10')).toBeLessThan(0)
    expect(compareFeedbackIds('F10', 'F2')).toBeGreaterThan(0)
  })

  it('orders by prefix first', () => {
    expect(compareFeedbackIds('A100', 'B1')).toBeLessThan(0)
  })

  it('is consistent for equal ids', () => {
    expect(compareFeedbackIds('F5', 'F5')).toBe(0)
  })

  it('sorts a list the way the export/order logic expects', () => {
    const sorted = ['F10', 'F2', 'F1', 'S3', 'F100'].sort(compareFeedbackIds)
    expect(sorted).toEqual(['F1', 'F2', 'F10', 'F100', 'S3'])
  })
})
