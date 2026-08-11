import { prisma } from '@/lib/db'
import {
  getExpectedReleaseDimensionIds,
  getExpectedReleaseUserIds,
  getExpectedScoresPerItemPerDimension,
  getReleaseOwnerUserId,
  releaseNeedsReconciliation,
  syncBatchStatus,
} from '@/lib/team-batch-releases'

async function getReleaseContext(releaseId: string) {
  return prisma.teamBatchRelease.findUnique({
    where: { id: releaseId },
    include: {
      batch: {
        select: {
          id: true,
          projectId: true,
          type: true,
          isDoubleScored: true,
        },
      },
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
  })
}

async function getReleaseDimensionIds(
  release: NonNullable<Awaited<ReturnType<typeof getReleaseContext>>>
) {
  const projectDimensionIds =
    release.batch.type === 'TRAINING'
      ? (
          await prisma.rubricDimension.findMany({
            where: { projectId: release.batch.projectId },
            select: { id: true },
          })
        ).map((dimension) => dimension.id)
      : []

  return getExpectedReleaseDimensionIds(release, projectDimensionIds)
}

export async function isReleaseFullyScored(releaseId: string): Promise<boolean> {
  const release = await getReleaseContext(releaseId)
  if (!release) return false
  if (!release.isVisible) return false

  const userIds = getExpectedReleaseUserIds(release)
  const dimensionIds = await getReleaseDimensionIds(release)
  if (userIds.length === 0 || dimensionIds.length === 0) return false

  const itemCount = await prisma.feedbackItem.count({
    where: { batchId: release.batchId },
  })
  if (itemCount === 0) return false

  const scoresPerItemPerDim = getExpectedScoresPerItemPerDimension(release)
  const expectedCount = itemCount * dimensionIds.length * scoresPerItemPerDim
  const actualCount = await prisma.score.count({
    where: {
      feedbackItem: { batchId: release.batchId },
      userId: { in: userIds },
      dimensionId: { in: dimensionIds },
      isReconciled: false,
    },
  })

  return actualCount >= expectedCount
}

/**
 * Create reconciled Score rows for agreed dimensions within one release.
 */
export async function autoReconcileAgreedScoresForRelease(releaseId: string) {
  const release = await getReleaseContext(releaseId)
  if (!release) return

  const userIds = getExpectedReleaseUserIds(release)
  const ownerUserId = getReleaseOwnerUserId(release)
  const dimensionIds = await getReleaseDimensionIds(release)
  if (userIds.length !== 2 || !ownerUserId || dimensionIds.length === 0) return

  const scores = await prisma.score.findMany({
    where: {
      feedbackItem: { batchId: release.batchId },
      userId: { in: userIds },
      dimensionId: { in: dimensionIds },
      isReconciled: false,
    },
    select: {
      id: true,
      feedbackItemId: true,
      userId: true,
      dimensionId: true,
      value: true,
    },
  })

  const groups = new Map<string, typeof scores>()
  for (const score of scores) {
    const key = `${score.feedbackItemId}::${score.dimensionId}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(score)
  }

  const toCreate: {
    feedbackItemId: string
    userId: string
    dimensionId: string
    value: number
    isReconciled: boolean
    reconciledFrom: string
    notes: string
  }[] = []

  for (const [, group] of groups) {
    if (group.length !== 2) continue
    if (group[0].userId === group[1].userId) continue
    if (group[0].value !== group[1].value) continue
    toCreate.push({
      feedbackItemId: group[0].feedbackItemId,
      userId: ownerUserId,
      dimensionId: group[0].dimensionId,
      value: group[0].value,
      isReconciled: true,
      reconciledFrom: `${group[0].id},${group[1].id}`,
      notes: 'Auto-reconciled (scores matched)',
    })
  }

  const CHUNK_SIZE = 100
  for (let i = 0; i < toCreate.length; i += CHUNK_SIZE) {
    const chunk = toCreate.slice(i, i + CHUNK_SIZE)
    await prisma.$transaction(
      chunk.map((data) =>
        prisma.score.upsert({
          where: {
            feedbackItemId_userId_dimensionId_isReconciled: {
              feedbackItemId: data.feedbackItemId,
              userId: data.userId,
              dimensionId: data.dimensionId,
              isReconciled: true,
            },
          },
          update: {
            value: data.value,
            reconciledFrom: data.reconciledFrom,
            notes: data.notes,
            // A row relabeled as auto-reconciled no longer reflects a human
            // decision — clear any stale attribution. (Fable review, 2026-08-11)
            reconciledById: null,
          },
          create: data,
        })
      )
    )
  }
}

export async function maybeAdvanceReleaseAfterScore(
  releaseId: string
): Promise<boolean> {
  const release = await getReleaseContext(releaseId)
  if (!release) return false
  if (release.status !== 'SCORING') return false

  const done = await isReleaseFullyScored(releaseId)
  if (!done) return false

  if (releaseNeedsReconciliation(release)) {
    await prisma.teamBatchRelease.update({
      where: { id: releaseId },
      data: { status: 'RECONCILING' },
    })
    await autoReconcileAgreedScoresForRelease(releaseId)
    // If the pair agreed on everything there are no discrepancies to resolve,
    // so the reconcile/adjudicate routes would never fire and the release would
    // be stranded in RECONCILING forever. Attempt completion now (idempotent;
    // no-ops when real discrepancies remain). (P1)
    await maybeCompleteReleaseReconciliation(releaseId)
  } else {
    await prisma.teamBatchRelease.update({
      where: { id: releaseId },
      data: { status: 'COMPLETE' },
    })
  }

  await syncBatchStatus(release.batchId)
  return true
}

/**
 * Re-settle reconciliation for ONE item×dimension after that annotator revised
 * their individual (raw) score — used by the admin "re-open a criterion" flow.
 * Only the revised item is touched, so every other item's reconciliation
 * (including the pair's manual decisions on other disagreements) is preserved.
 * Only this dimension is touched, so other criteria (e.g. Anchored) are untouched.
 *
 * For the revised item, in this dimension:
 *   - both members now AGREE  → upsert the reconciled final to the agreed value
 *     (replacing any stale prior final — Amber's "if they now agree, drop the old
 *     reconciled value in favor of the new agreement").
 *   - both members now DISAGREE → delete any existing reconciled final for this
 *     item so it re-surfaces as an open discrepancy for the pair to reconcile
 *     again (the item's inputs changed, so a prior decision no longer applies).
 *
 * Then the release status is re-derived across all items: back to RECONCILING if
 * any open discrepancy/escalation remains, or COMPLETE if everything is resolved.
 */
export async function reReconcileReleaseItem(
  releaseId: string,
  feedbackItemId: string,
  dimensionId: string
): Promise<void> {
  const release = await getReleaseContext(releaseId)
  if (!release) return

  const userIds = getExpectedReleaseUserIds(release)
  const ownerUserId = getReleaseOwnerUserId(release)
  const dimensionIds = await getReleaseDimensionIds(release)
  if (userIds.length !== 2 || !ownerUserId) return
  if (!dimensionIds.includes(dimensionId)) return

  const group = await prisma.score.findMany({
    where: { feedbackItemId, dimensionId, userId: { in: userIds }, isReconciled: false },
    select: { id: true, userId: true, value: true },
  })

  if (group.length === 2 && group[0].userId !== group[1].userId) {
    const agree = group[0].value === group[1].value
    if (agree) {
      await prisma.score.upsert({
        where: {
          feedbackItemId_userId_dimensionId_isReconciled: {
            feedbackItemId,
            userId: ownerUserId,
            dimensionId,
            isReconciled: true,
          },
        },
        update: {
          value: group[0].value,
          reconciledFrom: `${group[0].id},${group[1].id}`,
          notes: 'Auto-reconciled (scores matched)',
          // Relabeled auto — clear stale human attribution. (Fable, 2026-08-11)
          reconciledById: null,
        },
        create: {
          feedbackItemId,
          userId: ownerUserId,
          dimensionId,
          value: group[0].value,
          isReconciled: true,
          reconciledFrom: `${group[0].id},${group[1].id}`,
          notes: 'Auto-reconciled (scores matched)',
        },
      })
    } else {
      // Now disagree — remove any stale final so the pair must reconcile again.
      await prisma.score.deleteMany({
        where: { feedbackItemId, userId: ownerUserId, dimensionId, isReconciled: true },
      })
    }
  }

  // Re-derive status. A revision can create new discrepancies on an already
  // COMPLETE release, so we may need to move it back to RECONCILING.
  const hasOpenWork = await releaseHasOpenReconciliation(release, userIds, ownerUserId, dimensionIds)
  if (hasOpenWork) {
    if (release.status !== 'RECONCILING') {
      await prisma.teamBatchRelease.update({
        where: { id: releaseId },
        data: { status: 'RECONCILING' },
      })
      await syncBatchStatus(release.batchId)
    }
  } else if (release.status === 'RECONCILING') {
    await maybeCompleteReleaseReconciliation(releaseId)
  } else if (release.status === 'COMPLETE') {
    // Everything resolved and already COMPLETE — just keep batch status in sync.
    await syncBatchStatus(release.batchId)
  }
}

/**
 * True when the release still has at least one unresolved discrepancy (two
 * members disagree on an item×dimension with no reconciled final) or an open
 * escalation. Derived live from current raw scores.
 */
async function releaseHasOpenReconciliation(
  release: NonNullable<Awaited<ReturnType<typeof getReleaseContext>>>,
  userIds: string[],
  ownerUserId: string,
  dimensionIds: string[]
): Promise<boolean> {
  const rawScores = await prisma.score.findMany({
    where: {
      feedbackItem: { batchId: release.batchId },
      userId: { in: userIds },
      dimensionId: { in: dimensionIds },
      isReconciled: false,
    },
    select: { feedbackItemId: true, dimensionId: true, userId: true, value: true },
  })
  const groups = new Map<string, { userId: string; value: number }[]>()
  for (const s of rawScores) {
    const key = `${s.feedbackItemId}::${s.dimensionId}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push({ userId: s.userId, value: s.value })
  }
  const discrepantKeys = new Set<string>()
  for (const [key, g] of groups) {
    if (g.length === 2 && g[0].userId !== g[1].userId && g[0].value !== g[1].value) {
      discrepantKeys.add(key)
    }
  }
  if (discrepantKeys.size > 0) {
    const reconciled = await prisma.score.findMany({
      where: {
        feedbackItem: { batchId: release.batchId },
        userId: ownerUserId,
        dimensionId: { in: dimensionIds },
        isReconciled: true,
      },
      select: { feedbackItemId: true, dimensionId: true },
    })
    const reconciledKeys = new Set(
      reconciled.map((r) => `${r.feedbackItemId}::${r.dimensionId}`)
    )
    for (const key of discrepantKeys) {
      if (!reconciledKeys.has(key)) return true
    }
  }
  const openEscalations = await prisma.escalation.count({
    where: { teamReleaseId: release.id, resolvedAt: null },
  })
  return openEscalations > 0
}

export async function maybeCompleteReleaseReconciliation(
  releaseId: string
): Promise<boolean> {
  const release = await getReleaseContext(releaseId)
  if (!release) return false
  if (release.status !== 'RECONCILING') return false

  const userIds = getExpectedReleaseUserIds(release)
  const ownerUserId = getReleaseOwnerUserId(release)
  const dimensionIds = await getReleaseDimensionIds(release)
  if (userIds.length !== 2 || !ownerUserId || dimensionIds.length === 0) return false

  const originalScores = await prisma.score.findMany({
    where: {
      feedbackItem: { batchId: release.batchId },
      userId: { in: userIds },
      dimensionId: { in: dimensionIds },
      isReconciled: false,
    },
    select: {
      feedbackItemId: true,
      dimensionId: true,
      userId: true,
      value: true,
    },
  })

  const originalGroups = new Map<string, typeof originalScores>()
  for (const score of originalScores) {
    const key = `${score.feedbackItemId}::${score.dimensionId}`
    if (!originalGroups.has(key)) originalGroups.set(key, [])
    originalGroups.get(key)!.push(score)
  }

  const discrepantKeys = new Set<string>()
  for (const [key, group] of originalGroups) {
    if (group.length !== 2) continue
    if (group[0].userId === group[1].userId) continue
    if (group[0].value !== group[1].value) {
      discrepantKeys.add(key)
    }
  }

  const reconciledScores = await prisma.score.findMany({
    where: {
      feedbackItem: { batchId: release.batchId },
      userId: ownerUserId,
      dimensionId: { in: dimensionIds },
      isReconciled: true,
    },
    select: {
      feedbackItemId: true,
      dimensionId: true,
    },
  })
  const reconciledKeys = new Set(
    reconciledScores.map(
      (score) => `${score.feedbackItemId}::${score.dimensionId}`
    )
  )

  const openEscalations = await prisma.escalation.count({
    where: {
      teamReleaseId: releaseId,
      resolvedAt: null,
    },
  })

  const unresolvedDiscrepancies = Array.from(discrepantKeys).filter(
    (key) => !reconciledKeys.has(key)
  ).length

  if (unresolvedDiscrepancies > 0 || openEscalations > 0) {
    return false
  }

  await prisma.teamBatchRelease.update({
    where: { id: releaseId },
    data: { status: 'COMPLETE' },
  })
  await syncBatchStatus(release.batchId)
  return true
}

/**
 * Counts, for a team release in reconciliation, how many (item × dimension)
 * pairs are genuine discrepancies (two members, different values) and how many
 * of those have since been resolved (an isReconciled row by the release owner).
 *
 * Shared by the evaluator dashboard and the Reconcile hub so the "N to reconcile"
 * math stays in one place. TRAINING batches compare across every project
 * dimension; regular batches only the team's assigned dimensions.
 */
export async function computeReleaseDiscrepancyStats(args: {
  batchId: string
  batchType: string
  projectId: string
  memberUserIds: string[] // ordered by email asc; [0] is the release owner
  teamDimensionIds: string[]
}): Promise<{ discrepancyCount: number; reconciledCount: number }> {
  const { batchId, batchType, projectId, memberUserIds, teamDimensionIds } = args

  const dimensionIds =
    batchType === 'TRAINING'
      ? (
          await prisma.rubricDimension.findMany({
            where: { projectId },
            select: { id: true },
          })
        ).map((d) => d.id)
      : teamDimensionIds

  const ownerUserId = memberUserIds[0]

  const originalScores = await prisma.score.findMany({
    where: {
      feedbackItem: { batchId },
      userId: { in: memberUserIds },
      dimensionId: { in: dimensionIds },
      isReconciled: false,
    },
    select: { feedbackItemId: true, dimensionId: true, value: true, userId: true },
  })

  const groups = new Map<string, { value: number; userId: string }[]>()
  for (const s of originalScores) {
    const key = `${s.feedbackItemId}::${s.dimensionId}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push({ value: s.value, userId: s.userId })
  }

  let discrepancyCount = 0
  const discrepantKeys = new Set<string>()
  for (const [key, values] of groups) {
    if (
      values.length === 2 &&
      values[0].userId !== values[1].userId &&
      values[0].value !== values[1].value
    ) {
      discrepancyCount++
      discrepantKeys.add(key)
    }
  }

  let reconciledCount = 0
  if (ownerUserId) {
    const reconciledScores = await prisma.score.findMany({
      where: {
        feedbackItem: { batchId },
        userId: ownerUserId,
        dimensionId: { in: dimensionIds },
        isReconciled: true,
      },
      select: { feedbackItemId: true, dimensionId: true },
    })
    reconciledCount = reconciledScores.filter((r) =>
      discrepantKeys.has(`${r.feedbackItemId}::${r.dimensionId}`)
    ).length
  }

  return { discrepancyCount, reconciledCount }
}
