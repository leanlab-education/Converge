import { describe, it, expect } from 'vitest'
import {
  ACTIVITY_EVENTS,
  bucketForPath,
  isActivityEndReason,
  parsePeriodQuery,
  periodRange,
  startOfUtcDay,
  startOfUtcMonth,
  startOfUtcWeek,
} from '@/lib/activity-tracker-config'

// 2024-01-01 was a Monday.
const MON = new Date('2024-01-01T09:00:00Z')
const WED = new Date('2024-01-03T23:59:59Z')
const SUN = new Date('2024-01-07T00:00:01Z')

describe('bucketForPath', () => {
  it('books every page where an annotator does review work as ANNOTATION', () => {
    expect(bucketForPath('/evaluate/proj-1')).toBe('ANNOTATION')
    expect(bucketForPath('/reconcile/proj-1')).toBe('ANNOTATION')
    expect(bucketForPath('/revise/proj-1')).toBe('ANNOTATION')
    expect(bucketForPath('/adjudicate')).toBe('ANNOTATION')
    expect(bucketForPath('/adjudicate/anything')).toBe('ANNOTATION')
  })

  it('books the rest of the authenticated app as OTHER', () => {
    expect(bucketForPath('/')).toBe('OTHER')
    expect(bucketForPath('/projects/proj-1')).toBe('OTHER')
    expect(bucketForPath('/admin')).toBe('OTHER')
    expect(bucketForPath('/admin/proj-1/batches/new')).toBe('OTHER')
    // Prefix matching must not bleed into look-alike paths.
    expect(bucketForPath('/adjudicated')).toBe('OTHER')
    expect(bucketForPath('/evaluateX')).toBe('OTHER')
  })

  it('does not track unauthenticated pages', () => {
    expect(bucketForPath('/login')).toBeNull()
    expect(bucketForPath('/invite/tok')).toBeNull()
    expect(bucketForPath('/reset-password')).toBeNull()
    expect(bucketForPath('/reset-password/tok')).toBeNull()
  })
})

describe('ACTIVITY_EVENTS', () => {
  it('includes wheel and pointerdown alongside scroll (inner panes do not bubble scroll)', () => {
    expect(ACTIVITY_EVENTS).toContain('wheel')
    expect(ACTIVITY_EVENTS).toContain('pointerdown')
    expect(ACTIVITY_EVENTS).toContain('scroll')
  })
})

describe('isActivityEndReason', () => {
  it('accepts exactly the client reasons', () => {
    for (const r of ['hidden', 'idle', 'navigated', 'beacon']) {
      expect(isActivityEndReason(r)).toBe(true)
    }
  })

  it('rejects server-only, unknown, empty, oversized and non-string values', () => {
    expect(isActivityEndReason('swept')).toBe(false)
    expect(isActivityEndReason('test')).toBe(false)
    expect(isActivityEndReason('')).toBe(false)
    expect(isActivityEndReason('idle'.padEnd(200, 'x'))).toBe(false)
    expect(isActivityEndReason(42)).toBe(false)
    expect(isActivityEndReason(null)).toBe(false)
    expect(isActivityEndReason(undefined)).toBe(false)
    expect(isActivityEndReason(['idle'])).toBe(false)
  })
})

describe('UTC day/week/month math', () => {
  it('startOfUtcDay truncates to 00:00Z', () => {
    expect(startOfUtcDay(WED).toISOString()).toBe('2024-01-03T00:00:00.000Z')
  })

  it('startOfUtcWeek is the preceding Monday (ISO week)', () => {
    expect(startOfUtcWeek(MON).toISOString()).toBe('2024-01-01T00:00:00.000Z')
    expect(startOfUtcWeek(WED).toISOString()).toBe('2024-01-01T00:00:00.000Z')
    // Sunday belongs to the week that started the previous Monday.
    expect(startOfUtcWeek(SUN).toISOString()).toBe('2024-01-01T00:00:00.000Z')
    // Monday one second after midnight is its own week start.
    expect(startOfUtcWeek(new Date('2024-01-08T00:00:01Z')).toISOString()).toBe(
      '2024-01-08T00:00:00.000Z'
    )
  })

  it('startOfUtcMonth truncates to the 1st', () => {
    expect(startOfUtcMonth(new Date('2024-02-29T12:00:00Z')).toISOString()).toBe(
      '2024-02-01T00:00:00.000Z'
    )
  })
})

