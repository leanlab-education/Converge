import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ScoreAutosave,
  buildScorePayload,
  scoreSnapshot,
  type AutosaveStatus,
} from '@/lib/score-autosave'

// A persist() whose promises are resolved by the test, so we can hold a save
// "in flight" and make changes underneath it.
function deferredPersist() {
  const calls: {
    itemId: string
    payload: string
    resolve: (ok: boolean) => void
    reject: (err: unknown) => void
  }[] = []
  const persist = vi.fn(
    (itemId: string, payload: string) =>
      new Promise<boolean>((resolve, reject) => {
        calls.push({ itemId, payload, resolve, reject })
      })
  )
  return { persist, calls }
}

// Let chained promise continuations run (no timers involved).
async function tick() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function make(debounceMs = 1000) {
  const { persist, calls } = deferredPersist()
  const statuses: [string, AutosaveStatus][] = []
  const autosave = new ScoreAutosave<string>({
    debounceMs,
    persist,
    onStatus: (id, s) => statuses.push([id, s]),
  })
  // Payload and snapshot are the same string here; the component derives
  // both from the same state, so that is faithful enough.
  const update = (id: string, state: string) => autosave.update(id, state, state)
  return { autosave, persist, calls, statuses, update }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('ScoreAutosave debounce', () => {
  it('sends one save with the latest state after the quiet period', async () => {
    const { calls, update, persist } = make()
    update('F1', 'A')
    await vi.advanceTimersByTimeAsync(500)
    update('F1', 'A+B')
    await vi.advanceTimersByTimeAsync(999)
    expect(persist).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.map((c) => c.payload)).toEqual(['A+B'])
  })

  it('does not re-send an item whose loaded state matches the server', async () => {
    const { autosave, update, persist, statuses } = make()
    autosave.markSaved('F1', 'A+B')
    update('F1', 'A+B') // what the effect does on arrival at a scored item
    await vi.advanceTimersByTimeAsync(2000)
    expect(persist).not.toHaveBeenCalled()
    expect(autosave.isDirty('F1')).toBe(false)
    expect(statuses).toEqual([['F1', 'saved']])
  })

  it('cancels the pending save when the user reverts within the window', async () => {
    const { autosave, update, persist, statuses } = make()
    autosave.markSaved('F1', 'A')
    update('F1', 'B')
    await vi.advanceTimersByTimeAsync(300)
    update('F1', 'A')
    await vi.advanceTimersByTimeAsync(2000)
    expect(persist).not.toHaveBeenCalled()
    expect(autosave.isDirty()).toBe(false)
    expect(statuses.at(-1)).toEqual(['F1', 'saved'])
  })
})

