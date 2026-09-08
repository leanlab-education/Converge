// Pure row/CSV construction for the export routes.
//
// The export surface has three *score table* shapes plus one standalone QA
// report. The three tables differ along exactly two axes:
//
//   grain  — what one row represents: a (item × scorer) pair, or one item
//   scores — which values: every scorer's raw score, or the single final value
//
// Only three of the four combinations exist: "one row per item × every raw
// score" is impossible (two annotators' values can't share one cell), so the
// export kind is a single self-describing enum rather than two orthogonal
// params with a dead combination.
//
// Legacy names (`original`, `reconciled`) are still accepted by the route so
// existing bookmarks and scripts keep working.

export type ExportKind =
  | 'raw-by-scorer' // every annotator's raw score, one row per (item × scorer)
  | 'final-by-scorer' // final values, still split by scorer/team
  | 'final-by-item' // final values collapsed to one row per feedback item
  | 'discrepancies' // QA comparison report (own shape, scoped to one or more paired batches)

const LEGACY_KIND_ALIASES: Record<string, ExportKind> = {
  original: 'raw-by-scorer',
  reconciled: 'final-by-scorer',
  collapsed: 'final-by-item',
}

export const EXPORT_KINDS: ExportKind[] = [
  'raw-by-scorer',
  'final-by-scorer',
  'final-by-item',
  'discrepancies',
]

/**
 * Normalize the `type` query param, accepting the legacy preset names.
 * Returns null for anything unrecognized so the route can 400.
 */
export function parseExportKind(raw: string | null): ExportKind | null {
  if (!raw) return 'raw-by-scorer'
  if (EXPORT_KINDS.includes(raw as ExportKind)) return raw as ExportKind
  return LEGACY_KIND_ALIASES[raw] ?? null
}

/** True when this kind reports one row per feedback item. */
export function isItemGrain(kind: ExportKind): boolean {
  return kind === 'final-by-item'
}

/** True when this kind reports final (reconciled/adjudicated) values only. */
export function usesFinalScores(kind: ExportKind): boolean {
  return kind === 'final-by-scorer' || kind === 'final-by-item'
}

// ---------------------------------------------------------------------------
// CSV primitives
// ---------------------------------------------------------------------------

