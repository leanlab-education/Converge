// Mock @/lib/db BEFORE importing the module under test.
import { prismaMock } from '../../test/prisma-mock'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mockDeep } from 'vitest-mock-extended'
import type { PrismaClient } from '@/generated/prisma/client'
import {
  healStrandedRelease,
  maybeCompleteReleaseReconciliation,
  maybeAdvanceReleaseAfterScore,
  reReconcileReleaseItem,
  shouldListReconcileTask,
} from '@/lib/reconciliation'

// ---------------------------------------------------------------------------
// Release context fixtures.
//
// getReleaseContext does teamBatchRelease.findUnique with batch + team.members
// (ordered email asc) + team.dimensions. For the lifecycle functions we need:
//   - status (gates the function)
//   - batch.type / batch.isDoubleScored (drives reconcile-needed + scores/item)
//   - team.members (owner = members[0]; userIds; size)
//   - team.dimensions (dimensionIds for REGULAR batches)
//   - isVisible + batchId (used by isReleaseFullyScored)
// ---------------------------------------------------------------------------

const RELEASE_ID = 'rel-1'
const BATCH_ID = 'batch-1'

type ReleaseOverrides = {
  status?: string
  isVisible?: boolean
  type?: string
  isDoubleScored?: boolean
  members?: { userId: string }[]
  dimensions?: { dimensionId: string }[]
}

function makeRelease(o: ReleaseOverrides = {}) {
  return {
    id: RELEASE_ID,
    batchId: BATCH_ID,
    isVisible: o.isVisible ?? true,
    status: o.status ?? 'RECONCILING',
    scorerUserId: null,
    batch: {
      id: BATCH_ID,
      projectId: 'proj-1',
      type: o.type ?? 'REGULAR',
      isDoubleScored: o.isDoubleScored ?? true,
    },
    team: {
      members: o.members ?? [{ userId: 'u0' }, { userId: 'u1' }],
      dimensions: o.dimensions ?? [{ dimensionId: 'd1' }],
    },
  }
}

/** Wire getReleaseContext to return a given release (or null). */
function setRelease(release: ReturnType<typeof makeRelease> | null) {
  prismaMock.teamBatchRelease.findUnique.mockResolvedValue(release as never)
}

/**
 * Wire the two score.findMany queries used by maybeCompleteReleaseReconciliation
 * and autoReconcileAgreedScoresForRelease. Both branch on where.isReconciled.
 */
function setScoreFindMany(
  original: { feedbackItemId: string; dimensionId: string; value: number; userId: string }[],
  reconciled: { feedbackItemId: string; dimensionId: string }[]
) {
  prismaMock.score.findMany.mockImplementation((args) =>
    Promise.resolve(args?.where?.isReconciled ? reconciled : original) as never
  )
}

/** syncBatchStatus reads the batch's releases then updates. Give it something. */
function setSyncBatchStatus() {
  prismaMock.batch.findUnique.mockResolvedValue({
    id: BATCH_ID,
    teamReleases: [{ status: 'COMPLETE' }],
  } as never)
  prismaMock.batch.update.mockResolvedValue({} as never)
}

beforeEach(() => {
  // mockReset runs in prisma-mock's beforeEach; set the always-needed defaults.
  setSyncBatchStatus()
  prismaMock.teamBatchRelease.update.mockResolvedValue({} as never)
  // Completion now requires every expected raw score to exist. Default to a
  // fully scored pair (1 item × 1 dim × 2 scores); tests about the gate itself
  // override these.
  prismaMock.feedbackItem.count.mockResolvedValue(1 as never)
  prismaMock.score.count.mockResolvedValue(2 as never)
  // $transaction is used by autoReconcile; run the callback / resolve the array.
  prismaMock.$transaction.mockImplementation((arg: unknown) =>
    Promise.resolve(typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(prismaMock) : arg) as never
  )
  prismaMock.score.upsert.mockResolvedValue({} as never)
})

