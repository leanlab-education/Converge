import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { redirect } from 'next/navigation'
import { EvaluatorProjectPage } from './evaluator-project-page'
import { countForAssignment, loadSlotMaps } from '@/lib/evaluator-stats'
import {
  computeReleaseDiscrepancyStats,
  healStrandedRelease,
  shouldListReconcileTask,
} from '@/lib/reconciliation'
import { releaseNeedsReconciliation } from '@/lib/team-batch-releases'
import { unlockVisibleToUserWhere } from '@/lib/criterion-unlocks'
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
    // Chronological base order — pending work stays in a predictable place as
    // the batch list grows (Abi, 2026-07-29).
    orderBy: { batch: { createdAt: 'asc' } },
  })

  // Each batch is created filtered to one activity ("essay" to annotators) —
  // derive it from the items so the Scoring list can label and group by it.
  // Defensive: a hypothetical mixed-activity batch degrades to null (no label).
  const activityGroups = await prisma.feedbackItem.groupBy({
    by: ['batchId', 'activityId', 'conjunctionId'],
    where: { batchId: { in: batchAssignments.map((ba) => ba.batch.id) } },
  })
  const activityByBatch = new Map<string, { activityId: string | null; conjunctionId: string | null }>()
  for (const g of activityGroups) {
    if (!g.batchId) continue
    const existing = activityByBatch.get(g.batchId)
    if (!existing) {
      activityByBatch.set(g.batchId, {
        activityId: g.activityId,
        conjunctionId: g.conjunctionId,
      })
    } else {
      if (existing.activityId !== g.activityId) existing.activityId = null
      if (existing.conjunctionId !== g.conjunctionId) existing.conjunctionId = null
    }
  }

  // scoredCount only counts items this user has scored on EVERY criterion they
  // owe on that batch, so a half-scored item can't read as done.
  const { itemCountByBatchSlot, scoredCountByUser } = await loadSlotMaps(batchAssignments)
  const scoredCountByBatchSlot = scoredCountByUser.get(userId) ?? new Map()

  // --- Self-heal: a release whose scoring is finished but is still SCORING ---
  // The SCORING → RECONCILING/COMPLETE transition runs after every score save,
  // but the scores route deliberately swallows its failure so a transient DB
  // error can't fail the save itself. If that happens on the LAST score nothing
  // ever re-runs it, and a 100%-scored release sits in SCORING with both
  // partners shown "Waiting on partner" indefinitely. This page is the one place
  // either partner reliably comes back to, so it re-runs the check here.
  //
  // A side effect in a server render is accepted deliberately: the check is
  // idempotent, it runs only for the handful of SCORING releases where this
  // user's own share is complete (anyone else's visit can't have changed the
  // outcome), it no-ops unless every expected score exists, and it never
  // throws. It runs BEFORE the card list and task lists are built so they show
  // the repaired status, not the stale one.
  const healCandidates = batchAssignments.filter((ba) => {
    if (ba.teamRelease?.status !== 'SCORING') return false
    const itemCount = countForAssignment(ba, userId, itemCountByBatchSlot)
    return (
      itemCount > 0 &&
      countForAssignment(ba, userId, scoredCountByBatchSlot) >= itemCount
    )
  })
  const healedReleaseIds: string[] = []
  for (const ba of healCandidates) {
    if (await healStrandedRelease(ba.teamRelease!.id)) {
      healedReleaseIds.push(ba.teamRelease!.id)
    }
  }
  if (healedReleaseIds.length > 0) {
    const refreshed = await prisma.teamBatchRelease.findMany({
      where: { id: { in: healedReleaseIds } },
      select: { id: true, status: true },
    })
    const statusById = new Map(refreshed.map((r) => [r.id, r.status]))
    for (const ba of batchAssignments) {
      const next = ba.teamRelease ? statusById.get(ba.teamRelease.id) : undefined
      if (next) ba.teamRelease!.status = next
    }
  }

  const batches = batchAssignments.map((ba) => {
    const itemCount = countForAssignment(ba, userId, itemCountByBatchSlot)
    const scoredCount = countForAssignment(ba, userId, scoredCountByBatchSlot)
    const releaseStatus = ba.teamRelease?.status ?? ba.batch.status
    const releaseId = ba.teamReleaseId ?? null
    const activity = activityByBatch.get(ba.batch.id)
    // A paired release (double-scored or training) stays SCORING until the
    // partner finishes too, so the card can say "Waiting on partner" rather
    // than "Scored" once this user's own share is done.
    const isPaired = ba.teamRelease
      ? releaseNeedsReconciliation({
          id: ba.teamRelease.id,
          scorerUserId: ba.teamRelease.scorerUserId,
          batch: ba.batch,
          team: ba.teamRelease.team,
        })
      : false
    return {
      id: ba.batch.id,
      releaseId,
      name: ba.batch.name,
      status: releaseStatus,
      isPaired,
      itemCount,
      scoredCount,
      createdAt: ba.batch.createdAt.toISOString(),
      activityId: activity?.activityId ?? null,
      conjunctionId: activity?.conjunctionId ?? null,
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
  // Releases among the candidates that an admin currently has a criterion
  // re-opened on — any scope, since a partner-only re-open still means there is
  // nothing for this user to reconcile until the partner revises. Feeds
  // shouldListReconcileTask, which uses it to drop the phantom "Reconcile" entry
  // a re-open would otherwise create (the Revise task covers that work).
  const candidateReleaseIds = reconcileCandidates.map((ba) => ba.teamRelease!.id)
  const releaseIdsWithOpenUnlock = new Set(
    candidateReleaseIds.length === 0
      ? []
      : (
          await prisma.releaseCriterionUnlock.findMany({
            where: { teamReleaseId: { in: candidateReleaseIds } },
            select: { teamReleaseId: true },
          })
        ).map((u) => u.teamReleaseId)
  )
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
        if (
          !shouldListReconcileTask({
            status: release.status,
            discrepancyCount: stats.discrepancyCount,
            reconciledCount: stats.reconciledCount,
            hasOpenUnlock: releaseIdsWithOpenUnlock.has(release.id),
          })
        ) {
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

  // --- Revise: criteria an admin re-opened for this annotator ---
  // Each ReleaseCriterionUnlock on a batch this user's team scored lets them go
  // back and edit their individual scores for just that one criterion. Unlocks
  // scoped to a different annotator (userId set) are not their task.
  const reviseUnlocks = await prisma.releaseCriterionUnlock.findMany({
    where: {
      ...unlockVisibleToUserWhere(userId),
      teamRelease: {
        batch: { projectId, isHidden: false },
        team: { members: { some: { userId } } },
      },
    },
    select: {
      dimension: { select: { label: true } },
      teamRelease: {
        select: {
          batchId: true,
          batch: { select: { name: true, isLocked: true } },
        },
      },
    },
  })
  const reviseTasks = reviseUnlocks.map((u) => ({
    batchId: u.teamRelease.batchId,
    batchName: u.teamRelease.batch.name,
    criterionLabel: u.dimension.label,
    isLocked: u.teamRelease.batch.isLocked,
  }))

  return (
    <EvaluatorProjectPage
      project={projectEvaluator.project}
      batches={batches}
      reconcileTasks={reconcileTasks}
      adjudicateTasks={adjudicateTasks}
      reviseTasks={reviseTasks}
      userName={session.user.name || session.user.email || 'Annotator'}
    />
  )
}
