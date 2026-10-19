import { describe, it, expect } from 'vitest'
import {
  buildItemStates,
  dirtyItemIds,
  finalKey,
  isItemDirty,
  isOpenCell,
  mergeLocalSelections,
  type ItemReconcileState,
  type PersistedFinal,
  type StateItem,
} from '@/lib/reconcile-item-state'

const ESC = { id: 'esc' }
const ADJ = { resolvedByEmail: 'adj@test.com' }

function item(
  id: string,
  cells: { dim: string; escalated?: boolean; adjudicated?: boolean }[],
  agreements: { dimensionId: string; value: number }[] = []
): StateItem {
  return {
    feedbackItemId: id,
    agreements,
    discrepancies: cells.map((c) => ({
      dimensionId: c.dim,
      escalation: c.escalated ? ESC : null,
      adjudication: c.adjudicated ? ADJ : null,
    })),
  }
}

function final(
  feedbackItemId: string,
  dimensionId: string,
  value: number,
  notes: string | null = null
): PersistedFinal {
  return { feedbackItemId, dimensionId, value, notes }
}

describe('isOpenCell', () => {
  it('is open only when neither escalated nor adjudicated', () => {
    expect(isOpenCell({ dimensionId: 'd', escalation: null, adjudication: null })).toBe(true)
    expect(isOpenCell({ dimensionId: 'd', escalation: ESC, adjudication: null })).toBe(false)
    expect(isOpenCell({ dimensionId: 'd', escalation: null, adjudication: ADJ })).toBe(false)
  })
})

describe('buildItemStates', () => {
  it('pre-fills agreed cells, restores persisted finals, and leaves open cells null', () => {
    const items = [item('i1', [{ dim: 'd1' }, { dim: 'd2' }], [{ dimensionId: 'd3', value: 3 }])]
    const { states, persistedFinals, persistedNotes } = buildItemStates(items, [
      final('i1', 'd1', 2, 'we talked'),
    ])
    expect(states.i1.scores).toEqual({ d1: 2, d2: null, d3: 3 })
    expect(states.i1.notes).toBe('we talked')
    expect(states.i1.saved).toBe(false) // d2 still open with no final
    expect(persistedFinals).toEqual({ [finalKey('i1', 'd1')]: 2 })
    expect(persistedNotes).toEqual({ i1: 'we talked' })
  })

  it('marks an item saved when every discrepancy is escalated or has a final', () => {
    const items = [
      item('all-escalated', [{ dim: 'd1', escalated: true }]),
      item('all-final', [{ dim: 'd1' }]),
      item('mixed-open', [{ dim: 'd1', escalated: true }, { dim: 'd2' }]),
    ]
    const { states } = buildItemStates(items, [final('all-final', 'd1', 1)])
    expect(states['all-escalated'].saved).toBe(true)
    expect(states['all-final'].saved).toBe(true)
    expect(states['mixed-open'].saved).toBe(false)
  })

  it('records empty notes for items the server has none for', () => {
    const { persistedNotes } = buildItemStates([item('i1', [{ dim: 'd1' }])], [])
    expect(persistedNotes.i1).toBe('')
  })
})

describe('isItemDirty', () => {
  const it1 = item('i1', [{ dim: 'd1' }, { dim: 'd2', escalated: true }])
  const persistedFinals = { [finalKey('i1', 'd1')]: 2 }
  const persistedNotes = { i1: 'because' }

  function st(over: Partial<ItemReconcileState>): ItemReconcileState {
    return { scores: { d1: 2, d2: null }, notes: 'because', saved: false, ...over }
  }

  it('a freshly loaded, partially reconciled item is not dirty', () => {
    expect(isItemDirty(it1, st({}), persistedFinals, persistedNotes)).toBe(false)
  })

  it('a chosen value that differs from the persisted final is dirty', () => {
    expect(isItemDirty(it1, st({ scores: { d1: 3, d2: null } }), persistedFinals, persistedNotes)).toBe(true)
  })

  it('a first pick on a cell with no persisted final is dirty', () => {
    const fresh = item('i2', [{ dim: 'd1' }])
    expect(isItemDirty(fresh, st({ scores: { d1: 1 } }), {}, {})).toBe(true)
  })

  it('a null (unpicked) open cell is not dirty', () => {
    const fresh = item('i2', [{ dim: 'd1' }])
    expect(isItemDirty(fresh, st({ scores: { d1: null }, notes: '' }), {}, {})).toBe(false)
  })

  it('a value picked on an escalated cell does not count — the adjudicator owns it', () => {
    expect(isItemDirty(it1, st({ scores: { d1: 2, d2: 1 } }), persistedFinals, persistedNotes)).toBe(false)
  })

  it('a value on an adjudicated cell does not count either', () => {
    const adj = item('i3', [{ dim: 'd1', adjudicated: true }])
    expect(isItemDirty(adj, st({ scores: { d1: 3 }, notes: '' }), { [finalKey('i3', 'd1')]: 1 }, {})).toBe(false)
  })

  it('an edited rationale is dirty, whitespace-only edits are not', () => {
    expect(isItemDirty(it1, st({ notes: 'because we discussed' }), persistedFinals, persistedNotes)).toBe(true)
    expect(isItemDirty(it1, st({ notes: '  because ' }), persistedFinals, persistedNotes)).toBe(false)
  })

  it('a saved item is never dirty, and a missing state is never dirty', () => {
    expect(isItemDirty(it1, st({ saved: true, scores: { d1: 3 } }), persistedFinals, persistedNotes)).toBe(false)
    expect(isItemDirty(it1, undefined, persistedFinals, persistedNotes)).toBe(false)
  })

  it('dirtyItemIds returns ids in list order', () => {
    const items = [item('a', [{ dim: 'd1' }]), item('b', [{ dim: 'd1' }]), item('c', [{ dim: 'd1' }])]
    const states = {
      a: st({ scores: { d1: 1 }, notes: '' }),
      b: st({ scores: { d1: null }, notes: '' }),
      c: st({ scores: { d1: 2 }, notes: '' }),
    }
    expect(dirtyItemIds(items, states, {}, {})).toEqual(['a', 'c'])
  })
})

