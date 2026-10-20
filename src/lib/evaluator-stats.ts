import { prisma } from '@/lib/db'
import {
  getExpectedReleaseDimensionIds,
  getReleaseUserSlotIndex,
  isSlotSplitRelease,
} from '@/lib/team-batch-releases'

// ---------------------------------------------------------------------------
// Shared helpers for slot-aware item counting
// ---------------------------------------------------------------------------

// Minimal shape needed from a BatchAssignment to compute slot context. The
// caller is responsible for fetching teamRelease.team.members + the batch's
// {id, isDoubleScored, type}.
export interface BatchAssignmentForStats {
  userId: string
  // This row's persisted slot (BatchAssignment.slotIndex). Optional so hand-built
  // fixtures keep working; null/absent falls back to the email-asc rule.
  slotIndex?: number | null
  teamRelease: {
    id: string
    scorerUserId: string | null
    team: { members: { userId: string }[] }
  } | null
  batch: {
    id: string
    isDoubleScored: boolean
    type: string
  }
}

// Superset of BatchAssignmentForStats carrying what "which criteria must this
// user score on this batch" depends on: the team's dimensions (REGULAR
// releases) and the batch's project (TRAINING releases and teamless
// assignments score the whole rubric).
export interface BatchAssignmentForScoredStats {
  userId: string
  slotIndex?: number | null
  teamRelease: {
    id: string
    scorerUserId: string | null
    team: {
      members: { userId: string }[]
      dimensions: { dimensionId: string }[]
    }
  } | null
  batch: {
    id: string
    projectId: string
    isDoubleScored: boolean
    type: string
  }
}

// batchId → slotIndex → count
export type SlotCountMap = Map<string, Map<number | null, number>>

export interface StatsMaps {
  itemCountByBatchSlot: SlotCountMap
  // userId → batchId → slotIndex → items that user has scored on EVERY
  // criterion they owe on that batch. Feed into countForAssignment exactly
  // like itemCountByBatchSlot.
  scoredCountByUser: Map<string, SlotCountMap>
}

export interface ItemForStats {
  id: string
  batchId: string | null
  slotIndex: number | null
}

export interface RawScoreForStats {
  feedbackItemId: string
  userId: string
  dimensionId: string
}

/**
 * Which criteria `ba.userId` is expected to score on every item of this batch.
 * Delegates to the same rule the release lifecycle uses
 * (getExpectedReleaseDimensionIds): the team's criteria on a REGULAR release,
 * every project criterion on TRAINING. A teamless (legacy) assignment has no
 * team to narrow the rubric, so it is the whole rubric too.
 */
export function expectedDimensionIdsForAssignment(
  ba: BatchAssignmentForScoredStats,
  projectDimensionIds: string[]
): string[] {
  if (!ba.teamRelease) return projectDimensionIds
  return getExpectedReleaseDimensionIds(
    {
      id: ba.teamRelease.id,
      scorerUserId: ba.teamRelease.scorerUserId,
      batch: ba.batch,
      team: ba.teamRelease.team,
    },
    projectDimensionIds
  )
}

export function buildItemCountMap(items: ItemForStats[]): SlotCountMap {
  const map: SlotCountMap = new Map()
  for (const item of items) {
    if (item.batchId === null) continue
    let bySlot = map.get(item.batchId)
    if (!bySlot) {
      bySlot = new Map()
      map.set(item.batchId, bySlot)
    }
    bySlot.set(item.slotIndex, (bySlot.get(item.slotIndex) ?? 0) + 1)
  }
  return map
}

/**
 * Pure core of the scored-item count. An item counts as scored by a user only
 * when that user has a raw score for EVERY criterion they are expected to score
 * on that batch — one of two criteria saved is not "scored" (Batch 65 / F4287,
 * Amber 2026-10-19). Raw scores on criteria outside the expectation are
 * ignored, and an assignment that expects no criteria never counts anything
 * (matching isReleaseFullyScored, which treats such a release as never done).
 */
