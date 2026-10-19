// Mock @/lib/db BEFORE importing the module under test.
import { prismaMock } from '../../test/prisma-mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/email', () => ({ sendInviteEmail: vi.fn() }))
vi.mock('@/lib/tokens', () => ({ createToken: vi.fn() }))

import { sendInviteEmail } from '@/lib/email'
import { createToken } from '@/lib/tokens'
import { inviteUser, inviteVariant } from '@/lib/invite'

const sendInviteEmailMock = vi.mocked(sendInviteEmail)
const createTokenMock = vi.mocked(createToken)

const PROJECT = { id: 'p1', name: 'Quill Annotation' }

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    email: 'jane@example.com',
    name: null,
    hashedPassword: null,
    role: 'EVALUATOR',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  }
}

beforeEach(() => {
  sendInviteEmailMock.mockReset()
  createTokenMock.mockReset().mockResolvedValue('tok-123')
  prismaMock.project.findUnique.mockResolvedValue(PROJECT as never)
  prismaMock.projectEvaluator.upsert.mockResolvedValue({ role: 'EVALUATOR' } as never)
})

describe('inviteVariant', () => {
  it('picks admin copy for global admins regardless of project role', () => {
    expect(inviteVariant('ADMIN', null)).toBe('admin')
    expect(inviteVariant('ADMIN', 'PROJECT_ADMIN')).toBe('admin')
  })

  it('picks project-admin copy for a PROJECT_ADMIN membership', () => {
    expect(inviteVariant('EVALUATOR', 'PROJECT_ADMIN')).toBe('project-admin')
  })

  it('defaults to annotator copy', () => {
    expect(inviteVariant('EVALUATOR', 'EVALUATOR')).toBe('annotator')
    expect(inviteVariant('EVALUATOR', null)).toBe('annotator')
  })
})

describe('inviteUser — input validation', () => {
  it('rejects a missing or malformed email before touching the database', async () => {
    for (const email of [undefined, null, '', 'not-an-email', 42]) {
      const outcome = await inviteUser({
        email,
        name: null,
        scope: { kind: 'project', projectId: 'p1' },
      })
      expect(outcome).toEqual({
        ok: false,
        status: 400,
        error: 'A valid email address is required',
      })
    }
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.user.create).not.toHaveBeenCalled()
  })

  it('normalizes the email for lookup, creation, the token and the message', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null)
    prismaMock.user.create.mockResolvedValue(userRow() as never)

    await inviteUser({
      email: '  Jane@Example.COM ',
      name: '  Jane Doe ',
      scope: { kind: 'project', projectId: 'p1' },
    })

    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'jane@example.com' },
    })
    expect(prismaMock.user.create).toHaveBeenCalledWith({
      data: { email: 'jane@example.com', name: 'Jane Doe', role: 'EVALUATOR' },
    })
    expect(createTokenMock).toHaveBeenCalledWith('jane@example.com', 'INVITE')
    expect(sendInviteEmailMock.mock.calls[0][0]).toBe('jane@example.com')
  })

  it('stores a blank or non-string name as null', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null)
    prismaMock.user.create.mockResolvedValue(userRow() as never)

    await inviteUser({ email: 'a@b.co', name: '   ', scope: { kind: 'project', projectId: 'p1' } })
    await inviteUser({ email: 'a@b.co', name: 7, scope: { kind: 'project', projectId: 'p1' } })

    for (const call of prismaMock.user.create.mock.calls) {
      expect(call[0].data.name).toBeNull()
    }
  })

  it('returns 404 when the project does not exist, without creating an account', async () => {
    prismaMock.project.findUnique.mockResolvedValue(null)

    const outcome = await inviteUser({
      email: 'jane@example.com',
      name: null,
      scope: { kind: 'project', projectId: 'missing' },
    })

    expect(outcome).toEqual({ ok: false, status: 404, error: 'Project not found' })
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.user.create).not.toHaveBeenCalled()
  })
})

