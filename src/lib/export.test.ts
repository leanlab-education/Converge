import { describe, it, expect } from 'vitest'
import {
  DISCREPANCY_COLUMNS,
  buildDiscrepancyFilename,
  buildDiscrepancyRows,
  buildExportFilename,
  buildItemGrainRows,
  buildScorerGrainRows,
  csvEscape,
  discrepancyCells,
  discrepancyHeader,
  formatScoringRole,
  hasFullScoreSet,
  isItemGrain,
  itemGrainCells,
  itemGrainHeader,
  parseExportKind,
  scorerGrainCells,
  scorerGrainHeader,
  toCsv,
  usesFinalScores,
  type DiscrepancyRawScore,
  type ItemGrainItem,
  type ScorerGrainInput,
} from '@/lib/export'

const DIM_KEYS = ['criterion_1', 'criterion_2', 'criterion_3']
const DIM_LABELS = ['Manageable', 'Actionable Revision', 'Not Answer Giving']

function item(overrides: Partial<ScorerGrainInput['item']> = {}) {
  return {
    responseId: '292',
    studentId: '21809248',
    cycleId: '2',
    activityId: '9',
    conjunctionId: 'Because',
    studentText: 'CETI needs a large amount of data.',
    feedbackSource: 'HUMAN',
    teacherId: '1',
    feedbackText: 'Yes, the need for many examples is critical.',
    optimal: '1',
    feedbackType: '',
    feedbackId: 'F2475',
    ...overrides,
  }
}