// ===========================================================================
// maybeCompleteReleaseReconciliation
// ===========================================================================
describe('maybeCompleteReleaseReconciliation', () => {
  it('completes RECONCILING → COMPLETE when all discrepancies reconciled and no open escalations', async () => {
    // One item, one dim, two members disagree → one discrepancy, resolved.
    setRelease(makeRelease({ status: 'RECONCILING' }))
    setScoreFindMany(
      [
        { feedbackItemId: 'i1', dimensionId: 'd1', value: 1, userId: 'u0' },
        { feedbackItemId: 'i1', dimensionId: 'd1', value: 0, userId: 'u1' },
      ],
      [{ feedbackItemId: 'i1', dimensionId: 'd1' }]
    )
    prismaMock.escalation.count.mockResolvedValue(0 as never)

    const result = await maybeCompleteReleaseReconciliation(RELEASE_ID)

    expect(result).toBe(true)
    expect(prismaMock.teamBatchRelease.update).toHaveBeenCalledWith({
      where: { id: RELEASE_ID },
      data: { status: 'COMPLETE' },
    })
  })

  it('stays RECONCILING when an unresolved discrepancy remains', async () => {
    setRelease(makeRelease({ status: 'RECONCILING' }))
    setScoreFindMany(
      [
        { feedbackItemId: 'i1', dimensionId: 'd1', value: 1, userId: 'u0' },
        { feedbackItemId: 'i1', dimensionId: 'd1', value: 0, userId: 'u1' },
      ],
      [] // discrepancy NOT reconciled
    )
    prismaMock.escalation.count.mockResolvedValue(0 as never)

    const result = await maybeCompleteReleaseReconciliation(RELEASE_ID)

    expect(result).toBe(false)
    expect(prismaMock.teamBatchRelease.update).not.toHaveBeenCalled()
  })

  it('stays RECONCILING when an open escalation remains even if all discrepancies reconciled (I-10)', async () => {
    setRelease(makeRelease({ status: 'RECONCILING' }))
    setScoreFindMany(
      [
        { feedbackItemId: 'i1', dimensionId: 'd1', value: 1, userId: 'u0' },
        { feedbackItemId: 'i1', dimensionId: 'd1', value: 0, userId: 'u1' },
      ],
      [{ feedbackItemId: 'i1', dimensionId: 'd1' }] // reconciled...
    )
    prismaMock.escalation.count.mockResolvedValue(1 as never) // ...but one open escalation

    const result = await maybeCompleteReleaseReconciliation(RELEASE_ID)

    expect(result).toBe(false)
    expect(prismaMock.teamBatchRelease.update).not.toHaveBeenCalled()
  })

  it('completes when the pair fully agreed (zero discrepancies, no escalations)', async () => {
    setRelease(makeRelease({ status: 'RECONCILING' }))
    // Two members agree on the only (item,dim): not a discrepancy.
    setScoreFindMany(
      [
        { feedbackItemId: 'i1', dimensionId: 'd1', value: 2, userId: 'u0' },
        { feedbackItemId: 'i1', dimensionId: 'd1', value: 2, userId: 'u1' },
      ],
      [{ feedbackItemId: 'i1', dimensionId: 'd1' }] // auto-reconciled agreed row
    )
    prismaMock.escalation.count.mockResolvedValue(0 as never)

    const result = await maybeCompleteReleaseReconciliation(RELEASE_ID)

    expect(result).toBe(true)
    expect(prismaMock.teamBatchRelease.update).toHaveBeenCalledWith({
      where: { id: RELEASE_ID },
      data: { status: 'COMPLETE' },
    })
  })

  it('returns false when the release is not in RECONCILING status', async () => {
    setRelease(makeRelease({ status: 'SCORING' }))
    const result = await maybeCompleteReleaseReconciliation(RELEASE_ID)
    expect(result).toBe(false)
    expect(prismaMock.escalation.count).not.toHaveBeenCalled()
    expect(prismaMock.teamBatchRelease.update).not.toHaveBeenCalled()
  })

  it('never completes while a raw score is missing, even with nothing left to reconcile', async () => {
    // A RECONCILING release where the partner never scored one cell: the pair
    // "agrees" on everything that exists, zero escalations — the old rule
    // would complete it with work missing.
    setRelease(makeRelease({ status: 'RECONCILING' }))
    prismaMock.feedbackItem.count.mockResolvedValue(1 as never)
    prismaMock.score.count.mockResolvedValue(1 as never) // expected 2
    setScoreFindMany(
      [{ feedbackItemId: 'i1', dimensionId: 'd1', value: 2, userId: 'u0' }],
      []
    )
    prismaMock.escalation.count.mockResolvedValue(0 as never)

    const result = await maybeCompleteReleaseReconciliation(RELEASE_ID)

    expect(result).toBe(false)
    expect(prismaMock.teamBatchRelease.update).not.toHaveBeenCalled()
    expect(prismaMock.batch.update).not.toHaveBeenCalled()
  })

  it('returns false when the release does not exist', async () => {
    setRelease(null)
    const result = await maybeCompleteReleaseReconciliation(RELEASE_ID)
    expect(result).toBe(false)
  })

  it('returns false when the team does not have exactly 2 members', async () => {
    setRelease(makeRelease({ status: 'RECONCILING', members: [{ userId: 'u0' }] }))
    const result = await maybeCompleteReleaseReconciliation(RELEASE_ID)
    expect(result).toBe(false)
    // Bails before counting escalations / updating status.
    expect(prismaMock.escalation.count).not.toHaveBeenCalled()
    expect(prismaMock.teamBatchRelease.update).not.toHaveBeenCalled()
  })

  it('returns false when the release has no dimensions', async () => {
    setRelease(makeRelease({ status: 'RECONCILING', dimensions: [] }))
    const result = await maybeCompleteReleaseReconciliation(RELEASE_ID)
    expect(result).toBe(false)
    expect(prismaMock.teamBatchRelease.update).not.toHaveBeenCalled()
  })

  it('TRAINING release resolves dimension ids from project rubric dimensions', async () => {
    setRelease(
      makeRelease({ status: 'RECONCILING', type: 'TRAINING', isDoubleScored: false })
    )
    prismaMock.rubricDimension.findMany.mockResolvedValue([{ id: 'd1' }] as never)
    // Full agreement on the single project dim → completes.
    setScoreFindMany(
      [
        { feedbackItemId: 'i1', dimensionId: 'd1', value: 1, userId: 'u0' },
        { feedbackItemId: 'i1', dimensionId: 'd1', value: 1, userId: 'u1' },
      ],
      []
    )
    prismaMock.escalation.count.mockResolvedValue(0 as never)

    const result = await maybeCompleteReleaseReconciliation(RELEASE_ID)

    expect(result).toBe(true)
    expect(prismaMock.rubricDimension.findMany).toHaveBeenCalled()
  })
})

