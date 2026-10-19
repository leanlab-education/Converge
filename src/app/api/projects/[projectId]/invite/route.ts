import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import { inviteUser } from '@/lib/invite'
import { NextRequest, NextResponse } from 'next/server'

// Invite an annotator to one project — the Annotators tab's "Add Annotator".
// Open to that project's PROJECT_ADMINs as well as global admins
// (canAdminProject). The global role is never read from the request: this
// route only ever creates annotator accounts, so a project admin cannot mint
// a global admin through it. Rules shared with POST /api/invite via
// inviteUser().
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { projectId } = await params

  if (!(await canAdminProject(session.user.id, session.user.role, projectId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const { email, name } = body ?? {}

  const outcome = await inviteUser({
    email,
    name,
    scope: { kind: 'project', projectId },
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
