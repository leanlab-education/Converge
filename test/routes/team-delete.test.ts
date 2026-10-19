// Mocks must be registered BEFORE the route under test is imported.
import { signInAs } from '../auth-mock'
import { prismaMock } from '../prisma-mock'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/team-batch-releases', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/team-batch-releases')>()),
  syncBatchStatus: vi.fn(),
  syncTeamAcrossBatches: vi.fn(),
}))

import { syncBatchStatus } from '@/lib/team-batch-releases'
import { DELETE } from '@/app/api/projects/[projectId]/teams/[teamId]/route'

function deleteTeam(projectId = 'p1', teamId = 't1') {
  return DELETE(
    new NextRequest(
      `http://localhost/api/projects/${projectId}/teams/${teamId}`,
      { method: 'DELETE' }
    ),
    { params: Promise.resolve({ projectId, teamId }) }
  )
}

const team = {
  id: 't1',
  projectId: 'p1',
  name: 'Team A',
  members: [{ userId: 'u1' }, { userId: 'u2' }],
  dimensions: [{ dimensionId: 'd1' }, { dimensionId: 'd2' }],
}

beforeEach(() => {
  signInAs({ id: 'admin', role: 'ADMIN' })
  vi.mocked(syncBatchStatus).mockReset()
  // Interactive $transaction: run the callback with the deep mock as `tx`.
  prismaMock.$transaction.mockImplementation(((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: unknown) => unknown)(prismaMock)
      : Promise.resolve(arg)) as never)
  prismaMock.evaluatorTeam.findUnique.mockResolvedValue(team as never)
  prismaMock.score.count.mockResolvedValue(0)
  prismaMock.teamBatchRelease.findMany.mockResolvedValue([
    { batchId: 'b1' },
    { batchId: 'b2' },
    { batchId: 'b1' }, // a second release on b1 must not sync it twice
  ] as never)
  prismaMock.batchAssignment.deleteMany.mockResolvedValue({ count: 2 } as never)
  prismaMock.evaluatorTeam.delete.mockResolvedValue(team as never)
})

describe('DELETE /api/projects/[projectId]/teams/[teamId]', () => {
  it("removes the team's batch assignments before the team, in one transaction", async () => {
    const res = await deleteTeam()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: true })

    // BatchAssignment.teamRelease is SetNull, so without this the ex-members
    // would keep rows with teamReleaseId=null = legacy whole-batch access.
    expect(prismaMock.batchAssignment.deleteMany).toHaveBeenCalledWith({
      where: { teamRelease: { teamId: 't1' } },
    })
    expect(prismaMock.evaluatorTeam.delete).toHaveBeenCalledWith({
      where: { id: 't1' },
    })
    const deleteAssignmentsOrder =
      prismaMock.batchAssignment.deleteMany.mock.invocationCallOrder[0]
    const deleteTeamOrder = prismaMock.evaluatorTeam.delete.mock.invocationCallOrder[0]
    expect(deleteAssignmentsOrder).toBeLessThan(deleteTeamOrder)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('re-derives the status of every batch the team had a release on, once each', async () => {
    await deleteTeam()

    const synced = vi.mocked(syncBatchStatus).mock.calls.map((c) => c[0])
    expect(synced.sort()).toEqual(['b1', 'b2'])
  })

  it('refuses with 409 once any member has scored, and writes nothing', async () => {
    prismaMock.score.count.mockResolvedValue(7)

    const res = await deleteTeam()

    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe(
      'Cannot delete team after scoring has begun'
    )
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.batchAssignment.deleteMany).not.toHaveBeenCalled()
    expect(prismaMock.evaluatorTeam.delete).not.toHaveBeenCalled()
    expect(syncBatchStatus).not.toHaveBeenCalled()
  })

  it("counts member scores on the team's criteria AND on any criterion of a batch the team was released on (training)", async () => {
    await deleteTeam()

    expect(prismaMock.score.count).toHaveBeenCalledWith({
      where: {
        userId: { in: ['u1', 'u2'] },
        OR: [
          { dimensionId: { in: ['d1', 'd2'] }, feedbackItem: { projectId: 'p1' } },
          { feedbackItem: { batch: { teamReleases: { some: { teamId: 't1' } } } } },
        ],
      },
    })
  })

  it('404s for a team that belongs to another project', async () => {
    prismaMock.evaluatorTeam.findUnique.mockResolvedValue({
      ...team,
      projectId: 'other',
    } as never)

    const res = await deleteTeam()

    expect(res.status).toBe(404)
    expect(prismaMock.evaluatorTeam.delete).not.toHaveBeenCalled()
  })
})