function batch(overrides: Partial<ScorerGrainInput['batch']> = {}) {
  return {
    batchName: 'Batch 31',
    batchType: 'REGULAR',
    doubleScored: true,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------

describe('parseExportKind', () => {
  it('accepts the self-describing kinds', () => {
    expect(parseExportKind('raw-by-scorer')).toBe('raw-by-scorer')
    expect(parseExportKind('final-by-scorer')).toBe('final-by-scorer')
    expect(parseExportKind('final-by-item')).toBe('final-by-item')
    expect(parseExportKind('discrepancies')).toBe('discrepancies')
  })

  it('keeps the legacy preset names working (bookmarked URLs must not break)', () => {
    expect(parseExportKind('original')).toBe('raw-by-scorer')
    expect(parseExportKind('reconciled')).toBe('final-by-scorer')
  })

  it('defaults to raw-by-scorer when the param is absent, matching the old route', () => {
    expect(parseExportKind(null)).toBe('raw-by-scorer')
  })

  it('rejects unknown values so the route can 400 rather than export the wrong thing', () => {
    expect(parseExportKind('everything')).toBeNull()
    expect(parseExportKind('final')).toBeNull()
  })
})

describe('kind predicates', () => {
  it('only final-by-item collapses to item grain', () => {
    expect(isItemGrain('final-by-item')).toBe(true)
    expect(isItemGrain('final-by-scorer')).toBe(false)
    expect(isItemGrain('raw-by-scorer')).toBe(false)
  })

  it('both final kinds select reconciled/adjudicated values', () => {
    expect(usesFinalScores('final-by-item')).toBe(true)
    expect(usesFinalScores('final-by-scorer')).toBe(true)
    expect(usesFinalScores('raw-by-scorer')).toBe(false)
  })
})

describe('csvEscape', () => {
  it('quotes values containing commas, quotes, or newlines', () => {
    expect(csvEscape('a,b')).toBe('"a,b"')
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""')
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"')
  })

  it('neutralizes formula injection on the dangerous leading characters', () => {
    expect(csvEscape('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(csvEscape('+1')).toBe("'+1")
    expect(csvEscape('-1')).toBe("'-1")
    expect(csvEscape('@cmd')).toBe("'@cmd")
  })

  it('leaves ordinary values untouched', () => {
    expect(csvEscape('F2475')).toBe('F2475')
  })
})

// ---------------------------------------------------------------------------
// Scorer grain — the two exports that already existed. These tests pin the
// exact column layout so the refactor cannot silently change Amber's files.
// ---------------------------------------------------------------------------

describe('scorerGrainHeader', () => {
  it('matches the pre-refactor column order exactly', () => {
    expect(scorerGrainHeader(DIM_LABELS)).toEqual([
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
      'Score_ID',
      'Evaluator_Email',
      'Scoring_Role',
      'Team_Name',
      'Batch_Name',
      'Batch_Type',
      'Double_Scored',
      'Manageable',
      'Actionable Revision',
      'Not Answer Giving',
      'Notes',
      'Timestamp',
    ])
  })
})

describe('formatScoringRole', () => {
  it('maps the internal enum to symmetric labels', () => {
    // The pair scores independently — the labels must not imply a sequence.
    expect(formatScoringRole('PRIMARY')).toBe('Scorer A')
    expect(formatScoringRole('DOUBLE')).toBe('Scorer B')
  })

  it('passes through an unknown/absent role rather than inventing one', () => {
    expect(formatScoringRole('')).toBe('')
  })
})

describe('buildScorerGrainRows', () => {
  const lookups = {
    teamByUserId: new Map([['u1', 'Team Alpha']]),
    roleByBatchUser: new Map([['b1::u1', 'PRIMARY']]),
  }

  function score(overrides: Partial<ScorerGrainInput> = {}): ScorerGrainInput {
    return {
      feedbackItemId: 'i1',
      userId: 'u1',
      userEmail: 'a@test.com',
      batchId: 'b1',
      item: item(),
      batch: batch(),
      dimensionKey: 'criterion_1',
      value: 1,
      notes: null,
      scoredAt: new Date('2026-07-01T10:00:00Z'),
      ...overrides,
    }
  }

  it('groups every dimension of one (item × scorer) pair into a single row', () => {
    const rows = buildScorerGrainRows(
      [
        score({ dimensionKey: 'criterion_1', value: 1 }),
        score({ dimensionKey: 'criterion_2', value: 0 }),
      ],
      lookups
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].dimensionScores).toEqual({ criterion_1: 1, criterion_2: 0 })
  })

  it('emits a separate row per scorer on the same item', () => {
    const rows = buildScorerGrainRows(
      [score(), score({ userId: 'u2', userEmail: 'b@test.com' })],
      lookups
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.evaluatorEmail)).toEqual([
      'a@test.com',
      'b@test.com',
    ])
  })

  it('numbers Score_ID positionally in encounter order', () => {
    const rows = buildScorerGrainRows(
      [score(), score({ userId: 'u2', userEmail: 'b@test.com' })],
      lookups
    )
    expect(rows.map((r) => r.scoreId)).toEqual(['S001', 'S002'])
  })

  it('keeps the first non-empty note across an item/user dimension rows', () => {
    const rows = buildScorerGrainRows(
      [
        score({ dimensionKey: 'criterion_1', notes: null }),
        score({ dimensionKey: 'criterion_2', notes: 'unsure about scope' }),
      ],
      lookups
    )
    expect(rows[0].notes).toBe('unsure about scope')
  })

  it('uses the most recent scoredAt as the row timestamp', () => {
    const rows = buildScorerGrainRows(
      [
        score({
          dimensionKey: 'criterion_1',
          scoredAt: new Date('2026-07-01T10:00:00Z'),
        }),
        score({
          dimensionKey: 'criterion_2',
          scoredAt: new Date('2026-07-03T12:00:00Z'),
        }),
      ],
      lookups
    )
    expect(rows[0].timestamp.toISOString()).toBe('2026-07-03T12:00:00.000Z')
  })

  it('renders a full row in the pre-refactor cell order', () => {
    const rows = buildScorerGrainRows([score()], lookups)
    expect(scorerGrainCells(rows[0], DIM_KEYS)).toEqual([
      '292',
      '21809248',
      '2',
      '9',
      'Because',
      'CETI needs a large amount of data.',
      'HUMAN',
      '1',
      '"Yes, the need for many examples is critical."',
      '1',
      '',
      'F2475',
      'S001',
      'a@test.com',
      'Scorer A',
      'Team Alpha',
      'Batch 31',
      'REGULAR',
      'Yes',
      '1',
      '',
      '',
      '',
      '2026-07-01T10:00:00.000Z',
    ])
  })

  it('leaves criterion cells empty when that dimension has no score', () => {
    const rows = buildScorerGrainRows([score()], lookups)
    const cells = scorerGrainCells(rows[0], DIM_KEYS)
    expect(cells.slice(19, 22)).toEqual(['1', '', ''])
  })
})

// ---------------------------------------------------------------------------
// Item grain — the new collapsed export
// ---------------------------------------------------------------------------

describe('itemGrainHeader', () => {
  it('matches Amber’s target template: item columns, batch columns, criteria', () => {
    expect(itemGrainHeader(DIM_LABELS)).toEqual([
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
      'Batch_Name',
      'Batch_Type',
      'Double_Scored',
      'Manageable',
      'Actionable Revision',
      'Not Answer Giving',
    ])
  })

  it('drops every scorer-specific column', () => {
    const header = itemGrainHeader(DIM_LABELS)
    for (const dropped of [
      'Score_ID',
      'Evaluator_Email',
      'Scoring_Role',
      'Team_Name',
      'Notes',
      'Timestamp',
    ]) {
      expect(header).not.toContain(dropped)
    }
  })

  it('places the 8 criteria at P–W for a full Quill rubric', () => {
    const eight = [
      'Manageable',
      'Actionable Revision',
      'Appropriate Feedback Decision',
      'Not Answer Giving',
      'Task Aligned Revision',
      'Anchored in Student Response',
      'Acknowledges Strength',
      'Appropriate Emotional Pitch',
    ]
    const header = itemGrainHeader(eight)
    // Column P is index 15 (A=0), column W is index 22.
    expect(header.indexOf('Manageable')).toBe(15)
    expect(header.indexOf('Appropriate Emotional Pitch')).toBe(22)
    expect(header).toHaveLength(23)
  })
})

describe('buildItemGrainRows', () => {
  function entry(feedbackItemId: string, feedbackId: string): ItemGrainItem {
    return {
      feedbackItemId,
      item: item({ feedbackId }),
      batch: batch(),
    }
  }

  it('collapses scores from multiple teams and scorers into one row per item', () => {
    const rows = buildItemGrainRows(
      [entry('i1', 'F001')],
      [
        { feedbackItemId: 'i1', dimensionKey: 'criterion_1', value: 1 },
        { feedbackItemId: 'i1', dimensionKey: 'criterion_2', value: 0 },
        { feedbackItemId: 'i1', dimensionKey: 'criterion_3', value: 1 },
      ]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].dimensionScores).toEqual({
      criterion_1: 1,
      criterion_2: 0,
      criterion_3: 1,
    })
  })

  it('emits a row for a released but unscored item, with blank criteria', () => {
    const rows = buildItemGrainRows([entry('i1', 'F001')], [])
    expect(rows).toHaveLength(1)
    expect(itemGrainCells(rows[0], DIM_KEYS).slice(15)).toEqual(['', '', ''])
  })

  it('ignores scores for items outside the requested scope', () => {
    // A stray score must not resurrect an item the scope filter excluded.
    const rows = buildItemGrainRows(
      [entry('i1', 'F001')],
      [{ feedbackItemId: 'i-other', dimensionKey: 'criterion_1', value: 1 }]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].dimensionScores).toEqual({})
  })

  it('preserves item order from the query', () => {
    const rows = buildItemGrainRows(
      [entry('i1', 'F001'), entry('i2', 'F002'), entry('i3', 'F003')],
      []
    )
    expect(rows.map((r) => r.feedbackId)).toEqual(['F001', 'F002', 'F003'])
  })

  it('renders a full row in template order', () => {
    const rows = buildItemGrainRows(
      [entry('i1', 'F2475')],
      [
        { feedbackItemId: 'i1', dimensionKey: 'criterion_1', value: 1 },
        { feedbackItemId: 'i1', dimensionKey: 'criterion_3', value: 0 },
      ]
    )
    expect(itemGrainCells(rows[0], DIM_KEYS)).toEqual([
      '292',
      '21809248',
      '2',
      '9',
      'Because',
      'CETI needs a large amount of data.',
      'HUMAN',
      '1',
      '"Yes, the need for many examples is critical."',
      '1',
      '',
      'F2475',
      'Batch 31',
      'REGULAR',
      'Yes',
      '1',
      '',
      '0',
    ])
  })
})

