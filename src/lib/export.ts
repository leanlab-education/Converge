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
  | 'discrepancies' // QA comparison report (own shape, batch-scoped)

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
