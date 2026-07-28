// Data access for the export routes. Pure row/CSV shaping lives in
// `@/lib/export`; this module owns the Prisma queries and scope rules so the
// download route and the row-count route can never drift apart.

import { prisma } from '@/lib/db'
import type { Prisma } from '@/generated/prisma/client'
import {
  buildItemGrainRows,
  buildScorerGrainRows,
  hasFullScoreSet,
  isItemGrain,
  itemGrainCells,
  itemGrainHeader,
  scorerGrainCells,
  scorerGrainHeader,
  type ExportKind,
} from '@/lib/export'

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

/**
 * Score selector.
 *
 * "final" = the final value per item: the reconciled/adjudicated row for
 * double-scored & training batches, plus the lone score for single-scored
 * regular batches (which never reconcile). "raw" = every score as entered.
 */
function scoreSelectorWhere(kind: ExportKind): Prisma.ScoreWhereInput {
  if (kind === 'raw-by-scorer') return { isReconciled: false }
  return {
    OR: [
      { isReconciled: true },
      {
        isReconciled: false,
        feedbackItem: { batch: { type: 'REGULAR', isDoubleScored: false } },
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Scorer-grain (raw-by-scorer / final-by-scorer)
//
// Unchanged from the original implementation — same rows, same columns, same
// ordering — so anything built on these exports keeps working.
// ---------------------------------------------------------------------------

async function loadScorerLookups(projectId: string) {
  const [teamMemberships, batchAssignments] = await Promise.all([
    prisma.evaluatorTeamMember.findMany({
      where: { team: { projectId } },
      include: { team: { select: { name: true } } },
    }),
    prisma.batchAssignment.findMany({ where: { batch: { projectId } } }),
  ])

  const teamByUserId = new Map<string, string>()
  for (const tm of teamMemberships) teamByUserId.set(tm.userId, tm.team.name)

  const roleByBatchUser = new Map<string, string>()
  for (const ba of batchAssignments) {
    roleByBatchUser.set(`${ba.batchId}::${ba.userId}`, ba.scoringRole)
  }

  return { teamByUserId, roleByBatchUser }
}

async function buildScorerGrainCsv(
  kind: ExportKind,
  scope: ExportScope,
  dimensionKeys: string[],
  dimensionLabels: string[]
) {
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

  const lookups = await loadScorerLookups(scope.projectId)

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

  const [items, scores] = await Promise.all([
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
      orderBy: { feedbackId: 'asc' },
    }),
    prisma.score.findMany({
      where: {
        feedbackItem: where,
        ...scoreSelectorWhere('final-by-item'),
      },
      select: {
        feedbackItemId: true,
        value: true,
        dimension: { select: { key: true } },
      },
    }),
  ])

  const rows = buildItemGrainRows(
    items.map((item) => ({
      feedbackItemId: item.id,
      item: toItemFields(item),
      batch: toBatchFields(item.batch),
    })),
    scores.map((score) => ({
      feedbackItemId: score.feedbackItemId,
      dimensionKey: score.dimension.key,
      value: score.value,
    }))
  )

  return scope.completeItemsOnly
    ? rows.filter((row) => hasFullScoreSet(row, dimensionKeys))
    : rows
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export async function buildExportCsv(
  kind: ExportKind,
  scope: ExportScope,
  dimensionKeys: string[],
  dimensionLabels: string[]
): Promise<{ header: string[]; rows: string[][] }> {
  if (isItemGrain(kind)) {
    const rows = await loadItemGrainRows(scope, dimensionKeys)
    return {
      header: itemGrainHeader(dimensionLabels),
      rows: rows.map((row) => itemGrainCells(row, dimensionKeys)),
    }
  }
  return buildScorerGrainCsv(kind, scope, dimensionKeys, dimensionLabels)
}

/**
 * Row count for the current selection, so the Export tab can say what the file
 * will contain before it is downloaded.
 */
export async function countExportRows(
  kind: ExportKind,
  scope: ExportScope,
  dimensionKeys: string[]
): Promise<number> {
  if (isItemGrain(kind)) {
    return (await loadItemGrainRows(scope, dimensionKeys)).length
  }

  // Scorer grain: one row per distinct (item × scorer) pair.
  const pairs = await prisma.score.groupBy({
    by: ['feedbackItemId', 'userId'],
    where: {
      feedbackItem: itemFilterWhere(scope),
      ...scoreSelectorWhere(kind),
    },
  })
  return pairs.length
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
