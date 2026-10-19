/**
 * Loss-proof debounced save scheduler for the scoring screen.
 *
 * Why this exists: on 2026-10-19 we found Batch 65 / item F4287, where an
 * annotator's first criterion had saved in August but her second never did,
 * leaving the batch stuck in SCORING for two months while her screen read
 * "Saved". The old auto-save was a single timer owned by a React effect:
 * picking a second criterion while the first criterion's request was still in
 * flight hit `if (saveInProgress) return` and was never re-sent, and
 * navigating away inside the debounce window cancelled the timer outright.
 *
 * This class owns the timers and the request queue itself, outside React's
 * effect lifecycle, and holds three invariants:
 *
 *   1. Every `update()` is followed by a save attempt that includes it. A
 *      change made while a save is in flight is sent again as soon as that
 *      save lands, so nothing is dropped.
 *   2. Saves run one at a time, so a slow earlier request can never land after
 *      (and overwrite) a newer one. (`flushAllNow`, for beforeunload, is the
 *      one deliberate exception: it fires every dirty item at once because the
 *      page is about to go away.)
 *   3. `isDirty()` stays true until the latest local state is confirmed
 *      persisted, so callers can flush before navigating and warn on unload.
 *
 * A failed save keeps the item dirty (visible and retryable via `flush`) but
 * does not retry on its own, so a flaky connection cannot cause a request
 * loop. A *terminal* failure — the server said this state can never be
 * accepted (release no longer scoring, batch locked, item gone) — instead
 * marks the item clean with a notice: no retry, no unload warning, but the
 * reason is shown.
 *
 * The class is generic over the payload and takes a string `snapshot` of the
 * local state with each update; equality of snapshots is how it decides
 * whether anything still needs saving.
 */

export type AutosaveStatus =
  | 'idle'
  | 'saving'
  | 'saved'
  /** The save failed and may succeed if retried; the item stays dirty. */
  | 'error'
  /** The server refused this state for good; the item was dropped as clean. */
  | 'rejected'

export type PersistResult =
  | { ok: true }
  | { ok: false; message: string; terminal: boolean }

export const SAVE_FAILED_MESSAGE = 'Save failed'
export const UNREACHABLE_MESSAGE = 'Could not reach the server'

/** HTTP statuses after which re-sending the same save cannot succeed. */
export const TERMINAL_SAVE_STATUSES: ReadonlySet<number> = new Set([403, 404, 423])

export interface ScoreAutosaveOptions<P> {
  /** Quiet period after the last change before a save goes out. */
  debounceMs: number
  /** Persist one item. A throw counts as a retryable failure. */
  persist: (itemId: string, payload: P) => Promise<PersistResult>
  /**
   * Per-item status transitions, for the "Saving… / Saved / Save failed" chip.
   * `message` accompanies 'error' and 'rejected' with the server's reason.
   */
  onStatus?: (itemId: string, status: AutosaveStatus, message?: string) => void
}

interface Desired<P> {
  payload: P
  snapshot: string
}

export class ScoreAutosave<P> {
  /** Latest local state per item, whether or not it has been sent yet. */
  private readonly desired = new Map<string, Desired<P>>()
  /** Snapshot the server is known to hold per item. */
  private readonly persisted = new Map<string, string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Items whose save should go out as soon as the queue reaches them (FIFO). */
  private readonly due = new Set<string>()
  private readonly waiters = new Map<string, Array<(ok: boolean) => void>>()
  private readonly lastStatus = new Map<string, string>()
  private readonly inFlight = new Set<string>()
  private draining = false

  constructor(private readonly options: ScoreAutosaveOptions<P>) {}

  /** Seed what the server already holds so an untouched item is not re-sent. */
  markSaved(itemId: string, snapshot: string): void {
    this.persisted.set(itemId, snapshot)
  }

  /** Record an item's latest local state and (re)start its debounce. */
  update(itemId: string, payload: P, snapshot: string): void {
    this.desired.set(itemId, { payload, snapshot })
    this.clearTimer(itemId)

    if (!this.isItemDirty(itemId)) {
      // Back to exactly what the server holds: nothing to send. If a save of
      // an intermediate state is in flight, its completion re-checks this.
      if (!this.inFlight.has(itemId)) this.emit(itemId, 'saved')
      return
    }

    if (!this.inFlight.has(itemId)) this.emit(itemId, 'idle')
    this.timers.set(
      itemId,
      setTimeout(() => {
        this.timers.delete(itemId)
        this.enqueue(itemId)
      }, this.options.debounceMs)
    )
  }

