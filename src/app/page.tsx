import { auth } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db'
import { EvaluatorDashboard } from '@/components/evaluator-dashboard'
import { countForAssignment, loadSlotMaps } from '@/lib/evaluator-stats'
import { getAdminProjectIds } from '@/lib/authorization'
import { computeReleaseDiscrepancyStats } from '@/lib/reconciliation'

export default async function HomePage() {
  const session = await auth()
  if (!session?.user) redirect('/login')

  // Global admins go straight to the admin dashboard
  if (session.user.role === 'ADMIN') redirect('/admin')

  // Project admins land on their project's admin view — they manage a project
  // rather than annotate, so the annotator dashboard isn't their home. One
  // project goes straight to it; several falls back to the filtered list.
  const adminProjectIds = await getAdminProjectIds(session.user.id)
  if (adminProjectIds.length === 1) redirect(`/admin/${adminProjectIds[0]}`)
  if (adminProjectIds.length > 1) redirect('/admin')

  // Evaluator: fetch assigned projects server-side
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

  // Get batch assignments for this user
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
          _count: { select: { feedbackItems: true } },
          project: { select: { id: true } },
          teamReleases: {
            select: { status: true },
          },
        },
      },
    },
  })

  const { itemCountByBatchSlot, scoredCountByBatchSlot } = await loadSlotMaps(
    batchAssignments.map((ba) => ba.batch.id),
    session.user.id
  )

  // Group batch assignments by projectId and count scored items
  const batchesByProject = new Map<
    string,
    {
      id: string
      releaseId: string | null
      name: string
      status: string
      itemCount: number
      scoredCount: number
      discrepancyCount?: number
      reconciledCount?: number
    }[]
  >()

  for (const ba of batchAssignments) {
    const pid = ba.batch.project.id
    if (!batchesByProject.has(pid)) batchesByProject.set(pid, [])

    // For slot-split (non-double-scored regular) batches, countForAssignment
    // returns just this user's slot. Otherwise it returns the full batch total.
    const itemCount = countForAssignment(ba, session.user.id, itemCountByBatchSlot)
    const scoredCount = scoredCountByBatchSlot
      ? countForAssignment(ba, session.user.id, scoredCountByBatchSlot)
      : 0

    const releaseStatus = ba.teamRelease?.status ?? ba.batch.status
    const releaseId = ba.teamReleaseId ?? null

    let discrepancyCount: number | undefined
    let reconciledCount: number | undefined
    if (ba.teamRelease && releaseStatus === 'RECONCILING') {
      const stats = await computeReleaseDiscrepancyStats({
        batchId: ba.batch.id,
        batchType: ba.batch.type,
        projectId: ba.batch.project.id,
        memberUserIds: ba.teamRelease.team.members.map((m) => m.userId),
        teamDimensionIds: ba.teamRelease.team.dimensions.map((d) => d.dimensionId),
      })
      discrepancyCount = stats.discrepancyCount
      reconciledCount = stats.reconciledCount
    }

    batchesByProject.get(pid)!.push({
      id: ba.batch.id,
      releaseId,
      name: ba.batch.name,
      status: releaseStatus,
      itemCount,
      scoredCount,
      discrepancyCount,
      reconciledCount,
    })
  }

  const projects = evaluatorProjects.map((ep) => {
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
    }
  })

  return (
    <EvaluatorDashboard
      projects={projects}
      userName={session.user.name || session.user.email || 'Annotator'}
    />
  )
}