describe('inviteUser — project scope (Annotators tab)', () => {
  it('creates a new annotator, adds them to the project and emails the annotator invite', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null)
    prismaMock.user.create.mockResolvedValue(userRow({ name: 'Jane' }) as never)

    const outcome = await inviteUser({
      email: 'jane@example.com',
      name: 'Jane',
      scope: { kind: 'project', projectId: 'p1' },
    })

    expect(outcome).toEqual({ ok: true, userId: 'u1', invited: true, alreadyHasPassword: false })
    expect(prismaMock.user.create).toHaveBeenCalledWith({
      data: { email: 'jane@example.com', name: 'Jane', role: 'EVALUATOR' },
    })
    expect(prismaMock.projectEvaluator.upsert).toHaveBeenCalledWith({
      where: { projectId_userId: { projectId: 'p1', userId: 'u1' } },
      create: { projectId: 'p1', userId: 'u1' },
      update: {},
      select: { role: true },
    })
    expect(createTokenMock).toHaveBeenCalledWith('jane@example.com', 'INVITE')
    expect(sendInviteEmailMock).toHaveBeenCalledWith(
      'jane@example.com',
      'tok-123',
      'Jane',
      'annotator',
      'Quill Annotation'
    )
  })

  it('never creates a global admin, whatever the caller sends', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null)
    prismaMock.user.create.mockResolvedValue(userRow() as never)

    await inviteUser({
      email: 'jane@example.com',
      name: null,
      // A project scope has no role field; this guards against a future one.
      scope: { kind: 'project', projectId: 'p1', role: 'ADMIN' } as never,
    })

    expect(prismaMock.user.create.mock.calls[0][0].data.role).toBe('EVALUATOR')
  })

  it('adds an existing passwordless annotator and re-sends the invite', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userRow() as never)

    const outcome = await inviteUser({
      email: 'jane@example.com',
      name: 'Ignored For Existing',
      scope: { kind: 'project', projectId: 'p1' },
    })

    expect(outcome).toEqual({ ok: true, userId: 'u1', invited: true, alreadyHasPassword: false })
    expect(prismaMock.user.create).not.toHaveBeenCalled()
    expect(prismaMock.projectEvaluator.upsert).toHaveBeenCalledTimes(1)
    expect(createTokenMock).toHaveBeenCalledTimes(1)
    expect(sendInviteEmailMock).toHaveBeenCalledTimes(1)
  })

  it('adds an existing account that already has a password without emailing', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userRow({ hashedPassword: '$2a$hash' }) as never)

    const outcome = await inviteUser({
      email: 'jane@example.com',
      name: null,
      scope: { kind: 'project', projectId: 'p1' },
    })

    expect(outcome).toEqual({ ok: true, userId: 'u1', invited: false, alreadyHasPassword: true })
    expect(prismaMock.projectEvaluator.upsert).toHaveBeenCalledTimes(1)
    expect(createTokenMock).not.toHaveBeenCalled()
    expect(sendInviteEmailMock).not.toHaveBeenCalled()
  })

  it('lets a global admin be added to a project (no role conflict in project scope)', async () => {
    prismaMock.user.findUnique.mockResolvedValue(
      userRow({ id: 'admin1', role: 'ADMIN', hashedPassword: '$2a$hash' }) as never
    )

    const outcome = await inviteUser({
      email: 'amber@example.com',
      name: null,
      scope: { kind: 'project', projectId: 'p1' },
    })

    expect(outcome).toMatchObject({ ok: true, userId: 'admin1', alreadyHasPassword: true })
    expect(prismaMock.projectEvaluator.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { projectId: 'p1', userId: 'admin1' } })
    )
  })

  it('sends the project-admin copy when the membership is PROJECT_ADMIN', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userRow({ name: 'Pat' }) as never)
    prismaMock.projectEvaluator.upsert.mockResolvedValue({ role: 'PROJECT_ADMIN' } as never)

    await inviteUser({
      email: 'pat@example.com',
      name: null,
      scope: { kind: 'project', projectId: 'p1' },
    })

    expect(sendInviteEmailMock).toHaveBeenCalledWith(
      'pat@example.com',
      'tok-123',
      'Pat',
      'project-admin',
      'Quill Annotation'
    )
  })
})

