// Route-level test for POST .../reconcile's stale-write protection.
//
// Prisma is the deep mock from ./prisma-mock (imported first so @/lib/db is
// replaced before the route module resolves it); auth, authorization and the
// release-completion side effect are stubbed so only the route's own logic runs.
import { prismaMock } from './prisma-mock'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Prisma } from '@/generated/prisma/client'
import { STALE_FINAL_MESSAGE } from '@/lib/reconcile-write-guard'

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }))
vi.mock('@/lib/authorization', () => ({ canAdminProject: vi.fn() }))
vi.mock('@/lib/reconciliation', () => ({
  maybeCompleteReleaseReconciliation: vi.fn(),
}))

import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import { maybeCompleteReleaseReconciliation } from '@/lib/reconciliation'
import { POST } from '@/app/api/projects/[projectId]/batches/[batchId]/reconcile/route'

const PROJECT_ID = 'proj-1'
const BATCH_ID = 'batch-1'
const RELEASE_ID = 'rel-1'
const ITEM_ID = 'item-7'
const DIM_1 = 'dim-1'
const DIM_2 = 'dim-2'
const PARTNER = 'user-a' // alphabetically first → release owner
const ME = 'user-b'

const release = {
  id: RELEASE_ID,
  batchId: BATCH_ID,
  status: 'RECONCILING',
  adjudicatorId: null,
  batch: {
    id: BATCH_ID,
    projectId: PROJECT_ID,
    type: 'REGULAR',
    isDoubleScored: true,
    isLocked: false,
  },
  team: {
    members: [{ userId: PARTNER }, { userId: ME }],
    dimensions: [{ dimensionId: DIM_1 }, { dimensionId: DIM_2 }],
  },
}

type ScoreInput = { dimensionId: string; value: number; expectedFinal?: number | null }

function request(scores: ScoreInput[], notes?: string) {
  return new NextRequest(
    `http://localhost/api/projects/${PROJECT_ID}/batches/${BATCH_ID}/reconcile`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        releaseId: RELEASE_ID,
        items: [{ feedbackItemId: ITEM_ID, scores, notes }],
      }),
    }
  )
}

function call(scores: ScoreInput[], notes?: string) {
  return POST(request(scores, notes), {
    params: Promise.resolve({ projectId: PROJECT_ID, batchId: BATCH_ID }),
  })
}

/** What the server currently holds as the final for each dimension (null = none). */
function serverHolds(finals: Record<string, number | null>) {
  prismaMock.score.findUnique.mockImplementation(((args: {
    where: {
      feedbackItemId_userId_dimensionId_isReconciled: { dimensionId: string }
    }
  }) => {
    const value = finals[args.where.feedbackItemId_userId_dimensionId_isReconciled.dimensionId]
    return Promise.resolve(value == null ? null : { value })
  }) as never)
}

beforeEach(() => {
  vi.mocked(auth).mockResolvedValue({
    user: { id: ME, role: 'EVALUATOR', email: 'b@test.com' },
  } as never)
  vi.mocked(canAdminProject).mockResolvedValue(false)
  vi.mocked(maybeCompleteReleaseReconciliation).mockResolvedValue(false)

  prismaMock.batchAssignment.findFirst.mockResolvedValue({ id: 'ba-1' } as never)
  prismaMock.teamBatchRelease.findUnique.mockResolvedValue(release as never)
  prismaMock.rubricDimension.findMany.mockResolvedValue([
    { id: DIM_1, scaleMin: 1, scaleMax: 3 },
    { id: DIM_2, scaleMin: 1, scaleMax: 3 },
  ] as never)
  prismaMock.feedbackItem.findUnique.mockResolvedValue({ batchId: BATCH_ID } as never)
  // Interactive transaction: run the callback against the same mock.
  prismaMock.$transaction.mockImplementation(((fn: (tx: typeof prismaMock) => Promise<unknown>) =>
    fn(prismaMock)) as never)
  prismaMock.escalation.findMany.mockResolvedValue([])
  prismaMock.escalation.count.mockResolvedValue(0)
  prismaMock.score.findMany.mockResolvedValue([
    { id: 's-a', userId: PARTNER, value: 2 },
    { id: 's-b', userId: ME, value: 3 },
  ] as never)
  prismaMock.score.upsert.mockResolvedValue({} as never)
  serverHolds({})
})