export function csvEscape(value: string): string {
  // Defend against CSV formula injection — prefix dangerous leading characters
  if (/^[=+\-@\t\r]/.test(value)) {
    value = `'${value}`
  }
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

export function toCsv(header: string[], rows: string[][]): string {
  return [header.join(','), ...rows.map((row) => row.join(','))].join('\n')
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

/** The 12 item-level columns, in the original CSV import order. */
export const ITEM_COLUMNS = [
  'Response_ID',
  'Student_ID',
  'Cycle_ID',
  'Activity_ID',
  'Conjunction_ID',
  'Student_Text',
  'Feedback_Source',
  'Teacher_ID',
  'Feedback_Text',
  'optimal',
  'feedback_type',
  'Feedback_ID',
] as const

/** Batch context columns — well-defined at both grains (an item has one batch). */
export const BATCH_COLUMNS = ['Batch_Name', 'Batch_Type', 'Double_Scored'] as const

/** Scorer-specific columns — only meaningful at (item × scorer) grain. */
export const SCORER_COLUMNS = [
  'Score_ID',
  'Evaluator_Email',
  'Scoring_Role',
  'Team_Name',
] as const

/** Per-score trailing columns — only meaningful at (item × scorer) grain. */
export const SCORER_TRAILING_COLUMNS = ['Notes', 'Timestamp'] as const

export interface ExportItemFields {
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
}

export interface ExportBatchFields {
  batchName: string
  batchType: string
  doubleScored: boolean
}

function itemCells(item: ExportItemFields): string[] {
  return [
    csvEscape(item.responseId || ''),
    csvEscape(item.studentId),
    csvEscape(item.cycleId || ''),
    csvEscape(item.activityId || ''),
    csvEscape(item.conjunctionId || ''),
    csvEscape(item.studentText),
    item.feedbackSource,
    csvEscape(item.teacherId || ''),
    csvEscape(item.feedbackText),
    csvEscape(item.optimal || ''),
    csvEscape(item.feedbackType || ''),
    csvEscape(item.feedbackId),
  ]
}

function batchCells(batch: ExportBatchFields): string[] {
  return [
    csvEscape(batch.batchName),
    csvEscape(batch.batchType),
    batch.doubleScored ? 'Yes' : 'No',
  ]
}

// ---------------------------------------------------------------------------
// Scorer-grain rows (the two exports that existed before)
// ---------------------------------------------------------------------------

/**
 * The PRIMARY/DOUBLE enum is internal. The two scorers in a double-scored pair
 * score independently, so the exported labels are symmetric and imply no
 * sequence or hierarchy.
 */
export function formatScoringRole(rawRole: string): string {
  if (rawRole === 'PRIMARY') return 'Scorer A'
  if (rawRole === 'DOUBLE') return 'Scorer B'
  return rawRole
}

export interface ScorerGrainInput {
  feedbackItemId: string
  userId: string
  userEmail: string
  batchId: string | null
  item: ExportItemFields
  batch: ExportBatchFields
  dimensionKey: string
  value: number
  notes: string | null
  scoredAt: Date
}

export interface ScorerGrainRow extends ExportItemFields, ExportBatchFields {
  scoreId: string
  evaluatorEmail: string
  scoringRole: string
  teamName: string
  notes: string
  timestamp: Date
  dimensionScores: Record<string, number>
}

/**
 * Group per-dimension score rows into one wide row per (feedback item × scorer).
 * Score_ID is a positional label (S001, S002, …) assigned in encounter order.
 */
export function buildScorerGrainRows(
  scores: ScorerGrainInput[],
  lookups: {
    teamByUserId: Map<string, string>
    roleByBatchUser: Map<string, string>
  }
): ScorerGrainRow[] {
  const rowMap = new Map<string, ScorerGrainRow>()
  let scoreCounter = 0

  for (const score of scores) {
    const rowKey = `${score.feedbackItemId}::${score.userId}`
    if (!rowMap.has(rowKey)) {
      scoreCounter++
      const rawRole = score.batchId
        ? lookups.roleByBatchUser.get(`${score.batchId}::${score.userId}`) || ''
        : ''

      rowMap.set(rowKey, {
        ...score.item,
        ...score.batch,
        scoreId: `S${String(scoreCounter).padStart(3, '0')}`,
        evaluatorEmail: score.userEmail,
        scoringRole: formatScoringRole(rawRole),
        teamName: lookups.teamByUserId.get(score.userId) || '',
        notes: score.notes ?? '',
        timestamp: score.scoredAt,
        dimensionScores: {},
      })
    }
    const row = rowMap.get(rowKey)!
    row.dimensionScores[score.dimensionKey] = score.value
    // Notes can live on any one of an item/user's per-dimension rows; keep the
    // first non-empty. Timestamp = the most recent score for that item/user.
    if (!row.notes && score.notes) row.notes = score.notes
    if (score.scoredAt > row.timestamp) row.timestamp = score.scoredAt
  }

  return [...rowMap.values()]
}

export function scorerGrainHeader(dimensionLabels: string[]): string[] {
  return [
    ...ITEM_COLUMNS,
    'Score_ID',
    'Evaluator_Email',
    'Scoring_Role',
    'Team_Name',
    ...BATCH_COLUMNS,
    ...dimensionLabels,
    ...SCORER_TRAILING_COLUMNS,
  ]
}

export function scorerGrainCells(
  row: ScorerGrainRow,
  dimensionKeys: string[]
): string[] {
  return [
    ...itemCells(row),
    csvEscape(row.scoreId),
    csvEscape(row.evaluatorEmail),
    csvEscape(row.scoringRole),
    csvEscape(row.teamName),
    ...batchCells(row),
    ...dimensionKeys.map((key) =>
      row.dimensionScores[key] !== undefined
        ? String(row.dimensionScores[key])
        : ''
    ),
    csvEscape(row.notes),
    row.timestamp.toISOString(),
  ]
}

// ---------------------------------------------------------------------------
// Item-grain rows (the collapsed export)
// ---------------------------------------------------------------------------

export interface ItemGrainItem {
  feedbackItemId: string
  item: ExportItemFields
  batch: ExportBatchFields
}

export interface ItemGrainScore {
  feedbackItemId: string
  dimensionKey: string
  value: number
}

export interface ItemGrainRow extends ExportItemFields, ExportBatchFields {
  feedbackItemId: string
  dimensionScores: Record<string, number>
}

/**
 * Collapse final scores to one row per feedback item, merging across every team
 * and both members of each pair.
 *
 * Rows are built from the ITEMS in scope, not from the scores — so an item that
 * has been released but not yet scored still gets a row, with empty criterion
 * cells. That is what makes the "only items with a full set of scores" filter
 * meaningful rather than tautological.
 *
 * Each (item × dimension) has at most one final value: reconciled rows are
 * always written under the release owner, and in a REGULAR batch a dimension
 * belongs to exactly one team — so exactly one release owns each cell. (This is
 * why TRAINING batches are excluded upstream: there, every team scores every
 * dimension, so an item genuinely has one final per team and cannot collapse.)
 */
export function buildItemGrainRows(
  items: ItemGrainItem[],
  scores: ItemGrainScore[]
): ItemGrainRow[] {
  const rowMap = new Map<string, ItemGrainRow>()

  for (const entry of items) {
    rowMap.set(entry.feedbackItemId, {
      ...entry.item,
      ...entry.batch,
      feedbackItemId: entry.feedbackItemId,
      dimensionScores: {},
    })
  }

  for (const score of scores) {
    const row = rowMap.get(score.feedbackItemId)
    // Scores for items outside the requested scope are ignored rather than
    // silently reintroducing those items.
    if (!row) continue
    row.dimensionScores[score.dimensionKey] = score.value
  }

  return [...rowMap.values()]
}

export function itemGrainHeader(dimensionLabels: string[]): string[] {
  return [...ITEM_COLUMNS, ...BATCH_COLUMNS, ...dimensionLabels]
}

export function itemGrainCells(
  row: ItemGrainRow,
  dimensionKeys: string[]
): string[] {
  return [
    ...itemCells(row),
    ...batchCells(row),
    ...dimensionKeys.map((key) =>
      row.dimensionScores[key] !== undefined
        ? String(row.dimensionScores[key])
        : ''
    ),
  ]
}

/** True when the row carries a final value for every rubric dimension. */
export function hasFullScoreSet(
  row: ItemGrainRow,
  dimensionKeys: string[]
): boolean {
  return dimensionKeys.every((key) => row.dimensionScores[key] !== undefined)
}

// ---------------------------------------------------------------------------
// Discrepancy report
//
// One row per (item × criterion × team) where the two annotators in a pair
// entered different raw values. Unlike the score tables this is a *journey*
// view: both original scores and notes, the final value the pair (or the
// adjudicator) landed on, how it got resolved, and who recorded it — so a
// reader can follow a disagreement end to end without cross-referencing the
// other exports (Amber / Peter, 2026-09-08).
//
// Rows are grouped per team, not per item, because in a TRAINING batch every
// team scores every criterion: the same (item × criterion) legitimately holds
// one pair of raw scores per team, and each team reconciles its own.
// ---------------------------------------------------------------------------

/** Columns after the 12 item columns. Pinned in export.test.ts. */
export const DISCREPANCY_COLUMNS = [
  'Batch_Name',
  'Batch_Type',
  'Batch_Status',
  'Team_Name',
  'Dimension_Key',
  'Dimension_Label',
  'Evaluator_A_Email',
  'Evaluator_A_Score',
  'Evaluator_A_Notes',
  'Evaluator_B_Email',
  'Evaluator_B_Score',
  'Evaluator_B_Notes',
  'Difference',
  'Final_Score',
  'Resolution',
  'Final_Recorded_By',
  'Reconciliation_Notes',
] as const

export type DiscrepancyResolution =
  | 'Reconciled' // the pair recorded a final value themselves
  | 'Adjudicated' // escalated, and the adjudicator resolved it
  | 'Escalated' // escalated, adjudicator has not resolved it yet
  | 'Unresolved' // no final value recorded yet

export interface DiscrepancyBatchFields {
  batchName: string
  batchType: string
  batchStatus: string
  batchSortOrder: number
}

export interface DiscrepancyRawScore {
  feedbackItemId: string
  userId: string
  userEmail: string
  dimensionKey: string
  dimensionLabel: string
  dimensionSortOrder: number
  value: number
  /** Annotator notes for this item. Per-item, repeated across dimension rows. */
  notes: string | null
  item: ExportItemFields
  batch: DiscrepancyBatchFields
}

export interface DiscrepancyFinal {
  feedbackItemId: string
  /** Release-owner storage slot — a member of the team that owns this final. */
  ownerUserId: string
  dimensionKey: string
  value: number
  notes: string | null
  recordedByEmail: string | null
}

export interface DiscrepancyEscalation {
  feedbackItemId: string
  teamId: string
  dimensionKey: string
  resolved: boolean
}

export interface DiscrepancyLookups {
  /** Every annotator's team on this project. Users outside any team share ''. */
  teamByUserId: Map<string, { id: string; name: string }>
}

export interface DiscrepancyRow extends ExportItemFields, DiscrepancyBatchFields {
  teamName: string
  dimensionKey: string
  dimensionLabel: string
  dimensionSortOrder: number
  evaluatorA: { email: string; value: number; notes: string }
  evaluatorB: { email: string; value: number; notes: string }
  difference: number
  finalValue: number | null
  resolution: DiscrepancyResolution
  finalRecordedBy: string
  reconciliationNotes: string
}

function teamKey(
  feedbackItemId: string,
  dimensionKey: string,
  teamId: string
): string {
  return `${feedbackItemId}::${dimensionKey}::${teamId}`
}

/**
 * Pair up raw scores per (item × criterion × team) and keep only the pairs
 * that disagree. Groups with anything other than exactly two raw scores are
 * skipped: one score means the partner hasn't scored yet, and more than two
 * means the team isn't a pair, so there is no "discrepancy" to report.
 *
 * Scorer A / Scorer B are assigned alphabetically by email so the same
 * annotator lands in the same column on every row of a batch.
 */
export function buildDiscrepancyRows(
  rawScores: DiscrepancyRawScore[],
  finals: DiscrepancyFinal[],
  escalations: DiscrepancyEscalation[],
  lookups: DiscrepancyLookups
): DiscrepancyRow[] {
  const teamOf = (userId: string) =>
    lookups.teamByUserId.get(userId) ?? { id: '', name: '' }

  // Notes are entered per item, then repeated on every dimension row for that
  // (item, user). Collapse to the first non-empty so a note written on one
  // criterion still shows up on every discrepancy row for that item.
  const notesByItemUser = new Map<string, string>()
  for (const score of rawScores) {
    const key = `${score.feedbackItemId}::${score.userId}`
    if (score.notes?.trim() && !notesByItemUser.has(key)) {
      notesByItemUser.set(key, score.notes)
    }
  }

  const finalByKey = new Map<string, DiscrepancyFinal>()
  for (const final of finals) {
    finalByKey.set(
      teamKey(final.feedbackItemId, final.dimensionKey, teamOf(final.ownerUserId).id),
      final
    )
  }

  // The reconcile route writes the pair's rationale onto every reconciled
  // dimension row for an item, so a rationale on one criterion applies to the
  // item as a whole for that team.
  const rationaleByItemTeam = new Map<string, string>()
  for (const final of finals) {
    const key = `${final.feedbackItemId}::${teamOf(final.ownerUserId).id}`
    if (final.notes?.trim() && !rationaleByItemTeam.has(key)) {
      rationaleByItemTeam.set(key, final.notes)
    }
  }

  const escalationByKey = new Map<string, DiscrepancyEscalation>()
  for (const escalation of escalations) {
    escalationByKey.set(
      teamKey(escalation.feedbackItemId, escalation.dimensionKey, escalation.teamId),
      escalation
    )
  }

  const groups = new Map<
    string,
    {
      first: DiscrepancyRawScore
      teamId: string
      teamName: string
      scorers: { userId: string; email: string; value: number }[]
    }
  >()
  for (const score of rawScores) {
    const team = teamOf(score.userId)
    const key = teamKey(score.feedbackItemId, score.dimensionKey, team.id)
    let group = groups.get(key)
    if (!group) {
      group = { first: score, teamId: team.id, teamName: team.name, scorers: [] }
      groups.set(key, group)
    }
    group.scorers.push({
      userId: score.userId,
      email: score.userEmail,
      value: score.value,
    })
  }

  const rows: DiscrepancyRow[] = []
  for (const [key, group] of groups) {
    if (group.scorers.length !== 2) continue
    const [a, b] = [...group.scorers].sort((x, y) =>
      x.email.localeCompare(y.email)
    )
    if (a.value === b.value) continue

    const { first } = group
    const final = finalByKey.get(key) ?? null
    const escalation = escalationByKey.get(key) ?? null

    let resolution: DiscrepancyResolution
    if (escalation?.resolved) resolution = 'Adjudicated'
    else if (escalation) resolution = 'Escalated'
    else if (final) resolution = 'Reconciled'
    else resolution = 'Unresolved'

    rows.push({
      ...first.item,
      ...first.batch,
      teamName: group.teamName,
      dimensionKey: first.dimensionKey,
      dimensionLabel: first.dimensionLabel,
      dimensionSortOrder: first.dimensionSortOrder,
      evaluatorA: {
        email: a.email,
        value: a.value,
        notes: notesByItemUser.get(`${first.feedbackItemId}::${a.userId}`) ?? '',
      },
      evaluatorB: {
        email: b.email,
        value: b.value,
        notes: notesByItemUser.get(`${first.feedbackItemId}::${b.userId}`) ?? '',
      },
      difference: Math.abs(a.value - b.value),
      finalValue: final?.value ?? null,
      resolution,
      finalRecordedBy: final?.recordedByEmail ?? '',
      reconciliationNotes:
        rationaleByItemTeam.get(`${first.feedbackItemId}::${group.teamId}`) ?? '',
    })
  }

  // Stable, readable order: batch, then item, then criterion in rubric order,
  // then team (only distinguishes rows in training batches).
  rows.sort(
    (x, y) =>
      x.batchSortOrder - y.batchSortOrder ||
      x.batchName.localeCompare(y.batchName) ||
      x.feedbackId.localeCompare(y.feedbackId) ||
      x.dimensionSortOrder - y.dimensionSortOrder ||
      x.teamName.localeCompare(y.teamName)
  )
  return rows
}

export function discrepancyHeader(): string[] {
  return [...ITEM_COLUMNS, ...DISCREPANCY_COLUMNS]
}

export function discrepancyCells(row: DiscrepancyRow): string[] {
  return [
    ...itemCells(row),
    csvEscape(row.batchName),
    csvEscape(row.batchType),
    csvEscape(row.batchStatus),
    csvEscape(row.teamName),
    csvEscape(row.dimensionKey),
    csvEscape(row.dimensionLabel),
    csvEscape(row.evaluatorA.email),
    String(row.evaluatorA.value),
    csvEscape(row.evaluatorA.notes),
    csvEscape(row.evaluatorB.email),
    String(row.evaluatorB.value),
    csvEscape(row.evaluatorB.notes),
    String(row.difference),
    row.finalValue === null ? '' : String(row.finalValue),
    row.resolution,
    csvEscape(row.finalRecordedBy),
    csvEscape(row.reconciliationNotes),
  ]
}

/**
 * `discrepancies-<batch>-<date>.csv` for a single batch (unchanged from the
 * original report), otherwise a name that says which set of batches it holds.
 */
export function buildDiscrepancyFilename(
  selection:
    | { kind: 'batch'; batchName: string }
    | { kind: 'all-double-scored'; completeBatchesOnly: boolean },
  today: string
): string {
  const middle =
    selection.kind === 'batch'
      ? (selection.batchName || 'batch').replace(/[^a-zA-Z0-9_-]/g, '-')
      : selection.completeBatchesOnly
        ? 'all-double-scored-complete'
        : 'all-double-scored'
  return `discrepancies-${middle}-${today}.csv`
}

// ---------------------------------------------------------------------------
// Filenames
// ---------------------------------------------------------------------------

const KIND_FILENAME_SLUGS: Record<ExportKind, string> = {
  'raw-by-scorer': 'original',
  'final-by-scorer': 'reconciled',
  'final-by-item': 'reconciled-by-feedback',
  discrepancies: 'discrepancies',
}

export function buildExportFilename(
  kind: ExportKind,
  filters: {
    activityId?: string | null
    conjunctionId?: string | null
    completeItemsOnly?: boolean
    finalizedBatchesOnly?: boolean
  },
  today: string
): string {
  const parts = [KIND_FILENAME_SLUGS[kind]]
  if (filters.activityId) parts.push(`activity-${filters.activityId}`)
  if (filters.conjunctionId) parts.push(`conj-${filters.conjunctionId}`)
  if (filters.completeItemsOnly) parts.push('complete-items')
  if (filters.finalizedBatchesOnly) parts.push('finalized-batches')
  return `scores-${parts.join('-')}-${today}.csv`
}
