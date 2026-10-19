// Mock @/lib/db BEFORE importing the route.
import { prismaMock } from '../../../../../test/prisma-mock'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { END_GRACE_MS, HEARTBEAT_INTERVAL_MS } from '@/lib/activity-tracker-config'

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }))
import { auth } from '@/lib/auth'
import { POST } from './route'

const NOW = new Date('2026-10-19T12:00:00Z')
const USER = 'u1'

function post(body: unknown, raw = false) {
  return new NextRequest('http://localhost:3333/api/activity/end', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  })
}

function openSession(over: Partial<{ startedAt: Date; lastHeartbeatAt: Date; userId: string }> = {}) {
  return {
    id: 'sess-1',
    userId: USER,
    bucket: 'ANNOTATION',
    startedAt: new Date('2026-10-19T11:00:00Z'),
    lastHeartbeatAt: new Date('2026-10-19T11:59:50Z'),
    endedAt: null,
    endReason: null,
    userAgent: null,
    ...over,
  }
}

function endedAtWritten(): Date {
  expect(prismaMock.activitySession.updateMany).toHaveBeenCalledTimes(1)
  const args = prismaMock.activitySession.updateMany.mock.calls[0][0]!
  expect(args.where).toEqual({ id: 'sess-1', endedAt: null })
  return (args.data as { endedAt: Date }).endedAt
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(auth).mockResolvedValue({ user: { id: USER, role: 'EVALUATOR' } } as never)
  prismaMock.activitySession.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.activitySession.findMany.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('POST /api/activity/end — validation', () => {
  it('401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    const res = await POST(post({ sessionId: 'sess-1', reason: 'navigated' }))
    expect(res.status).toBe(401)
  })

  it('400 on an unparseable body (beacon or fetch)', async () => {
    const res = await POST(post('{not json', true))
    expect(res.status).toBe(400)
  })

  it('400 when sessionId is missing or not a short string', async () => {
    expect((await POST(post({ reason: 'navigated' }))).status).toBe(400)
    expect((await POST(post({ sessionId: 42, reason: 'navigated' }))).status).toBe(400)
    expect((await POST(post({ sessionId: 'x'.repeat(65), reason: 'navigated' }))).status).toBe(400)
  })

  it('400 when reason is missing, unknown, server-only or oversized', async () => {
    for (const reason of [undefined, 'test', 'swept', 'idle'.padEnd(100, '!'), 7]) {
      const res = await POST(post({ sessionId: 'sess-1', reason }))
      expect(res.status, `reason=${String(reason)}`).toBe(400)
    }
    expect(prismaMock.activitySession.findUnique).not.toHaveBeenCalled()
  })

  it('400 when lastActiveAt is present but not a number', async () => {
    // (NaN / Infinity cannot be sent over JSON — JSON.stringify emits null,
    // which the route treats as "not provided".)
    for (const lastActiveAt of ['2026-10-19', {}, true, [1]]) {
      const res = await POST(post({ sessionId: 'sess-1', reason: 'idle', lastActiveAt }))
      expect(res.status, `lastActiveAt=${JSON.stringify(lastActiveAt)}`).toBe(400)
    }
    expect(prismaMock.activitySession.findUnique).not.toHaveBeenCalled()
  })

  it('404 when the session does not exist or belongs to someone else', async () => {
    prismaMock.activitySession.findUnique.mockResolvedValue(null)
    expect((await POST(post({ sessionId: 'sess-1', reason: 'navigated' }))).status).toBe(404)

    prismaMock.activitySession.findUnique.mockResolvedValue(openSession({ userId: 'other' }) as never)
    expect((await POST(post({ sessionId: 'sess-1', reason: 'navigated' }))).status).toBe(404)
    expect(prismaMock.activitySession.updateMany).not.toHaveBeenCalled()
  })
})

