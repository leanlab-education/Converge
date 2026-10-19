import { prisma } from '@/lib/db'
import {
  getExpectedReleaseDimensionIds,
  getReleaseItemScope,
  getReleaseUserSlotIndex,
  isSlotSplitRelease,
  type ReleaseItemScope,
} from '@/lib/team-batch-releases'

// ---------------------------------------------------------------------------
// Shared helpers for slot-aware item counting
// ---------------------------------------------------------------------------

// Minimal shape needed from a BatchAssignment to compute slot context. The
// caller is responsible for fetching teamRelease.team.members + the batch's
// {id, isDoubleScored, type}.
export interface BatchAssignmentForStats {
  userId: string
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

// ---------------------------------------------------------------------------
// Expected-scorer predicate and project-level "fully scored" items
// ---------------------------------------------------------------------------

interface Expectation {
  /** Criteria this user owes on this batch. */
  expected: Set<string>
  /** Which of the batch's items they owe them on. */
  scope: ReleaseItemScope
}

function assignmentScope(ba: BatchAssignmentForScoredStats): ReleaseItemScope {
  if (!ba.teamRelease) return { mode: 'all' }
  return getReleaseItemScope(
    {
      id: ba.teamRelease.id,
      scorerUserId: ba.teamRelease.scorerUserId,
      batch: ba.batch,
      team: ba.teamRelease.team,
    },
    ba.userId
  )
}

function itemInScope(item: ItemForStats, scope: ReleaseItemScope): boolean {
  if (scope.mode === 'all') return true
  if (scope.mode === 'slot') return item.slotIndex === scope.slotIndex
  return false
}

// (batchId, userId) → what that user owes on that batch.
function indexExpectations(
  assignments: BatchAssignmentForScoredStats[],
  projectDimensionIdsByProject: Map<string, string[]>
): Map<string, Expectation> {
  const index = new Map<string, Expectation>()
  for (const ba of assignments) {
    index.set(`${ba.batch.id}::${ba.userId}`, {
      expected: new Set(
        expectedDimensionIdsForAssignment(
          ba,
          projectDimensionIdsByProject.get(ba.batch.projectId) ?? []
        )
      ),
      scope: assignmentScope(ba),
    })
  }
  return index
}

/**
 * Predicate: is this raw score one an *expected* scorer owed? True only when the
 * scorer is assigned to the item's batch, the criterion is one they owe there,
 * and the item is inside their scope (every item, or just their slot half on an
 * independent batch). Anything else — an admin's stray score, a partner scoring
 * outside their slot, a criterion another team owns — is not a candidate for
 * "the" score of that cell. Shared by the Overview count and the export's
 * independent-batch finals so the two can't disagree about what counts.
 */
export function createExpectedScoreFilter(
  assignments: BatchAssignmentForScoredStats[],
  projectDimensionIdsByProject: Map<string, string[]>,
  items: ItemForStats[]
): (score: RawScoreForStats) => boolean {
  const expectations = indexExpectations(assignments, projectDimensionIdsByProject)
  const itemsById = new Map(items.map((item) => [item.id, item]))
  return (score) => {
    const item = itemsById.get(score.feedbackItemId)
    if (!item || item.batchId === null) return false
    const expectation = expectations.get(`${item.batchId}::${score.userId}`)
    return (
      expectation !== undefined &&
      expectation.expected.has(score.dimensionId) &&
      itemInScope(item, expectation.scope)
    )
  }
}

/**
 * Items where EVERY owed criterion has a raw score from at least one expected
 * scorer. "Owed" is the union, over every assignment on the item's batch whose
 * scope includes the item, of that assignment's expected criteria — so an item
 * in a two-team regular batch is owed both teams' criteria, and one where only
 * one team has scored is not done. An item in a batch with no assignments owes
 * nothing and is never counted. This is the Overview's "Scored" figure; it
 * replaces the old "has any raw score" proxy, under which 1 of 8 criteria read
 * as scored.
 */
export function buildFullyScoredItemIds(
  assignments: BatchAssignmentForScoredStats[],
  projectDimensionIdsByProject: Map<string, string[]>,
  items: ItemForStats[],
  scores: RawScoreForStats[]
): Set<string> {
  const expectations = indexExpectations(assignments, projectDimensionIdsByProject)
  const isExpected = createExpectedScoreFilter(assignments, projectDimensionIdsByProject, items)

  const assignmentsByBatch = new Map<string, BatchAssignmentForScoredStats[]>()
  for (const ba of assignments) {
    const list = assignmentsByBatch.get(ba.batch.id) ?? []
    list.push(ba)
    assignmentsByBatch.set(ba.batch.id, list)
  }

  // (itemId, userId) → expected criteria that user has actually scored.
  const scoredDims = new Map<string, Set<string>>()
  for (const score of scores) {
    if (!isExpected(score)) continue
    const key = `${score.feedbackItemId}::${score.userId}`
    let dims = scoredDims.get(key)
    if (!dims) {
      dims = new Set()
      scoredDims.set(key, dims)
    }
    dims.add(score.dimensionId)
  }

  const fullyScored = new Set<string>()
  for (const item of items) {
    if (item.batchId === null) continue
    const batchAssignments = assignmentsByBatch.get(item.batchId)
    if (!batchAssignments) continue
    const owed = new Set<string>()
    const covered = new Set<string>()
    for (const ba of batchAssignments) {
      const expectation = expectations.get(`${item.batchId}::${ba.userId}`)!
      if (!itemInScope(item, expectation.scope)) continue
      const scored = scoredDims.get(`${item.id}::${ba.userId}`)
      for (const dimensionId of expectation.expected) {
        owed.add(dimensionId)
        if (scored?.has(dimensionId)) covered.add(dimensionId)
      }
    }
    if (owed.size > 0 && covered.size === owed.size) fullyScored.add(item.id)
  }
  return fullyScored
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

interface StatsInputs {
  projectDimensionIdsByProject: Map<string, string[]>
  items: ItemForStats[]
  scores: RawScoreForStats[]
}

/**
 * The three queries every stats computation needs for a set of assignments:
 * the project rubrics (for TRAINING / teamless expectations), the batches'
 * items, and the raw scores those users have on them. Scalar selects only — a
 * nested relation select on the score rows doubled the project-wide (admin)
 * load time.
 */
async function loadStatsInputs(
  assignments: BatchAssignmentForScoredStats[]
): Promise<StatsInputs> {
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

  return { projectDimensionIdsByProject, items, scores }
}

/**
 * Bulk-load item counts and fully-scored item counts for every (user, batch)
 * in `assignments`, keyed by (batchId, slotIndex). Three queries regardless of
 * how many users or batches are involved.
 */
export async function loadSlotMaps(
  assignments: BatchAssignmentForScoredStats[]
): Promise<StatsMaps> {
  if (assignments.length === 0) {
    return { itemCountByBatchSlot: new Map(), scoredCountByUser: new Map() }
  }

  const { projectDimensionIdsByProject, items, scores } = await loadStatsInputs(assignments)

  return {
    itemCountByBatchSlot: buildItemCountMap(items),
    scoredCountByUser: buildScoredCountMaps(assignments, projectDimensionIdsByProject, items, scores),
  }
}

// What an annotator can see of a batch assignment. Mirrors the where-clause the
// annotator project page (src/app/projects/[projectId]/page.tsx) and the
// feedback-items route apply: hidden batches and unreleased (DRAFT, invisible)
// team releases are not work the annotator can do yet, so the admin's
// Assigned/Completed figures for them must leave those out too — otherwise a
// finished annotator reads as 100/300 and trips the low-progress warning.
export interface AssignmentVisibility {
  teamRelease: { isVisible: boolean } | null
  batch: { isHidden: boolean }
}

export function isVisibleToAnnotator(ba: AssignmentVisibility): boolean {
  return !ba.batch.isHidden && (ba.teamRelease === null || ba.teamRelease.isVisible)
}

export interface AnnotatorProgress {
  /** Items in this user's share of the batches they can see. */
  assignedCount: number
  /** Of those, items they have scored on every criterion they owe. */
  completedCount: number
}

export interface AdminProjectStats {
  /** Items where every owed criterion has a raw score from an expected scorer. */
  fullyScoredItemCount: number
  /** Per-user Assigned/Completed over annotator-visible assignments only. */
  progressByUser: Map<string, AnnotatorProgress>
}

/**
 * One loader for every admin surface that reports scoring progress — the
 * project page (Overview + Annotators tab), the evaluators route, and the stats
 * route — so the figures cannot drift between them. Loads every batch
 * assignment in the project once: the Overview count needs them all (what is
 * owed includes unreleased teams), while the per-annotator figures use only
 * the ones the annotator can see.
 */
export async function loadAdminProjectStats(projectId: string): Promise<AdminProjectStats> {
  const assignments = await prisma.batchAssignment.findMany({
    where: { batch: { projectId } },
    select: {
      userId: true,
      teamRelease: {
        select: {
          id: true,
          scorerUserId: true,
          isVisible: true,
          team: {
            select: {
              members: {
                select: { userId: true },
                orderBy: { user: { email: 'asc' } },
              },
              dimensions: { select: { dimensionId: true } },
            },
          },
        },
      },
      batch: {
        select: { id: true, projectId: true, isDoubleScored: true, type: true, isHidden: true },
      },
    },
  })

  if (assignments.length === 0) {
    return { fullyScoredItemCount: 0, progressByUser: new Map() }
  }

  const { projectDimensionIdsByProject, items, scores } = await loadStatsInputs(assignments)
  const itemCountByBatchSlot = buildItemCountMap(items)
  const scoredCountByUser = buildScoredCountMaps(
    assignments,
    projectDimensionIdsByProject,
    items,
    scores
  )

  const progressByUser = new Map<string, AnnotatorProgress>()
  for (const ba of assignments) {
    if (!isVisibleToAnnotator(ba)) continue
    const entry = progressByUser.get(ba.userId) ?? { assignedCount: 0, completedCount: 0 }
    entry.assignedCount += countForAssignment(ba, ba.userId, itemCountByBatchSlot)
    entry.completedCount += countForAssignment(
      ba,
      ba.userId,
      scoredCountByUser.get(ba.userId) ?? new Map()
    )
    progressByUser.set(ba.userId, entry)
  }

  return {
    fullyScoredItemCount: buildFullyScoredItemIds(
      assignments,
      projectDimensionIdsByProject,
      items,
      scores
    ).size,
    progressByUser,
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
