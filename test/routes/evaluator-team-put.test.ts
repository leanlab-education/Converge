// Mocks must be registered BEFORE the route under test is imported.
import { signInAs } from '../auth-mock'
import { prismaMock } from '../prisma-mock'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/team-batch-releases', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/team-batch-releases')>()),
  syncTeamAcrossBatches: vi.fn(),
}))

import { syncTeamAcrossBatches } from '@/lib/team-batch-releases'
import { PUT } from '@/app/api/projects/[projectId]/evaluators/[userId]/team/route'

function putTeam(teamId: string | null, userId = 'u1', projectId = 'p1') {
  return PUT(
    new NextRequest(
      `http://localhost/api/projects/${projectId}/evaluators/${userId}/team`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teamId }),
      }
    ),
    { params: Promise.resolve({ projectId, userId }) }
  )
}

// u1 is currently on Team A with partner u2 (criteria d1, d2).
const teamA = {
  id: 't1',
  name: 'Team A',
  projectId: 'p1',
  dimensions: [{ dimensionId: 'd1' }, { dimensionId: 'd2' }],
  members: [{ userId: 'u1' }, { userId: 'u2' }],
}

function mockDestination(memberCount: number) {
  prismaMock.evaluatorTeam.findUnique.mockResolvedValue({
    id: 't2',
    name: 'Team B',
    projectId: 'p1',
    _count: { members: memberCount },
  } as never)
}

/** Partner (u2) vs. mover (u1) score counts, keyed on the `where.userId` shape. */
function mockScores({ partner, self }: { partner: number; self: number }) {
  prismaMock.score.count.mockImplementation((async (args: {
    where: { userId: string | { in: string[] } }
  }) => (typeof args.where.userId === 'string' ? self : partner)) as never)
}

beforeEach(() => {
  signInAs({ id: 'admin', role: 'ADMIN' })
  vi.mocked(syncTeamAcrossBatches).mockReset()
  prismaMock.$transaction.mockImplementation(((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: unknown) => unknown)(prismaMock)
      : Promise.resolve(arg)) as never)
  prismaMock.projectEvaluator.findUnique.mockResolvedValue({ id: 'pe1' } as never)
  prismaMock.evaluatorTeamMember.findMany.mockResolvedValue([
    { teamId: 't1', userId: 'u1', team: teamA },
  ] as never)
  prismaMock.evaluatorTeamDimension.findMany.mockResolvedValue([
    { dimensionId: 'd3' },
  ] as never)
  prismaMock.evaluatorTeamMember.deleteMany.mockResolvedValue({ count: 1 } as never)
  prismaMock.evaluatorTeamMember.create.mockResolvedValue({} as never)
  mockScores({ partner: 0, self: 0 })
})

describe('PUT /api/projects/[projectId]/evaluators/[userId]/team', () => {
  it('refuses with 409 when the destination team already has 2 members', async () => {
    mockDestination(2)

    const res = await putTeam('t2')

    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe(
      '"Team B" already has 2 members. Remove one of them first.'
    )
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.evaluatorTeamMember.create).not.toHaveBeenCalled()
    expect(syncTeamAcrossBatches).not.toHaveBeenCalled()
  })

  it("refuses with 409 when the partner left behind has scores on the team's criteria", async () => {
    mockDestination(1)
    mockScores({ partner: 12, self: 0 })

    const res = await putTeam('t2')

    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe(
      'Cannot remove this annotator from "Team A": their partner has already scored items on the team\'s criteria.'
    )
    expect(prismaMock.score.count).toHaveBeenCalledWith({
      where: {
        userId: { in: ['u2'] },
        dimensionId: { in: ['d1', 'd2'] },
        feedbackItem: { projectId: 'p1' },
      },
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('also applies the partner guard when removing from all teams (teamId: null)', async () => {
    mockScores({ partner: 1, self: 0 })

    const res = await putTeam(null)

    expect(res.status).toBe(409)
    expect(prismaMock.evaluatorTeamMember.deleteMany).not.toHaveBeenCalled()
  })

  it("keeps the existing guard on the mover's own scores", async () => {
    mockDestination(1)
    mockScores({ partner: 0, self: 3 })

    const res = await putTeam('t2')

    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('after they have scored items')
  })

  it('moves the annotator into a 1-member team and re-syncs both teams', async () => {
    mockDestination(1)

    const res = await putTeam('t2')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ teamId: 't2' })
    expect(prismaMock.evaluatorTeamMember.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1', team: { projectId: 'p1' } },
    })
    expect(prismaMock.evaluatorTeamMember.create).toHaveBeenCalledWith({
      data: { teamId: 't2', userId: 'u1' },
    })
    const synced = vi.mocked(syncTeamAcrossBatches).mock.calls.map((c) => c[0])
    expect(synced.sort()).toEqual(['t1', 't2'])
  })

  it('removes the annotator from their team when the partner has not scored', async () => {
    const res = await putTeam(null)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ teamId: null })
    expect(prismaMock.evaluatorTeamMember.deleteMany).toHaveBeenCalled()
    expect(prismaMock.evaluatorTeamMember.create).not.toHaveBeenCalled()
    expect(syncTeamAcrossBatches).toHaveBeenCalledWith('t1')
  })

  it('is a no-op (not a 409) when the annotator is already on the full destination team', async () => {
    mockDestination(2)
    prismaMock.evaluatorTeamMember.findMany.mockResolvedValue([
      { teamId: 't2', userId: 'u1', team: { ...teamA, id: 't2', name: 'Team B' } },
    ] as never)

    const res = await putTeam('t2')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ teamId: 't2' })
    expect(prismaMock.score.count).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('404s when the destination team is in another project', async () => {
    prismaMock.evaluatorTeam.findUnique.mockResolvedValue({
      id: 't9',
      name: 'Elsewhere',
      projectId: 'other',
      _count: { members: 0 },
    } as never)

    expect((await putTeam('t9')).status).toBe(404)
  })
})
