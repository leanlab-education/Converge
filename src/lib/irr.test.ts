import { prismaMock } from '../../test/prisma-mock'
import { describe, it, expect } from 'vitest'
import { computeBatchIRRSummary } from '@/lib/irr'

// A REGULAR double-scored batch, one team (u0, u1) scoring dimension d1 across
// two items: i1 they agree (1,1), i2 they disagree (1,0) → 1/2 = 50% IRR.
function mockBatchAndScores() {
  prismaMock.batch.findUnique.mockResolvedValue({
    id: 'b', type: 'REGULAR', isDoubleScored: true,
    teamReleases: [
      {
        id: 'r1', teamId: 'T1',
        team: {
          name: 'Team 1',
          members: [{ userId: 'u0' }, { userId: 'u1' }],
          dimensions: [{ dimension: { id: 'd1', label: 'D1', sortOrder: 0 } }],
        },
      },
    ],
  } as never)

  const d = { id: 'd1', label: 'D1', sortOrder: 0 }
  prismaMock.score.findMany.mockResolvedValue([
    { feedbackItemId: 'i1', dimensionId: 'd1', value: 1, userId: 'u0', dimension: d },
    { feedbackItemId: 'i1', dimensionId: 'd1', value: 1, userId: 'u1', dimension: d },
    { feedbackItemId: 'i2', dimensionId: 'd1', value: 1, userId: 'u0', dimension: d },
    { feedbackItemId: 'i2', dimensionId: 'd1', value: 0, userId: 'u1', dimension: d },
  ] as never)
}

describe('computeBatchIRRSummary', () => {
  it('computes exact-match per-criterion + per-team agreement', async () => {
    mockBatchAndScores()
    const summary = await computeBatchIRRSummary('b')
    expect(summary).not.toBeNull()
    expect(summary!.perDimension).toEqual([
      { dimensionId: 'd1', dimensionLabel: 'D1', agreementPct: 50, agreedPairs: 1, totalPairs: 2 },
    ])
    expect(summary!.teams[0].agreementPct).toBe(50)
    expect(summary!.teams[0].agreedPairs).toBe(1)
    expect(summary!.teams[0].totalPairs).toBe(2)
  })

  it('reports IRR as not-applicable for a single-scored batch', async () => {
    prismaMock.batch.findUnique.mockResolvedValue({
      id: 'b', type: 'REGULAR', isDoubleScored: false,
      teamReleases: [
        { id: 'r1', teamId: 'T1', team: { name: 'Team 1', members: [{ userId: 'u0' }, { userId: 'u1' }], dimensions: [{ dimension: { id: 'd1', label: 'D1', sortOrder: 0 } }] } },
      ],
    } as never)
    const summary = await computeBatchIRRSummary('b')
    expect(summary!.applicableTeamCount).toBe(0)
    expect(summary!.perDimension).toEqual([])
  })

  it('returns null for a missing batch', async () => {
    prismaMock.batch.findUnique.mockResolvedValue(null as never)
    expect(await computeBatchIRRSummary('nope')).toBeNull()
  })
})
