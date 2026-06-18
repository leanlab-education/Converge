// Mock @/lib/db BEFORE importing the module under test.
import { prismaMock } from '../../test/prisma-mock'
import { describe, it, expect } from 'vitest'
import { computeReleaseDiscrepancyStats } from '@/lib/reconciliation'

type Orig = { feedbackItemId: string; dimensionId: string; value: number; userId: string }

// Two raters (u0 owner, u1) on one dimension d1 across three items:
//   i1: 1 vs 0  → discrepancy (reconciled below)
//   i2: 1 vs 1  → agree (not a discrepancy)
//   i3: 0 vs 1  → discrepancy (still open)
const original: Orig[] = [
  { feedbackItemId: 'i1', dimensionId: 'd1', value: 1, userId: 'u0' },
  { feedbackItemId: 'i1', dimensionId: 'd1', value: 0, userId: 'u1' },
  { feedbackItemId: 'i2', dimensionId: 'd1', value: 1, userId: 'u0' },
  { feedbackItemId: 'i2', dimensionId: 'd1', value: 1, userId: 'u1' },
  { feedbackItemId: 'i3', dimensionId: 'd1', value: 0, userId: 'u0' },
  { feedbackItemId: 'i3', dimensionId: 'd1', value: 1, userId: 'u1' },
]

function setScores(reconciled: { feedbackItemId: string; dimensionId: string }[]) {
  // The function queries original (isReconciled:false) then reconciled (true).
  prismaMock.score.findMany.mockImplementation((args) =>
    Promise.resolve(args?.where?.isReconciled ? reconciled : original) as never
  )
}

describe('computeReleaseDiscrepancyStats', () => {
  it('counts genuine 2-rater disagreements and how many were reconciled', async () => {
    setScores([{ feedbackItemId: 'i1', dimensionId: 'd1' }]) // i1 resolved, i3 open
    const stats = await computeReleaseDiscrepancyStats({
      batchId: 'b', batchType: 'REGULAR', projectId: 'p',
      memberUserIds: ['u0', 'u1'], teamDimensionIds: ['d1'],
    })
    expect(stats).toEqual({ discrepancyCount: 2, reconciledCount: 1 })
  })

  it('does not count an agreed pair as a discrepancy', async () => {
    // Only i2 (agree) present.
    prismaMock.score.findMany.mockImplementation((args) =>
      Promise.resolve(
        args?.where?.isReconciled
          ? []
          : original.filter((s) => s.feedbackItemId === 'i2')
      ) as never
    )
    const stats = await computeReleaseDiscrepancyStats({
      batchId: 'b', batchType: 'REGULAR', projectId: 'p',
      memberUserIds: ['u0', 'u1'], teamDimensionIds: ['d1'],
    })
    expect(stats.discrepancyCount).toBe(0)
  })

  it('ignores a single rater (no pair → no discrepancy)', async () => {
    prismaMock.score.findMany.mockImplementation((args) =>
      Promise.resolve(
        args?.where?.isReconciled ? [] : [{ feedbackItemId: 'i1', dimensionId: 'd1', value: 1, userId: 'u0' }]
      ) as never
    )
    const stats = await computeReleaseDiscrepancyStats({
      batchId: 'b', batchType: 'REGULAR', projectId: 'p',
      memberUserIds: ['u0', 'u1'], teamDimensionIds: ['d1'],
    })
    expect(stats).toEqual({ discrepancyCount: 0, reconciledCount: 0 })
  })
})
