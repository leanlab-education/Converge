import { prisma } from '@/lib/db'
import {
  type DbClient,
  getExpectedReleaseDimensionIds,
  getExpectedReleaseUserIds,
  getExpectedScoresPerItemPerDimension,
  getReleaseOwnerUserId,
  releaseNeedsReconciliation,
  syncBatchStatus,
} from '@/lib/team-batch-releases'

async function getReleaseContext(releaseId: string, db: DbClient = prisma) {
  return db.teamBatchRelease.findUnique({
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

type ReleaseContext = NonNullable<Awaited<ReturnType<typeof getReleaseContext>>>

async function getReleaseDimensionIds(
  release: ReleaseContext,
  db: DbClient = prisma
) {
  const projectDimensionIds =
    release.batch.type === 'TRAINING'
      ? (
          await db.rubricDimension.findMany({
            where: { projectId: release.batch.projectId },
            select: { id: true },
          })
        ).map((dimension) => dimension.id)
      : []

  return getExpectedReleaseDimensionIds(release, projectDimensionIds)
}

/**
 * True when every raw score the release expects exists: items × expected
 * criteria × scores per cell (1 for an independent split, 2 for a pair, every
 * member for training). The core of `isReleaseFullyScored`, without the
 * visibility requirement, so completion can use the same truth.
 */
async function hasEveryExpectedRawScore(
  release: ReleaseContext,
  db: DbClient = prisma
): Promise<boolean> {
  const userIds = getExpectedReleaseUserIds(release)
  const dimensionIds = await getReleaseDimensionIds(release, db)
  if (userIds.length === 0 || dimensionIds.length === 0) return false

  const itemCount = await db.feedbackItem.count({
    where: { batchId: release.batchId },
  })
  if (itemCount === 0) return false

  const scoresPerItemPerDim = getExpectedScoresPerItemPerDimension(release)
  const expectedCount = itemCount * dimensionIds.length * scoresPerItemPerDim
  const actualCount = await db.score.count({
    where: {
      feedbackItem: { batchId: release.batchId },
      userId: { in: userIds },
      dimensionId: { in: dimensionIds },
      isReconciled: false,
    },
  })

  return actualCount >= expectedCount
}

export async function isReleaseFullyScored(releaseId: string): Promise<boolean> {
  const release = await getReleaseContext(releaseId)
  if (!release) return false
  if (!release.isVisible) return false
  return hasEveryExpectedRawScore(release)
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
 * Re-run the SCORING → RECONCILING / COMPLETE check for a release that may have
 * been stranded.
 *
 * The scores route runs `maybeAdvanceReleaseAfterScore` after every save but
 * deliberately swallows its failure, so a transient DB error can't fail the save
 * itself. The cost is that when the failure hits the LAST save, nothing ever
 * re-runs the check: a 100%-scored release sits in SCORING with both partners
 * shown "Waiting on partner" indefinitely. This is the repair hook. It is
 * idempotent and no-ops unless the release is SCORING, visible and fully
 * scored, so callers can run it on every candidate they see. It never throws:
 * it is run from a page render, where a failed repair must not take the page
 * down with it — the next visit simply retries.
 *
 * @returns true when the release advanced out of SCORING.
 */
export async function healStrandedRelease(releaseId: string): Promise<boolean> {
  try {
    return await maybeAdvanceReleaseAfterScore(releaseId)
  } catch (err) {
    console.error(`healStrandedRelease(${releaseId}) failed:`, err)
    return false
  }
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
 *   - either way, any Escalation on the cell is removed (see inline comment).
 *
 * Then the release status is re-derived across all items: a COMPLETE release
 * moves back to RECONCILING if any open discrepancy/escalation remains, and a
 * RECONCILING release completes if everything is resolved.
 *
 * Pass the `tx` of an interactive transaction as `db` to run the whole
 * re-derivation atomically with the raw-score write that triggered it.
 */
export async function reReconcileReleaseItem(
  releaseId: string,
  feedbackItemId: string,
  dimensionId: string,
  db: DbClient = prisma
): Promise<void> {
  const release = await getReleaseContext(releaseId, db)
  if (!release) return

  const userIds = getExpectedReleaseUserIds(release)
  const ownerUserId = getReleaseOwnerUserId(release)
  const dimensionIds = await getReleaseDimensionIds(release, db)
  if (userIds.length !== 2 || !ownerUserId) return
  if (!dimensionIds.includes(dimensionId)) return

  const group = await db.score.findMany({
    where: { feedbackItemId, dimensionId, userId: { in: userIds }, isReconciled: false },
    select: { id: true, userId: true, value: true },
  })

  if (group.length === 2 && group[0].userId !== group[1].userId) {
    // An escalation on this cell — open OR already adjudicated — was a ruling
    // on the OLD pair of values, so it is void once a raw score changes. Left in
    // place it strands the cell: a RESOLVED row makes every reader treat the
    // cell as "set by the adjudicator" (the discrepancies route reports
    // adjudication != null, so the hub renders the locked panel with no value;
    // the reconcile route refuses the key; re-escalating hits the unique
    // constraint → 409; withdraw → 400 "resolved"; the adjudicator's queue
    // lists only resolvedAt:null) and maybeCompleteReleaseReconciliation can
    // never finish. An OPEN one would have the adjudicator rule on values that
    // no longer exist. Deleting it returns the cell to an ordinary open
    // discrepancy (disagree) or an auto-reconciled agreement (agree); the pair
    // can re-escalate if they still can't settle it.
    await db.escalation.deleteMany({
      where: { teamReleaseId: releaseId, feedbackItemId, dimensionId },
    })

    const agree = group[0].value === group[1].value
    if (agree) {
      await db.score.upsert({
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
      await db.score.deleteMany({
        where: { feedbackItemId, userId: ownerUserId, dimensionId, isReconciled: true },
      })
    }
  }

  // Re-derive status. A revision can create new discrepancies on an already
  // COMPLETE release, so we may need to move it back to RECONCILING.
  const hasOpenWork = await releaseHasOpenReconciliation(
    release,
    userIds,
    ownerUserId,
    dimensionIds,
    db
  )
  if (hasOpenWork) {
    // Only a COMPLETE release moves back. A RECONCILING one is already there.
    // A SCORING release must never be promoted from here: scoring is not
    // finished (the partner may still owe items), and the scores route only
    // accepts writes while SCORING, so promoting it would 403 the partner's
    // remaining scoring and leave the release with items nobody can score.
    // maybeAdvanceReleaseAfterScore owns SCORING → RECONCILING.
    if (release.status === 'COMPLETE') {
      await db.teamBatchRelease.update({
        where: { id: releaseId },
        data: { status: 'RECONCILING' },
      })
      await syncBatchStatus(release.batchId, db)
    }
  } else if (release.status === 'RECONCILING') {
    await maybeCompleteReleaseReconciliation(releaseId, db)
  } else if (release.status === 'COMPLETE') {
    // Everything resolved and already COMPLETE — just keep batch status in sync.
    await syncBatchStatus(release.batchId, db)
  }
}

/**
 * True when the release still has at least one unresolved discrepancy (two
 * members disagree on an item×dimension with no reconciled final) or an open
 * escalation. Derived live from current raw scores.
 */
async function releaseHasOpenReconciliation(
  release: ReleaseContext,
  userIds: string[],
  ownerUserId: string,
  dimensionIds: string[],
  db: DbClient = prisma
): Promise<boolean> {
  const rawScores = await db.score.findMany({
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
    const reconciled = await db.score.findMany({
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
  const openEscalations = await db.escalation.count({
    where: { teamReleaseId: release.id, resolvedAt: null },
  })
  return openEscalations > 0
}

export async function maybeCompleteReleaseReconciliation(
  releaseId: string,
  db: DbClient = prisma
): Promise<boolean> {
  const release = await getReleaseContext(releaseId, db)
  if (!release) return false
  if (release.status !== 'RECONCILING') return false

  const userIds = getExpectedReleaseUserIds(release)
  const ownerUserId = getReleaseOwnerUserId(release)
  const dimensionIds = await getReleaseDimensionIds(release, db)
  if (userIds.length !== 2 || !ownerUserId || dimensionIds.length === 0) return false

  // Reconciliation cannot be finished unless scoring was. A release normally
  // enters RECONCILING only once every expected raw score exists, but it can
  // also be put there by paths that don't re-check that (legacy re-open flows
  // promoted a half-scored SCORING release), and "no unresolved discrepancies"
  // is trivially true for cells the partner never scored. Without this gate a
  // release could reach COMPLETE — and the batch be exported as finalized —
  // with items one annotator never saw.
  if (!(await hasEveryExpectedRawScore(release, db))) return false

  const originalScores = await db.score.findMany({
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

  const reconciledScores = await db.score.findMany({
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

  const openEscalations = await db.escalation.count({
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

  await db.teamBatchRelease.update({
    where: { id: releaseId },
    data: { status: 'COMPLETE' },
  })
  await syncBatchStatus(release.batchId, db)
  return true
}

/**
 * Whether a release belongs on an annotator's "Reconcile" task list. Pure, so
 * the project page's rule is testable.
 *
 *   - RECONCILING: listed — except when there is nothing to reconcile yet
 *     (every discrepancy already has a final) AND an admin has a criterion
 *     re-opened on the release. That state is the re-open flow itself: the
 *     release was moved to RECONCILING so the hub is reachable while the pair
 *     revises, but until a revision creates a new disagreement a "Reconcile"
 *     entry would only lead to an empty hub ("You have 1 to reconcile" with
 *     nothing in it). The Revise task already represents that work.
 *   - COMPLETE: listed as "Review / Edit" only if it ever had discrepancies —
 *     a fully-agreed release has nothing to revisit.
 *   - anything else: not listed.
 */
export function shouldListReconcileTask(task: {
  status: string
  discrepancyCount: number
  reconciledCount: number
  hasOpenUnlock: boolean
}): boolean {
  if (task.status === 'COMPLETE') return task.discrepancyCount > 0
  if (task.status !== 'RECONCILING') return false
  const nothingUnresolved = task.discrepancyCount <= task.reconciledCount
  return !(nothingUnresolved && task.hasOpenUnlock)
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