describe('inviteUser — global scope (Accounts page)', () => {
  it('creates a new global admin and sends the admin copy', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null)
    prismaMock.user.create.mockResolvedValue(userRow({ id: 'u9', role: 'ADMIN' }) as never)

    const outcome = await inviteUser({
      email: 'new-admin@example.com',
      name: null,
      scope: { kind: 'global', role: 'ADMIN' },
    })

    expect(outcome).toEqual({ ok: true, userId: 'u9', invited: true, alreadyHasPassword: false })
    expect(prismaMock.user.create.mock.calls[0][0].data.role).toBe('ADMIN')
    expect(prismaMock.project.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.projectEvaluator.upsert).not.toHaveBeenCalled()
    expect(sendInviteEmailMock).toHaveBeenCalledWith(
      'new-admin@example.com',
      'tok-123',
      null,
      'admin',
      null
    )
  })

  it('refuses to re-invite an existing account under a different global role', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userRow() as never) // EVALUATOR

    const outcome = await inviteUser({
      email: 'jane@example.com',
      name: null,
      scope: { kind: 'global', role: 'ADMIN' },
    })

    expect(outcome).toEqual({
      ok: false,
      status: 409,
      error:
        'jane@example.com already has an account as an annotator. Change their role from the Accounts list instead of re-inviting them.',
    })
    expect(prismaMock.user.create).not.toHaveBeenCalled()
    expect(prismaMock.projectEvaluator.upsert).not.toHaveBeenCalled()
    expect(createTokenMock).not.toHaveBeenCalled()
    expect(sendInviteEmailMock).not.toHaveBeenCalled()
  })

  it('names the existing role in the conflict message for an admin too', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userRow({ role: 'ADMIN' }) as never)

    const outcome = await inviteUser({
      email: 'jane@example.com',
      name: null,
      scope: { kind: 'global', role: 'EVALUATOR' },
    })

    expect(outcome).toMatchObject({ ok: false, status: 409 })
    expect((outcome as { error: string }).error).toContain('as an admin')
  })

  it('re-sends the invite to an existing passwordless account with the same role', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userRow({ role: 'ADMIN', name: 'Amber' }) as never)

    const outcome = await inviteUser({
      email: 'jane@example.com',
      name: null,
      scope: { kind: 'global', role: 'ADMIN' },
    })

    expect(outcome).toEqual({ ok: true, userId: 'u1', invited: true, alreadyHasPassword: false })
    expect(prismaMock.user.create).not.toHaveBeenCalled()
    expect(sendInviteEmailMock).toHaveBeenCalledWith(
      'jane@example.com',
      'tok-123',
      'Amber',
      'admin',
      null
    )
  })

  it('reports an existing account with a password and sends nothing', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userRow({ hashedPassword: '$2a$hash' }) as never)

    const outcome = await inviteUser({
      email: 'jane@example.com',
      name: null,
      scope: { kind: 'global', role: 'EVALUATOR' },
    })

    expect(outcome).toEqual({ ok: true, userId: 'u1', invited: false, alreadyHasPassword: true })
    expect(createTokenMock).not.toHaveBeenCalled()
    expect(sendInviteEmailMock).not.toHaveBeenCalled()
  })

  it('also adds the person to a project when the global invite names one', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null)
    prismaMock.user.create.mockResolvedValue(userRow() as never)

    await inviteUser({
      email: 'jane@example.com',
      name: null,
      scope: { kind: 'global', role: 'EVALUATOR', projectId: 'p1' },
    })

    expect(prismaMock.projectEvaluator.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { projectId: 'p1', userId: 'u1' } })
    )
    expect(sendInviteEmailMock.mock.calls[0][4]).toBe('Quill Annotation')
  })
})
