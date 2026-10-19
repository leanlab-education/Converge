// Mocks must be registered BEFORE the route under test is imported.
import { signInAs } from '../auth-mock'
import { prismaMock } from '../prisma-mock'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/team-batch-releases', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/team-batch-releases')>()),
  syncTeamAcrossBatches: vi.fn(),
}))

import { POST } from '@/app/api/projects/[projectId]/teams/route'

function createTeam(body: Record<string, unknown>, projectId = 'p1') {
  return POST(
    new NextRequest(`http://localhost/api/projects/${projectId}/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectId }) }
  )
}

const validBody = {
  name: 'Team A',
  memberUserIds: ['u1', 'u2'],
  dimensionIds: ['d1', 'd2'],
}

beforeEach(() => {
  signInAs({ id: 'admin', role: 'ADMIN' })
  prismaMock.projectEvaluator.findMany.mockResolvedValue([
    { userId: 'u1' },
    { userId: 'u2' },
  ] as never)
  prismaMock.rubricDimension.count.mockResolvedValue(2)
  prismaMock.evaluatorTeam.findUnique.mockResolvedValue(null as never)
  prismaMock.evaluatorTeamMember.findMany.mockResolvedValue([] as never)
  prismaMock.evaluatorTeamDimension.findMany.mockResolvedValue([] as never)
  prismaMock.evaluatorTeam.create.mockResolvedValue({
    id: 't1',
    ...validBody,
  } as never)
})

describe('POST /api/projects/[projectId]/teams cross-project ids', () => {
  it("rejects a member who is not an annotator on this project", async () => {
    prismaMock.projectEvaluator.findMany.mockResolvedValue([
      { userId: 'u1' },
    ] as never)

    const res = await createTeam({ ...validBody, memberUserIds: ['u1', 'stranger'] })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(
      'One of the selected users is not an annotator on this project.'
    )
    expect(prismaMock.evaluatorTeam.create).not.toHaveBeenCalled()
  })

  it("rejects a dimension from another project's rubric", async () => {
    prismaMock.rubricDimension.count.mockResolvedValue(1)

    const res = await createTeam({ ...validBody, dimensionIds: ['d1', 'foreign'] })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(
      "One of the selected criteria is not part of this project's rubric."
    )
    expect(prismaMock.evaluatorTeam.create).not.toHaveBeenCalled()
  })

  it('creates the team when both members and criteria belong to the project', async () => {
    const res = await createTeam(validBody)

    expect(res.status).toBe(201)
    expect(prismaMock.evaluatorTeam.create).toHaveBeenCalledTimes(1)
  })
})
