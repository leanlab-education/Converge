import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import { prisma } from '@/lib/db'
import { NextRequest, NextResponse } from 'next/server'

// GET /api/projects/[projectId]/teams — list teams with members + dimensions
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

  const teams = await prisma.evaluatorTeam.findMany({
    where: { projectId },
    include: {
      members: {
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      },
      dimensions: {
        include: {
          dimension: {
            select: { id: true, key: true, label: true, sortOrder: true },
          },
        },
        orderBy: { dimension: { sortOrder: 'asc' } },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  return NextResponse.json(teams)
}

// POST /api/projects/[projectId]/teams — create a team
// Body: { name, memberUserIds: string[], dimensionIds: string[] }
export async function POST(
  request: Request,
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
  const { name, memberUserIds, dimensionIds } = body as {
    name: string
    memberUserIds: string[]
    dimensionIds: string[]
  }

  if (!name?.trim()) {
    return NextResponse.json(
      { error: 'Team name is required' },
      { status: 400 }
    )
  }

  // A team is a scoring pair. Double-scoring, reconciliation, and IRR all
  // assume exactly 2 members; a team of any other size silently bricks its
  // releases in RECONCILING (P2). Enforce it at the source.
  if (!Array.isArray(memberUserIds) || new Set(memberUserIds).size !== 2) {
    return NextResponse.json(
      { error: 'A team must have exactly 2 distinct members (a scoring pair).' },
      { status: 400 }
    )
  }

  if (!Array.isArray(dimensionIds) || dimensionIds.length === 0) {
    return NextResponse.json(
      { error: 'At least one dimension is required' },
      { status: 400 }
    )
  }

  // Check for duplicate team name
  const existing = await prisma.evaluatorTeam.findUnique({
    where: { projectId_name: { projectId, name: name.trim() } },
  })
  if (existing) {
    return NextResponse.json(
      { error: `A team named "${name}" already exists in this project` },
      { status: 409 }
    )
  }

  // Check that users aren't already on another team in this project
  const existingMemberships = await prisma.evaluatorTeamMember.findMany({
    where: {
      userId: { in: memberUserIds },
      team: { projectId },
    },
    include: {
      user: { select: { email: true } },
      team: { select: { name: true } },
    },
  })

  if (existingMemberships.length > 0) {
    const conflicts = existingMemberships
      .map((m) => `${m.user.email} is already on "${m.team.name}"`)
      .join(', ')
    return NextResponse.json(
      { error: `Evaluators can only be on one team per project: ${conflicts}` },
      { status: 409 }
    )
  }

  // Check that dimensions aren't already assigned to another team
  const existingDimAssignments = await prisma.evaluatorTeamDimension.findMany({
    where: {
      dimensionId: { in: dimensionIds },
      team: { projectId },
    },
    include: {
      dimension: { select: { label: true } },
      team: { select: { name: true } },
    },
  })

  if (existingDimAssignments.length > 0) {
    const conflicts = existingDimAssignments
      .map((d) => `"${d.dimension.label}" is assigned to "${d.team.name}"`)
      .join(', ')
    return NextResponse.json(
      {
        error: `Each dimension can only be assigned to one team: ${conflicts}`,
      },
      { status: 409 }
    )
  }

  // Create team with members and dimensions in a transaction
  const team = await prisma.evaluatorTeam.create({
    data: {
      projectId,
      name: name.trim(),
      members: {
        create: memberUserIds.map((userId) => ({ userId })),
      },
      dimensions: {
        create: dimensionIds.map((dimensionId) => ({ dimensionId })),
      },
    },
    include: {
      members: {
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      },
      dimensions: {
        include: {
          dimension: {
            select: { id: true, key: true, label: true, sortOrder: true },
          },
        },
      },
    },
  })

  return NextResponse.json(team, { status: 201 })
}
