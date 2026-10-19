// Mock @/lib/db BEFORE importing the route.
import { prismaMock } from '../../../../test/prisma-mock'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }))
vi.mock('@/lib/authorization', () => ({ canAdminProject: vi.fn() }))
vi.mock('@/lib/reconciliation', () => ({ maybeAdvanceReleaseAfterScore: vi.fn() }))

import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import { maybeAdvanceReleaseAfterScore } from '@/lib/reconciliation'
import { GET, PUT } from '@/app/api/scores/route'
import {
  NOT_ASSIGNED_MESSAGE,
  NOT_YOUR_CRITERION_MESSAGE,
  RELEASE_NOT_OPEN_MESSAGE,
  UNBATCHED_ITEM_MESSAGE,
  WRONG_SLOT_MESSAGE,
} from '@/lib/score-write-scope'
import { BATCH_LOCKED_MESSAGE } from '@/lib/reconciliation-access'

const USER = { id: 'u0', role: 'EVALUATOR', email: 'a@x.test', name: 'A' }

function signedIn(user = USER) {
  vi.mocked(auth).mockResolvedValue({ user } as never)
}

// Team of two on a non-double-scored REGULAR batch: u0 (email a) → slot 0,
// u1 (email b) → slot 1; the team scores d1 and d2 of the four criteria.
const assignment = {
  teamReleaseId: 'r1',
  teamRelease: {
    id: 'r1',
    scorerUserId: null,
    isVisible: true,
    status: 'SCORING',
    batch: { type: 'REGULAR', isDoubleScored: false },
    team: {
      members: [{ userId: 'u0' }, { userId: 'u1' }],
      dimensions: [{ dimensionId: 'd1' }, { dimensionId: 'd2' }],
    },
  },
}
const dims = ['d1', 'd2', 'd3', 'd4'].map((id) => ({ id, scaleMin: 0, scaleMax: 1 }))

