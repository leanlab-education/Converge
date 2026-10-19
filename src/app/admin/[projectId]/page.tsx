import { auth } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import { prisma } from '@/lib/db'
import { loadAdminProjectStats } from '@/lib/evaluator-stats'
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

  // Fetch all data in parallel. Scoring progress (the Overview's "Scored"
  // count and each annotator's Assigned/Completed) comes from the one shared
  // loader the evaluators and stats routes also use, so the tabs agree.
  const [project, evaluatorsRaw, stats, feedbackItemsResult, feedbackItemsCount, unassignedCount, allItemsForFilters] = await Promise.all([
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
    loadAdminProjectStats(projectId),
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

  const evaluators = evaluatorsRaw.map((ev) => {
    const progress = stats.progressByUser.get(ev.user.id)
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
      initialScoredItemCount={stats.fullyScoredItemCount}
      initialFeedbackItemsData={initialFeedbackItemsData}
      initialActiveTab={tab === 'batches' ? 'batches' : 'overview'}
    />
  )
}