describe('POST /reconcile — stale-write protection', () => {
  it('refuses a save when the client saw no final but the partner has since recorded one', async () => {
    // Partner A saved item 7 = 2 while B's screen still showed it unsaved.
    serverHolds({ [DIM_1]: 2 })

    const res = await call([{ dimensionId: DIM_1, value: 3, expectedFinal: null }])

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: STALE_FINAL_MESSAGE })
    expect(prismaMock.score.upsert).not.toHaveBeenCalled()
    expect(maybeCompleteReleaseReconciliation).not.toHaveBeenCalled()
  })

  it('refuses a save when the final the client saw differs from the one the server holds', async () => {
    serverHolds({ [DIM_1]: 2 })

    const res = await call([{ dimensionId: DIM_1, value: 3, expectedFinal: 1 }])

    expect(res.status).toBe(409)
    expect(prismaMock.score.upsert).not.toHaveBeenCalled()
  })

  it('detects staleness in the pre-pass, so a multi-cell save applies nothing partially', async () => {
    // First cell is fresh, second is stale: neither may be written.
    serverHolds({ [DIM_1]: null, [DIM_2]: 2 })

    const res = await call([
      { dimensionId: DIM_1, value: 1, expectedFinal: null },
      { dimensionId: DIM_2, value: 3, expectedFinal: null },
    ])

    expect(res.status).toBe(409)
    expect(prismaMock.score.upsert).not.toHaveBeenCalled()
  })

  it('accepts a first recording when neither side has a final yet', async () => {
    serverHolds({ [DIM_1]: null })

    const res = await call([{ dimensionId: DIM_1, value: 2, expectedFinal: null }])

    expect(res.status).toBe(200)
    expect(prismaMock.score.upsert).toHaveBeenCalledTimes(1)
    const upsert = prismaMock.score.upsert.mock.calls[0][0]
    expect(upsert.create).toMatchObject({
      feedbackItemId: ITEM_ID,
      userId: PARTNER, // release owner storage slot, not the actor
      dimensionId: DIM_1,
      value: 2,
      isReconciled: true,
      reconciledFrom: 's-a,s-b',
      reconciledById: ME,
    })
    expect(maybeCompleteReleaseReconciliation).toHaveBeenCalledWith(RELEASE_ID)
  })

  it('accepts an edit when the client saw the final the server holds, and attributes the change', async () => {
    serverHolds({ [DIM_1]: 2 })

    const res = await call([{ dimensionId: DIM_1, value: 3, expectedFinal: 2 }], 'we talked')

    expect(res.status).toBe(200)
    const upsert = prismaMock.score.upsert.mock.calls[0][0]
    expect(upsert.update).toMatchObject({
      value: 3,
      notes: 'we talked',
      reconciledById: ME,
    })
  })

  it('a no-op resave of the same final keeps the original attribution', async () => {
    serverHolds({ [DIM_1]: 2 })

    const res = await call([{ dimensionId: DIM_1, value: 2, expectedFinal: 2 }], 'notes only')

    expect(res.status).toBe(200)
    const upsert = prismaMock.score.upsert.mock.calls[0][0]
    expect(upsert.update).not.toHaveProperty('reconciledById')
  })

  it('a caller that omits expectedFinal is not checked (last write wins)', async () => {
    serverHolds({ [DIM_1]: 2 })

    const res = await call([{ dimensionId: DIM_1, value: 3 }])

    expect(res.status).toBe(200)
    expect(prismaMock.score.upsert).toHaveBeenCalledTimes(1)
  })

  it('rejects a malformed expectedFinal before touching the database', async () => {
    const res = await call([
      { dimensionId: DIM_1, value: 2, expectedFinal: '2' as unknown as number },
    ])

    expect(res.status).toBe(400)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('still maps a serialization failure (P2034) to 409', async () => {
    prismaMock.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('could not serialize access', {
        code: 'P2034',
        clientVersion: 'test',
      })
    )

    const res = await call([{ dimensionId: DIM_1, value: 2, expectedFinal: null }])

    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/just updated by someone else/)
  })

  it('reports the release status and open-escalation count after the save', async () => {
    prismaMock.teamBatchRelease.findUnique
      .mockResolvedValueOnce(release as never)
      .mockResolvedValueOnce({ status: 'COMPLETE' } as never)
    prismaMock.escalation.count.mockResolvedValue(0)

    const res = await call([{ dimensionId: DIM_1, value: 2, expectedFinal: null }])

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      saved: true,
      reconciledCount: 1,
      releaseStatus: 'COMPLETE',
      openEscalationCount: 0,
    })
  })
})
