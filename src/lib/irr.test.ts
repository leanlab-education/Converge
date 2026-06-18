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

// ---------------------------------------------------------------------------
// TRAINING batches: both members score every item against EVERY project
// criterion (not just the team's assigned 2). IRR is the same exact-match,
// pre-reconciliation pairwise comparison as double-scored.
// ---------------------------------------------------------------------------
describe('computeBatchIRRSummary — TRAINING', () => {
  // The project rubric has three criteria; the team is "assigned" only d1, but
  // training ignores that and scores all three.
  const projectDims = [
    { id: 'd1', label: 'D1', sortOrder: 0 },
    { id: 'd2', label: 'D2', sortOrder: 1 },
    { id: 'd3', label: 'D3', sortOrder: 2 },
  ]

  function mockTrainingBatch(
    scores: { feedbackItemId: string; dimensionId: string; value: number; userId: string }[]
  ) {
    prismaMock.batch.findUnique.mockResolvedValue({
      id: 'b', type: 'TRAINING', isDoubleScored: false, projectId: 'p1',
      teamReleases: [
        {
          id: 'r1', teamId: 'T1',
          team: {
            name: 'Team 1',
            members: [{ userId: 'u0' }, { userId: 'u1' }],
            // Team's assigned dimension set is just d1 — training must ignore it.
            dimensions: [{ dimension: { id: 'd1', label: 'D1', sortOrder: 0 } }],
          },
        },
      ],
    } as never)
    prismaMock.rubricDimension.findMany.mockResolvedValue(projectDims as never)
    const dimById = new Map(projectDims.map((d) => [d.id, d]))
    prismaMock.score.findMany.mockResolvedValue(
      scores.map((s) => ({ ...s, dimension: dimById.get(s.dimensionId) })) as never
    )
  }

  it('computes per-criterion IRR across ALL project dimensions, not the team’s assigned 2', async () => {
    // d1: agree (1,1) · d2: agree (2,2) · d3: disagree (3,1) → 2/3 = 67% overall.
    mockTrainingBatch([
      { feedbackItemId: 'i1', dimensionId: 'd1', value: 1, userId: 'u0' },
      { feedbackItemId: 'i1', dimensionId: 'd1', value: 1, userId: 'u1' },
      { feedbackItemId: 'i1', dimensionId: 'd2', value: 2, userId: 'u0' },
      { feedbackItemId: 'i1', dimensionId: 'd2', value: 2, userId: 'u1' },
      { feedbackItemId: 'i1', dimensionId: 'd3', value: 3, userId: 'u0' },
      { feedbackItemId: 'i1', dimensionId: 'd3', value: 1, userId: 'u1' },
    ])
    const summary = await computeBatchIRRSummary('b')
    expect(summary).not.toBeNull()
    expect(summary!.applicableTeamCount).toBe(1)
    // All three project criteria appear (d2/d3 are NOT in the team's assigned set).
    expect(summary!.perDimension).toEqual([
      { dimensionId: 'd1', dimensionLabel: 'D1', agreementPct: 100, agreedPairs: 1, totalPairs: 1 },
      { dimensionId: 'd2', dimensionLabel: 'D2', agreementPct: 100, agreedPairs: 1, totalPairs: 1 },
      { dimensionId: 'd3', dimensionLabel: 'D3', agreementPct: 0, agreedPairs: 0, totalPairs: 1 },
    ])
    expect(summary!.teams[0].agreementPct).toBe(67)
  })

  it('uses the same exact-match math as double-scored (50% case)', async () => {
    // One criterion, two items: agree then disagree → 1/2 = 50%, mirroring the
    // double-scored test above.
    mockTrainingBatch([
      { feedbackItemId: 'i1', dimensionId: 'd1', value: 1, userId: 'u0' },
      { feedbackItemId: 'i1', dimensionId: 'd1', value: 1, userId: 'u1' },
      { feedbackItemId: 'i2', dimensionId: 'd1', value: 1, userId: 'u0' },
      { feedbackItemId: 'i2', dimensionId: 'd1', value: 0, userId: 'u1' },
    ])
    const summary = await computeBatchIRRSummary('b')
    expect(summary!.teams[0].agreementPct).toBe(50)
    expect(summary!.teams[0].agreedPairs).toBe(1)
    expect(summary!.teams[0].totalPairs).toBe(2)
  })

  it('reports 100% when a training pair fully agrees across all criteria', async () => {
    mockTrainingBatch([
      { feedbackItemId: 'i1', dimensionId: 'd1', value: 3, userId: 'u0' },
      { feedbackItemId: 'i1', dimensionId: 'd1', value: 3, userId: 'u1' },
      { feedbackItemId: 'i1', dimensionId: 'd2', value: 2, userId: 'u0' },
      { feedbackItemId: 'i1', dimensionId: 'd2', value: 2, userId: 'u1' },
      { feedbackItemId: 'i1', dimensionId: 'd3', value: 1, userId: 'u0' },
      { feedbackItemId: 'i1', dimensionId: 'd3', value: 1, userId: 'u1' },
    ])
    const summary = await computeBatchIRRSummary('b')
    expect(summary!.teams[0].agreementPct).toBe(100)
    expect(summary!.teams[0].isReady).toBe(true)
    expect(summary!.averageAgreementPct).toBe(100)
    expect(summary!.perDimension.every((d) => d.agreementPct === 100)).toBe(true)
  })
})
