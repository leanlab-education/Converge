import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import { prisma } from '@/lib/db'
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

  const evaluators = await prisma.projectEvaluator.findMany({
    where: { projectId },
    include: {
      user: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  // Team membership per user, scoped to this project
  const teamMemberships = await prisma.evaluatorTeamMember.findMany({
    where: {
      userId: { in: evaluators.map((ev) => ev.user.id) },
      team: { projectId },
    },
    include: { team: { select: { id: true, name: true } } },
  })
  const teamByUser = new Map(
    teamMemberships.map((m) => [m.userId, m.team])
  )

  // Assigned = this user's slot-adjusted share of each batch they can see;
  // completed = the items in that share they have scored on every criterion
  // they owe. Same loader as the project page, so the two never disagree.
  const { progressByUser } = await loadAdminProjectStats(projectId)

  const latestScores = await prisma.score.findMany({
    where: { feedbackItem: { batch: { projectId } } },
    select: { userId: true, scoredAt: true },
    orderBy: { scoredAt: 'desc' },
    distinct: ['userId'],
  })
  const lastScoredByUser = new Map(latestScores.map((s) => [s.userId, s.scoredAt.toISOString()]))

  const result = evaluators.map((ev) => {
    const progress = progressByUser.get(ev.user.id)
    return {
      id: ev.id,
      user: ev.user,
      role: ev.role,
      assignedCount: progress?.assignedCount ?? 0,
      completedCount: progress?.completedCount ?? 0,
      lastScoredAt: lastScoredByUser.get(ev.user.id) ?? null,
      team: teamByUser.get(ev.user.id) ?? null,
    }
  })

  return NextResponse.json(result)
}

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

  const body = await request.json()
  const { userId } = body

  if (!userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  }

  const [project, user] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId } }),
    prisma.user.findUnique({ where: { id: userId } }),
  ])

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const existing = await prisma.projectEvaluator.findUnique({
    where: { projectId_userId: { projectId, userId } },
  })

  if (existing) {
    return NextResponse.json(
      { error: 'Evaluator is already assigned to this project' },
      { status: 409 }
    )
  }

  const evaluator = await prisma.projectEvaluator.create({
    data: { projectId, userId },
    include: {
      user: { select: { id: true, name: true, email: true } },
    },
  })

  return NextResponse.json(evaluator, { status: 201 })
}
