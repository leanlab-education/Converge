// Mock @/lib/db BEFORE importing the module under test.
import { prismaMock } from '../../test/prisma-mock'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  maybeCompleteReleaseReconciliation,
  maybeAdvanceReleaseAfterScore,
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
