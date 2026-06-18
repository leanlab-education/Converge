// Mock @/lib/db BEFORE importing the module under test.
import { prismaMock } from '../../test/prisma-mock'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  ensureTeamReleasesForBatch,
  syncBatchAssignmentsForRelease,
  syncTeamAcrossBatches,
} from '@/lib/team-batch-releases'

// $transaction in syncBatchAssignmentsForRelease takes an interactive callback
// and passes a `tx` client. Run the callback with the deep mock acting as tx,
// so deleteMany/createMany/batch.update assertions hit prismaMock directly.
beforeEach(() => {
  prismaMock.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: unknown) => unknown)(prismaMock)
      : Promise.resolve(arg)
  )
  // syncBatchStatus runs at the tail of several paths; give it a benign batch.
  prismaMock.batch.findUnique.mockResolvedValue({
    id: 'b1',
    teamReleases: [{ status: 'SCORING' }],
  } as never)
  prismaMock.batch.update.mockResolvedValue({} as never)
})

// ---------------------------------------------------------------------------
// syncBatchAssignmentsForRelease
// ---------------------------------------------------------------------------
describe('syncBatchAssignmentsForRelease', () => {
  function mockRelease(release: Record<string, unknown>) {
    prismaMock.teamBatchRelease.findUnique.mockResolvedValue(release as never)
    prismaMock.batchAssignment.deleteMany.mockResolvedValue({ count: 0 } as never)
    prismaMock.batchAssignment.createMany.mockResolvedValue({ count: 0 } as never)
  }

  it('throws when the release is missing', async () => {
    prismaMock.teamBatchRelease.findUnique.mockResolvedValue(null as never)
    await expect(syncBatchAssignmentsForRelease('nope')).rejects.toThrow(
      'Release not found'
    )
  })

  it('deletes stale assignments scoped to the release before assigning', async () => {
    mockRelease({
      id: 'r1',
      scorerUserId: null,
      batch: { id: 'b1', isDoubleScored: false, type: 'REGULAR' },
      team: { members: [{ userId: 'u0' }, { userId: 'u1' }], dimensions: [] },
    })

    await syncBatchAssignmentsForRelease('r1')

    expect(prismaMock.batchAssignment.deleteMany).toHaveBeenCalledWith({
      where: { teamReleaseId: 'r1' },
    })
    // delete must run before create (stale wipe first).
    const delOrder = prismaMock.batchAssignment.deleteMany.mock.invocationCallOrder[0]
    const createOrder =
      prismaMock.batchAssignment.createMany.mock.invocationCallOrder[0]
    expect(delOrder).toBeLessThan(createOrder)
  })

  it('assigns both members on a non-double-scored regular split, all PRIMARY', async () => {
    mockRelease({
      id: 'r1',
      scorerUserId: null,
      batch: { id: 'b1', isDoubleScored: false, type: 'REGULAR' },
      team: { members: [{ userId: 'u0' }, { userId: 'u1' }], dimensions: [] },
    })

    await syncBatchAssignmentsForRelease('r1')

    const arg = prismaMock.batchAssignment.createMany.mock.calls[0][0] as {
      data: { userId: string; scoringRole: string; teamReleaseId: string; batchId: string }[]
    }
    expect(arg.data.map((d) => d.userId)).toEqual(['u0', 'u1'])
    // Non-double split: both PRIMARY (each owns half the items).
    expect(arg.data.every((d) => d.scoringRole === 'PRIMARY')).toBe(true)
    expect(arg.data.every((d) => d.teamReleaseId === 'r1')).toBe(true)
    expect(arg.data.every((d) => d.batchId === 'b1')).toBe(true)
  })

  it('assigns both members on double-scored, second member is DOUBLE', async () => {
    mockRelease({
      id: 'r1',
      scorerUserId: null,
      batch: { id: 'b1', isDoubleScored: true, type: 'REGULAR' },
      team: { members: [{ userId: 'u0' }, { userId: 'u1' }], dimensions: [] },
    })

    await syncBatchAssignmentsForRelease('r1')

    const arg = prismaMock.batchAssignment.createMany.mock.calls[0][0] as {
      data: { userId: string; scoringRole: string }[]
    }
    expect(arg.data).toEqual([
      expect.objectContaining({ userId: 'u0', scoringRole: 'PRIMARY' }),
      expect.objectContaining({ userId: 'u1', scoringRole: 'DOUBLE' }),
    ])
  })

  it('assigns ONLY the named scorer on a single-scorer regular release', async () => {
    mockRelease({
      id: 'r1',
      scorerUserId: 'u1',
      batch: { id: 'b1', isDoubleScored: false, type: 'REGULAR' },
      team: { members: [{ userId: 'u0' }, { userId: 'u1' }], dimensions: [] },
    })

    await syncBatchAssignmentsForRelease('r1')

    const arg = prismaMock.batchAssignment.createMany.mock.calls[0][0] as {
      data: { userId: string }[]
    }
    expect(arg.data.map((d) => d.userId)).toEqual(['u1'])
  })

  it('assigns every member on a TRAINING release (ignores scorer split)', async () => {
    mockRelease({
      id: 'r1',
      scorerUserId: null,
      batch: { id: 'b1', isDoubleScored: false, type: 'TRAINING' },
      team: { members: [{ userId: 'u0' }, { userId: 'u1' }], dimensions: [] },
    })

    await syncBatchAssignmentsForRelease('r1')

    const arg = prismaMock.batchAssignment.createMany.mock.calls[0][0] as {
      data: { userId: string }[]
    }
    expect(arg.data.map((d) => d.userId)).toEqual(['u0', 'u1'])
  })

  it('deletes but does not create when there are no expected users (empty team)', async () => {
    mockRelease({
      id: 'r1',
      scorerUserId: null,
      batch: { id: 'b1', isDoubleScored: false, type: 'REGULAR' },
      team: { members: [], dimensions: [] },
    })

    await syncBatchAssignmentsForRelease('r1')

    expect(prismaMock.batchAssignment.deleteMany).toHaveBeenCalledOnce()
    expect(prismaMock.batchAssignment.createMany).not.toHaveBeenCalled()
    // No assignments → batch must not be flagged isAssigned via this path.
    expect(prismaMock.batch.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { isAssigned: true } })
    )
  })

  it('handles a single-member team by assigning that one member', async () => {
    mockRelease({
      id: 'r1',
      scorerUserId: null,
      batch: { id: 'b1', isDoubleScored: false, type: 'REGULAR' },
      team: { members: [{ userId: 'u0' }], dimensions: [] },
    })

    await syncBatchAssignmentsForRelease('r1')

    const arg = prismaMock.batchAssignment.createMany.mock.calls[0][0] as {
      data: { userId: string }[]
    }
    expect(arg.data.map((d) => d.userId)).toEqual(['u0'])
  })

  it('marks the batch assigned when at least one user is assigned', async () => {
    mockRelease({
      id: 'r1',
      scorerUserId: null,
      batch: { id: 'b1', isDoubleScored: false, type: 'REGULAR' },
      team: { members: [{ userId: 'u0' }, { userId: 'u1' }], dimensions: [] },
    })

    await syncBatchAssignmentsForRelease('r1')

    expect(prismaMock.batch.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { isAssigned: true },
    })
  })
})

