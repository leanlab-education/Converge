import { auth } from '@/lib/auth'
import { inviteUser } from '@/lib/invite'
import { NextResponse } from 'next/server'

// Global-admin-only invite behind the Accounts page (/admin/accounts): the one
// path that can create a global admin. Project admins add annotators through
// POST /api/projects/[projectId]/invite instead; both routes share their rules
// via inviteUser().
export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const { email, name, projectId, role } = body ?? {}

  const outcome = await inviteUser({
    email,
    name,
    scope: {
      kind: 'global',
      role: role === 'ADMIN' ? 'ADMIN' : 'EVALUATOR',
      projectId: typeof projectId === 'string' && projectId ? projectId : null,
    },
  })

  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.status })
  }

  return NextResponse.json(
    {
      userId: outcome.userId,
      invited: outcome.invited,
      alreadyHasPassword: outcome.alreadyHasPassword,
    },
    { status: 201 }
  )
}
