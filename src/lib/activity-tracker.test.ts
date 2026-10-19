// Mock @/lib/db BEFORE importing the module under test.
import { prismaMock } from '../../test/prisma-mock'
import { describe, it, expect } from 'vitest'
import {
  computeDailyActivity,
  mergeIntervals,
  recomputeForSessionInterval,
  resolveSessionEnd,
  sweepStaleSessions,
  sweepStaleSessionsForUser,
} from '@/lib/activity-tracker'
import {
  END_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  SWEEP_STALE_AFTER_MS,
} from '@/lib/activity-tracker-config'

const T = (iso: string) => new Date(iso)
const ms = (iso: string) => new Date(iso).getTime()

type SessionRow = {
  bucket: 'ANNOTATION' | 'OTHER'
  startedAt: Date
  lastHeartbeatAt: Date
  endedAt: Date | null
}

function session(
  start: string,
  end: string | null,
  bucket: 'ANNOTATION' | 'OTHER' = 'ANNOTATION',
  lastHeartbeat?: string
): SessionRow {
  return {
    bucket,
    startedAt: T(start),
    lastHeartbeatAt: T(lastHeartbeat ?? end ?? start),
    endedAt: end ? T(end) : null,
  }
}

/** The (annotationSeconds, otherSeconds) that computeDailyActivity upserted. */
function upserted() {
  expect(prismaMock.activityDaily.upsert).toHaveBeenCalledTimes(1)
  const args = prismaMock.activityDaily.upsert.mock.calls[0][0]
  return {
    date: args.where.userId_date!.date as Date,
    annotationSeconds: args.update.annotationSeconds,
    otherSeconds: args.update.otherSeconds,
  }
}

describe('mergeIntervals', () => {
  it('returns [] for no intervals', () => {
    expect(mergeIntervals([])).toEqual([])
  })

  it('keeps disjoint intervals apart and sorts them', () => {
    expect(mergeIntervals([[30, 40], [0, 10]])).toEqual([[0, 10], [30, 40]])
  })

  it('merges overlapping, touching and nested intervals', () => {
    expect(mergeIntervals([[0, 10], [5, 15]])).toEqual([[0, 15]])
    expect(mergeIntervals([[0, 10], [10, 20]])).toEqual([[0, 20]])
    expect(mergeIntervals([[0, 100], [20, 30]])).toEqual([[0, 100]])
    expect(mergeIntervals([[20, 30], [0, 10], [10, 25], [40, 50]])).toEqual([[0, 30], [40, 50]])
  })

  it('does not mutate its input', () => {
    const input: [number, number][] = [[5, 15], [0, 10]]
    mergeIntervals(input)
    expect(input).toEqual([[5, 15], [0, 10]])
  })
})

describe('resolveSessionEnd', () => {
  const startedAt = T('2026-10-19T10:00:00Z')
  const cap = HEARTBEAT_INTERVAL_MS + END_GRACE_MS

  it('ends at now when the last heartbeat is recent', () => {
    const now = T('2026-10-19T10:30:10Z')
    const endedAt = resolveSessionEnd({
      startedAt,
      lastHeartbeatAt: T('2026-10-19T10:30:00Z'),
      now,
      reason: 'navigated',
    })
    expect(endedAt).toEqual(now)
  })

  it('never extends more than one heartbeat (plus grace) past the last heartbeat', () => {
    // Laptop slept for two hours with the tab open; the client sent its end on wake.
    const lastHeartbeatAt = T('2026-10-19T10:30:00Z')
    for (const reason of ['navigated', 'hidden', 'beacon', 'idle'] as const) {
      const endedAt = resolveSessionEnd({
        startedAt,
        lastHeartbeatAt,
        now: T('2026-10-19T12:30:00Z'),
        reason,
      })
      expect(endedAt.getTime()).toBe(lastHeartbeatAt.getTime() + cap)
    }
  })

  it('backs an idle end up to the client’s last input event', () => {
    // Active until 10:20; the hook kept heartbeating until 10:25 then declared idle.
    const endedAt = resolveSessionEnd({
      startedAt,
      lastHeartbeatAt: T('2026-10-19T10:25:00Z'),
      now: T('2026-10-19T10:25:20Z'),
      reason: 'idle',
      clientLastActiveAt: T('2026-10-19T10:20:00Z'),
    })
    expect(endedAt).toEqual(T('2026-10-19T10:20:00Z'))
  })

  it('lets the client shorten an idle end but never extend it', () => {
    const lastHeartbeatAt = T('2026-10-19T10:25:00Z')
    const now = T('2026-10-19T10:25:20Z')
    // Client clock ahead of the server: claimed activity is in the future.
    expect(
      resolveSessionEnd({
        startedAt,
        lastHeartbeatAt,
        now,
        reason: 'idle',
        clientLastActiveAt: T('2026-10-19T10:26:00Z'),
      })
    ).toEqual(now)
    // Claimed activity after the heartbeat cap (heartbeats failed) — cap wins.
    expect(
      resolveSessionEnd({
        startedAt,
        lastHeartbeatAt,
        now: T('2026-10-19T11:00:00Z'),
        reason: 'idle',
        clientLastActiveAt: T('2026-10-19T10:50:00Z'),
      }).getTime()
    ).toBe(lastHeartbeatAt.getTime() + cap)
  })

  it('ignores the client’s last-active time for non-idle reasons', () => {
    const now = T('2026-10-19T10:30:10Z')
    const endedAt = resolveSessionEnd({
      startedAt,
      lastHeartbeatAt: T('2026-10-19T10:30:00Z'),
      now,
      reason: 'hidden',
      clientLastActiveAt: T('2026-10-19T10:10:00Z'),
    })
    expect(endedAt).toEqual(now)
  })

  it('never ends before the session started', () => {
    const endedAt = resolveSessionEnd({
      startedAt,
      lastHeartbeatAt: startedAt,
      now: T('2026-10-19T10:00:20Z'),
      reason: 'idle',
      clientLastActiveAt: T('2026-10-19T09:00:00Z'),
    })
    expect(endedAt).toEqual(startedAt)
  })
})