  /**
   * Cancel the debounce and persist the item's latest state now. Resolves
   * `true` once that state is confirmed persisted (including any follow-up
   * save for changes made in the meantime), or `false` when a save failed —
   * retryably (the item stays dirty) or terminally (it was dropped).
   */
  flush(itemId: string): Promise<boolean> {
    if (!this.isItemDirty(itemId)) return Promise.resolve(true)
    this.clearTimer(itemId)
    return new Promise((resolve) => {
      const list = this.waiters.get(itemId) ?? []
      list.push(resolve)
      this.waiters.set(itemId, list)
      this.enqueue(itemId)
    })
  }

  /** Persist now even when nothing changed (explicit Continue / Update). */
  save(itemId: string, payload: P, snapshot: string): Promise<boolean> {
    this.desired.set(itemId, { payload, snapshot })
    this.persisted.delete(itemId)
    return this.flush(itemId)
  }

  /** Flush every dirty item, one at a time; `true` only when all persisted. */
  flushAll(): Promise<boolean> {
    const dirty = [...this.desired.keys()].filter((id) => this.isItemDirty(id))
    return Promise.all(dirty.map((id) => this.flush(id))).then((results) =>
      results.every(Boolean)
    )
  }

  /**
   * Fire a save for every dirty item at once, bypassing the one-at-a-time
   * queue. For beforeunload only: the page is going away, and a queue that
   * awaits each request would get just the first keepalive request out. Items
   * already in flight are left to land on their own (and re-queue themselves
   * if they changed meanwhile).
   */
  flushAllNow(): Promise<boolean> {
    const dirty = [...this.desired.keys()].filter(
      (id) => this.isItemDirty(id) && !this.inFlight.has(id)
    )
    for (const id of dirty) {
      this.clearTimer(id)
      this.due.delete(id)
    }
    return Promise.all(dirty.map((id) => this.saveOne(id))).then((results) =>
      results.every(Boolean)
    )
  }

  /** Whether an item (or, with no argument, any item) has unpersisted state. */
  isDirty(itemId?: string): boolean {
    if (itemId !== undefined) return this.isItemDirty(itemId)
    for (const id of this.desired.keys()) {
      if (this.isItemDirty(id)) return true
    }
    return false
  }

  /** Forget everything (used when the item list is reloaded from the server). */
  reset(): void {
    for (const id of [...this.timers.keys()]) this.clearTimer(id)
    this.desired.clear()
    this.persisted.clear()
    this.due.clear()
    this.lastStatus.clear()
  }

  // ---------------------------------------------------------------------------

  private isItemDirty(itemId: string): boolean {
    const desired = this.desired.get(itemId)
    return desired !== undefined && desired.snapshot !== this.persisted.get(itemId)
  }

