import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import { loadAdminProjectStats } from '@/lib/evaluator-stats'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(
  _request: NextRequest,
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

  // Items where every owed criterion has a raw score from an expected scorer —
  // the same figure the project page's Overview tab renders. An item with one
  // of eight criteria saved is not scored.
  const { fullyScoredItemCount } = await loadAdminProjectStats(projectId)

  return NextResponse.json({
    scoredItemCount: fullyScoredItemCount,
  })
}
