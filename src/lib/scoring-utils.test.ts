import { describe, it, expect } from 'vitest'
import {
  buildNavWindow,
  getScoreColor,
  getSelectedScoreColor,
} from '@/lib/scoring-utils'

describe('getScoreColor (unselected)', () => {
  it('returns low token at the bottom of a 1-3 scale (ratio 0)', () => {
    expect(getScoreColor(1, 1, 3)).toBe(
      'border-score-low-border bg-score-low-bg text-score-low-text'
    )
  })

  it('returns mid token at the middle of a 1-3 scale (ratio 0.5)', () => {
    expect(getScoreColor(2, 1, 3)).toBe(
      'border-score-mid-border bg-score-mid-bg text-score-mid-text'
    )
  })

  it('returns high token at the top of a 1-3 scale (ratio 1)', () => {
    expect(getScoreColor(3, 1, 3)).toBe(
      'border-score-high-border bg-score-high-bg text-score-high-text'
    )
  })

  it('treats ratio exactly 0.25 as low (inclusive lower bound)', () => {
    // value 2 on a 1-5 scale: (2-1)/(5-1) = 0.25
    expect(getScoreColor(2, 1, 5)).toBe(
      'border-score-low-border bg-score-low-bg text-score-low-text'
    )
  })

  it('treats ratio just above 0.25 as mid', () => {
    // value 3 on a 1-5 scale: (3-1)/(5-1) = 0.5
    expect(getScoreColor(3, 1, 5)).toBe(
      'border-score-mid-border bg-score-mid-bg text-score-mid-text'
    )
  })

  it('treats ratio exactly 0.75 as high (mid is strictly < 0.75)', () => {
    // value 4 on a 1-5 scale: (4-1)/(5-1) = 0.75
    expect(getScoreColor(4, 1, 5)).toBe(
      'border-score-high-border bg-score-high-bg text-score-high-text'
    )
  })

  it('treats ratio just below 0.75 as mid', () => {
    // (0.749) — value 0.749 on a 0-1 scale
    expect(getScoreColor(0.749, 0, 1)).toBe(
      'border-score-mid-border bg-score-mid-bg text-score-mid-text'
    )
  })

  it('falls back to mid when min equals max (degenerate scale, no division by zero)', () => {
    expect(getScoreColor(5, 5, 5)).toBe(
      'border-score-mid-border bg-score-mid-bg text-score-mid-text'
    )
  })

  it('works with a non-1-based scale (0-2)', () => {
    expect(getScoreColor(0, 0, 2)).toContain('score-low')
    expect(getScoreColor(1, 0, 2)).toContain('score-mid')
    expect(getScoreColor(2, 0, 2)).toContain('score-high')
  })
})

describe('getSelectedScoreColor (active)', () => {
  it('returns solid low token at the bottom of a 1-3 scale', () => {
    expect(getSelectedScoreColor(1, 1, 3)).toBe(
      'bg-score-low-solid text-white border-score-low-solid'
    )
  })

  it('returns solid mid token at the middle of a 1-3 scale', () => {
    expect(getSelectedScoreColor(2, 1, 3)).toBe(
      'bg-score-mid-solid text-white border-score-mid-solid'
    )
  })

  it('returns solid high token at the top of a 1-3 scale', () => {
    expect(getSelectedScoreColor(3, 1, 3)).toBe(
      'bg-score-high-solid text-white border-score-high-solid'
    )
  })

  it('treats ratio exactly 0.25 as low and 0.75 as high (same thresholds as unselected)', () => {
    expect(getSelectedScoreColor(2, 1, 5)).toBe(
      'bg-score-low-solid text-white border-score-low-solid'
    )
    expect(getSelectedScoreColor(4, 1, 5)).toBe(
      'bg-score-high-solid text-white border-score-high-solid'
    )
  })

  it('falls back to solid mid when min equals max', () => {
    expect(getSelectedScoreColor(3, 3, 3)).toBe(
      'bg-score-mid-solid text-white border-score-mid-solid'
    )
  })

  it('mirrors the bucket chosen by getScoreColor for every value on a 1-3 scale', () => {
    const bucket = (cls: string) =>
      cls.includes('low') ? 'low' : cls.includes('high') ? 'high' : 'mid'
    for (const v of [1, 2, 3]) {
      expect(bucket(getSelectedScoreColor(v, 1, 3))).toBe(
        bucket(getScoreColor(v, 1, 3))
      )
    }
  })
})

describe('buildNavWindow', () => {
  it('lists every index without ellipsis when total fits the window', () => {
    // total <= wing*2 + 3 => 1*2+3 = 5
    expect(buildNavWindow(0, 5, 1)).toEqual([0, 1, 2, 3, 4])
  })

  it('returns an empty array for zero items', () => {
    expect(buildNavWindow(0, 0, 1)).toEqual([])
  })

  it('collapses a long range with leading and trailing ellipses around the current index', () => {
    const win = buildNavWindow(10, 20, 1)
    expect(win[0]).toBe(0)
    expect(win[win.length - 1]).toBe(19)
    expect(win).toContain('...')
    expect(win).toContain(10)
    // exactly two ellipsis markers when current is in the interior
    expect(win.filter((x) => x === '...')).toHaveLength(2)
  })

  it('omits the leading ellipsis when current is near the start', () => {
    const win = buildNavWindow(1, 20, 1)
    // start = max(1, 0) = 1, so no leading gap before index 1
    expect(win.filter((x) => x === '...')).toHaveLength(1)
    expect(win[0]).toBe(0)
    expect(win[win.length - 1]).toBe(19)
  })

  it('omits the trailing ellipsis when current is near the end', () => {
    const win = buildNavWindow(18, 20, 1)
    expect(win.filter((x) => x === '...')).toHaveLength(1)
    expect(win[0]).toBe(0)
    expect(win[win.length - 1]).toBe(19)
  })
})