// ===========================================================================
// maybeAdvanceReleaseAfterScore
// ===========================================================================
describe('maybeAdvanceReleaseAfterScore', () => {
  it('returns false when the release is not in SCORING', async () => {
    setRelease(makeRelease({ status: 'RECONCILING' }))
    const result = await maybeAdvanceReleaseAfterScore(RELEASE_ID)
    expect(result).toBe(false)
    expect(prismaMock.teamBatchRelease.update).not.toHaveBeenCalled()
  })

  it('returns false when the release does not exist', async () => {
    setRelease(null)
    expect(await maybeAdvanceReleaseAfterScore(RELEASE_ID)).toBe(false)
  })

  it('stays SCORING when not fully scored (partner unfinished)', async () => {
    setRelease(makeRelease({ status: 'SCORING' }))
    // isReleaseFullyScored: 1 item × 1 dim × 2 scores/item = 2 expected, only 1 present.
    prismaMock.feedbackItem.count.mockResolvedValue(1 as never)
    prismaMock.score.count.mockResolvedValue(1 as never)

    const result = await maybeAdvanceReleaseAfterScore(RELEASE_ID)

    expect(result).toBe(false)
    expect(prismaMock.teamBatchRelease.update).not.toHaveBeenCalled()
  })

  it('non-double single-scored regular goes SCORING → COMPLETE (no reconciliation)', async () => {
    setRelease(
      makeRelease({ status: 'SCORING', isDoubleScored: false })
    )
    // scoresPerItemPerDim = 1 for non-double regular → expected 1, present 1.
    prismaMock.feedbackItem.count.mockResolvedValue(1 as never)
    prismaMock.score.count.mockResolvedValue(1 as never)

    const result = await maybeAdvanceReleaseAfterScore(RELEASE_ID)

    expect(result).toBe(true)
    expect(prismaMock.teamBatchRelease.update).toHaveBeenCalledWith({
      where: { id: RELEASE_ID },
      data: { status: 'COMPLETE' },
    })
    // No reconciliation path → escalation.count never consulted.
    expect(prismaMock.escalation.count).not.toHaveBeenCalled()
  })

  it('P1: a fully-AGREED double-scored release reaches COMPLETE (RECONCILING then auto-complete)', async () => {
    // This is the launch-critical regression: full agreement means no
    // discrepancies, so the reconcile/adjudicate routes never fire — the inline
    // maybeCompleteReleaseReconciliation call must carry it to COMPLETE.
    //
    // The real DB write of RECONCILING is what lets the inner
    // maybeCompleteReleaseReconciliation (which re-reads via getReleaseContext)
    // proceed past its status guard. Make findUnique reflect the persisted
    // status so the mock models that hand-off.
    let persistedStatus = 'SCORING'
    prismaMock.teamBatchRelease.findUnique.mockImplementation(
      () => Promise.resolve(makeRelease({ status: persistedStatus, isDoubleScored: true })) as never
    )
    prismaMock.teamBatchRelease.update.mockImplementation((args) => {
      persistedStatus = (args as { data: { status: string } }).data.status
      return Promise.resolve({}) as never
    })
    // Fully scored: 1 item × 1 dim × 2 = 2 expected, 2 present.
    prismaMock.feedbackItem.count.mockResolvedValue(1 as never)
    prismaMock.score.count.mockResolvedValue(2 as never)
    // Both members agree → zero discrepancies.
    setScoreFindMany(
      [
        { feedbackItemId: 'i1', dimensionId: 'd1', value: 3, userId: 'u0' },
        { feedbackItemId: 'i1', dimensionId: 'd1', value: 3, userId: 'u1' },
      ],
      // After auto-reconcile, the agreed row exists under the owner.
      [{ feedbackItemId: 'i1', dimensionId: 'd1' }]
    )
    prismaMock.escalation.count.mockResolvedValue(0 as never)

    const result = await maybeAdvanceReleaseAfterScore(RELEASE_ID)

    expect(result).toBe(true)
    // It first set RECONCILING, then COMPLETE (two status updates).
    const updateCalls = prismaMock.teamBatchRelease.update.mock.calls.map(
      (c) => (c[0] as { data: { status: string } }).data.status
    )
    expect(updateCalls).toEqual(['RECONCILING', 'COMPLETE'])
    // Auto-reconcile wrote the agreed row.
    expect(prismaMock.score.upsert).toHaveBeenCalled()
  })

  it('double-scored release with an open discrepancy lands in RECONCILING (not COMPLETE)', async () => {
    setRelease(makeRelease({ status: 'SCORING', isDoubleScored: true }))
    prismaMock.feedbackItem.count.mockResolvedValue(1 as never)
    prismaMock.score.count.mockResolvedValue(2 as never)
    // Members disagree, nothing reconciled yet.
    setScoreFindMany(
      [
        { feedbackItemId: 'i1', dimensionId: 'd1', value: 3, userId: 'u0' },
        { feedbackItemId: 'i1', dimensionId: 'd1', value: 1, userId: 'u1' },
      ],
      []
    )
    prismaMock.escalation.count.mockResolvedValue(0 as never)

    const result = await maybeAdvanceReleaseAfterScore(RELEASE_ID)

    expect(result).toBe(true)
    const updateCalls = prismaMock.teamBatchRelease.update.mock.calls.map(
      (c) => (c[0] as { data: { status: string } }).data.status
    )
    // Set RECONCILING; the inline complete attempt no-ops (discrepancy open).
    expect(updateCalls).toEqual(['RECONCILING'])
  })

  it('TRAINING release advances SCORING → RECONCILING (reconciliation applies)', async () => {
    setRelease(
      makeRelease({ status: 'SCORING', type: 'TRAINING', isDoubleScored: false })
    )
    prismaMock.rubricDimension.findMany.mockResolvedValue([{ id: 'd1' }] as never)
    // TRAINING: scoresPerItemPerDim = members.length = 2. 1 item × 1 dim × 2 = 2.
    prismaMock.feedbackItem.count.mockResolvedValue(1 as never)
    prismaMock.score.count.mockResolvedValue(2 as never)
    // Disagreement keeps it in RECONCILING.
    setScoreFindMany(
      [
        { feedbackItemId: 'i1', dimensionId: 'd1', value: 0, userId: 'u0' },
        { feedbackItemId: 'i1', dimensionId: 'd1', value: 1, userId: 'u1' },
      ],
      []
    )
    prismaMock.escalation.count.mockResolvedValue(0 as never)

    const result = await maybeAdvanceReleaseAfterScore(RELEASE_ID)

    expect(result).toBe(true)
    const updateCalls = prismaMock.teamBatchRelease.update.mock.calls.map(
      (c) => (c[0] as { data: { status: string } }).data.status
    )
    expect(updateCalls).toEqual(['RECONCILING'])
  })

  it('stays SCORING when the release is not visible', async () => {
    // isReleaseFullyScored short-circuits to false when !isVisible.
    setRelease(makeRelease({ status: 'SCORING', isVisible: false }))
    const result = await maybeAdvanceReleaseAfterScore(RELEASE_ID)
    expect(result).toBe(false)
    expect(prismaMock.teamBatchRelease.update).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// reReconcileReleaseItem — after an annotator revises one raw score
// ===========================================================================
describe('reReconcileReleaseItem', () => {
  const ITEM = 'i1'
  const DIM = 'd1'

  /**
   * score.findMany is called three ways here:
   *   - the revised cell's raw pair   (where.feedbackItemId set, isReconciled false)
   *   - every raw score in the batch   (where.feedbackItem.batchId, isReconciled false)
   *   - the owner's reconciled finals  (isReconciled true)
   */
  function setScores(args: {
    cell: { id: string; userId: string; value: number }[]
    allRaw: { feedbackItemId: string; dimensionId: string; value: number; userId: string }[]
    reconciled: { feedbackItemId: string; dimensionId: string }[]
  }) {
    prismaMock.score.findMany.mockImplementation((q) => {
      const where = (q?.where ?? {}) as { feedbackItemId?: string; isReconciled?: boolean }
      if (where.isReconciled) return Promise.resolve(args.reconciled) as never
      if (where.feedbackItemId) return Promise.resolve(args.cell) as never
      return Promise.resolve(args.allRaw) as never
    })
  }

  beforeEach(() => {
    prismaMock.escalation.deleteMany.mockResolvedValue({ count: 0 } as never)
    prismaMock.score.deleteMany.mockResolvedValue({ count: 0 } as never)
    prismaMock.escalation.count.mockResolvedValue(0 as never)
  })

  it('pair now DISAGREES: drops the stale final AND any escalation so the cell is an ordinary open discrepancy', async () => {
    setRelease(makeRelease({ status: 'RECONCILING' }))
    setScores({
      cell: [
        { id: 's0', userId: 'u0', value: 1 },
        { id: 's1', userId: 'u1', value: 0 },
      ],
      allRaw: [
        { feedbackItemId: ITEM, dimensionId: DIM, value: 1, userId: 'u0' },
        { feedbackItemId: ITEM, dimensionId: DIM, value: 0, userId: 'u1' },
      ],
      reconciled: [],
    })

    await reReconcileReleaseItem(RELEASE_ID, ITEM, DIM)

    // A RESOLVED escalation left here made every reader treat the cell as
    // "set by the adjudicator" with no value, and completion impossible.
    expect(prismaMock.escalation.deleteMany).toHaveBeenCalledWith({
      where: { teamReleaseId: RELEASE_ID, feedbackItemId: ITEM, dimensionId: DIM },
    })
    expect(prismaMock.score.deleteMany).toHaveBeenCalledWith({
      where: { feedbackItemId: ITEM, userId: 'u0', dimensionId: DIM, isReconciled: true },
    })
    expect(prismaMock.score.upsert).not.toHaveBeenCalled()
  })

  it('pair now AGREES: writes the auto-reconciled final AND drops any escalation (no adjudicator value survives)', async () => {
    setRelease(makeRelease({ status: 'RECONCILING' }))
    setScores({
      cell: [
        { id: 's0', userId: 'u0', value: 2 },
        { id: 's1', userId: 'u1', value: 2 },
      ],
      allRaw: [
        { feedbackItemId: ITEM, dimensionId: DIM, value: 2, userId: 'u0' },
        { feedbackItemId: ITEM, dimensionId: DIM, value: 2, userId: 'u1' },
      ],
      reconciled: [{ feedbackItemId: ITEM, dimensionId: DIM }],
    })

    await reReconcileReleaseItem(RELEASE_ID, ITEM, DIM)

    expect(prismaMock.escalation.deleteMany).toHaveBeenCalledWith({
      where: { teamReleaseId: RELEASE_ID, feedbackItemId: ITEM, dimensionId: DIM },
    })
    expect(prismaMock.score.upsert).toHaveBeenCalledOnce()
    const upsert = prismaMock.score.upsert.mock.calls[0][0] as {
      where: { feedbackItemId_userId_dimensionId_isReconciled: { userId: string } }
      update: { value: number; reconciledById: null }
    }
    expect(upsert.where.feedbackItemId_userId_dimensionId_isReconciled.userId).toBe('u0')
    expect(upsert.update.value).toBe(2)
    expect(upsert.update.reconciledById).toBeNull()
    expect(prismaMock.score.deleteMany).not.toHaveBeenCalled()
  })

  it('never promotes a SCORING release to RECONCILING (the partner may still owe items)', async () => {
    setRelease(makeRelease({ status: 'SCORING' }))
    setScores({
      cell: [
        { id: 's0', userId: 'u0', value: 1 },
        { id: 's1', userId: 'u1', value: 0 },
      ],
      allRaw: [
        { feedbackItemId: ITEM, dimensionId: DIM, value: 1, userId: 'u0' },
        { feedbackItemId: ITEM, dimensionId: DIM, value: 0, userId: 'u1' },
      ],
      reconciled: [],
    })

    await reReconcileReleaseItem(RELEASE_ID, ITEM, DIM)

    // Open work exists, but SCORING → RECONCILING belongs to
    // maybeAdvanceReleaseAfterScore; promoting here would 403 the partner's
    // remaining scoring.
    expect(prismaMock.teamBatchRelease.update).not.toHaveBeenCalled()
    expect(prismaMock.batch.update).not.toHaveBeenCalled()
  })

  it('moves a COMPLETE release back to RECONCILING when the revision re-opens a discrepancy, and syncs the batch', async () => {
    setRelease(makeRelease({ status: 'COMPLETE' }))
    setScores({
      cell: [
        { id: 's0', userId: 'u0', value: 1 },
        { id: 's1', userId: 'u1', value: 0 },
      ],
      allRaw: [
        { feedbackItemId: ITEM, dimensionId: DIM, value: 1, userId: 'u0' },
        { feedbackItemId: ITEM, dimensionId: DIM, value: 0, userId: 'u1' },
      ],
      reconciled: [],
    })

    await reReconcileReleaseItem(RELEASE_ID, ITEM, DIM)

    expect(prismaMock.teamBatchRelease.update).toHaveBeenCalledWith({
      where: { id: RELEASE_ID },
      data: { status: 'RECONCILING' },
    })
    expect(prismaMock.batch.update).toHaveBeenCalled()
  })

  it('leaves a RECONCILING release alone while open work remains', async () => {
    setRelease(makeRelease({ status: 'RECONCILING' }))
    setScores({
      cell: [
        { id: 's0', userId: 'u0', value: 1 },
        { id: 's1', userId: 'u1', value: 0 },
      ],
      allRaw: [
        { feedbackItemId: ITEM, dimensionId: DIM, value: 1, userId: 'u0' },
        { feedbackItemId: ITEM, dimensionId: DIM, value: 0, userId: 'u1' },
      ],
      reconciled: [],
    })

    await reReconcileReleaseItem(RELEASE_ID, ITEM, DIM)

    expect(prismaMock.teamBatchRelease.update).not.toHaveBeenCalled()
  })

  it('completes a RECONCILING release when the revision resolved the last discrepancy', async () => {
    setRelease(makeRelease({ status: 'RECONCILING' }))
    setScores({
      cell: [
        { id: 's0', userId: 'u0', value: 2 },
        { id: 's1', userId: 'u1', value: 2 },
      ],
      allRaw: [
        { feedbackItemId: ITEM, dimensionId: DIM, value: 2, userId: 'u0' },
        { feedbackItemId: ITEM, dimensionId: DIM, value: 2, userId: 'u1' },
      ],
      reconciled: [{ feedbackItemId: ITEM, dimensionId: DIM }],
    })

    await reReconcileReleaseItem(RELEASE_ID, ITEM, DIM)

    expect(prismaMock.teamBatchRelease.update).toHaveBeenCalledWith({
      where: { id: RELEASE_ID },
      data: { status: 'COMPLETE' },
    })
  })

  it('runs every read and write on the transaction client it is given', async () => {
    // The revise route runs the raw-score upsert and this re-derivation in one
    // serializable transaction; a query on the shared client would not see the
    // transaction's uncommitted upsert.
    const tx = mockDeep<PrismaClient>()
    tx.teamBatchRelease.findUnique.mockResolvedValue(
      makeRelease({ status: 'COMPLETE' }) as never
    )
    tx.score.findMany.mockImplementation((q) => {
      const where = (q?.where ?? {}) as { feedbackItemId?: string; isReconciled?: boolean }
      if (where.isReconciled) return Promise.resolve([]) as never
      if (where.feedbackItemId) {
        return Promise.resolve([
          { id: 's0', userId: 'u0', value: 1 },
          { id: 's1', userId: 'u1', value: 0 },
        ]) as never
      }
      return Promise.resolve([
        { feedbackItemId: ITEM, dimensionId: DIM, value: 1, userId: 'u0' },
        { feedbackItemId: ITEM, dimensionId: DIM, value: 0, userId: 'u1' },
      ]) as never
    })
    tx.escalation.deleteMany.mockResolvedValue({ count: 1 } as never)
    tx.score.deleteMany.mockResolvedValue({ count: 1 } as never)
    tx.escalation.count.mockResolvedValue(0 as never)
    tx.teamBatchRelease.update.mockResolvedValue({} as never)
    tx.batch.findUnique.mockResolvedValue({
      id: BATCH_ID,
      teamReleases: [{ status: 'RECONCILING' }],
    } as never)
    tx.batch.update.mockResolvedValue({} as never)

    await reReconcileReleaseItem(RELEASE_ID, ITEM, DIM, tx)

    expect(tx.escalation.deleteMany).toHaveBeenCalledOnce()
    expect(tx.score.deleteMany).toHaveBeenCalledOnce()
    expect(tx.teamBatchRelease.update).toHaveBeenCalledWith({
      where: { id: RELEASE_ID },
      data: { status: 'RECONCILING' },
    })
    expect(tx.batch.update).toHaveBeenCalledOnce()
    // Nothing leaked to the shared client.
    expect(prismaMock.teamBatchRelease.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.score.findMany).not.toHaveBeenCalled()
    expect(prismaMock.escalation.deleteMany).not.toHaveBeenCalled()
    expect(prismaMock.score.deleteMany).not.toHaveBeenCalled()
    expect(prismaMock.teamBatchRelease.update).not.toHaveBeenCalled()
    expect(prismaMock.batch.update).not.toHaveBeenCalled()
  })

  it('does nothing when the dimension is not one this release scores', async () => {
    setRelease(makeRelease({ status: 'RECONCILING', dimensions: [{ dimensionId: 'other' }] }))

    await reReconcileReleaseItem(RELEASE_ID, ITEM, DIM)

    expect(prismaMock.score.findMany).not.toHaveBeenCalled()
    expect(prismaMock.escalation.deleteMany).not.toHaveBeenCalled()
    expect(prismaMock.teamBatchRelease.update).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// healStrandedRelease — repair a fully scored release left in SCORING
// ===========================================================================
describe('healStrandedRelease', () => {
  it('advances a fully scored SCORING release and reports it', async () => {
    // Non-double regular, 1 item × 1 dim × 1 score: fully scored → COMPLETE.
    setRelease(makeRelease({ status: 'SCORING', isDoubleScored: false }))
    prismaMock.feedbackItem.count.mockResolvedValue(1 as never)
    prismaMock.score.count.mockResolvedValue(1 as never)

    expect(await healStrandedRelease(RELEASE_ID)).toBe(true)
    expect(prismaMock.teamBatchRelease.update).toHaveBeenCalledWith({
      where: { id: RELEASE_ID },
      data: { status: 'COMPLETE' },
    })
  })

  it('is a no-op for a release that is not SCORING', async () => {
    setRelease(makeRelease({ status: 'RECONCILING' }))
    expect(await healStrandedRelease(RELEASE_ID)).toBe(false)
    expect(prismaMock.teamBatchRelease.update).not.toHaveBeenCalled()
  })

  it('is a no-op for a SCORING release that is not actually fully scored', async () => {
    setRelease(makeRelease({ status: 'SCORING' }))
    prismaMock.feedbackItem.count.mockResolvedValue(1 as never)
    prismaMock.score.count.mockResolvedValue(1 as never) // pair expects 2
    expect(await healStrandedRelease(RELEASE_ID)).toBe(false)
    expect(prismaMock.teamBatchRelease.update).not.toHaveBeenCalled()
  })

  it('never throws — a failed repair must not take the page down', async () => {
    prismaMock.teamBatchRelease.findUnique.mockRejectedValue(new Error('db down'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(healStrandedRelease(RELEASE_ID)).resolves.toBe(false)
      expect(errorSpy).toHaveBeenCalledOnce()
    } finally {
      errorSpy.mockRestore()
    }
  })
})

// ===========================================================================
// shouldListReconcileTask — the annotator project page's "Reconcile" list rule
// ===========================================================================
describe('shouldListReconcileTask', () => {
  const task = (o: {
    status: string
    discrepancyCount?: number
    reconciledCount?: number
    hasOpenUnlock?: boolean
  }) => ({
    status: o.status,
    discrepancyCount: o.discrepancyCount ?? 0,
    reconciledCount: o.reconciledCount ?? 0,
    hasOpenUnlock: o.hasOpenUnlock ?? false,
  })

  it('lists a RECONCILING release with unresolved discrepancies', () => {
    expect(
      shouldListReconcileTask(task({ status: 'RECONCILING', discrepancyCount: 3, reconciledCount: 1 }))
    ).toBe(true)
  })

  it('lists a RECONCILING release with unresolved discrepancies even while a criterion is re-opened', () => {
    expect(
      shouldListReconcileTask(
        task({ status: 'RECONCILING', discrepancyCount: 3, reconciledCount: 1, hasOpenUnlock: true })
      )
    ).toBe(true)
  })

  it('drops the phantom task: RECONCILING only because a criterion is re-opened, nothing to reconcile yet', () => {
    // Admin re-opened a criterion on a COMPLETE release (→ RECONCILING); no
    // revision has created a new disagreement. "You have 1 to reconcile" would
    // lead to an empty hub — the Revise task already represents the work.
    expect(
      shouldListReconcileTask(
        task({ status: 'RECONCILING', discrepancyCount: 4, reconciledCount: 4, hasOpenUnlock: true })
      )
    ).toBe(false)
    expect(
      shouldListReconcileTask(
        task({ status: 'RECONCILING', discrepancyCount: 0, reconciledCount: 0, hasOpenUnlock: true })
      )
    ).toBe(false)
  })

  it('still lists a RECONCILING release with nothing unresolved when no criterion is re-opened', () => {
    // Not the re-open flow — keep it visible rather than hide a stuck release.
    expect(
      shouldListReconcileTask(task({ status: 'RECONCILING', discrepancyCount: 2, reconciledCount: 2 }))
    ).toBe(true)
  })

  it('lists a COMPLETE release as Review / Edit only if it ever had discrepancies', () => {
    expect(shouldListReconcileTask(task({ status: 'COMPLETE', discrepancyCount: 2, reconciledCount: 2 }))).toBe(true)
    expect(shouldListReconcileTask(task({ status: 'COMPLETE', discrepancyCount: 0 }))).toBe(false)
    // An open unlock does not change the COMPLETE rule.
    expect(
      shouldListReconcileTask(task({ status: 'COMPLETE', discrepancyCount: 2, reconciledCount: 2, hasOpenUnlock: true }))
    ).toBe(true)
  })

  it('never lists SCORING or DRAFT releases', () => {
    expect(shouldListReconcileTask(task({ status: 'SCORING', discrepancyCount: 5 }))).toBe(false)
    expect(shouldListReconcileTask(task({ status: 'DRAFT', discrepancyCount: 5 }))).toBe(false)
  })
})
