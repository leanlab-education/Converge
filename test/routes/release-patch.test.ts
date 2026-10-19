// Mocks must be registered BEFORE the route under test is imported.
import { signInAs } from '../auth-mock'
import { prismaMock } from '../prisma-mock'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/team-batch-releases', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/team-batch-releases')>()),
  syncBatchAssignmentsForRelease: vi.fn(),
  syncBatchStatus: vi.fn(),
}))

import {
  syncBatchAssignmentsForRelease,
  syncBatchStatus,
} from '@/lib/team-batch-releases'
import { PATCH } from '@/app/api/projects/[projectId]/batches/[batchId]/releases/[releaseId]/route'

const ids = { projectId: 'p1', batchId: 'b1', releaseId: 'r1' }

function patchRelease(body: Record<string, unknown>) {
  return PATCH(
    new NextRequest(
      `http://localhost/api/projects/p1/batches/b1/releases/r1`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    ),
    { params: Promise.resolve(ids) }
  )
}

function mockRelease(status: 'DRAFT' | 'SCORING' | 'RECONCILING' | 'COMPLETE') {
  prismaMock.teamBatchRelease.findUnique.mockResolvedValue({
    id: 'r1',
    batchId: 'b1',
    teamId: 't1',
    scorerUserId: null,
    adjudicatorId: null,
    isVisible: true,
    status,
    batch: {
      id: 'b1',
      projectId: 'p1',
      type: 'REGULAR',
      isDoubleScored: true,
      status,
    },
    team: {
      id: 't1',
      members: [{ userId: 'u1' }, { userId: 'u2' }],
      dimensions: [{ dimensionId: 'd1' }],
    },
  } as never)
}

/** Which user ids have a ProjectEvaluator row on p1. */
function mockProjectMembers(userIds: string[]) {
  prismaMock.projectEvaluator.findMany.mockResolvedValue(
    userIds.map((userId) => ({ userId })) as never
  )
}

beforeEach(() => {
  signInAs({ id: 'admin', role: 'ADMIN' })
  vi.mocked(syncBatchAssignmentsForRelease).mockReset()
  vi.mocked(syncBatchStatus).mockReset()
  prismaMock.teamBatchRelease.update.mockResolvedValue({ id: 'r1' } as never)
  mockProjectMembers(['u1', 'u2', 'amber'])
})

describe('PATCH .../releases/[releaseId] on a COMPLETE release', () => {
  beforeEach(() => mockRelease('COMPLETE'))

  it('still refuses visibility changes', async () => {
    const res = await patchRelease({ isVisible: false })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(
      'Cannot change the visibility or scoring assignment of a completed release'
    )
    expect(prismaMock.teamBatchRelease.update).not.toHaveBeenCalled()
  })

  it('still refuses scoring-assignment changes', async () => {
    const res = await patchRelease({ scorerUserId: 'u1' })

    expect(res.status).toBe(400)
    expect(prismaMock.teamBatchRelease.update).not.toHaveBeenCalled()
  })

  it('allows setting the adjudicator so an edit-after-COMPLETE escalation has someone to go to', async () => {
    const res = await patchRelease({ adjudicatorId: 'amber' })

    expect(res.status).toBe(200)
    expect(prismaMock.teamBatchRelease.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { adjudicatorId: 'amber' },
    })
  })

  it('allows clearing the adjudicator', async () => {
    const res = await patchRelease({ adjudicatorId: null })

    expect(res.status).toBe(200)
    expect(prismaMock.teamBatchRelease.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { adjudicatorId: null },
    })
  })

  it('does not re-sync assignments or batch status for an adjudicator-only change', async () => {
    await patchRelease({ adjudicatorId: 'amber' })

    expect(syncBatchAssignmentsForRelease).not.toHaveBeenCalled()
    expect(syncBatchStatus).not.toHaveBeenCalled()
  })

  it('keeps the "adjudicator cannot be a pair member" rule', async () => {
    const res = await patchRelease({ adjudicatorId: 'u1' })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(
      'The adjudicator cannot be a member of the team they adjudicate'
    )
    expect(prismaMock.teamBatchRelease.update).not.toHaveBeenCalled()
  })
})

describe('PATCH .../releases/[releaseId] adjudicator scope', () => {
  beforeEach(() => mockRelease('SCORING'))

  it('requires the adjudicator to be an annotator on this project', async () => {
    mockProjectMembers(['u1', 'u2'])

    const res = await patchRelease({ adjudicatorId: 'outsider' })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(
      'The adjudicator must be an annotator on this project'
    )
    expect(prismaMock.projectEvaluator.findMany).toHaveBeenCalledWith({
      where: { projectId: 'p1', userId: { in: ['outsider'] } },
      select: { userId: true },
    })
    expect(prismaMock.teamBatchRelease.update).not.toHaveBeenCalled()
  })

  it('accepts a project annotator from another team', async () => {
    const res = await patchRelease({ adjudicatorId: 'amber' })

    expect(res.status).toBe(200)
    expect(prismaMock.teamBatchRelease.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { adjudicatorId: 'amber' },
    })
  })
})

describe('PATCH .../releases/[releaseId] on an active release', () => {
  it('still re-syncs assignments and batch status when visibility changes', async () => {
    mockRelease('DRAFT')

    const res = await patchRelease({ isVisible: true })

    expect(res.status).toBe(200)
    expect(prismaMock.teamBatchRelease.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { isVisible: true, status: 'SCORING' },
    })
    expect(syncBatchAssignmentsForRelease).toHaveBeenCalledWith('r1')
    expect(syncBatchStatus).toHaveBeenCalledWith('b1')
  })
})