export function buildScoredCountMaps(
  assignments: BatchAssignmentForScoredStats[],
  projectDimensionIdsByProject: Map<string, string[]>,
  items: ItemForStats[],
  scores: RawScoreForStats[]
): Map<string, SlotCountMap> {
  const expectedByBatchUser = new Map<string, Set<string>>()
  for (const ba of assignments) {
    const dims = expectedDimensionIdsForAssignment(
      ba,
      projectDimensionIdsByProject.get(ba.batch.projectId) ?? []
    )
    expectedByBatchUser.set(`${ba.batch.id}::${ba.userId}`, new Set(dims))
  }

  const itemsById = new Map(items.map((item) => [item.id, item]))

  // (batchId, userId, itemId) → the expected criteria this user has scored.
  const scoredDims = new Map<
    string,
    { batchId: string; userId: string; slotIndex: number | null; dims: Set<string> }
  >()
  for (const score of scores) {
    const item = itemsById.get(score.feedbackItemId)
    if (!item || item.batchId === null) continue
    const expected = expectedByBatchUser.get(`${item.batchId}::${score.userId}`)
    if (!expected || !expected.has(score.dimensionId)) continue
    const key = `${item.batchId}::${score.userId}::${item.id}`
    let entry = scoredDims.get(key)
    if (!entry) {
      entry = { batchId: item.batchId, userId: score.userId, slotIndex: item.slotIndex, dims: new Set() }
      scoredDims.set(key, entry)
    }
    entry.dims.add(score.dimensionId)
  }

  const result = new Map<string, SlotCountMap>()
  for (const entry of scoredDims.values()) {
    const expected = expectedByBatchUser.get(`${entry.batchId}::${entry.userId}`)!
    if (expected.size === 0 || entry.dims.size < expected.size) continue
    let byBatch = result.get(entry.userId)
    if (!byBatch) {
      byBatch = new Map()
      result.set(entry.userId, byBatch)
    }
    let bySlot = byBatch.get(entry.batchId)
    if (!bySlot) {
      bySlot = new Map()
      byBatch.set(entry.batchId, bySlot)
    }
    bySlot.set(entry.slotIndex, (bySlot.get(entry.slotIndex) ?? 0) + 1)
  }
  return result
}

/**
 * Bulk-load item counts and fully-scored item counts for every (user, batch)
 * in `assignments`, keyed by (batchId, slotIndex). Three queries regardless of
 * how many users or batches are involved: the project rubrics (for TRAINING /
 * teamless expectations), the batches' items, and the raw scores those users
 * have on them. Scalar selects only — a nested relation select on the score
 * rows doubled the project-wide (admin) load time.
 */
export async function loadSlotMaps(
  assignments: BatchAssignmentForScoredStats[]
): Promise<StatsMaps> {
  if (assignments.length === 0) {
    return { itemCountByBatchSlot: new Map(), scoredCountByUser: new Map() }
  }

  const batchIds = Array.from(new Set(assignments.map((ba) => ba.batch.id)))
  const userIds = Array.from(new Set(assignments.map((ba) => ba.userId)))
  const projectIds = Array.from(new Set(assignments.map((ba) => ba.batch.projectId)))

  const [dimensions, items, scores] = await Promise.all([
    prisma.rubricDimension.findMany({
      where: { projectId: { in: projectIds } },
      select: { id: true, projectId: true },
    }),
    prisma.feedbackItem.findMany({
      where: { batchId: { in: batchIds } },
      select: { id: true, batchId: true, slotIndex: true },
    }),
    prisma.score.findMany({
      where: {
        feedbackItem: { batchId: { in: batchIds } },
        userId: { in: userIds },
        isReconciled: false,
      },
      select: { feedbackItemId: true, userId: true, dimensionId: true },
    }),
  ])

  const projectDimensionIdsByProject = new Map<string, string[]>()
  for (const dimension of dimensions) {
    const list = projectDimensionIdsByProject.get(dimension.projectId) ?? []
    list.push(dimension.id)
    projectDimensionIdsByProject.set(dimension.projectId, list)
  }

  return {
    itemCountByBatchSlot: buildItemCountMap(items),
    scoredCountByUser: buildScoredCountMaps(assignments, projectDimensionIdsByProject, items, scores),
  }
}

// Look up the slot-adjusted count for a single (assignment, slotMap) pair.
// Used inside loops where the caller already has the assignment in hand.
export function countForAssignment(
  ba: BatchAssignmentForStats,
  forUserId: string,
  slotMap: SlotCountMap
): number {
  const releaseContext = ba.teamRelease
    ? {
        id: ba.teamRelease.id,
        // Honor a single named scorer: such a release is NOT slot-split, so the
        // scorer is counted for ALL items, not half (P7 — was hardcoded null).
        scorerUserId: ba.teamRelease.scorerUserId,
        batch: ba.batch,
        team: { members: ba.teamRelease.team.members },
        // The persisted slot on this very row wins over the email-asc rule.
        assignments: [{ userId: ba.userId, slotIndex: ba.slotIndex ?? null }],
      }
    : null
  const slotSplit = releaseContext ? isSlotSplitRelease(releaseContext) : false
  const userSlot =
    releaseContext && slotSplit ? getReleaseUserSlotIndex(releaseContext, forUserId) : null

  const slots = slotMap.get(ba.batch.id)
  if (!slots) return 0
  if (slotSplit && userSlot !== null) {
    return slots.get(userSlot) ?? 0
  }
  let total = 0
  for (const c of slots.values()) total += c
  return total
}
