import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { redirect } from 'next/navigation'
import { EvaluatorProjectPage } from './evaluator-project-page'
import { countForAssignment, loadSlotMaps } from '@/lib/evaluator-stats'
import { computeReleaseDiscrepancyStats } from '@/lib/reconciliation'
import { displayAnnotatorName } from '@/lib/generate-name'

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect('/login')
  if (session.user.role === 'ADMIN') redirect('/admin')

  const { projectId } = await params
  const userId = session.user.id

  // Verify this evaluator belongs to the project
  const projectEvaluator = await prisma.projectEvaluator.findUnique({
    where: { projectId_userId: { projectId, userId } },
    include: {
      project: {
        select: { id: true, name: true, description: true, usePseudonyms: true },
      },
    },
  })
  if (!projectEvaluator) redirect('/')
  const usePseudonyms = projectEvaluator.project.usePseudonyms

  // Fetch batch assignments for this user + project
  const batchAssignments = await prisma.batchAssignment.findMany({
    where: {
      userId,
      OR: [{ teamReleaseId: null }, { teamRelease: { isVisible: true } }],
      batch: { projectId, isHidden: false },
    },
    include: {
      teamRelease: {
        include: {
          team: {
            include: {
              members: {
                include: { user: { select: { id: true, name: true, email: true } } },
                orderBy: { user: { email: 'asc' } },
              },
              dimensions: {
                include: { dimension: { select: { id: true, label: true, sortOrder: true } } },
                orderBy: { dimension: { sortOrder: 'asc' } },
              },
            },
          },
        },
      },
      batch: {
        include: {
          _count: { select: { feedbackItems: true } },
          project: { select: { id: true } },
        },
      },
    },
  })

  const { itemCountByBatchSlot, scoredCountByBatchSlot } = await loadSlotMaps(
    batchAssignments.map((ba) => ba.batch.id),
    userId
  )

  const batches = batchAssignments.map((ba) => {
    const itemCount = countForAssignment(ba, userId, itemCountByBatchSlot)
    const scoredCount = scoredCountByBatchSlot
      ? countForAssignment(ba, userId, scoredCountByBatchSlot)
      : 0
    const releaseStatus = ba.teamRelease?.status ?? ba.batch.status
    const releaseId = ba.teamReleaseId ?? null
    return {
      id: ba.batch.id,
      releaseId,
      name: ba.batch.name,
      status: releaseStatus,
      itemCount,
      scoredCount,
    }
  })

  // --- Reconciliation: discrepancies to resolve with your own partner ---
  // Includes releases actively RECONCILING, plus ones that have auto-completed
  // but whose batch is still unlocked — so the pair can revisit and correct a
  // final score until an admin locks the batch (Amber 2026-06-30). Completed
  // releases only surface if they actually had discrepancies to reconcile.
  const reconcileCandidates = batchAssignments.filter((ba) => {
    const status = ba.teamRelease?.status
    if (status === 'RECONCILING') return true
    if (status === 'COMPLETE' && !ba.batch.isLocked) return true
    return false
  })
  const reconcileTasks = (
    await Promise.all(
      reconcileCandidates.map(async (ba) => {
        const release = ba.teamRelease!
        const stats = await computeReleaseDiscrepancyStats({
          batchId: ba.batch.id,
          batchType: ba.batch.type,
          projectId,
          memberUserIds: release.team.members.map((m) => m.userId),
          teamDimensionIds: release.team.dimensions.map((d) => d.dimensionId),
        })
        // A completed release with no discrepancies had nothing to reconcile —
        // don't clutter the list with a non-actionable "edit" entry.
        if (release.status === 'COMPLETE' && stats.discrepancyCount === 0) {
          return null
        }
        const partner = release.team.members.find((m) => m.userId !== userId)?.user ?? null
        return {
          releaseId: release.id,
          batchId: ba.batch.id,
          batchName: ba.batch.name,
          status: release.status,
          criteria: release.team.dimensions.map((d) => d.dimension.label),
          partnerName: partner
            ? displayAnnotatorName(partner.id, partner.name, usePseudonyms)
            : null,
          discrepancyCount: stats.discrepancyCount,
          reconciledCount: stats.reconciledCount,
        }
      })
    )
  ).filter((t): t is NonNullable<typeof t> => t !== null)

  // --- Adjudication: items escalated to you for another group in this project ---
  const myEscalations = await prisma.escalation.findMany({
    where: {
      resolvedAt: null,
      batch: { projectId },
      teamRelease: { adjudicatorId: userId },
    },
    include: {
      batch: { select: { name: true } },
      teamRelease: {
        select: {
          id: true,
          team: {
            select: {
              name: true,
              dimensions: {
                include: { dimension: { select: { label: true, sortOrder: true } } },
                orderBy: { dimension: { sortOrder: 'asc' } },
              },
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  const adjudicateMap = new Map<
    string,
    { releaseId: string; batchName: string; teamName: string; criteria: string[]; count: number }
  >()
  for (const esc of myEscalations) {
    const existing = adjudicateMap.get(esc.teamReleaseId)
    if (existing) {
      existing.count++
    } else {
      adjudicateMap.set(esc.teamReleaseId, {
        releaseId: esc.teamReleaseId,
        batchName: esc.batch.name,
        teamName: esc.teamRelease.team.name,
        criteria: esc.teamRelease.team.dimensions.map((d) => d.dimension.label),
        count: 1,
      })
    }
  }
  const adjudicateTasks = Array.from(adjudicateMap.values())

  return (
    <EvaluatorProjectPage
      project={projectEvaluator.project}
      batches={batches}
      reconcileTasks={reconcileTasks}
      adjudicateTasks={adjudicateTasks}
      userName={session.user.name || session.user.email || 'Annotator'}
    />
  )
}