describe('ScoreAutosave with a save in flight (Batch 65 / F4287)', () => {
  it('re-sends a criterion picked while the previous save is still in flight', async () => {
    // The old code dropped criterion B here: the timer fired while A's request
    // was out, hit `if (saveInProgress) return`, and nothing re-triggered it.
    const { autosave, calls, update, statuses } = make()
    update('F4287', 'A')
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls.map((c) => c.payload)).toEqual(['A'])

    update('F4287', 'A+B') // picked while A is in flight
    await vi.advanceTimersByTimeAsync(1000) // B's own debounce fires meanwhile
    expect(calls).toHaveLength(1) // serialized: nothing goes out until A lands
    expect(autosave.isDirty('F4287')).toBe(true)
    // Status must not read "saved" while B is unsent.
    expect(statuses.some(([, s]) => s === 'saved')).toBe(false)

    calls[0].resolve(true)
    await tick()
    expect(calls.map((c) => c.payload)).toEqual(['A', 'A+B'])
    expect(autosave.isDirty('F4287')).toBe(true)

    calls[1].resolve(true)
    await tick()
    expect(autosave.isDirty('F4287')).toBe(false)
    expect(statuses.at(-1)).toEqual(['F4287', 'saved'])
  })

  it('re-sends immediately after the in-flight save lands, without waiting out the debounce', async () => {
    const { calls, update } = make()
    update('F1', 'A')
    await vi.advanceTimersByTimeAsync(1000)
    update('F1', 'A+B') // debounce for this change has NOT elapsed yet
    calls[0].resolve(true)
    await tick()
    expect(calls.map((c) => c.payload)).toEqual(['A', 'A+B'])
  })

  it('keeps the chip on "saving" rather than flashing back to idle during a follow-up', async () => {
    const { calls, update, statuses } = make()
    update('F1', 'A')
    await vi.advanceTimersByTimeAsync(1000)
    update('F1', 'A+B')
    calls[0].resolve(true)
    await tick()
    calls[1].resolve(true)
    await tick()
    expect(statuses).toEqual([
      ['F1', 'idle'],
      ['F1', 'saving'],
      ['F1', 'saved'],
    ])
  })

  it('re-saves a revert made during flight, because the server now holds the intermediate state', async () => {
    const { autosave, calls, update } = make()
    autosave.markSaved('F1', 'A')
    update('F1', 'B')
    await vi.advanceTimersByTimeAsync(1000)
    update('F1', 'A') // back to what was persisted before B went out
    calls[0].resolve(true) // ...but B has now landed
    await tick()
    expect(calls.map((c) => c.payload)).toEqual(['B', 'A'])
    calls[1].resolve(true)
    await tick()
    expect(autosave.isDirty()).toBe(false)
  })

  it('treats a failed save as "saved" if the user reverted to the persisted state meanwhile', async () => {
    const { autosave, calls, update, statuses } = make()
    autosave.markSaved('F1', 'A')
    update('F1', 'B')
    await vi.advanceTimersByTimeAsync(1000)
    update('F1', 'A')
    calls[0].resolve(false)
    await tick()
    expect(autosave.isDirty()).toBe(false)
    expect(statuses.at(-1)).toEqual(['F1', 'saved'])
  })
})

describe('ScoreAutosave.flush (navigation)', () => {
  it('cancels the debounce and saves the latest state at once', async () => {
    const { autosave, calls, update } = make()
    update('F1', 'A')
    update('F1', 'A+B')
    await vi.advanceTimersByTimeAsync(200) // user clicks a nav circle
    const done = autosave.flush('F1')
    await tick()
    expect(calls.map((c) => c.payload)).toEqual(['A+B'])
    calls[0].resolve(true)
    await expect(done).resolves.toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toHaveLength(1) // the cancelled timer never fires a duplicate
  })

  it('resolves true immediately for a clean item without a request', async () => {
    const { autosave, persist, update } = make()
    autosave.markSaved('F1', 'A')
    update('F1', 'A')
    await expect(autosave.flush('F1')).resolves.toBe(true)
    expect(persist).not.toHaveBeenCalled()
  })

  it('waits for an in-flight save and any follow-up before resolving', async () => {
    const { autosave, calls, update } = make()
    update('F1', 'A')
    await vi.advanceTimersByTimeAsync(1000)
    update('F1', 'A+B')
    let settled: boolean | null = null
    autosave.flush('F1').then((ok) => (settled = ok))
    await tick()
    expect(settled).toBeNull()
    calls[0].resolve(true)
    await tick()
    expect(settled).toBeNull() // A+B still unsent
    expect(calls).toHaveLength(2)
    calls[1].resolve(true)
    await tick()
    expect(settled).toBe(true)
  })

  it('resolves false when the save fails and leaves the item dirty', async () => {
    const { autosave, calls, update } = make()
    update('F1', 'A')
    const done = autosave.flush('F1')
    await tick()
    calls[0].resolve(false)
    await expect(done).resolves.toBe(false)
    expect(autosave.isDirty('F1')).toBe(true)
  })

  it('flushAll covers every dirty item and reports the combined result', async () => {
    const { autosave, calls, update } = make()
    update('F1', 'A')
    update('F2', 'X')
    autosave.markSaved('F3', 'Z')
    update('F3', 'Z')
    const done = autosave.flushAll()
    await tick()
    expect(calls.map((c) => c.itemId)).toEqual(['F1'])
    calls[0].resolve(true)
    await tick()
    expect(calls.map((c) => c.itemId)).toEqual(['F1', 'F2'])
    calls[1].resolve(false)
    await expect(done).resolves.toBe(false)
    expect(autosave.isDirty('F1')).toBe(false)
    expect(autosave.isDirty('F2')).toBe(true)
  })
})

