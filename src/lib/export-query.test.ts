// Mock @/lib/db BEFORE importing the module under test.
import { prismaMock } from '../../test/prisma-mock'
import { describe, it, expect, vi } from 'vitest'
import { buildExportCsv, countExportRows, type ExportScope } from '@/lib/export-query'

// Wiring test for the final-value exports: the pure pieces (the expected-scorer
// predicate, conflict detection) are unit-tested in evaluator-stats.test.ts and
// export.test.ts; this pins that export-query actually runs the raw "finals" of
// an independent batch through that predicate instead of trusting every
// isReconciled:false row.

const PROJECT = 'p1'
const scope: ExportScope = {
  projectId: PROJECT,
  activityId: null,
  conjunctionId: null,
  completeItemsOnly: false,
  finalizedBatchesOnly: false,
}
const DIM_KEYS = ['c1', 'c2']
const DIM_LABELS = ['Criterion 1', 'Criterion 2']

// Independent batch B: u-a (slot 0) and u-b (slot 1) own both criteria.
const members = [{ userId: 'u-a' }, { userId: 'u-b' }]
const dimensions = [{ dimensionId: 'd1' }, { dimensionId: 'd2' }]
const batchB = { id: 'B', projectId: PROJECT, isDoubleScored: false, type: 'REGULAR' }
const assignments = ['u-a', 'u-b'].map((userId) => ({
  userId,
  teamRelease: { id: 'r', scorerUserId: null, team: { members, dimensions } },
  batch: batchB,
}))

function itemRow(id: string, feedbackId: string, slotIndex: number) {
  return {
    id,
    feedbackId,
    batchId: 'B',
    slotIndex,
    responseId: null,
    studentId: 's',
    cycleId: null,
    activityId: null,
    conjunctionId: null,
    studentText: 'text',
    feedbackSource: 'AI',
    teacherId: null,
    feedbackText: 'fb',
    optimal: null,
    feedbackType: null,
    batch: { name: 'Batch 1', type: 'REGULAR', isDoubleScored: false },
  }
}

function candidate(
  feedbackItemId: string,
  userId: string,
  dimensionId: 'd1' | 'd2',
  value: number,
  isReconciled = false
) {
  return {
    feedbackItemId,
    userId,
    dimensionId,
    isReconciled,
    value,
    dimension: { key: dimensionId === 'd1' ? 'c1' : 'c2' },
  }
}

function mockProject(
  items: ReturnType<typeof itemRow>[],
  candidates: ReturnType<typeof candidate>[]
) {
  prismaMock.batchAssignment.findMany.mockResolvedValue(assignments as never)
  prismaMock.feedbackItem.findMany.mockResolvedValue(items as never)
  prismaMock.rubricDimension.findMany.mockResolvedValue(
    [{ id: 'd1' }, { id: 'd2' }] as never
  )
  prismaMock.score.findMany.mockResolvedValue(candidates as never)
}

describe('final-by-item on an independent batch', () => {
  // F10 is in slot 1 (u-b's), F2 in slot 0 (u-a's).
  const items = [itemRow('i10', 'F10', 1), itemRow('i2', 'F2', 0)]

  it('takes the expected scorer’s raw score and drops a stray one from the partner or an admin', async () => {
    mockProject(items, [
      candidate('i2', 'u-a', 'd1', 1), // expected: u-a owns slot 0
      candidate('i2', 'u-b', 'd1', 0), // partner outside their slot — ignored
      candidate('i2', 'admin', 'd2', 0), // no assignment — ignored
      candidate('i10', 'u-b', 'd1', 0), // expected: u-b owns slot 1
      candidate('i10', 'u-a', 'd2', 1), // partner outside their slot — ignored
    ])

    const { rows, conflicts } = await buildExportCsv('final-by-item', scope, DIM_KEYS, DIM_LABELS)

    const criterionCells = rows.map((cells) => [cells[11], ...cells.slice(15)])
    expect(criterionCells).toEqual([
      ['F2', '1', ''], // d1 from u-a; the admin's d2 did not fill the cell
      ['F10', '0', ''], // d1 from u-b; u-a's d2 did not fill the cell
    ])
    expect(conflicts).toEqual([])
  })

  it('orders rows numerically by Feedback_ID even though the query returned F10 first', async () => {
    mockProject(items, [])
    const { rows } = await buildExportCsv('final-by-item', scope, DIM_KEYS, DIM_LABELS)
    expect(rows.map((cells) => cells[11])).toEqual(['F2', 'F10'])
  })

  it('always keeps reconciled rows, and reports a conflict when they disagree with the raw final', async () => {
    mockProject(items, [
      candidate('i2', 'u-a', 'd1', 1),
      candidate('i2', 'owner', 'd1', 0, true), // a reconciled row under a release owner
    ])

    const { rows, conflicts } = await buildExportCsv('final-by-item', scope, DIM_KEYS, DIM_LABELS)
    expect(rows[0].slice(15)).toEqual(['', ''])
    expect(conflicts).toEqual([
      { feedbackItemId: 'i2', feedbackId: 'F2', dimensionKey: 'c1', values: [1, 0] },
    ])

    const count = await countExportRows('final-by-item', scope, DIM_KEYS)
    expect(count).toEqual({ rowCount: 2, conflictCount: 1 })
  })
})

describe('final-by-scorer on an independent batch', () => {
  it('counts a row only for expected scorers, matching what the download emits', async () => {
    const items = [itemRow('i2', 'F2', 0)]
    mockProject(items, [
      candidate('i2', 'u-a', 'd1', 1),
      candidate('i2', 'admin', 'd1', 0),
    ])
    const count = await countExportRows('final-by-scorer', scope, DIM_KEYS)
    expect(count).toEqual({ rowCount: 1, conflictCount: 0 })
    expect(prismaMock.score.groupBy).not.toHaveBeenCalled()
  })

  it('still counts raw-by-scorer with a plain groupBy (every row is a row)', async () => {
    // groupBy's generic signature defeats the deep mock's typing; the runtime
    // proxy is still a vi.fn.
    ;(prismaMock.score.groupBy as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{}, {}, {}])
    const count = await countExportRows('raw-by-scorer', scope, DIM_KEYS)
    expect(count).toEqual({ rowCount: 3, conflictCount: 0 })
    expect(prismaMock.batchAssignment.findMany).not.toHaveBeenCalled()
  })
})