describe('hasFullScoreSet', () => {
  const row = buildItemGrainRows(
    [{ feedbackItemId: 'i1', item: item(), batch: batch() }],
    [
      { feedbackItemId: 'i1', dimensionKey: 'criterion_1', value: 1 },
      { feedbackItemId: 'i1', dimensionKey: 'criterion_2', value: 0 },
    ]
  )[0]

  it('is false while any criterion is missing a final value', () => {
    expect(hasFullScoreSet(row, DIM_KEYS)).toBe(false)
  })

  it('is true once every criterion has a final value', () => {
    row.dimensionScores.criterion_3 = 1
    expect(hasFullScoreSet(row, DIM_KEYS)).toBe(true)
  })

  it('counts a legitimate 0 as present, not missing', () => {
    // The V12 scale is 0/1 — a 0 is a real score, so a falsy check would be a bug.
    const zeroed = buildItemGrainRows(
      [{ feedbackItemId: 'i1', item: item(), batch: batch() }],
      DIM_KEYS.map((key) => ({
        feedbackItemId: 'i1',
        dimensionKey: key,
        value: 0,
      }))
    )[0]
    expect(hasFullScoreSet(zeroed, DIM_KEYS)).toBe(true)
  })
})

// ---------------------------------------------------------------------------

describe('toCsv', () => {
  it('joins the header and rows with newlines', () => {
    expect(toCsv(['A', 'B'], [['1', '2'], ['3', '4']])).toBe('A,B\n1,2\n3,4')
  })

  it('emits a header-only file when there are no rows', () => {
    expect(toCsv(['A', 'B'], [])).toBe('A,B')
  })
})

