// Mock @/lib/db BEFORE importing the route.
import { prismaMock } from '../../../../../test/prisma-mock'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SWEEP_STALE_AFTER_MS } from '@/lib/activity-tracker-config'

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }))
import { auth } from '@/lib/auth'
import { POST } from './route'

const NOW = new Date('2026-10-19T12:00:00Z')
const USER = 'u1'

function post(body: unknown) {
  return new NextRequest('http://localhost:3333/api/activity/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'vitest' },
    body: JSON.stringify(body),
  })
}

function liveSession(over: Partial<{ userId: string; bucket: string; endedAt: Date | null }> = {}) {
  return {
    userId: USER,
    bucket: 'ANNOTATION',
    startedAt: new Date('2026-10-19T11:00:00Z'),
    endedAt: null,
    ...over,
  }
}

/**
 * activitySession.findMany serves two callers: the per-user stale sweep (where
 * has `endedAt: null` at the top level) and computeDailyActivity (where has
 * `OR`). Route the sweep lookup to `stale`, everything else to [].
 */
function setStale(stale: object[]) {
  prismaMock.activitySession.findMany.mockImplementation(((args: { where?: Record<string, unknown> }) =>
    Promise.resolve(args?.where && 'OR' in args.where ? [] : stale)) as never)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(auth).mockResolvedValue({ user: { id: USER, role: 'EVALUATOR' } } as never)
  setStale([])
  prismaMock.activitySession.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.activitySession.create.mockResolvedValue({
    id: 'sess-new',
    userId: USER,
    bucket: 'ANNOTATION',
    startedAt: NOW,
    lastHeartbeatAt: NOW,
    endedAt: null,
    endReason: null,
    userAgent: 'vitest',
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('POST /api/activity/heartbeat — validation', () => {
  it('401 when unauthenticated', async () => {
    vi.mocked(auth).mockResolvedValue(null as never)
    expect((await POST(post({ bucket: 'OTHER' }))).status).toBe(401)
  })

  it('400 on an invalid bucket', async () => {
    expect((await POST(post({ bucket: 'REVIEW' }))).status).toBe(400)
    expect((await POST(post({}))).status).toBe(400)
  })

  it('400 on a malformed sessionId', async () => {
    expect((await POST(post({ bucket: 'OTHER', sessionId: 42 }))).status).toBe(400)
    expect((await POST(post({ bucket: 'OTHER', sessionId: '' }))).status).toBe(400)
    expect((await POST(post({ bucket: 'OTHER', sessionId: 'x'.repeat(65) }))).status).toBe(400)
  })
})

describe('POST /api/activity/heartbeat — starting a session', () => {
  it('creates a session when no sessionId is sent and returns its id', async () => {
    const res = await POST(post({ bucket: 'ANNOTATION' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sessionId: 'sess-new' })
    expect(prismaMock.activitySession.create).toHaveBeenCalledWith({
      data: {
        userId: USER,
        bucket: 'ANNOTATION',
        startedAt: NOW,
        lastHeartbeatAt: NOW,
        userAgent: 'vitest',
      },
    })
    expect(prismaMock.activityDaily.upsert).toHaveBeenCalled()
  })

  it('sweeps the user’s stale sessions before creating (crash recovery on next visit)', async () => {
    const orphan = {
      id: 'sess-orphan',
      userId: USER,
      startedAt: new Date('2026-10-19T08:00:00Z'),
      lastHeartbeatAt: new Date('2026-10-19T08:20:00Z'),
    }
    setStale([orphan])
    const res = await POST(post({ bucket: 'OTHER' }))
    expect(res.status).toBe(200)

    const sweepWhere = prismaMock.activitySession.findMany.mock.calls[0][0]!.where
    expect(sweepWhere).toEqual({
      userId: USER,
      endedAt: null,
      lastHeartbeatAt: { lt: new Date(NOW.getTime() - SWEEP_STALE_AFTER_MS) },
    })
    expect(prismaMock.activitySession.update).toHaveBeenCalledWith({
      where: { id: 'sess-orphan' },
      data: { endedAt: orphan.lastHeartbeatAt, endReason: 'swept' },
    })
    expect(prismaMock.activitySession.create).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/activity/heartbeat — refreshing a session', () => {
  it('refreshes a live session, sweeping the user’s other stale ones but never this one', async () => {
    prismaMock.activitySession.findUnique.mockResolvedValue(liveSession() as never)
    const res = await POST(post({ bucket: 'ANNOTATION', sessionId: 'sess-1' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sessionId: 'sess-1' })

    expect(prismaMock.activitySession.findMany.mock.calls[0][0]!.where).toMatchObject({
      userId: USER,
      endedAt: null,
      id: { not: 'sess-1' },
    })
    expect(prismaMock.activitySession.updateMany).toHaveBeenCalledWith({
      where: { id: 'sess-1', endedAt: null },
      data: { lastHeartbeatAt: NOW },
    })
    expect(prismaMock.activitySession.create).not.toHaveBeenCalled()
    expect(prismaMock.activityDaily.upsert).toHaveBeenCalled()
  })

  it.each([
    ['unknown', null],
    ['closed', liveSession({ endedAt: new Date('2026-10-19T11:30:00Z') })],
    ['another user’s', liveSession({ userId: 'someone-else' })],
    ['a different bucket', liveSession({ bucket: 'OTHER' })],
  ])('410 for a %s session — never silently creates a replacement', async (_label, existing) => {
    prismaMock.activitySession.findUnique.mockResolvedValue(existing as never)
    const res = await POST(post({ bucket: 'ANNOTATION', sessionId: 'sess-1' }))
    expect(res.status).toBe(410)
    expect(prismaMock.activitySession.create).not.toHaveBeenCalled()
    expect(prismaMock.activitySession.updateMany).not.toHaveBeenCalled()
  })

  it('410 when an end request closed the session between the read and the refresh', async () => {
    prismaMock.activitySession.findUnique.mockResolvedValue(liveSession() as never)
    prismaMock.activitySession.updateMany.mockResolvedValue({ count: 0 })
    const res = await POST(post({ bucket: 'ANNOTATION', sessionId: 'sess-1' }))
    expect(res.status).toBe(410)
    expect(prismaMock.activitySession.create).not.toHaveBeenCalled()
    expect(prismaMock.activityDaily.upsert).not.toHaveBeenCalled()
  })
})
