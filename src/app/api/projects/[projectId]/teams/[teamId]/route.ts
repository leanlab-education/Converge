import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import { prisma } from '@/lib/db'
import { NextRequest, NextResponse } from 'next/server'

type Params = Promise<{ projectId: string; teamId: string }>

// PATCH /api/projects/[projectId]/teams/[teamId] — update team
// Body: { name?, memberUserIds?, dimensionIds? }
export async function PATCH(request: Request, { params }: { params: Params }) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { projectId, teamId } = await params

  if (!(await canAdminProject(session.user.id, session.user.role, projectId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const body = await request.json()
  const { name, memberUserIds, dimensionIds } = body as {
    name?: string
    memberUserIds?: string[]
    dimensionIds?: string[]
  }

  // Verify team exists
  const team = await prisma.evaluatorTeam.findUnique({
    where: { id: teamId },
    include: { members: true, dimensions: true },
  })

  if (!team || team.projectId !== projectId) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 })
  }

  // Check if any scores exist for this team's members on this team's dimensions
  // If so, block changes to members and dimensions (name is always editable)
  if (memberUserIds || dimensionIds) {
    const memberIds = team.members.map((m) => m.userId)
    const dimIds = team.dimensions.map((d) => d.dimensionId)

    if (memberIds.length > 0 && dimIds.length > 0) {
      const scoreCount = await prisma.score.count({
        where: {
          userId: { in: memberIds },
          dimensionId: { in: dimIds },
          feedbackItem: { projectId },
        },
      })

      if (scoreCount > 0) {
        return NextResponse.json(
          {
            error:
              'Cannot change team members or dimensions after scoring has begun. Rename is still allowed.',
          },
          { status: 409 }
        )
      }
    }
  }

  // Check name uniqueness if changing name
  if (name?.trim() && name.trim() !== team.name) {
    const nameConflict = await prisma.evaluatorTeam.findUnique({
      where: { projectId_name: { projectId, name: name.trim() } },
    })
    if (nameConflict) {
      return NextResponse.json(
        { error: `A team named "${name}" already exists` },
        { status: 409 }
      )
    }
  }

  // Validate new members aren't on other teams
  if (memberUserIds) {
    // A team is a scoring pair — exactly 2 distinct members (see P2 / teams POST).
    if (new Set(memberUserIds).size !== 2) {
      return NextResponse.json(
        { error: 'A team must have exactly 2 distinct members (a scoring pair).' },
        { status: 400 }
      )
    }
    const existingMemberships = await prisma.evaluatorTeamMember.findMany({
      where: {
        userId: { in: memberUserIds },
        team: { projectId, id: { not: teamId } },
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
        { error: `Evaluators can only be on one team: ${conflicts}` },
        { status: 409 }
      )
    }
  }

  // Validate dimensions aren't assigned elsewhere
  if (dimensionIds) {
    const existingDimAssignments =
      await prisma.evaluatorTeamDimension.findMany({
        where: {
          dimensionId: { in: dimensionIds },
          team: { projectId, id: { not: teamId } },
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
        { error: `Dimensions already assigned: ${conflicts}` },
        { status: 409 }
      )
    }
  }

  // Apply updates in a transaction
  const updated = await prisma.$transaction(async (tx) => {
    // Update name if provided
    if (name?.trim()) {
      await tx.evaluatorTeam.update({
        where: { id: teamId },
        data: { name: name.trim() },
      })
    }

    // Replace members if provided
    if (memberUserIds) {
      await tx.evaluatorTeamMember.deleteMany({ where: { teamId } })
      await tx.evaluatorTeamMember.createMany({
        data: memberUserIds.map((userId) => ({ teamId, userId })),
      })
    }

    // Replace dimensions if provided
    if (dimensionIds) {
      await tx.evaluatorTeamDimension.deleteMany({ where: { teamId } })
      await tx.evaluatorTeamDimension.createMany({
        data: dimensionIds.map((dimensionId) => ({ teamId, dimensionId })),
      })
    }

    return tx.evaluatorTeam.findUnique({
      where: { id: teamId },
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
  })

  return NextResponse.json(updated)
}

// DELETE /api/projects/[projectId]/teams/[teamId] — delete team
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Params }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { projectId, teamId } = await params

  if (!(await canAdminProject(session.user.id, session.user.role, projectId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const team = await prisma.evaluatorTeam.findUnique({
    where: { id: teamId },
    include: { members: true, dimensions: true },
  })

  if (!team || team.projectId !== projectId) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 })
  }

  // Check for existing scores
  const memberIds = team.members.map((m) => m.userId)
  const dimIds = team.dimensions.map((d) => d.dimensionId)

  if (memberIds.length > 0 && dimIds.length > 0) {
    const scoreCount = await prisma.score.count({
      where: {
        userId: { in: memberIds },
        dimensionId: { in: dimIds },
        feedbackItem: { projectId },
      },
    })

    if (scoreCount > 0) {
      return NextResponse.json(
        { error: 'Cannot delete team after scoring has begun' },
        { status: 409 }
      )
    }
  }

  // Cascade handles members + dimensions
  await prisma.evaluatorTeam.delete({ where: { id: teamId } })

  return NextResponse.json({ deleted: true })
}
