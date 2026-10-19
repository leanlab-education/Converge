import { describe, it, expect } from 'vitest'
import { deriveReconcileOutcome, pendingItemIds } from '@/lib/reconcile-outcome'
import type { ItemReconcileState, StateItem } from '@/lib/reconcile-item-state'

const ESC = { id: 'esc' }
const ADJ = { resolvedByEmail: 'adj@test.com' }

function item(
  id: string,
  cells: { dim: string; escalated?: boolean; adjudicated?: boolean }[]
): StateItem {
  return {
    feedbackItemId: id,
    agreements: [],
    discrepancies: cells.map((c) => ({
      dimensionId: c.dim,
      escalation: c.escalated ? ESC : null,
      adjudication: c.adjudicated ? ADJ : null,
    })),
  }
}

function state(saved: boolean, scores: Record<string, number | null> = {}): ItemReconcileState {
  return { scores, notes: '', saved }
}

const base = {
  releaseStatus: 'RECONCILING' as string | null,
  openEscalationCount: 0,
  fetchError: null as string | null,
}

describe('deriveReconcileOutcome', () => {
  it('reports a failed fetch before anything else, even with stale items on hand', () => {
    const outcome = deriveReconcileOutcome({
      ...base,
      releaseStatus: 'COMPLETE',
      fetchError: 'Failed to fetch discrepancies',
      items: [item('i1', [{ dim: 'd1' }])],
      itemStates: { i1: state(true, { d1: 2 }) },
    })
    expect(outcome).toEqual({ kind: 'error', message: 'Failed to fetch discrepancies' })
  })

  it('shows "no discrepancies" only when the server returned none AND says COMPLETE', () => {
    expect(
      deriveReconcileOutcome({ ...base, releaseStatus: 'COMPLETE', items: [], itemStates: {} })
    ).toEqual({ kind: 'no-discrepancies' })
  })

  it('does not claim "no discrepancies" for an empty list while the release is still RECONCILING', () => {
    expect(
      deriveReconcileOutcome({ ...base, items: [], itemStates: {} })
    ).toEqual({ kind: 'finalizing' })
  })

  it('stays in progress while any unsaved item has an open cell', () => {
    const items = [item('i1', [{ dim: 'd1' }]), item('i2', [{ dim: 'd1' }])]
    const outcome = deriveReconcileOutcome({
      ...base,
      items,
      itemStates: { i1: state(true, { d1: 3 }), i2: state(false, { d1: null }) },
    })
    expect(outcome).toEqual({ kind: 'in-progress', pendingItemIds: ['i2'] })
  })

  it('treats an edited (saved → unsaved) item as pending even when the server says COMPLETE', () => {
    // Review mode: the pair re-opened a completed release and changed a value.
    const outcome = deriveReconcileOutcome({
      ...base,
      releaseStatus: 'COMPLETE',
      items: [item('i1', [{ dim: 'd1' }])],
      itemStates: { i1: state(false, { d1: 1 }) },
    })
    expect(outcome.kind).toBe('in-progress')
  })

  it('celebrates only when the server status is COMPLETE', () => {
    const outcome = deriveReconcileOutcome({
      ...base,
      releaseStatus: 'COMPLETE',
      items: [item('i1', [{ dim: 'd1' }])],
      itemStates: { i1: state(true, { d1: 2 }) },
    })
    expect(outcome).toEqual({ kind: 'complete' })
  })

  it('a pair that escalated everything is told the adjudicator is holding it up, not "complete"', () => {
    // Every cell escalated: nothing left for the pair, release still RECONCILING.
    const items = [
      item('i1', [{ dim: 'd1', escalated: true }]),
      item('i2', [{ dim: 'd1', escalated: true }, { dim: 'd2', escalated: true }]),
    ]
    const outcome = deriveReconcileOutcome({
      ...base,
      openEscalationCount: 3,
      items,
      itemStates: { i1: state(true), i2: state(true) },
    })
    expect(outcome).toEqual({
      kind: 'awaiting-adjudicator',
      openEscalationCount: 3,
      itemIds: ['i1', 'i2'],
    })
  })

  it('lists only the items that carry an open escalation', () => {
    const items = [
      item('i1', [{ dim: 'd1' }]),
      item('i2', [{ dim: 'd1', escalated: true }]),
      item('i3', [{ dim: 'd1', adjudicated: true }]),
    ]
    const outcome = deriveReconcileOutcome({
      ...base,
      openEscalationCount: 1,
      items,
      itemStates: { i1: state(true, { d1: 2 }), i2: state(true), i3: state(true, { d1: 1 }) },
    })
    expect(outcome).toEqual({
      kind: 'awaiting-adjudicator',
      openEscalationCount: 1,
      itemIds: ['i2'],
    })
  })

  it('an escalated cell does not count as "done" for the pair if the item is unsaved with another open cell', () => {
    const items = [item('i1', [{ dim: 'd1', escalated: true }, { dim: 'd2' }])]
    const outcome = deriveReconcileOutcome({
      ...base,
      openEscalationCount: 1,
      items,
      itemStates: { i1: state(false, { d1: null, d2: null }) },
    })
    expect(outcome).toEqual({ kind: 'in-progress', pendingItemIds: ['i1'] })
  })

  it('an item whose only cells are adjudicated has nothing pending', () => {
    const items = [item('i1', [{ dim: 'd1', adjudicated: true }])]
    const outcome = deriveReconcileOutcome({
      ...base,
      items,
      // Adjudicated cells have a final, so the seed marks the item saved.
      itemStates: { i1: state(true, { d1: 2 }) },
    })
    expect(outcome).toEqual({ kind: 'finalizing' })
  })

  it('falls through to "finalizing" when everything is recorded, nothing is escalated, but the server has not flipped yet', () => {
    const outcome = deriveReconcileOutcome({
      ...base,
      items: [item('i1', [{ dim: 'd1' }])],
      itemStates: { i1: state(true, { d1: 2 }) },
    })
    expect(outcome).toEqual({ kind: 'finalizing' })
  })

  it('a null release status (never loaded) is never treated as COMPLETE', () => {
    const outcome = deriveReconcileOutcome({
      ...base,
      releaseStatus: null,
      items: [item('i1', [{ dim: 'd1' }])],
      itemStates: { i1: state(true, { d1: 2 }) },
    })
    expect(outcome.kind).toBe('finalizing')
  })
})

describe('pendingItemIds', () => {
  it('excludes saved items and items with no open cells, keeps list order', () => {
    const items = [
      item('a', [{ dim: 'd1' }]),
      item('b', [{ dim: 'd1', escalated: true }]),
      item('c', [{ dim: 'd1' }]),
      item('d', [{ dim: 'd1', adjudicated: true }]),
    ]
    const states = {
      a: state(false),
      b: state(false),
      c: state(false),
      d: state(false),
    }
    expect(pendingItemIds(items, states)).toEqual(['a', 'c'])
  })

  it('treats a missing state entry as unsaved', () => {
    expect(pendingItemIds([item('a', [{ dim: 'd1' }])], {})).toEqual(['a'])
  })
})