describe('buildExportFilename', () => {
  it('keeps the pre-refactor names for the two original exports', () => {
    expect(buildExportFilename('raw-by-scorer', {}, '2026-07-28')).toBe(
      'scores-original-2026-07-28.csv'
    )
    expect(buildExportFilename('final-by-scorer', {}, '2026-07-28')).toBe(
      'scores-reconciled-2026-07-28.csv'
    )
  })

  it('names the collapsed export by its grain', () => {
    expect(buildExportFilename('final-by-item', {}, '2026-07-28')).toBe(
      'scores-reconciled-by-feedback-2026-07-28.csv'
    )
  })

  it('records the active filters so downloads are self-describing', () => {
    expect(
      buildExportFilename(
        'final-by-item',
        {
          activityId: '9',
          conjunctionId: 'Because',
          completeItemsOnly: true,
          finalizedBatchesOnly: true,
        },
        '2026-07-28'
      )
    ).toBe(
      'scores-reconciled-by-feedback-activity-9-conj-Because-complete-items-finalized-batches-2026-07-28.csv'
    )
  })
})

// ---------------------------------------------------------------------------

describe('discrepancy report', () => {
  const TEAMS = new Map([
    ['u-abi', { id: 't1', name: 'Team 1' }],
    ['u-luofan', { id: 't1', name: 'Team 1' }],
    ['u-jon', { id: 't2', name: 'Team 2' }],
    ['u-mei', { id: 't2', name: 'Team 2' }],
  ])
  const BATCH = {
    batchName: 'Batch 45',
    batchType: 'REGULAR',
    batchStatus: 'RECONCILING',
    batchSortOrder: 45,
  }

  function raw(
    overrides: Partial<DiscrepancyRawScore> & {
      userId: string
      value: number
    }
  ): DiscrepancyRawScore {
    return {
      feedbackItemId: 'i1',
      userEmail: `${overrides.userId.replace('u-', '')}@test.com`,
      dimensionKey: 'criterion_1',
      dimensionLabel: 'Manageable',
      dimensionSortOrder: 1,
      notes: null,
      item: item(),
      batch: BATCH,
      ...overrides,
    }
  }

  it('reports only the criteria where the pair disagreed', () => {
    const rows = buildDiscrepancyRows(
      [
        raw({ userId: 'u-abi', value: 1 }),
        raw({ userId: 'u-luofan', value: 2 }),
        raw({ userId: 'u-abi', value: 3, dimensionKey: 'criterion_2' }),
        raw({ userId: 'u-luofan', value: 3, dimensionKey: 'criterion_2' }),
      ],
      [],
      [],
      { teamByUserId: TEAMS }
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].dimensionKey).toBe('criterion_1')
    expect(rows[0].difference).toBe(1)
    expect(rows[0].resolution).toBe('Unresolved')
    expect(rows[0].finalValue).toBeNull()
  })

  it('puts the same annotator in the same column on every row (alphabetical)', () => {
    const rows = buildDiscrepancyRows(
      [
        raw({ userId: 'u-luofan', value: 2 }),
        raw({ userId: 'u-abi', value: 1 }),
        raw({ userId: 'u-abi', value: 2, dimensionKey: 'criterion_2' }),
        raw({ userId: 'u-luofan', value: 1, dimensionKey: 'criterion_2' }),
      ],
      [],
      [],
      { teamByUserId: TEAMS }
    )
    expect(rows.map((r) => r.evaluatorA.email)).toEqual([
      'abi@test.com',
      'abi@test.com',
    ])
    expect(rows.map((r) => r.evaluatorB.email)).toEqual([
      'luofan@test.com',
      'luofan@test.com',
    ])
  })

  it('skips cells that are not a completed pair (partner not yet scored)', () => {
    const rows = buildDiscrepancyRows(
      [raw({ userId: 'u-abi', value: 1 })],
      [],
      [],
      { teamByUserId: TEAMS }
    )
    expect(rows).toEqual([])
  })

  it('attaches the final value, who recorded it, and the rationale', () => {
    const rows = buildDiscrepancyRows(
      [
        raw({ userId: 'u-abi', value: 1, notes: 'Too vague' }),
        raw({ userId: 'u-luofan', value: 3 }),
      ],
      [
        {
          feedbackItemId: 'i1',
          ownerUserId: 'u-abi', // release-owner slot, not the actor
          dimensionKey: 'criterion_1',
          value: 3,
          notes: 'Discussed; feedback does name the next step.',
          recordedByEmail: 'luofan@test.com',
        },
      ],
      [],
      { teamByUserId: TEAMS }
    )
    expect(rows[0].finalValue).toBe(3)
    expect(rows[0].resolution).toBe('Reconciled')
    expect(rows[0].finalRecordedBy).toBe('luofan@test.com')
    expect(rows[0].reconciliationNotes).toBe(
      'Discussed; feedback does name the next step.'
    )
    expect(rows[0].evaluatorA.notes).toBe('Too vague')
    expect(rows[0].evaluatorB.notes).toBe('')
  })

  it('carries per-item notes and rationale onto every discrepancy row for that item', () => {
    // Notes are entered once per item; the DB repeats them on each dimension
    // row, but a note may only be present on the row for one criterion.
    const rows = buildDiscrepancyRows(
      [
        raw({ userId: 'u-abi', value: 1, notes: 'Hard call' }),
        raw({ userId: 'u-luofan', value: 2 }),
        raw({ userId: 'u-abi', value: 1, dimensionKey: 'criterion_2', dimensionSortOrder: 2 }),
        raw({ userId: 'u-luofan', value: 2, dimensionKey: 'criterion_2', dimensionSortOrder: 2 }),
      ],
      [
        {
          feedbackItemId: 'i1',
          ownerUserId: 'u-abi',
          dimensionKey: 'criterion_1',
          value: 2,
          notes: 'Agreed on B',
          recordedByEmail: null,
        },
      ],
      [],
      { teamByUserId: TEAMS }
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.evaluatorA.notes)).toEqual(['Hard call', 'Hard call'])
    expect(rows.map((r) => r.reconciliationNotes)).toEqual(['Agreed on B', 'Agreed on B'])
    // Only criterion_1 has a final; criterion_2 is still open.
    expect(rows.map((r) => r.resolution)).toEqual(['Reconciled', 'Unresolved'])
  })

  it('distinguishes escalated-pending from adjudicated', () => {
    const rows = buildDiscrepancyRows(
      [
        raw({ userId: 'u-abi', value: 1 }),
        raw({ userId: 'u-luofan', value: 2 }),
        raw({ userId: 'u-abi', value: 1, dimensionKey: 'criterion_2', dimensionSortOrder: 2 }),
        raw({ userId: 'u-luofan', value: 2, dimensionKey: 'criterion_2', dimensionSortOrder: 2 }),
      ],
      [
        {
          feedbackItemId: 'i1',
          ownerUserId: 'u-abi',
          dimensionKey: 'criterion_2',
          value: 1,
          notes: null,
          recordedByEmail: 'amber@test.com',
        },
      ],
      [
        { feedbackItemId: 'i1', teamId: 't1', dimensionKey: 'criterion_1', resolved: false },
        { feedbackItemId: 'i1', teamId: 't1', dimensionKey: 'criterion_2', resolved: true },
      ],
      { teamByUserId: TEAMS }
    )
    expect(rows.map((r) => [r.dimensionKey, r.resolution, r.finalValue])).toEqual([
      ['criterion_1', 'Escalated', null],
      ['criterion_2', 'Adjudicated', 1],
    ])
  })

  it('groups per team, so training batches yield one row per disagreeing pair', () => {
    // Two teams scored the same item × criterion; only Team 2 disagreed.
    const rows = buildDiscrepancyRows(
      [
        raw({ userId: 'u-abi', value: 2 }),
        raw({ userId: 'u-luofan', value: 2 }),
        raw({ userId: 'u-jon', value: 1 }),
        raw({ userId: 'u-mei', value: 3 }),
      ],
      [
        // Team 1's final should not be mistaken for Team 2's.
        {
          feedbackItemId: 'i1',
          ownerUserId: 'u-abi',
          dimensionKey: 'criterion_1',
          value: 2,
          notes: null,
          recordedByEmail: null,
        },
      ],
      [],
      { teamByUserId: TEAMS }
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].teamName).toBe('Team 2')
    expect(rows[0].difference).toBe(2)
    expect(rows[0].resolution).toBe('Unresolved')
  })

  it('orders rows by batch, then item, then rubric order', () => {
    const rows = buildDiscrepancyRows(
      [
        raw({ userId: 'u-abi', value: 1, feedbackItemId: 'i2', item: item({ feedbackId: 'F2' }), dimensionKey: 'criterion_2', dimensionSortOrder: 2 }),
        raw({ userId: 'u-luofan', value: 2, feedbackItemId: 'i2', item: item({ feedbackId: 'F2' }), dimensionKey: 'criterion_2', dimensionSortOrder: 2 }),
        raw({ userId: 'u-abi', value: 1, feedbackItemId: 'i2', item: item({ feedbackId: 'F2' }) }),
        raw({ userId: 'u-luofan', value: 2, feedbackItemId: 'i2', item: item({ feedbackId: 'F2' }) }),
        raw({ userId: 'u-abi', value: 1, item: item({ feedbackId: 'F1' }), batch: { ...BATCH, batchName: 'Batch 9', batchSortOrder: 9 } }),
        raw({ userId: 'u-luofan', value: 2, item: item({ feedbackId: 'F1' }), batch: { ...BATCH, batchName: 'Batch 9', batchSortOrder: 9 } }),
      ],
      [],
      [],
      { teamByUserId: TEAMS }
    )
    expect(rows.map((r) => [r.batchName, r.feedbackId, r.dimensionKey])).toEqual([
      ['Batch 9', 'F1', 'criterion_1'],
      ['Batch 45', 'F2', 'criterion_1'],
      ['Batch 45', 'F2', 'criterion_2'],
    ])
  })

  it('pins the column order', () => {
    expect(discrepancyHeader()).toEqual([
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
    ])
    expect(discrepancyHeader()).toHaveLength(12 + DISCREPANCY_COLUMNS.length)
  })

  it('renders cells in header order, with a blank Final_Score when unresolved', () => {
    const [row] = buildDiscrepancyRows(
      [raw({ userId: 'u-abi', value: 1 }), raw({ userId: 'u-luofan', value: 3 })],
      [],
      [],
      { teamByUserId: TEAMS }
    )
    const cells = discrepancyCells(row)
    expect(cells).toHaveLength(discrepancyHeader().length)
    const at = (name: string) => cells[discrepancyHeader().indexOf(name)]
    expect(at('Feedback_ID')).toBe('F2475')
    expect(at('Feedback_Source')).toBe('HUMAN')
    expect(at('Batch_Name')).toBe('Batch 45')
    expect(at('Team_Name')).toBe('Team 1')
    expect(at('Evaluator_A_Score')).toBe('1')
    expect(at('Evaluator_B_Score')).toBe('3')
    expect(at('Difference')).toBe('2')
    expect(at('Final_Score')).toBe('')
    expect(at('Resolution')).toBe('Unresolved')
  })
})

describe('buildDiscrepancyFilename', () => {
  it('keeps the original per-batch name', () => {
    expect(
      buildDiscrepancyFilename({ kind: 'batch', batchName: 'Batch 45' }, '2026-09-08')
    ).toBe('discrepancies-Batch-45-2026-09-08.csv')
  })

  it('names the aggregate by its scope', () => {
    expect(
      buildDiscrepancyFilename(
        { kind: 'all-double-scored', completeBatchesOnly: false },
        '2026-09-08'
      )
    ).toBe('discrepancies-all-double-scored-2026-09-08.csv')
    expect(
      buildDiscrepancyFilename(
        { kind: 'all-double-scored', completeBatchesOnly: true },
        '2026-09-08'
      )
    ).toBe('discrepancies-all-double-scored-complete-2026-09-08.csv')
  })
})
