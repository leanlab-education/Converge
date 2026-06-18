import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import { prisma } from '@/lib/db'
import { NextRequest, NextResponse } from 'next/server'

const STUDYFLOW_STUDY_ID_REGEX = /^[a-zA-Z0-9_-]+$/

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { projectId } = await params

  // Evaluators can only access projects they're assigned to
  if (session.user.role !== 'ADMIN') {
    const assignment = await prisma.projectEvaluator.findUnique({
      where: {
        projectId_userId: { projectId, userId: session.user.id },
      },
    })
    if (!assignment) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      rubric: { orderBy: { sortOrder: 'asc' } },
      _count: {
        select: {
          feedbackItems: true,
          evaluators: true,
          assignments: true,
        },
      },
    },
  })

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  return NextResponse.json(project)
}

export async function PATCH(
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

  const body = await request.json()
  const { studyflowStudyId, usePseudonyms, status } = body

  // project.status is set manually by an admin (SETUP → ACTIVE etc.); it is
  // organizational only and does not gate annotator access.
  // RECONCILIATION is intentionally omitted — reconciliation is an ongoing,
  // batch-level state, not a project status.
  const VALID_STATUSES = ['SETUP', 'ACTIVE', 'COMPLETE']
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: 'Invalid project status' }, { status: 400 })
  }

  if (
    studyflowStudyId !== undefined &&
    studyflowStudyId !== null &&
    studyflowStudyId !== '' &&
    !STUDYFLOW_STUDY_ID_REGEX.test(studyflowStudyId)
  ) {
    return NextResponse.json(
      {
        error:
          'Invalid studyflowStudyId. Must be alphanumeric, underscores, or hyphens only.',
      },
      { status: 400 }
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: Record<string, any> = {}
  if (studyflowStudyId !== undefined) updateData.studyflowStudyId = studyflowStudyId || null
  if (usePseudonyms !== undefined) updateData.usePseudonyms = Boolean(usePseudonyms)
  if (status !== undefined) updateData.status = status

  const project = await prisma.project.update({
    where: { id: projectId },
    data: updateData,
    include: {
      rubric: { orderBy: { sortOrder: 'asc' } },
      _count: {
        select: {
          feedbackItems: true,
          evaluators: true,
          assignments: true,
        },
      },
    },
  })

  return NextResponse.json(project)
}
