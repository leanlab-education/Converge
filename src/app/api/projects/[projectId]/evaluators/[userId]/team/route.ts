import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import { prisma } from '@/lib/db'
import { syncTeamAcrossBatches } from '@/lib/team-batch-releases'
import { NextResponse } from 'next/server'

type Params = Promise<{ projectId: string; userId: string }>

// PUT /api/projects/[projectId]/evaluators/[userId]/team
// Body: { teamId: string | null }
//
// Sets (or clears) the user's team membership for this project.
// - teamId === null  → remove user from any team in the project
// - teamId === <id>  → remove from any other team, then add to this team
//
// Blocks the change if the user already has scores tied to either the
// current or destination team's dimensions, to avoid orphaning data.
export async function PUT(request: Request, { params }: { params: Params }) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { projectId, userId } = await params

  if (!(await canAdminProject(session.user.id, session.user.role, projectId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const body = await request.json().catch(() => ({}))
  const teamId: string | null = body?.teamId ?? null

  // Verify user is an evaluator on this project
  const projectEvaluator = await prisma.projectEvaluator.findUnique({
    where: { projectId_userId: { projectId, userId } },
  })
  if (!projectEvaluator) {
    return NextResponse.json(
      { error: 'Annotator is not on this project' },
      { status: 404 }
    )
  }

  // Verify destination team if provided
  if (teamId !== null) {
    const team = await prisma.evaluatorTeam.findUnique({
      where: { id: teamId },
      select: { id: true, projectId: true },
    })
    if (!team || team.projectId !== projectId) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 })
    }
  }

  // Find current memberships in this project
  const currentMemberships = await prisma.evaluatorTeamMember.findMany({
    where: { userId, team: { projectId } },
    include: { team: { include: { dimensions: true } } },
  })

  const currentTeamIds = currentMemberships.map((m) => m.teamId)
  const alreadyOnTarget = teamId !== null && currentTeamIds.includes(teamId)

  // No-op if already in the target team and not on any other team
  if (alreadyOnTarget && currentMemberships.length === 1) {
    return NextResponse.json({ teamId })
  }

  // Collect dimensions for current teams + destination team
  const currentDimensionIds = currentMemberships.flatMap((m) =>
    m.team.dimensions.map((d) => d.dimensionId)
  )

  let destinationDimensionIds: string[] = []
  if (teamId !== null && !alreadyOnTarget) {
    const destDims = await prisma.evaluatorTeamDimension.findMany({
      where: { teamId },
      select: { dimensionId: true },
    })
    destinationDimensionIds = destDims.map((d) => d.dimensionId)
  }

  const involvedDimensionIds = Array.from(
    new Set([...currentDimensionIds, ...destinationDimensionIds])
  )

  // Block if scoring has begun on any involved dimension
  if (involvedDimensionIds.length > 0) {
    const scoreCount = await prisma.score.count({
      where: {
        userId,
        dimensionId: { in: involvedDimensionIds },
        feedbackItem: { projectId },
      },
    })
    if (scoreCount > 0) {
      return NextResponse.json(
        {
          error:
            'Cannot change this annotator\'s team after they have scored items on the involved dimensions.',
        },
        { status: 409 }
      )
    }
  }

  // Apply: remove from any teams in this project, then add to destination
  await prisma.$transaction(async (tx) => {
    if (currentMemberships.length > 0) {
      await tx.evaluatorTeamMember.deleteMany({
        where: { userId, team: { projectId } },
      })
    }
    if (teamId !== null) {
      await tx.evaluatorTeamMember.create({ data: { teamId, userId } })
    }
  })

  // Re-sync every team the change touched (the team(s) left and the team
  // joined) so their batch assignments reflect the new membership. (P11)
  const affectedTeamIds = new Set([
    ...currentTeamIds,
    ...(teamId !== null ? [teamId] : []),
  ])
  for (const affectedTeamId of affectedTeamIds) {
    await syncTeamAcrossBatches(affectedTeamId)
  }

  return NextResponse.json({ teamId })
}