describe('POST /api/activity/end — booking the end', () => {
  it('ends at now when the last heartbeat is recent', async () => {
    prismaMock.activitySession.findUnique.mockResolvedValue(openSession() as never)
    const res = await POST(post({ sessionId: 'sess-1', reason: 'navigated', lastActiveAt: NOW.getTime() }))
    expect(res.status).toBe(200)
    expect(endedAtWritten()).toEqual(NOW)
    expect(prismaMock.activitySession.updateMany.mock.calls[0][0]!.data).toMatchObject({
      endReason: 'navigated',
    })
    // Rollup recomputed for the session's day.
    expect(prismaMock.activityDaily.upsert).toHaveBeenCalledTimes(1)
  })

  it('clamps a stale end (laptop slept) to one heartbeat + grace past the last heartbeat', async () => {
    // Scored 08:00–09:00, lid closed, end request arrives at 12:00.
    const lastHeartbeatAt = new Date('2026-10-19T09:00:00Z')
    prismaMock.activitySession.findUnique.mockResolvedValue(
      openSession({ startedAt: new Date('2026-10-19T08:00:00Z'), lastHeartbeatAt }) as never
    )
    const res = await POST(post({ sessionId: 'sess-1', reason: 'navigated' }))
    expect(res.status).toBe(200)
    expect(endedAtWritten().getTime()).toBe(
      lastHeartbeatAt.getTime() + HEARTBEAT_INTERVAL_MS + END_GRACE_MS
    )
  })

  it('books an idle end at the client’s last input, not at idle detection', async () => {
    const lastActiveAt = new Date('2026-10-19T11:54:30Z')
    prismaMock.activitySession.findUnique.mockResolvedValue(openSession() as never)
    const res = await POST(
      post({ sessionId: 'sess-1', reason: 'idle', lastActiveAt: lastActiveAt.getTime() })
    )
    expect(res.status).toBe(200)
    expect(endedAtWritten()).toEqual(lastActiveAt)
  })

  it('recomputes through the old lastHeartbeatAt when the end moved earlier across midnight', async () => {
    // Session heartbeat ran past UTC midnight, but the client was last active before it.
    prismaMock.activitySession.findUnique.mockResolvedValue(
      openSession({
        startedAt: new Date('2026-10-18T23:30:00Z'),
        lastHeartbeatAt: new Date('2026-10-19T00:04:00Z'),
      }) as never
    )
    vi.setSystemTime(new Date('2026-10-19T00:04:10Z'))
    const res = await POST(
      post({
        sessionId: 'sess-1',
        reason: 'idle',
        lastActiveAt: new Date('2026-10-18T23:58:00Z').getTime(),
      })
    )
    expect(res.status).toBe(200)
    expect(endedAtWritten()).toEqual(new Date('2026-10-18T23:58:00Z'))
    // Both the 18th (where the session now ends) and the 19th (which previously
    // held four minutes of it) must be recomputed.
    const days = prismaMock.activityDaily.upsert.mock.calls
      .map((c) => (c[0].where.userId_date!.date as Date).toISOString())
      .sort()
    expect(days).toEqual(['2026-10-18T00:00:00.000Z', '2026-10-19T00:00:00.000Z'])
  })

  it('reports alreadyEnded without writing when the session is closed', async () => {
    prismaMock.activitySession.findUnique.mockResolvedValue(
      { ...openSession(), endedAt: new Date('2026-10-19T11:30:00Z') } as never
    )
    const res = await POST(post({ sessionId: 'sess-1', reason: 'navigated' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, alreadyEnded: true })
    expect(prismaMock.activitySession.updateMany).not.toHaveBeenCalled()
  })

  it('reports alreadyEnded when a racing request closed it first (conditional write)', async () => {
    prismaMock.activitySession.findUnique.mockResolvedValue(openSession() as never)
    prismaMock.activitySession.updateMany.mockResolvedValue({ count: 0 })
    const res = await POST(post({ sessionId: 'sess-1', reason: 'beacon' }))
    expect(await res.json()).toEqual({ ok: true, alreadyEnded: true })
    expect(prismaMock.activityDaily.upsert).not.toHaveBeenCalled()
  })
})