describe('computeDailyActivity', () => {
  const userId = 'u1'

  it('queries sessions touching the UTC day and upserts the row for that day', async () => {
    prismaMock.activitySession.findMany.mockResolvedValue([])
    await computeDailyActivity(userId, T('2026-10-19T15:30:00Z'))

    const where = prismaMock.activitySession.findMany.mock.calls[0][0]!.where!
    expect(where.userId).toBe(userId)
    expect(where.startedAt).toEqual({ lt: T('2026-10-20T00:00:00Z') })
    expect(where.OR).toEqual([
      { endedAt: { gt: T('2026-10-19T00:00:00Z') } },
      { endedAt: null, lastHeartbeatAt: { gt: T('2026-10-19T00:00:00Z') } },
    ])
    expect(upserted()).toEqual({
      date: T('2026-10-19T00:00:00Z'),
      annotationSeconds: 0,
      otherSeconds: 0,
    })
  })

  it('clips a cross-midnight session to the day being computed', async () => {
    const s = session('2026-10-19T23:00:00Z', '2026-10-20T01:30:00Z')
    prismaMock.activitySession.findMany.mockResolvedValue([s] as never)
    await computeDailyActivity(userId, T('2026-10-19T12:00:00Z'))
    expect(upserted().annotationSeconds).toBe(3600)

    prismaMock.activityDaily.upsert.mockClear()
    await computeDailyActivity(userId, T('2026-10-20T12:00:00Z'))
    expect(upserted().annotationSeconds).toBe(5400)
  })

  it('dedupes overlapping sessions in the same bucket (two tabs count once)', async () => {
    prismaMock.activitySession.findMany.mockResolvedValue([
      session('2026-10-19T10:00:00Z', '2026-10-19T10:30:00Z'),
      session('2026-10-19T10:15:00Z', '2026-10-19T10:45:00Z'),
    ] as never)
    await computeDailyActivity(userId, T('2026-10-19T00:00:00Z'))
    expect(upserted().annotationSeconds).toBe(45 * 60)
  })

  it('keeps ANNOTATION and OTHER separate even when they overlap', async () => {
    prismaMock.activitySession.findMany.mockResolvedValue([
      session('2026-10-19T10:00:00Z', '2026-10-19T10:30:00Z', 'ANNOTATION'),
      session('2026-10-19T10:10:00Z', '2026-10-19T10:20:00Z', 'OTHER'),
    ] as never)
    await computeDailyActivity(userId, T('2026-10-19T00:00:00Z'))
    expect(upserted()).toMatchObject({ annotationSeconds: 1800, otherSeconds: 600 })
  })

  it('books an open session only through its last heartbeat', async () => {
    prismaMock.activitySession.findMany.mockResolvedValue([
      session('2026-10-19T10:00:00Z', null, 'OTHER', '2026-10-19T10:05:00Z'),
    ] as never)
    await computeDailyActivity(userId, T('2026-10-19T00:00:00Z'))
    expect(upserted().otherSeconds).toBe(300)
  })

  it('ignores sessions whose clipped end is not after their start', async () => {
    prismaMock.activitySession.findMany.mockResolvedValue([
      // Zero-length (swept at its only heartbeat).
      session('2026-10-19T10:00:00Z', '2026-10-19T10:00:00Z'),
      // Ends exactly at midnight — contributes nothing to the 20th.
      session('2026-10-19T23:00:00Z', '2026-10-20T00:00:00Z'),
    ] as never)
    await computeDailyActivity(userId, T('2026-10-20T00:00:00Z'))
    expect(upserted()).toMatchObject({ annotationSeconds: 0, otherSeconds: 0 })
  })
})

