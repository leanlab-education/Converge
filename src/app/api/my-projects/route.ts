import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { countForAssignment, loadSlotMaps } from '@/lib/evaluator-stats'
import { NextResponse } from 'next/server'

export async function GET() {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const evaluatorProjects = await prisma.projectEvaluator.findMany({
    where: { userId: session.user.id },
    include: {
      project: {
        select: {
          id: true,
          name: true,
          description: true,
          status: true,
          usePseudonyms: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  // Get batch assignments for this user — skip admin-hidden batches
  // so the Double-before-Independent release workflow works.
  const batchAssignments = await prisma.batchAssignment.findMany({
    where: {
      userId: session.user.id,
      OR: [{ teamReleaseId: null }, { teamRelease: { isVisible: true } }],
      batch: { isHidden: false },
    },
    include: {
      teamRelease: {
        include: {
          team: {
            include: {
              members: {
                select: { userId: true },
                orderBy: { user: { email: 'asc' } },
              },
              dimensions: {
                select: { dimensionId: true },
              },
            },
          },
        },
      },
      batch: {
        include: {
          project: { select: { id: true } },
        },
      },
    },
  })

  const { itemCountByBatchSlot, scoredCountByUser } = await loadSlotMaps(batchAssignments)
  const scoredCountByBatchSlot = scoredCountByUser.get(session.user.id) ?? new Map()

  // Group batch assignments by projectId
  const batchesByProject = new Map<
    string,
    { id: string; name: string; status: string; itemCount: number; scoredCount: number }[]
  >()

  for (const ba of batchAssignments) {
    const pid = ba.batch.project.id
    if (!batchesByProject.has(pid)) batchesByProject.set(pid, [])

    const itemCount = countForAssignment(ba, session.user.id, itemCountByBatchSlot)
    const scoredCount = countForAssignment(ba, session.user.id, scoredCountByBatchSlot)

    batchesByProject.get(pid)!.push({
      id: ba.batch.id,
      name: ba.batch.name,
      status: ba.batch.status,
      itemCount,
      scoredCount,
    })
  }

  // Get team memberships for this user across all projects
  const teamMemberships = await prisma.evaluatorTeamMember.findMany({
    where: { userId: session.user.id },
    include: {
      team: {
        include: {
          dimensions: {
            include: {
              dimension: { select: { label: true } },
            },
            orderBy: { dimension: { sortOrder: 'asc' } },
          },
          members: {
            include: {
              user: { select: { id: true, name: true, email: true } },
            },
            orderBy: { user: { email: 'asc' } },
          },
        },
      },
    },
  })

  const teamByProject = new Map<
    string,
    {
      teamId: string
      teamName: string
      criteria: string[]
      partnerId: string | null
      partnerName: string | null
    }
  >()

  for (const tm of teamMemberships) {
    const partner = tm.team.members
      .filter((m) => m.userId !== session.user!.id)[0] || null

    teamByProject.set(tm.team.projectId, {
      teamId: tm.team.id,
      teamName: tm.team.name,
      criteria: tm.team.dimensions.map((d) => d.dimension.label),
      partnerId: partner?.userId || null,
      partnerName: partner?.user.name || null,
    })
  }

  const result = evaluatorProjects.map((ep) => {
    const batches = batchesByProject.get(ep.projectId) || []
    const assignmentCount = batches.reduce((sum, b) => sum + b.itemCount, 0)
    const completedCount = batches.reduce((sum, b) => sum + b.scoredCount, 0)
    return {
      id: ep.id,
      projectId: ep.projectId,
      project: ep.project,
      assignmentCount,
      completedCount,
      batches,
      team: teamByProject.get(ep.projectId) || null,
    }
  })

  return NextResponse.json(result)
}
