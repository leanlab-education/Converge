// Data access for the export routes. Pure row/CSV shaping lives in
// `@/lib/export`; this module owns the Prisma queries and scope rules so the
// download route and the row-count route can never drift apart.

import { prisma } from '@/lib/db'
import type { Prisma } from '@/generated/prisma/client'
import {
  buildDiscrepancyRows,
  buildItemGrainRows,
  buildScorerGrainRows,
  discrepancyCells,
  discrepancyHeader,
  hasFullScoreSet,
  isItemGrain,
  itemGrainCells,
  itemGrainHeader,
  scorerGrainCells,
  scorerGrainHeader,
  scoringRoleLabel,
  usesFinalScores,
  type ExportKind,
  type ItemGrainConflict,
} from '@/lib/export'
import {
  createExpectedScoreFilter,
  type RawScoreForStats,
} from '@/lib/evaluator-stats'

export interface ExportScope {
  projectId: string
  activityId: string | null
  conjunctionId: string | null
  completeItemsOnly: boolean
  finalizedBatchesOnly: boolean
}

export function parseExportScope(
  params: URLSearchParams,
  projectId: string
): ExportScope {
  return {
    projectId,
    activityId: params.get('activityId'),
    conjunctionId: params.get('conjunctionId'),
    completeItemsOnly: params.get('completeItemsOnly') === '1',
    finalizedBatchesOnly: params.get('finalizedBatchesOnly') === '1',
  }
}

export async function getProjectDimensions(projectId: string) {
  const dimensions = await prisma.rubricDimension.findMany({
    where: { projectId },
    orderBy: { sortOrder: 'asc' },
  })
  return {
    dimensionKeys: dimensions.map((d) => d.key),
    dimensionLabels: dimensions.map((d) => d.label),
  }
}

// ---------------------------------------------------------------------------
// Scope predicates
// ---------------------------------------------------------------------------

/** Activity/conjunction filters — shared by every export kind. */
function itemFilterWhere(scope: ExportScope): Prisma.FeedbackItemWhereInput {
  return {
    projectId: scope.projectId,
    ...(scope.activityId ? { activityId: scope.activityId } : {}),
    ...(scope.conjunctionId ? { conjunctionId: scope.conjunctionId } : {}),
  }
}

/**
 * Which items are in scope for the collapsed (item-grain) export.
 *
 *   - REGULAR batches only. In a TRAINING batch every team scores every
 *     criterion, so an item legitimately holds one final value per team and
 *     cannot collapse to a single row. Training data stays fully available in
 *     both scorer-grain exports.
 *   - Released batches only (assigned to a batch, status ≠ DRAFT). Unreleased
 *     items are not part of the annotation run yet.
 *   - Optionally, only fully finalized batches: Batch.status is COMPLETE
 *     exactly when every team release completed — everyone scored, every
 *     discrepancy reconciled, every escalation adjudicated.
 */
function itemGrainWhere(scope: ExportScope): Prisma.FeedbackItemWhereInput {
  return {
    ...itemFilterWhere(scope),
    batch: {
      is: {
        type: 'REGULAR',
        ...(scope.finalizedBatchesOnly
          ? { status: 'COMPLETE' }
          : { status: { not: 'DRAFT' } }),
      },
    },
  }
}

/** Batches whose raw scores stand in as finals (they never reconcile). */
const INDEPENDENT_BATCH_WHERE: Prisma.BatchWhereInput = {
  type: 'REGULAR',
  isDoubleScored: false,
}

/**
 * Score selector.
 *
 * "final" = the final value per item: the reconciled/adjudicated row for
 * double-scored & training batches, plus the raw score for single-scored
 * regular batches (which never reconcile). "raw" = every score as entered.
 *
 * The raw half of "final" is only a *candidate* set: the database cannot say
 * which raw score on an independent batch is the expected scorer's, so the
 * caller must run `loadIndependentFinalFilter` over the result.
 */
function scoreSelectorWhere(kind: ExportKind): Prisma.ScoreWhereInput {
  if (kind === 'raw-by-scorer') return { isReconciled: false }
  return {
    OR: [
      { isReconciled: true },
      {
        isReconciled: false,
        feedbackItem: { batch: INDEPENDENT_BATCH_WHERE },
      },
    ],
  }
}