describe('recomputeForSessionInterval', () => {
  it('recomputes every UTC day the interval touches', async () => {
    prismaMock.activitySession.findMany.mockResolvedValue([])
    await recomputeForSessionInterval('u1', T('2026-10-18T23:00:00Z'), T('2026-10-20T00:30:00Z'))
    const dates = prismaMock.activityDaily.upsert.mock.calls
      .map((c) => (c[0].where.userId_date!.date as Date).toISOString())
      .sort()
    expect(dates).toEqual([
      '2026-10-18T00:00:00.000Z',
      '2026-10-19T00:00:00.000Z',
      '2026-10-20T00:00:00.000Z',
    ])
  })

  it('recomputes exactly one day when start and end share a day', async () => {
    prismaMock.activitySession.findMany.mockResolvedValue([])
    await recomputeForSessionInterval('u1', T('2026-10-19T10:00:00Z'), T('2026-10-19T10:00:00Z'))
    expect(prismaMock.activityDaily.upsert).toHaveBeenCalledTimes(1)
  })
})

describe('sweepStaleSessionsForUser', () => {
  const now = T('2026-10-19T12:00:00Z')
  const stale = [
    {
      id: 's-old-1',
      userId: 'u1',
      startedAt: T('2026-10-19T09:00:00Z'),
      lastHeartbeatAt: T('2026-10-19T09:40:00Z'),
    },
    {
      id: 's-old-2',
      userId: 'u1',
      startedAt: T('2026-10-18T23:50:00Z'),
      lastHeartbeatAt: T('2026-10-19T00:10:00Z'),
    },
  ]

  it('closes this user’s stale sessions at their last heartbeat, skipping the live one', async () => {
    // First findMany is the stale lookup; later ones are computeDailyActivity reads.
    prismaMock.activitySession.findMany
      .mockResolvedValueOnce(stale as never)
      .mockResolvedValue([])

    const result = await sweepStaleSessionsForUser('u1', { now, exceptSessionId: 's-live' })

    expect(result).toEqual({ closed: 2 })
    expect(prismaMock.activitySession.findMany.mock.calls[0][0]!.where).toEqual({
      userId: 'u1',
      endedAt: null,
      lastHeartbeatAt: { lt: new Date(now.getTime() - SWEEP_STALE_AFTER_MS) },
      id: { not: 's-live' },
    })
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(prismaMock.activitySession.update).toHaveBeenCalledTimes(2)
    for (const s of stale) {
      expect(prismaMock.activitySession.update).toHaveBeenCalledWith({
        where: { id: s.id },
        data: { endedAt: s.lastHeartbeatAt, endReason: 'swept' },
      })
    }
    // Rollups recomputed for every day the closed sessions touched (18th + 19th).
    const days = new Set(
      prismaMock.activityDaily.upsert.mock.calls.map((c) =>
        (c[0].where.userId_date!.date as Date).toISOString()
      )
    )
    expect(days).toEqual(new Set(['2026-10-18T00:00:00.000Z', '2026-10-19T00:00:00.000Z']))
  })

  it('does nothing when there is nothing stale', async () => {
    prismaMock.activitySession.findMany.mockResolvedValue([])
    const result = await sweepStaleSessionsForUser('u1', { now })
    expect(result).toEqual({ closed: 0 })
    expect(prismaMock.activitySession.findMany.mock.calls[0][0]!.where).not.toHaveProperty('id')
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.activityDaily.upsert).not.toHaveBeenCalled()
  })
})

describe('sweepStaleSessions (cron)', () => {
  it('sweeps across all users with the same threshold', async () => {
    const now = T('2026-10-19T04:00:00Z')
    prismaMock.activitySession.findMany
      .mockResolvedValueOnce([
        {
          id: 's1',
          userId: 'u1',
          startedAt: T('2026-10-18T20:00:00Z'),
          lastHeartbeatAt: T('2026-10-18T20:30:00Z'),
        },
      ] as never)
      .mockResolvedValue([])

    expect(await sweepStaleSessions(now)).toEqual({ closed: 1 })
    expect(prismaMock.activitySession.findMany.mock.calls[0][0]!.where).toEqual({
      endedAt: null,
      lastHeartbeatAt: { lt: new Date(ms('2026-10-19T04:00:00Z') - SWEEP_STALE_AFTER_MS) },
    })
    expect(prismaMock.activitySession.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { endedAt: T('2026-10-18T20:30:00Z'), endReason: 'swept' },
    })
  })
})