describe('mergeLocalSelections', () => {
  const items = [
    item('i7', [{ dim: 'd1' }]),
    item('i8', [{ dim: 'd1' }, { dim: 'd2', escalated: true }]),
    item('i9', [{ dim: 'd1' }]),
  ]

  it('the server wins where it holds a final; unsaved picks elsewhere survive the refetch', () => {
    // Partner recorded i7 = 2 (the 409); the user had picked 3 on i7 and 1 on i9.
    const server = buildItemStates(items, [final('i7', 'd1', 2, 'partner note')])
    const local: Record<string, ItemReconcileState> = {
      i7: { scores: { d1: 3 }, notes: '', saved: false },
      i8: { scores: { d1: null, d2: null }, notes: '', saved: false },
      i9: { scores: { d1: 1 }, notes: 'my reasoning', saved: false },
    }
    const merged = mergeLocalSelections(items, server, local)
    expect(merged.i7).toEqual({ scores: { d1: 2 }, notes: 'partner note', saved: true })
    expect(merged.i8).toEqual({ scores: { d1: null, d2: null }, notes: '', saved: false })
    expect(merged.i9).toEqual({ scores: { d1: 1 }, notes: 'my reasoning', saved: false })
  })

  it('a local pick on an escalated cell is dropped — the adjudicator owns it', () => {
    const server = buildItemStates(items, [])
    const local: Record<string, ItemReconcileState> = {
      i8: { scores: { d1: null, d2: 3 }, notes: '', saved: false },
    }
    const merged = mergeLocalSelections(items, server, local)
    expect(merged.i8.scores.d2).toBeNull()
  })

  it('a local change to a cell the server now holds is discarded and the item stays saved', () => {
    // Server: i8's d1 has a final (d2 is escalated) → saved. The user had
    // changed d1 locally; the server holds that cell, so the server wins.
    const server = buildItemStates(items, [final('i8', 'd1', 1)])
    const local: Record<string, ItemReconcileState> = {
      i8: { scores: { d1: 3, d2: null }, notes: '', saved: false },
    }
    const merged = mergeLocalSelections(items, server, local)
    expect(merged.i8.scores.d1).toBe(1)
    expect(merged.i8.saved).toBe(true)
  })

  it('local rationale is kept when non-empty and different; empty local defers to the server', () => {
    const server = buildItemStates(items, [final('i7', 'd1', 2, 'partner note')])
    const merged = mergeLocalSelections(items, server, {
      i7: { scores: { d1: 2 }, notes: '', saved: true },
      i9: { scores: { d1: null }, notes: 'draft', saved: false },
    })
    expect(merged.i7.notes).toBe('partner note')
    expect(merged.i7.saved).toBe(true)
    expect(merged.i9.notes).toBe('draft')
    expect(merged.i9.saved).toBe(false)
  })

  it('items without local state take the server state; items the server dropped vanish', () => {
    const server = buildItemStates(items.slice(0, 2), [])
    const merged = mergeLocalSelections(items.slice(0, 2), server, {
      i9: { scores: { d1: 1 }, notes: '', saved: false },
    })
    expect(Object.keys(merged).sort()).toEqual(['i7', 'i8'])
    expect(merged.i7).toEqual(server.states.i7)
  })
})