/**
 * On an independent (non-double-scored REGULAR) batch there is no reconciled
 * row, so a raw score is "the" final — but only the one written by the scorer
 * the release expects for that item: the team member whose slot the item is in
 * (or the single named scorer), on a criterion their team owns. Any other raw
 * row on such an item — an admin trying the scoring UI, a partner scoring
 * outside their slot — is not a final and must not leak into the export; before
 * this filter whichever row the database returned last won.
 *
 * Built from the batches' assignments, items and the project rubric via the
 * same predicate the Overview count uses (createExpectedScoreFilter).
 */
async function loadIndependentFinalFilter(
  scope: ExportScope
): Promise<(score: RawScoreForStats) => boolean> {
  const batchWhere: Prisma.BatchWhereInput = {
    projectId: scope.projectId,
    ...INDEPENDENT_BATCH_WHERE,
  }
  const [assignments, items, dimensions] = await Promise.all([
    prisma.batchAssignment.findMany({
      where: { batch: batchWhere },
      select: {
        userId: true,
        teamRelease: {
          select: {
            id: true,
            scorerUserId: true,
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
        batch: { select: { id: true, projectId: true, isDoubleScored: true, type: true } },
      },
    }),
    prisma.feedbackItem.findMany({
      where: { ...itemFilterWhere(scope), batch: { is: batchWhere } },
      select: { id: true, batchId: true, slotIndex: true },
    }),
    prisma.rubricDimension.findMany({
      where: { projectId: scope.projectId },
      select: { id: true },
    }),
  ])
  return createExpectedScoreFilter(
    assignments,
    new Map([[scope.projectId, dimensions.map((d) => d.id)]]),
    items
  )
}

interface FinalCandidate extends RawScoreForStats {
  isReconciled: boolean
}

/** Reconciled rows always qualify; raw rows only from the expected scorer. */
function keepFinals<T extends FinalCandidate>(
  scores: T[],
  isExpectedRaw: (score: RawScoreForStats) => boolean
): T[] {
  return scores.filter((score) => score.isReconciled || isExpectedRaw(score))
}

// ---------------------------------------------------------------------------
// Scorer-grain (raw-by-scorer / final-by-scorer)
// ---------------------------------------------------------------------------

async function loadScorerLookups(projectId: string) {
  const [teamMemberships, batchAssignments] = await Promise.all([
    prisma.evaluatorTeamMember.findMany({
      where: { team: { projectId } },
      include: { team: { select: { name: true } } },
    }),
    prisma.batchAssignment.findMany({
      where: { batch: { projectId } },
      select: {
        batchId: true,
        userId: true,
        scoringRole: true,
        batch: { select: { type: true, isDoubleScored: true } },
        teamRelease: {
          select: {
            team: {
              select: {
                members: {
                  select: { userId: true },
                  orderBy: { user: { email: 'asc' } },
                },
              },
            },
          },
        },
      },
    }),
  ])

  const teamByUserId = new Map<string, string>()
  for (const tm of teamMemberships) teamByUserId.set(tm.userId, tm.team.name)

  const roleByBatchUser = new Map<string, string>()
  for (const ba of batchAssignments) {
    const memberIndex = ba.teamRelease
      ? ba.teamRelease.team.members.findIndex((m) => m.userId === ba.userId)
      : null
    roleByBatchUser.set(
      `${ba.batchId}::${ba.userId}`,
      scoringRoleLabel({
        scoringRole: ba.scoringRole,
        isPaired: ba.batch.type === 'TRAINING' || ba.batch.isDoubleScored,
        memberIndex,
      })
    )
  }

  return { teamByUserId, roleByBatchUser }
}

async function loadScorerGrainScores(kind: ExportKind, scope: ExportScope) {
  const scores = await prisma.score.findMany({
    where: {
      feedbackItem: itemFilterWhere(scope),
      ...scoreSelectorWhere(kind),
    },
    include: {
      feedbackItem: {
        select: {
          responseId: true,
          studentId: true,
          cycleId: true,
          activityId: true,
          conjunctionId: true,
          studentText: true,
          feedbackSource: true,
          teacherId: true,
          feedbackText: true,
          optimal: true,
          feedbackType: true,
          feedbackId: true,
          batchId: true,
          batch: { select: { name: true, type: true, isDoubleScored: true } },
        },
      },
      user: { select: { email: true, id: true } },
      dimension: { select: { key: true } },
    },
    orderBy: [{ feedbackItemId: 'asc' }, { userId: 'asc' }],
  })
  if (!usesFinalScores(kind)) return scores
  return keepFinals(scores, await loadIndependentFinalFilter(scope))
}

async function buildScorerGrainCsv(
  kind: ExportKind,
  scope: ExportScope,
  dimensionKeys: string[],
  dimensionLabels: string[]
) {
  const [scores, lookups] = await Promise.all([
    loadScorerGrainScores(kind, scope),
    loadScorerLookups(scope.projectId),
  ])

  const rows = buildScorerGrainRows(
    scores.map((score) => ({
      feedbackItemId: score.feedbackItemId,
      userId: score.user.id,
      userEmail: score.user.email,
      batchId: score.feedbackItem.batchId,
      item: toItemFields(score.feedbackItem),
      batch: toBatchFields(score.feedbackItem.batch),
      dimensionKey: score.dimension.key,
      value: score.value,
      notes: score.notes,
      scoredAt: score.scoredAt,
    })),
    lookups
  )

  return {
    header: scorerGrainHeader(dimensionLabels),
    rows: rows.map((row) => scorerGrainCells(row, dimensionKeys)),
  }
}

// ---------------------------------------------------------------------------
// Item-grain (final-by-item / "collapsed")
// ---------------------------------------------------------------------------

async function loadItemGrainRows(scope: ExportScope, dimensionKeys: string[]) {
  const where = itemGrainWhere(scope)

  const [items, candidates, isExpectedRaw] = await Promise.all([
    prisma.feedbackItem.findMany({
      where,
      select: {
        id: true,
        responseId: true,
        studentId: true,
        cycleId: true,
        activityId: true,
        conjunctionId: true,
        studentText: true,
        feedbackSource: true,
        teacherId: true,
        feedbackText: true,
        optimal: true,
        feedbackType: true,
        feedbackId: true,
        batch: { select: { name: true, type: true, isDoubleScored: true } },
      },
    }),
    prisma.score.findMany({
      where: {
        feedbackItem: where,
        ...scoreSelectorWhere('final-by-item'),
      },
      select: {
        feedbackItemId: true,
        userId: true,
        dimensionId: true,
        isReconciled: true,
        value: true,
        dimension: { select: { key: true } },
      },
      // Deterministic input order so a conflict's listed values are stable.
      orderBy: [{ feedbackItemId: 'asc' }, { dimensionId: 'asc' }, { userId: 'asc' }],
    }),
    loadIndependentFinalFilter(scope),
  ])

  // buildItemGrainRows orders rows by numeric Feedback_ID itself.
  const { rows, conflicts } = buildItemGrainRows(
    items.map((item) => ({
      feedbackItemId: item.id,
      item: toItemFields(item),
      batch: toBatchFields(item.batch),
    })),
    keepFinals(candidates, isExpectedRaw).map((score) => ({
      feedbackItemId: score.feedbackItemId,
      dimensionKey: score.dimension.key,
      value: score.value,
    }))
  )

  return {
    rows: scope.completeItemsOnly
      ? rows.filter((row) => hasFullScoreSet(row, dimensionKeys))
      : rows,
    conflicts,
  }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export interface ExportCsv {
  header: string[]
  rows: string[][]
  /**
   * (item × criterion) cells left blank because more than one distinct final
   * candidate existed. Only the item-grain export collapses cells, so this is
   * empty for the scorer-grain kinds.
   */
  conflicts: ItemGrainConflict[]
}

export async function buildExportCsv(
  kind: ExportKind,
  scope: ExportScope,
  dimensionKeys: string[],
  dimensionLabels: string[]
): Promise<ExportCsv> {
  if (isItemGrain(kind)) {
    const { rows, conflicts } = await loadItemGrainRows(scope, dimensionKeys)
    return {
      header: itemGrainHeader(dimensionLabels),
      rows: rows.map((row) => itemGrainCells(row, dimensionKeys)),
      conflicts,
    }
  }
  const { header, rows } = await buildScorerGrainCsv(
    kind,
    scope,
    dimensionKeys,
    dimensionLabels
  )
  return { header, rows, conflicts: [] }
}

/**
 * Row count for the current selection, so the Export tab can say what the file
 * will contain before it is downloaded. `conflictCount` is the number of cells
 * the item-grain file will leave blank because the finals disagreed.
 */
export async function countExportRows(
  kind: ExportKind,
  scope: ExportScope,
  dimensionKeys: string[]
): Promise<{ rowCount: number; conflictCount: number }> {
  if (isItemGrain(kind)) {
    const { rows, conflicts } = await loadItemGrainRows(scope, dimensionKeys)
    return { rowCount: rows.length, conflictCount: conflicts.length }
  }

  // Scorer grain: one row per distinct (item × scorer) pair.
  if (!usesFinalScores(kind)) {
    const pairs = await prisma.score.groupBy({
      by: ['feedbackItemId', 'userId'],
      where: {
        feedbackItem: itemFilterWhere(scope),
        ...scoreSelectorWhere(kind),
      },
    })
    return { rowCount: pairs.length, conflictCount: 0 }
  }

  // Final kinds need the expected-scorer filter, which a groupBy can't express.
  const [candidates, isExpectedRaw] = await Promise.all([
    prisma.score.findMany({
      where: {
        feedbackItem: itemFilterWhere(scope),
        ...scoreSelectorWhere(kind),
      },
      select: { feedbackItemId: true, userId: true, dimensionId: true, isReconciled: true },
    }),
    loadIndependentFinalFilter(scope),
  ])
  const pairs = new Set(
    keepFinals(candidates, isExpectedRaw).map((s) => `${s.feedbackItemId}::${s.userId}`)
  )
  return { rowCount: pairs.size, conflictCount: 0 }
}

// ---------------------------------------------------------------------------
// Discrepancy report
// ---------------------------------------------------------------------------

/**
 * Which batches the report covers.
 *
 *   - `batch`: one batch by id (the original, still-supported form — `batchId`
 *     in the URL). Any paired batch qualifies, including TRAINING.
 *   - `all-double-scored`: every released double-scored REGULAR batch in the
 *     project, optionally narrowed to COMPLETE ones. TRAINING batches are left
 *     out of the aggregate on purpose: they are calibration, not study data,
 *     and this file is what gets handed to Quill (Amber, 2026-09-08).
 */
export type DiscrepancyScope =
  | { kind: 'batch'; projectId: string; batchId: string }
  | { kind: 'all-double-scored'; projectId: string; completeBatchesOnly: boolean }

/** Returns null when neither a batchId nor `batches=all-double-scored` is given. */
export function parseDiscrepancyScope(
  params: URLSearchParams,
  projectId: string
): DiscrepancyScope | null {
  const batchId = params.get('batchId')
  if (batchId) return { kind: 'batch', projectId, batchId }
  if (params.get('batches') === 'all-double-scored') {
    return {
      kind: 'all-double-scored',
      projectId,
      completeBatchesOnly: params.get('completeBatchesOnly') === '1',
    }
  }
  return null
}

function discrepancyBatchWhere(scope: DiscrepancyScope): Prisma.BatchWhereInput {
  if (scope.kind === 'batch') {
    return { id: scope.batchId, projectId: scope.projectId }
  }
  return {
    projectId: scope.projectId,
    type: 'REGULAR',
    isDoubleScored: true,
    status: scope.completeBatchesOnly ? 'COMPLETE' : { not: 'DRAFT' },
  }
}

/**
 * The batches a scope resolves to. For a single-batch scope an empty result
 * means the batch doesn't exist in this project — the route turns that into a
 * 404 rather than an empty file.
 */
export async function resolveDiscrepancyBatches(scope: DiscrepancyScope) {
  return prisma.batch.findMany({
    where: discrepancyBatchWhere(scope),
    select: { id: true, name: true, type: true, status: true, sortOrder: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })
}

async function loadDiscrepancyRows(projectId: string, batchIds: string[]) {
  if (batchIds.length === 0) return []
  const itemWhere: Prisma.FeedbackItemWhereInput = { batchId: { in: batchIds } }

  const [rawScores, finals, escalations, teamMemberships] = await Promise.all([
    prisma.score.findMany({
      where: { feedbackItem: itemWhere, isReconciled: false },
      select: {
        feedbackItemId: true,
        value: true,
        notes: true,
        user: { select: { id: true, email: true } },
        dimension: { select: { key: true, label: true, sortOrder: true } },
        feedbackItem: {
          select: {
            responseId: true,
            studentId: true,
            cycleId: true,
            activityId: true,
            conjunctionId: true,
            studentText: true,
            feedbackSource: true,
            teacherId: true,
            feedbackText: true,
            optimal: true,
            feedbackType: true,
            feedbackId: true,
            batch: {
              select: { name: true, type: true, status: true, sortOrder: true },
            },
          },
        },
      },
    }),
    prisma.score.findMany({
      where: { feedbackItem: itemWhere, isReconciled: true },
      select: {
        feedbackItemId: true,
        userId: true,
        value: true,
        notes: true,
        dimension: { select: { key: true } },
        reconciledBy: { select: { email: true } },
      },
    }),
    prisma.escalation.findMany({
      where: { batchId: { in: batchIds } },
      select: {
        feedbackItemId: true,
        resolvedAt: true,
        dimension: { select: { key: true } },
        teamRelease: { select: { teamId: true } },
      },
    }),
    prisma.evaluatorTeamMember.findMany({
      where: { team: { projectId } },
      select: { userId: true, team: { select: { id: true, name: true } } },
    }),
  ])

  const teamByUserId = new Map<string, { id: string; name: string }>()
  for (const tm of teamMemberships) teamByUserId.set(tm.userId, tm.team)

  return buildDiscrepancyRows(
    rawScores.map((score) => ({
      feedbackItemId: score.feedbackItemId,
      userId: score.user.id,
      userEmail: score.user.email,
      dimensionKey: score.dimension.key,
      dimensionLabel: score.dimension.label,
      dimensionSortOrder: score.dimension.sortOrder,
      value: score.value,
      notes: score.notes,
      item: toItemFields(score.feedbackItem),
      batch: {
        batchName: score.feedbackItem.batch?.name ?? '',
        batchType: score.feedbackItem.batch?.type ?? '',
        batchStatus: score.feedbackItem.batch?.status ?? '',
        batchSortOrder: score.feedbackItem.batch?.sortOrder ?? 0,
      },
    })),
    finals.map((final) => ({
      feedbackItemId: final.feedbackItemId,
      ownerUserId: final.userId,
      dimensionKey: final.dimension.key,
      value: final.value,
      notes: final.notes,
      recordedByEmail: final.reconciledBy?.email ?? null,
    })),
    escalations.map((escalation) => ({
      feedbackItemId: escalation.feedbackItemId,
      teamId: escalation.teamRelease.teamId,
      dimensionKey: escalation.dimension.key,
      resolved: escalation.resolvedAt !== null,
    })),
    { teamByUserId }
  )
}

export async function buildDiscrepancyCsv(
  projectId: string,
  batchIds: string[]
): Promise<{ header: string[]; rows: string[][] }> {
  const rows = await loadDiscrepancyRows(projectId, batchIds)
  return { header: discrepancyHeader(), rows: rows.map(discrepancyCells) }
}

export async function countDiscrepancyRows(
  projectId: string,
  batchIds: string[]
): Promise<number> {
  return (await loadDiscrepancyRows(projectId, batchIds)).length
}

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

function toItemFields(item: {
  responseId: string | null
  studentId: string
  cycleId: string | null
  activityId: string | null
  conjunctionId: string | null
  studentText: string
  feedbackSource: string
  teacherId: string | null
  feedbackText: string
  optimal: string | null
  feedbackType: string | null
  feedbackId: string
}) {
  return {
    responseId: item.responseId,
    studentId: item.studentId,
    cycleId: item.cycleId,
    activityId: item.activityId,
    conjunctionId: item.conjunctionId,
    studentText: item.studentText,
    feedbackSource: item.feedbackSource,
    teacherId: item.teacherId,
    feedbackText: item.feedbackText,
    optimal: item.optimal,
    feedbackType: item.feedbackType,
    feedbackId: item.feedbackId,
  }
}

function toBatchFields(
  batch: { name: string; type: string; isDoubleScored: boolean } | null
) {
  return {
    batchName: batch?.name || '',
    batchType: batch?.type || '',
    doubleScored: batch?.isDoubleScored ?? false,
  }
}
