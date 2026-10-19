import { auth } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import { prisma } from '@/lib/db'
import { countForAssignment, loadSlotMaps } from '@/lib/evaluator-stats'
import { ProjectDetailClient } from '@/components/project-detail-client'
import { canAdminProject } from '@/lib/authorization'

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect('/login')

  const { projectId } = await params
  if (!(await canAdminProject(session.user.id, session.user.role, projectId))) redirect('/')

  const { tab } = await searchParams

  // Fetch all data in parallel
  const [project, evaluatorsRaw, scoredItems, feedbackItemsResult, feedbackItemsCount, unassignedCount, allItemsForFilters] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      include: {
        rubric: { orderBy: { sortOrder: 'asc' } },
        _count: {
          select: {
            feedbackItems: true,
            evaluators: true,
          },
        },
      },
    }),
    prisma.projectEvaluator.findMany({
      where: { projectId },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.score.findMany({
      where: {
        feedbackItem: { projectId },
        isReconciled: false,
      },
      select: { feedbackItemId: true },
      distinct: ['feedbackItemId'],
    }),
    prisma.feedbackItem.findMany({
      where: { projectId },
      select: {
        id: true,
        feedbackId: true,
        activityId: true,
        conjunctionId: true,
        batchId: true,
        batch: { select: { id: true, name: true, type: true, status: true } },
      },
      orderBy: [
        { activityId: 'asc' },
        { conjunctionId: 'asc' },
        { feedbackId: 'asc' },
      ],
      take: 50,
    }),
    prisma.feedbackItem.count({ where: { projectId } }),
    prisma.feedbackItem.count({ where: { projectId, batchId: null } }),
    prisma.feedbackItem.findMany({
      where: { projectId },
      select: { activityId: true, conjunctionId: true },
    }),
  ])

  const activityIds = [
    ...new Set(
      allItemsForFilters
        .map((i) => i.activityId)
        .filter((v): v is string => Boolean(v))
    ),
  ].sort()
  const conjunctionIds = [
    ...new Set(
      allItemsForFilters
        .map((i) => i.conjunctionId)
        .filter((v): v is string => Boolean(v))
    ),
  ].sort()

  const initialFeedbackItemsData = {
    items: feedbackItemsResult,
    total: feedbackItemsCount,
    unassignedTotal: unassignedCount,
    filterOptions: { activityIds, conjunctionIds },
  }

  if (!project) notFound()

  // Compute slot-adjusted assigned + completed counts per evaluator. Completed
  // only counts items the user has scored on every criterion they owe on that
  // batch (a half-scored item does not count).
  const allBatchAssignments = await prisma.batchAssignment.findMany({
    where: { batch: { projectId } },
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
      batch: { select: { id: true, projectId: true, isDoubleScored: true, type: true } },
    },
  })

  const basByUser = new Map<string, typeof allBatchAssignments>()
  for (const ba of allBatchAssignments) {
    const list = basByUser.get(ba.userId) ?? []
    list.push(ba)
    basByUser.set(ba.userId, list)
  }

  const { itemCountByBatchSlot, scoredCountByUser } = await loadSlotMaps(allBatchAssignments)

  const assignedByUser = new Map<string, number>()
  const completedByUser = new Map<string, number>()
  for (const [userId, bas] of basByUser) {
    const scoredMap = scoredCountByUser.get(userId) ?? new Map()
    let assigned = 0
    let completed = 0
    for (const ba of bas) {
      assigned += countForAssignment(ba, userId, itemCountByBatchSlot)
      completed += countForAssignment(ba, userId, scoredMap)
    }
    assignedByUser.set(userId, assigned)
    completedByUser.set(userId, completed)
  }

  const latestScores = await prisma.score.findMany({
    where: { feedbackItem: { batch: { projectId } } },
    select: { userId: true, scoredAt: true },
    orderBy: { scoredAt: 'desc' },
    distinct: ['userId'],
  })
  const lastScoredByUser = new Map(latestScores.map((s) => [s.userId, s.scoredAt.toISOString()]))

  const teamMemberships = await prisma.evaluatorTeamMember.findMany({
    where: {
      userId: { in: evaluatorsRaw.map((ev) => ev.user.id) },
      team: { projectId },
    },
    include: { team: { select: { id: true, name: true } } },
  })
  const teamByUser = new Map(teamMemberships.map((m) => [m.userId, m.team]))

  const evaluators = evaluatorsRaw.map((ev) => ({
    id: ev.id,
    user: ev.user,
    role: ev.role,
    assignedCount: assignedByUser.get(ev.user.id) ?? 0,
    completedCount: completedByUser.get(ev.user.id) ?? 0,
    lastScoredAt: lastScoredByUser.get(ev.user.id) ?? null,
    team: teamByUser.get(ev.user.id) ?? null,
  }))

  // Serialize dates for client component
  const serializedProject = {
    ...project,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  }

  return (
    <ProjectDetailClient
      initialProject={serializedProject}
      initialEvaluators={evaluators}
      initialScoredItemCount={scoredItems.length}
      initialFeedbackItemsData={initialFeedbackItemsData}
      initialActiveTab={tab === 'batches' ? 'batches' : 'overview'}
    />
  )
}
