// Mocks must be registered BEFORE the route under test is imported.
import { signInAs, signedOut } from '../auth-mock'
import { prismaMock } from '../prisma-mock'
import { describe, it, expect, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { Prisma } from '@/generated/prisma/client'
import { DELETE } from '@/app/api/users/[userId]/route'

function deleteUser(userId: string) {
  return DELETE(
    new NextRequest(`http://localhost/api/users/${userId}`, { method: 'DELETE' }),
    { params: Promise.resolve({ userId }) }
  )
}

function mockFootprint(scores: number, escalations: number, unlocks: number) {
  prismaMock.score.count.mockResolvedValue(scores)
  prismaMock.escalation.count.mockResolvedValue(escalations)
  prismaMock.releaseCriterionUnlock.count.mockResolvedValue(unlocks)
}

beforeEach(() => {
  signInAs({ id: 'admin', role: 'ADMIN' })
  prismaMock.user.findUnique.mockResolvedValue({
    id: 'u1',
    email: 'annotator@test.com',
  } as never)
  prismaMock.user.delete.mockResolvedValue({ id: 'u1' } as never)
})

describe('DELETE /api/users/[userId]', () => {
  it('refuses with 409 and the exact counts when the account holds scores and escalations', async () => {
    mockFootprint(4151, 12, 0)

    const res = await deleteUser('u1')

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error:
        'This account has 4,151 scores and 12 escalations. Deleting it would destroy annotation data. Remove them from projects instead.',
    })
    expect(prismaMock.user.delete).not.toHaveBeenCalled()
  })

  it('counts the whole footprint: raw + reconciled scores (by userId), escalations raised, criterion re-opens opened', async () => {
    mockFootprint(1, 1, 1)

    const res = await deleteUser('u1')

    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain(
      'This account has 1 score, 1 escalation, and 1 criterion re-open.'
    )
    expect(prismaMock.score.count).toHaveBeenCalledWith({
      where: { userId: 'u1' },
    })
    expect(prismaMock.escalation.count).toHaveBeenCalledWith({
      where: { escalatedById: 'u1' },
    })
    expect(prismaMock.releaseCriterionUnlock.count).toHaveBeenCalledWith({
      where: { openedById: 'u1' },
    })
  })

  it('refuses when only escalations exist (no scores)', async () => {
    mockFootprint(0, 3, 0)

    const res = await deleteUser('u1')

    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('This account has 3 escalations.')
    expect(prismaMock.user.delete).not.toHaveBeenCalled()
  })

  it('deletes an account with no annotation footprint', async () => {
    mockFootprint(0, 0, 0)

    const res = await deleteUser('u1')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: 'u1' } })
  })

  it('turns a Restrict FK violation (P2003) into a 409 instead of a 500', async () => {
    mockFootprint(0, 0, 0)
    prismaMock.user.delete.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('fk', {
        code: 'P2003',
        clientVersion: 'test',
      })
    )

    const res = await deleteUser('u1')

    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('cannot be deleted')
  })

  it('still refuses self-deletion before touching the footprint', async () => {
    const res = await deleteUser('admin')

    expect(res.status).toBe(400)
    expect(prismaMock.score.count).not.toHaveBeenCalled()
    expect(prismaMock.user.delete).not.toHaveBeenCalled()
  })

  it('is global-admin only', async () => {
    signInAs({ id: 'pa', role: 'EVALUATOR' })
    expect((await deleteUser('u1')).status).toBe(403)

    signedOut()
    expect((await deleteUser('u1')).status).toBe(403)
    expect(prismaMock.user.delete).not.toHaveBeenCalled()
  })
})
