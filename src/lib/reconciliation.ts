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
