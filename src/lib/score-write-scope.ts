/**
 * Who may write a raw score, and where.
 *
 * A raw score is only valid when it comes from the annotator the batch was
 * assigned to, for an item in their half of a slot-split batch, against a
 * criterion their team scores. Anything else corrupts the data the exports
 * depend on: on an independent (non-double-scored) batch every item×criterion
 * holds exactly ONE raw score and the exports treat it as the final, so a
 * second row — from a teammate writing outside their slot, or from an admin
 * clicking through "Preview Annotator View" — becomes a candidate final under
 * the wrong name. Until 2026-10 the scores route checked none of this and let
 * admins through without an assignment.
 *
 * Pure: the route (PUT /api/scores) and the evaluate page load the rows and
 * call these; the revise route applies the same slot rule inline. Kept
 * together so the two write paths and the read-only check cannot drift.
 */

import { BATCH_LOCKED_MESSAGE } from '@/lib/reconciliation-access'
import {
  getExpectedReleaseDimensionIds,
  getReleaseItemScope,
} from '@/lib/team-batch-releases'

export const NOT_ASSIGNED_MESSAGE = 'You are not assigned to score this batch.'
export const BATCH_NOT_OPEN_MESSAGE = 'Scoring is not open for this batch.'
export const RELEASE_NOT_OPEN_MESSAGE = 'Scoring is not open for this release.'
export const UNBATCHED_ITEM_MESSAGE =
  'This item is not part of a batch and cannot be scored.'
export const WRONG_SLOT_MESSAGE =
  'That item is not assigned to you on this batch.'
export const NOT_YOUR_CRITERION_MESSAGE =
  'That criterion is not one you score on this batch.'

export interface ScopeBatch {
  status: string
  isHidden: boolean
  isLocked: boolean
}

export interface ScopeRelease {
  id: string
  scorerUserId: string | null
  isVisible: boolean
  status: string
  batch: { type: string; isDoubleScored: boolean }
  team: {
    /** Must be ordered by user email asc: index = slot. */
    members: { userId: string }[]
    dimensions: { dimensionId: string }[]
  }
}

/** The caller's BatchAssignment on the item's batch. `teamRelease` is null on a legacy teamless assignment. */
export interface ScopeAssignment {
  teamRelease: ScopeRelease | null
}

/** What the openness check needs of an assignment (the page loads only this). */
export interface OpenCheckAssignment {
  teamRelease: Pick<ScopeRelease, 'isVisible' | 'status'> | null
}

export type ScoreWriteRefusalReason =
  | 'unbatched'
  | 'locked'
  | 'unassigned'
  | 'hidden'
  | 'release-closed'
  | 'batch-closed'
  | 'wrong-slot'
  | 'not-your-criterion'

export type ScoreWriteAccess =
  | { ok: true }
  | {
      ok: false
      reason: ScoreWriteRefusalReason
      httpStatus: 403 | 423
      error: string
    }

const OK: ScoreWriteAccess = { ok: true }

function refuse(
  reason: ScoreWriteRefusalReason,
  httpStatus: 403 | 423,
  error: string
): ScoreWriteAccess {
  return { ok: false, reason, httpStatus, error }
}

/**
 * Is scoring open for this caller on this batch at all? Lock first (a locked
 * batch is frozen for everyone), then the caller must hold a BatchAssignment —
 * there is no admin bypass, so an admin previewing a batch is read-only — and
 * the batch must be visible with its release (or, teamless, the batch itself)
 * in SCORING.
 */
export function evaluateScoringOpen(input: {
  batch: ScopeBatch
  assignment: OpenCheckAssignment | null
}): ScoreWriteAccess {
  const { batch, assignment } = input
  if (batch.isLocked) return refuse('locked', 423, BATCH_LOCKED_MESSAGE)
  if (!assignment) return refuse('unassigned', 403, NOT_ASSIGNED_MESSAGE)
  if (batch.isHidden) return refuse('hidden', 403, BATCH_NOT_OPEN_MESSAGE)

  const release = assignment.teamRelease
  if (release) {
    if (!release.isVisible || release.status !== 'SCORING') {
      return refuse('release-closed', 403, RELEASE_NOT_OPEN_MESSAGE)
    }
  } else if (batch.status !== 'SCORING') {
    return refuse('batch-closed', 403, BATCH_NOT_OPEN_MESSAGE)
  }
  return OK
}

/**
 * May this caller write these criteria on this item? The item must be in a
 * batch the caller is assigned to; on a slot-split release (non-double-scored
 * REGULAR) the item must be in the caller's slot; on a REGULAR batch every
 * criterion must be one of the team's, on TRAINING any project criterion is
 * fine. A legacy teamless assignment covers the whole batch and whole rubric.
 *
 * `dimensionIds` are assumed to already be valid project criteria (the route
 * returns 400 for unknown ones before asking about scope).
 */
export function evaluateScoreWriteScope(input: {
  item: { batchId: string | null; slotIndex: number | null }
  assignment: ScopeAssignment | null
  userId: string
  dimensionIds: string[]
  projectDimensionIds: string[]
}): ScoreWriteAccess {
  const { item, assignment, userId, dimensionIds, projectDimensionIds } = input
  if (!item.batchId) return refuse('unbatched', 403, UNBATCHED_ITEM_MESSAGE)
  if (!assignment) return refuse('unassigned', 403, NOT_ASSIGNED_MESSAGE)

  const release = assignment.teamRelease
  if (!release) return OK

  const releaseContext = {
    id: release.id,
    scorerUserId: release.scorerUserId,
    isDoubleScored: release.batch.isDoubleScored,
    batchType: release.batch.type,
    team: release.team,
  }

  const scope = getReleaseItemScope(releaseContext, userId)
  if (scope.mode === 'none') return refuse('unassigned', 403, NOT_ASSIGNED_MESSAGE)
  if (scope.mode === 'slot' && item.slotIndex !== scope.slotIndex) {
    return refuse('wrong-slot', 403, WRONG_SLOT_MESSAGE)
  }

  const allowed = new Set(
    getExpectedReleaseDimensionIds(releaseContext, projectDimensionIds)
  )
  if (dimensionIds.some((id) => !allowed.has(id))) {
    return refuse('not-your-criterion', 403, NOT_YOUR_CRITERION_MESSAGE)
  }
  return OK
}

/**
 * The full check a raw-score write must pass, in the order the route reports
 * it: unbatched item, then batch openness for the caller, then item/criterion
 * scope. `batch` is null only when the item has no batch.
 */
export function evaluateScoreWrite(input: {
  item: { batchId: string | null; slotIndex: number | null }
  batch: ScopeBatch | null
  assignment: ScopeAssignment | null
  userId: string
  dimensionIds: string[]
  projectDimensionIds: string[]
}): ScoreWriteAccess {
  if (!input.item.batchId || !input.batch) {
    return refuse('unbatched', 403, UNBATCHED_ITEM_MESSAGE)
  }
  const open = evaluateScoringOpen({
    batch: input.batch,
    assignment: input.assignment,
  })
  if (!open.ok) return open
  return evaluateScoreWriteScope(input)
}