// ---------------------------------------------------------------------------
// ensureTeamReleasesForBatch
// ---------------------------------------------------------------------------
describe('ensureTeamReleasesForBatch', () => {
  it('throws when the batch does not exist', async () => {
    prismaMock.batch.findUnique.mockResolvedValue(null as never)
    await expect(ensureTeamReleasesForBatch('missing')).rejects.toThrow(
      'Batch not found'
    )
  })

  it('is a no-op when every project team already has a release', async () => {
    // First findUnique = the batch (with its existing releases). Subsequent
    // findUnique calls would be from syncBatchStatus, but we short-circuit.
    prismaMock.batch.findUnique.mockResolvedValue({
      id: 'b1',
      projectId: 'p1',
      teamReleases: [{ teamId: 'T1' }, { teamId: 'T2' }],
    } as never)
    prismaMock.evaluatorTeam.findMany.mockResolvedValue([
      { id: 'T1' },
      { id: 'T2' },
    ] as never)

    const created = await ensureTeamReleasesForBatch('b1')

    expect(created).toEqual([])
    expect(prismaMock.teamBatchRelease.create).not.toHaveBeenCalled()
    // No work → batch status not touched.
    expect(prismaMock.batch.update).not.toHaveBeenCalled()
  })

  it('creates a hidden DRAFT release for each missing team and wires assignments', async () => {
    // batch.findUnique is called by ensureTeamReleasesForBatch AND by
    // syncBatchStatus (different select). Branch on the `select` shape.
    prismaMock.batch.findUnique.mockImplementation((args: unknown) => {
      const a = args as { select?: { projectId?: boolean } }
      if (a.select?.projectId) {
        return Promise.resolve({
          id: 'b1',
          projectId: 'p1',
          teamReleases: [{ teamId: 'T1' }], // T2 is missing
        }) as never
      }
      // syncBatchStatus query
      return Promise.resolve({
        id: 'b1',
        teamReleases: [{ status: 'DRAFT' }],
      }) as never
    })
    prismaMock.evaluatorTeam.findMany.mockResolvedValue([
      { id: 'T1' },
      { id: 'T2' },
    ] as never)
    prismaMock.teamBatchRelease.create.mockResolvedValue({ id: 'rNew' } as never)
    // syncBatchAssignmentsForRelease loads the new release.
    prismaMock.teamBatchRelease.findUnique.mockResolvedValue({
      id: 'rNew',
      scorerUserId: null,
      batch: { id: 'b1', isDoubleScored: false, type: 'REGULAR' },
      team: { members: [{ userId: 'u0' }, { userId: 'u1' }], dimensions: [] },
    } as never)
    prismaMock.batchAssignment.deleteMany.mockResolvedValue({ count: 0 } as never)
    prismaMock.batchAssignment.createMany.mockResolvedValue({ count: 0 } as never)

    const created = await ensureTeamReleasesForBatch('b1')

    expect(created).toEqual(['rNew'])
    expect(prismaMock.teamBatchRelease.create).toHaveBeenCalledOnce()
    const createArg = prismaMock.teamBatchRelease.create.mock.calls[0][0] as {
      data: Record<string, unknown>
    }
    expect(createArg.data).toMatchObject({
      batchId: 'b1',
      teamId: 'T2',
      isVisible: false,
      status: 'DRAFT',
      scorerUserId: null,
    })
    // It wired assignments for the new release.
    expect(prismaMock.batchAssignment.deleteMany).toHaveBeenCalledWith({
      where: { teamReleaseId: 'rNew' },
    })
    expect(prismaMock.batchAssignment.createMany).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// syncTeamAcrossBatches (P11)
// ---------------------------------------------------------------------------
describe('syncTeamAcrossBatches', () => {
  it('does nothing when the team is missing', async () => {
    prismaMock.evaluatorTeam.findUnique.mockResolvedValue(null as never)
    await syncTeamAcrossBatches('gone')
    expect(prismaMock.batch.findMany).not.toHaveBeenCalled()
    expect(prismaMock.teamBatchRelease.findMany).not.toHaveBeenCalled()
  })

  it('ensures releases across each batch then re-syncs this team’s releases', async () => {
    prismaMock.evaluatorTeam.findUnique.mockResolvedValue({
      projectId: 'p1',
    } as never)
    // Two project batches.
    prismaMock.batch.findMany.mockResolvedValue([
      { id: 'b1' },
      { id: 'b2' },
    ] as never)

    // ensureTeamReleasesForBatch -> batch.findUnique(select projectId): report
    // all teams already present so it is a no-op (keeps this test focused on
    // the re-sync step). syncBatchStatus also calls batch.findUnique.
    prismaMock.batch.findUnique.mockImplementation((args: unknown) => {
      const a = args as { select?: { projectId?: boolean } }
      if (a.select?.projectId) {
        return Promise.resolve({
          id: 'bX',
          projectId: 'p1',
          teamReleases: [{ teamId: 'T9' }],
        }) as never
      }
      return Promise.resolve({
        id: 'bX',
        teamReleases: [{ status: 'SCORING' }],
      }) as never
    })
    // Only T9 exists, matches existing releases → no creates.
    prismaMock.evaluatorTeam.findMany.mockResolvedValue([{ id: 'T9' }] as never)

    // The team's existing releases across the project.
    prismaMock.teamBatchRelease.findMany.mockResolvedValue([
      { id: 'rA' },
      { id: 'rB' },
    ] as never)
    // Each gets re-synced via syncBatchAssignmentsForRelease.
    prismaMock.teamBatchRelease.findUnique.mockImplementation((args: unknown) => {
      const id = (args as { where: { id: string } }).where.id
      return Promise.resolve({
        id,
        scorerUserId: null,
        batch: { id: 'b1', isDoubleScored: false, type: 'REGULAR' },
        team: { members: [{ userId: 'u0' }, { userId: 'u1' }], dimensions: [] },
      }) as never
    })
    prismaMock.batchAssignment.deleteMany.mockResolvedValue({ count: 0 } as never)
    prismaMock.batchAssignment.createMany.mockResolvedValue({ count: 0 } as never)

    await syncTeamAcrossBatches('T9')

    // Walked both project batches.
    expect(prismaMock.batch.findMany).toHaveBeenCalledWith({
      where: { projectId: 'p1' },
      select: { id: true },
    })
    // Queried the team's existing releases scoped to the project.
    expect(prismaMock.teamBatchRelease.findMany).toHaveBeenCalledWith({
      where: { teamId: 'T9', batch: { projectId: 'p1' } },
      select: { id: true },
    })
    // Re-synced both releases (rA, rB).
    const synced = prismaMock.teamBatchRelease.findUnique.mock.calls.map(
      (c) => (c[0] as { where: { id: string } }).where.id
    )
    expect(synced).toEqual(expect.arrayContaining(['rA', 'rB']))
    // Each re-sync deleted stale assignments first.
    expect(prismaMock.batchAssignment.deleteMany).toHaveBeenCalledWith({
      where: { teamReleaseId: 'rA' },
    })
    expect(prismaMock.batchAssignment.deleteMany).toHaveBeenCalledWith({
      where: { teamReleaseId: 'rB' },
    })
  })
})