describe('periodRange', () => {
  it('week runs from Monday through the end of today (exclusive)', () => {
    expect(periodRange('week', { now: WED })).toEqual({
      from: new Date('2024-01-01T00:00:00Z'),
      to: new Date('2024-01-04T00:00:00Z'),
    })
  })

  it('month runs from the 1st through the end of today', () => {
    expect(periodRange('month', { now: new Date('2024-02-15T10:00:00Z') })).toEqual({
      from: new Date('2024-02-01T00:00:00Z'),
      to: new Date('2024-02-16T00:00:00Z'),
    })
  })

  it('all runs from the epoch through the end of today', () => {
    expect(periodRange('all', { now: WED })).toEqual({
      from: new Date(0),
      to: new Date('2024-01-04T00:00:00Z'),
    })
  })

  it('custom truncates from to its day and treats to as an inclusive day', () => {
    expect(
      periodRange('custom', {
        from: new Date('2024-01-02T10:00:00Z'),
        to: new Date('2024-01-05T23:00:00Z'),
      })
    ).toEqual({
      from: new Date('2024-01-02T00:00:00Z'),
      to: new Date('2024-01-06T00:00:00Z'),
    })
  })

  it('custom without both bounds throws', () => {
    expect(() => periodRange('custom', { from: WED })).toThrow(/from and to/)
    expect(() => periodRange('custom', {})).toThrow(/from and to/)
  })
})

describe('parsePeriodQuery', () => {
  const q = (s: string) => new URLSearchParams(s)

  it('defaults to month', () => {
    const r = parsePeriodQuery(q(''), WED)
    expect(r).toMatchObject({ ok: true, period: 'month' })
    expect(r.ok && r.range.from.toISOString()).toBe('2024-01-01T00:00:00.000Z')
  })

  it('rejects an unknown period', () => {
    expect(parsePeriodQuery(q('period=year'), WED)).toEqual({ ok: false, error: 'Invalid period' })
  })

  it('rejects unparseable dates instead of passing Invalid Date to Prisma', () => {
    expect(parsePeriodQuery(q('period=custom&from=garbage&to=2024-01-05'), WED)).toEqual({
      ok: false,
      error: 'Invalid from date',
    })
    expect(parsePeriodQuery(q('period=custom&from=2024-01-02&to=not-a-date'), WED)).toEqual({
      ok: false,
      error: 'Invalid to date',
    })
    // A bad date on a non-custom period is still a bad request, not silently ignored.
    expect(parsePeriodQuery(q('period=week&from=garbage'), WED)).toEqual({
      ok: false,
      error: 'Invalid from date',
    })
  })

  it('rejects custom without both bounds', () => {
    expect(parsePeriodQuery(q('period=custom&from=2024-01-02'), WED)).toEqual({
      ok: false,
      error: 'Custom period requires from and to',
    })
  })

  it('accepts a valid custom range', () => {
    const r = parsePeriodQuery(q('period=custom&from=2024-01-02&to=2024-01-05'), WED)
    expect(r).toEqual({
      ok: true,
      period: 'custom',
      range: { from: new Date('2024-01-02T00:00:00Z'), to: new Date('2024-01-06T00:00:00Z') },
    })
  })

  it('treats empty from/to as absent', () => {
    expect(parsePeriodQuery(q('period=week&from=&to='), WED)).toMatchObject({
      ok: true,
      period: 'week',
    })
  })
})
