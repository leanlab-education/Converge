import { prisma } from './db'
import { createToken } from './tokens'
import { sendInviteEmail, type InviteVariant } from './email'
import { parseEmail } from './email-address'
import type { ProjectEvaluatorRole, Role } from '@/generated/prisma/client'

// The one place that decides what an invite does. Two routes call it:
//
//   POST /api/invite                       — Accounts page, global admins only.
//                                            Picks the global role for a new
//                                            account and may re-send an invite.
//   POST /api/projects/[projectId]/invite  — a project's Annotators tab, open
//                                            to project admins. Always creates
//                                            annotators, never admins, and adds
//                                            them to that one project.
//
// Both share: find-or-create the account, add the project membership, and send
// the set-your-password email only while the account has no password yet.
// Keeping the rules here means the two routes cannot drift apart.

export type InviteScope =
  | {
      kind: 'global'
      // Global role for a new account. For an existing account the role must
      // already match; promoting or demoting happens from the Accounts list,
      // not by re-inviting, so a mismatch is refused rather than ignored.
      role: Role
      // Optional project to add the person to as well.
      projectId?: string | null
    }
  | {
      kind: 'project'
      projectId: string
    }

export type InviteInput = {
  // Untrusted request values; normalized and validated here.
  email: unknown
  name: unknown
  scope: InviteScope
}

export type InviteOutcome =
  | {
      ok: true
      userId: string
      // An invite email was sent (the account has no password yet).
      invited: boolean
      // The account already exists with a password; nothing was emailed.
      alreadyHasPassword: boolean
    }
  | { ok: false; status: 400 | 404 | 409; error: string }

const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'an admin',
  EVALUATOR: 'an annotator',
}

// Which copy the invite email gets. Global admins hear about admin access;
// someone whose membership on the target project is PROJECT_ADMIN hears about
// that project; everyone else is invited as an annotator.
export function inviteVariant(
  globalRole: Role,
  projectRole: ProjectEvaluatorRole | null
): InviteVariant {
  if (globalRole === 'ADMIN') return 'admin'
  if (projectRole === 'PROJECT_ADMIN') return 'project-admin'
  return 'annotator'
}

export async function inviteUser(input: InviteInput): Promise<InviteOutcome> {
  const email = parseEmail(input.email)
  if (!email) {
    return { ok: false, status: 400, error: 'A valid email address is required' }
  }
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : null

  const { scope } = input
  const projectId = scope.kind === 'project' ? scope.projectId : (scope.projectId ?? null)

  // Resolve the project up front so a stale id is a clean 404, not a foreign
  // key error after the account was already created.
  const project = projectId
    ? await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true },
      })
    : null
  if (projectId && !project) {
    return { ok: false, status: 404, error: 'Project not found' }
  }

  let user = await prisma.user.findUnique({ where: { email } })

  if (user && scope.kind === 'global' && user.role !== scope.role) {
    return {
      ok: false,
      status: 409,
      error: `${email} already has an account as ${ROLE_LABEL[user.role]}. Change their role from the Accounts list instead of re-inviting them.`,
    }
  }

  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        name,
        // Project-scoped invites can only ever create annotators.
        role: scope.kind === 'global' ? scope.role : 'EVALUATOR',
      },
    })
  }

  let projectRole: ProjectEvaluatorRole | null = null
  if (project) {
    const membership = await prisma.projectEvaluator.upsert({
      where: { projectId_userId: { projectId: project.id, userId: user.id } },
      create: { projectId: project.id, userId: user.id },
      update: {},
      select: { role: true },
    })
    projectRole = membership.role
  }

  if (user.hashedPassword) {
    return { ok: true, userId: user.id, invited: false, alreadyHasPassword: true }
  }

  const token = await createToken(email, 'INVITE')
  await sendInviteEmail(
    email,
    token,
    user.name,
    inviteVariant(user.role, projectRole),
    project?.name ?? null
  )

  return { ok: true, userId: user.id, invited: true, alreadyHasPassword: false }
}