function putRequest(body: unknown) {
  return new Request('http://localhost/api/scores', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function arrangePut(over: {
  item?: Partial<{ projectId: string; batchId: string | null; slotIndex: number | null }>
  batch?: Partial<{ status: string; isHidden: boolean; isLocked: boolean }> | null
  assignment?: typeof assignment | null
} = {}) {
  prismaMock.feedbackItem.findUnique.mockResolvedValue({
    projectId: 'p1',
    batchId: 'B',
    slotIndex: 0,
    ...over.item,
  } as never)
  prismaMock.projectEvaluator.findUnique.mockResolvedValue({ id: 'pe' } as never)
  prismaMock.batch.findUnique.mockResolvedValue(
    over.batch === null
      ? null
      : ({ status: 'SCORING', isHidden: false, isLocked: false, ...over.batch } as never)
  )
  prismaMock.batchAssignment.findUnique.mockResolvedValue(
    (over.assignment === undefined ? assignment : over.assignment) as never
  )
  prismaMock.rubricDimension.findMany.mockResolvedValue(dims as never)
  prismaMock.score.upsert.mockResolvedValue({} as never)
  prismaMock.score.updateMany.mockResolvedValue({ count: 0 })
}

beforeEach(() => {
  vi.mocked(auth).mockReset()
  vi.mocked(canAdminProject).mockReset()
  vi.mocked(maybeAdvanceReleaseAfterScore).mockReset()
  vi.mocked(canAdminProject).mockResolvedValue(false)
})

describe('GET /api/scores', () => {
  it("returns only the caller's own raw rows, scoped to the batch", async () => {
    signedIn()
    prismaMock.projectEvaluator.findUnique.mockResolvedValue({ id: 'pe' } as never)
    prismaMock.score.findMany.mockResolvedValue([])

    const res = await GET(new NextRequest('http://localhost/api/scores?projectId=p1&batchId=B'))
    expect(res.status).toBe(200)
    expect(prismaMock.score.findMany).toHaveBeenCalledTimes(1)
    const args = prismaMock.score.findMany.mock.calls[0][0]!
    expect(args.where).toMatchObject({
      feedbackItem: { projectId: 'p1', batchId: 'B' },
      userId: 'u0',
      isReconciled: false,
    })
  })

  it('scopes admins to their own raw rows too (no cross-annotator read, no finals)', async () => {
    signedIn({ ...USER, id: 'admin', role: 'ADMIN' })
    vi.mocked(canAdminProject).mockResolvedValue(true)
    prismaMock.score.findMany.mockResolvedValue([])

    const res = await GET(new NextRequest('http://localhost/api/scores?projectId=p1'))
    expect(res.status).toBe(200)
    expect(prismaMock.projectEvaluator.findUnique).not.toHaveBeenCalled()
    const args = prismaMock.score.findMany.mock.calls[0][0]!
    expect(args.where).toMatchObject({ userId: 'admin', isReconciled: false })
    expect(args.where).not.toHaveProperty('feedbackItem.batchId')
  })

  it('refuses a non-member', async () => {
    signedIn()
    prismaMock.projectEvaluator.findUnique.mockResolvedValue(null)
    const res = await GET(new NextRequest('http://localhost/api/scores?projectId=p1'))
    expect(res.status).toBe(403)
    expect(prismaMock.score.findMany).not.toHaveBeenCalled()
  })
})

describe('PUT /api/scores: scope', () => {
  beforeEach(() => signedIn())

  it('writes the caller’s own slot and team criteria, then checks release advancement', async () => {
    arrangePut()
    const res = await PUT(
      putRequest({
        feedbackItemId: 'i1',
        scores: [{ dimensionId: 'd1', value: 1 }, { dimensionId: 'd2', value: 0 }],
        notes: 'n',
        startedAt: '2026-10-19T10:00:00.000Z',
      })
    )
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ saved: true })
    expect(prismaMock.score.upsert).toHaveBeenCalledTimes(2)
    expect(maybeAdvanceReleaseAfterScore).toHaveBeenCalledWith('r1')
  })

  it('refuses an admin with no assignment (Preview Annotator View is read-only)', async () => {
    vi.mocked(canAdminProject).mockResolvedValue(true)
    arrangePut({ assignment: null })
    const res = await PUT(putRequest({ feedbackItemId: 'i1', scores: [{ dimensionId: 'd1', value: 1 }] }))
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: NOT_ASSIGNED_MESSAGE })
    expect(prismaMock.score.upsert).not.toHaveBeenCalled()
    expect(prismaMock.score.updateMany).not.toHaveBeenCalled()
  })

  it("refuses an item in the teammate's slot", async () => {
    arrangePut({ item: { slotIndex: 1 } })
    const res = await PUT(putRequest({ feedbackItemId: 'i1', scores: [{ dimensionId: 'd1', value: 1 }] }))
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: WRONG_SLOT_MESSAGE })
    expect(prismaMock.score.upsert).not.toHaveBeenCalled()
  })

  it("refuses a criterion outside the team's on a REGULAR batch", async () => {
    arrangePut()
    const res = await PUT(putRequest({ feedbackItemId: 'i1', scores: [{ dimensionId: 'd3', value: 1 }] }))
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: NOT_YOUR_CRITERION_MESSAGE })
    expect(prismaMock.score.upsert).not.toHaveBeenCalled()
  })

  it('refuses an item that is in no batch', async () => {
    arrangePut({ item: { batchId: null, slotIndex: null }, batch: null, assignment: null })
    const res = await PUT(putRequest({ feedbackItemId: 'i1', scores: [{ dimensionId: 'd1', value: 1 }] }))
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: UNBATCHED_ITEM_MESSAGE })
    expect(prismaMock.batch.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.score.upsert).not.toHaveBeenCalled()
  })

  it('refuses a locked batch with 423', async () => {
    arrangePut({ batch: { isLocked: true } })
    const res = await PUT(putRequest({ feedbackItemId: 'i1', scores: [{ dimensionId: 'd1', value: 1 }] }))
    expect(res.status).toBe(423)
    await expect(res.json()).resolves.toEqual({ error: BATCH_LOCKED_MESSAGE })
  })

  it('refuses once the release has left SCORING', async () => {
    arrangePut({
      assignment: { ...assignment, teamRelease: { ...assignment.teamRelease, status: 'RECONCILING' } },
    })
    const res = await PUT(putRequest({ feedbackItemId: 'i1', scores: [{ dimensionId: 'd1', value: 1 }] }))
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: RELEASE_NOT_OPEN_MESSAGE })
  })

  it('rejects an unknown criterion with 400 before asking about scope', async () => {
    arrangePut({ assignment: null })
    const res = await PUT(putRequest({ feedbackItemId: 'i1', scores: [{ dimensionId: 'nope', value: 1 }] }))
    expect(res.status).toBe(400)
  })

  it('rejects a malformed score entry with 400', async () => {
    arrangePut()
    const res = await PUT(putRequest({ feedbackItemId: 'i1', scores: [{ dimensionId: 'd1', value: '1' }] }))
    expect(res.status).toBe(400)
    expect(prismaMock.feedbackItem.findUnique).not.toHaveBeenCalled()
  })
})

describe('PUT /api/scores: startedAt is set once', () => {
  beforeEach(() => signedIn())

  it('sets startedAt on create, never on update, and back-fills rows that have none', async () => {
    arrangePut()
    const startedAt = '2026-10-19T10:00:00.000Z'
    await PUT(
      putRequest({ feedbackItemId: 'i1', scores: [{ dimensionId: 'd1', value: 1 }], startedAt })
    )
    const upsert = prismaMock.score.upsert.mock.calls[0][0]
    expect(upsert.update).not.toHaveProperty('startedAt')
    expect(upsert.update).toMatchObject({ value: 1 })
    expect(upsert.create).toMatchObject({ startedAt: new Date(startedAt), value: 1, userId: 'u0' })

    expect(prismaMock.score.updateMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.score.updateMany.mock.calls[0][0]).toEqual({
      where: { feedbackItemId: 'i1', userId: 'u0', isReconciled: false, startedAt: null },
      data: { startedAt: new Date(startedAt) },
    })
  })

  it('leaves startedAt alone when the save carries none', async () => {
    arrangePut()
    await PUT(putRequest({ feedbackItemId: 'i1', scores: [{ dimensionId: 'd1', value: 1 }] }))
    expect(prismaMock.score.upsert.mock.calls[0][0].create).toMatchObject({ startedAt: null })
    expect(prismaMock.score.updateMany).not.toHaveBeenCalled()
  })
})