  private enqueue(itemId: string): void {
    this.due.add(itemId)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      for (;;) {
        const next = this.due.values().next()
        if (next.done) break
        const itemId = next.value
        this.due.delete(itemId)
        // Already out via flushAllNow: when it lands it re-queues itself if
        // still dirty and settles any waiters.
        if (this.inFlight.has(itemId)) continue
        if (!this.isItemDirty(itemId)) {
          // Became clean while queued (e.g. an in-flight save already covered
          // it, or the user reverted). Nothing to send; release any waiters.
          this.settle(itemId, true)
          continue
        }
        await this.saveOne(itemId)
      }
    } finally {
      this.draining = false
    }
  }

  /** Send one item's latest state; resolves whether that state is now held by the server. */
  private async saveOne(itemId: string): Promise<boolean> {
    const { payload, snapshot } = this.desired.get(itemId)!
    this.inFlight.add(itemId)
    this.emit(itemId, 'saving')

    let result: PersistResult
    try {
      result = await this.options.persist(itemId, payload)
    } catch {
      result = { ok: false, message: UNREACHABLE_MESSAGE, terminal: false }
    }

    this.inFlight.delete(itemId)

    if (result.ok) {
      this.persisted.set(itemId, snapshot)
    } else if (result.terminal) {
      // The server will never accept this item's state. Drop whatever is
      // pending for it so there is no retry and no unload warning, and say why.
      this.persisted.set(itemId, this.desired.get(itemId)!.snapshot)
      this.emit(itemId, 'rejected', result.message)
      this.settle(itemId, false)
      return false
    }

    if (this.isItemDirty(itemId)) {
      if (result.ok) {
        // Changed while the request was in flight: send the newer state at
        // once rather than waiting out another debounce. Waiters stay pending
        // until that follow-up lands.
        this.clearTimer(itemId)
        this.enqueue(itemId)
        return true
      }
      this.emit(itemId, 'error', result.message)
      this.settle(itemId, false)
      return false
    }

    // Either the save succeeded, or it failed but the user has since reverted
    // to exactly what the server holds. Both mean the latest state is saved.
    this.emit(itemId, 'saved')
    this.settle(itemId, true)
    return true
  }

  private settle(itemId: string, ok: boolean): void {
    const list = this.waiters.get(itemId)
    if (!list) return
    this.waiters.delete(itemId)
    for (const resolve of list) resolve(ok)
  }

  private clearTimer(itemId: string): void {
    const timer = this.timers.get(itemId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.timers.delete(itemId)
  }

  private emit(itemId: string, status: AutosaveStatus, message?: string): void {
    const key = message === undefined ? status : `${status}:${message}`
    if (this.lastStatus.get(itemId) === key) return
    this.lastStatus.set(itemId, key)
    this.options.onStatus?.(itemId, status, message)
  }
}

// -----------------------------------------------------------------------------
// Persist helpers
// -----------------------------------------------------------------------------

/**
 * Turn a save response into a PersistResult: the server's `error` string as
 * the message when it sent one, and terminal for the statuses that mean the
 * same save can never succeed (403 scoring closed / not yours, 404 item gone,
 * 423 batch locked). Everything else is retryable.
 */
export async function persistResultFromResponse(
  res: Response
): Promise<PersistResult> {
  if (res.ok) return { ok: true }
  let message = SAVE_FAILED_MESSAGE
  try {
    const body = (await res.json()) as { error?: unknown } | null
    if (typeof body?.error === 'string' && body.error) message = body.error
  } catch {
    // No JSON body (e.g. a bare 500): keep the generic message.
  }
  return { ok: false, message, terminal: TERMINAL_SAVE_STATUSES.has(res.status) }
}

/**
 * One result for a save that took several requests (the revise flow sends one
 * per criterion): ok only when all were, otherwise the first failure — a
 * terminal one taking precedence, since retrying cannot fix it.
 */
export function combinePersistResults(results: PersistResult[]): PersistResult {
  const failures = results.filter(
    (r): r is Extract<PersistResult, { ok: false }> => !r.ok
  )
  if (failures.length === 0) return { ok: true }
  return failures.find((f) => f.terminal) ?? failures[0]
}

// -----------------------------------------------------------------------------
// Payload helpers shared with the scoring screen
// -----------------------------------------------------------------------------

export interface ItemScoreInput {
  scores: { dimensionId: string; value: number | null }[]
  notes: string
  startedAt: string | null
}

export interface ScoreSavePayload {
  scores: { dimensionId: string; value: number }[]
  notes?: string
  startedAt?: string
}

/**
 * The server upserts per criterion, so a save carries only the criteria that
 * have a value; an unscored criterion is simply absent, never `null`.
 */
export function buildScorePayload(state: ItemScoreInput): ScoreSavePayload {
  return {
    scores: state.scores
      .filter((s): s is { dimensionId: string; value: number } => s.value !== null)
      .map((s) => ({ dimensionId: s.dimensionId, value: s.value })),
    notes: state.notes || undefined,
    startedAt: state.startedAt || undefined,
  }
}

/** The part of local state whose change means a save is needed. */
export function scoreSnapshot(state: ItemScoreInput): string {
  return JSON.stringify({ scores: state.scores, notes: state.notes })
}