describe('ScoreAutosave serialization and failure handling', () => {
  it('never runs two requests concurrently, even across items', async () => {
    const { calls, update } = make()
    update('F1', 'A')
    update('F2', 'X')
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toHaveLength(1)
    calls[0].resolve(true)
    await tick()
    expect(calls.map((c) => c.itemId)).toEqual(['F1', 'F2'])
  })

  it('reports an error, stays dirty, and does not retry on its own', async () => {
    const { autosave, calls, update, statuses, persist } = make()
    update('F1', 'A')
    await vi.advanceTimersByTimeAsync(1000)
    calls[0].reject(new Error('423 locked'))
    await tick()
    expect(statuses.at(-1)).toEqual(['F1', 'error'])
    expect(autosave.isDirty('F1')).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('retries a failed item on the next change or explicit flush', async () => {
    const { autosave, calls, update } = make()
    update('F1', 'A')
    await vi.advanceTimersByTimeAsync(1000)
    calls[0].resolve(false)
    await tick()
    const retry = autosave.flush('F1') // the "Retry" button
    await tick()
    expect(calls.map((c) => c.payload)).toEqual(['A', 'A'])
    calls[1].resolve(true)
    await expect(retry).resolves.toBe(true)
    expect(autosave.isDirty()).toBe(false)
  })

  it('a change made during a failing save is still sent by its own debounce', async () => {
    const { calls, update } = make()
    update('F1', 'A')
    await vi.advanceTimersByTimeAsync(1000)
    update('F1', 'A+B')
    calls[0].resolve(false)
    await tick()
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls.map((c) => c.payload)).toEqual(['A', 'A+B'])
  })

  it('save() forces a request even when nothing changed', async () => {
    const { autosave, calls, update } = make()
    autosave.markSaved('F1', 'A')
    update('F1', 'A')
    const done = autosave.save('F1', 'A', 'A')
    await tick()
    expect(calls.map((c) => c.payload)).toEqual(['A'])
    calls[0].resolve(true)
    await expect(done).resolves.toBe(true)
    expect(autosave.isDirty()).toBe(false)
  })

  it('reset() drops pending timers and dirtiness', async () => {
    const { autosave, persist, update } = make()
    update('F1', 'A')
    autosave.reset()
    await vi.advanceTimersByTimeAsync(5000)
    expect(persist).not.toHaveBeenCalled()
    expect(autosave.isDirty()).toBe(false)
  })
})

describe('buildScorePayload / scoreSnapshot', () => {
  const state = {
    scores: [
      { dimensionId: 'd1', value: 1 },
      { dimensionId: 'd2', value: null },
      { dimensionId: 'd3', value: 0 },
    ],
    notes: '',
    startedAt: null,
  }

  it('sends only criteria with a value (0 counts as a value)', () => {
    expect(buildScorePayload(state).scores).toEqual([
      { dimensionId: 'd1', value: 1 },
      { dimensionId: 'd3', value: 0 },
    ])
  })

  it('omits empty notes and missing startedAt', () => {
    const payload = buildScorePayload(state)
    expect(payload).not.toHaveProperty('notes', '')
    expect(payload.notes).toBeUndefined()
    expect(payload.startedAt).toBeUndefined()
    expect(
      buildScorePayload({ ...state, notes: 'n', startedAt: '2026-10-19T00:00:00Z' })
    ).toMatchObject({ notes: 'n', startedAt: '2026-10-19T00:00:00Z' })
  })

  it('snapshot changes with scores and notes but not with timing', () => {
    const a = scoreSnapshot(state)
    expect(scoreSnapshot({ ...state, startedAt: '2026-10-19T00:00:00Z' })).toBe(a)
    expect(scoreSnapshot({ ...state, notes: 'x' })).not.toBe(a)
    expect(
      scoreSnapshot({
        ...state,
        scores: state.scores.map((s) =>
          s.dimensionId === 'd2' ? { ...s, value: 1 } : s
        ),
      })
    ).not.toBe(a)
  })
})
