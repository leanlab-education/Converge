// Activity tracker configuration shared between client and server.
// No Prisma imports — safe to import from client components.

export const HEARTBEAT_INTERVAL_MS = 20_000
export const IDLE_THRESHOLD_MS = 5 * 60_000
export const SWEEP_STALE_AFTER_MS = 2 * 60_000

// A session's end can never be booked more than one heartbeat interval (plus
// this grace for network latency) past its last heartbeat. Without the cap, a
// laptop that sleeps with the tab open would book the entire sleep as active
// time when the client finally wakes up and sends its end request.
export const END_GRACE_MS = 10_000

// Input events that count as "the annotator is here". Registered on `window`
// in the capture phase so events that don't bubble (notably `scroll` inside
// the evaluate page's inner scroll pane) are still seen; `wheel` covers
// trackpad/mouse scrolling even when nothing actually scrolls, `pointerdown`
// covers pen/touch/mouse presses uniformly.
export const ACTIVITY_EVENTS = [
  'mousemove',
  'keydown',
  'click',
  'pointerdown',
  'wheel',
  'scroll',
  'touchstart',
] as const

export type ActivityBucket = 'ANNOTATION' | 'OTHER'

// Why the client closed a session. The server also writes 'swept' when it
// closes an orphaned session itself; clients may not claim that reason.
export const ACTIVITY_END_REASONS = ['hidden', 'idle', 'navigated', 'beacon'] as const
export type ActivityEndReason = (typeof ACTIVITY_END_REASONS)[number]
export const SWEPT_END_REASON = 'swept'

export function isActivityEndReason(value: unknown): value is ActivityEndReason {
  return (
    typeof value === 'string' &&
    value.length <= 16 &&
    (ACTIVITY_END_REASONS as readonly string[]).includes(value)
  )
}

// Two-bucket model, deliberately. ANNOTATION is every page where an
// annotator does paid review work — initial scoring (/evaluate), pair
// reconciliation (/reconcile), tie-break adjudication (/adjudicate) and
// re-opened-criterion revision (/revise). Reconciliation and adjudication
// are the same billable work as scoring, so splitting them into a third
// bucket would only make the Annotators-tab split harder to read; they were
// previously booked as OTHER, which made review work look like dashboard
// browsing. OTHER is every other authenticated page (dashboard, batch list,
// admin views). Unauthenticated pages are not tracked at all.
const ANNOTATION_PATH_PREFIXES = ['/evaluate/', '/reconcile/', '/revise/'] as const

export function bucketForPath(pathname: string): ActivityBucket | null {
  if (ANNOTATION_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return 'ANNOTATION'
  }
  if (pathname === '/adjudicate' || pathname.startsWith('/adjudicate/')) {
    return 'ANNOTATION'
  }
  if (
    pathname === '/login' ||
    pathname.startsWith('/invite/') ||
    pathname.startsWith('/reset-password')
  ) {
    return null
  }
  return 'OTHER'
}

// UTC date math — keeps display deterministic regardless of viewer TZ.
export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

// ISO week — Monday is the first day.
export function startOfUtcWeek(d: Date): Date {
  const day = startOfUtcDay(d)
  const dow = day.getUTCDay() // 0 = Sun .. 6 = Sat
  const offset = (dow + 6) % 7 // 0 if Mon .. 6 if Sun
  return new Date(day.getTime() - offset * 86_400_000)
}

export function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}

export const PERIODS = ['week', 'month', 'all', 'custom'] as const
export type Period = (typeof PERIODS)[number]

export function isPeriod(value: unknown): value is Period {
  return typeof value === 'string' && (PERIODS as readonly string[]).includes(value)
}

export function periodRange(
  period: Period,
  options: { now?: Date; from?: Date; to?: Date } = {}
): { from: Date; to: Date } {
  const now = options.now ?? new Date()
  // End is exclusive; we cap at end of today (start of tomorrow UTC).
  const endOfToday = new Date(startOfUtcDay(now).getTime() + 86_400_000)
  switch (period) {
    case 'week':
      return { from: startOfUtcWeek(now), to: endOfToday }
    case 'month':
      return { from: startOfUtcMonth(now), to: endOfToday }
    case 'all':
      return { from: new Date(0), to: endOfToday }
    case 'custom': {
      if (!options.from || !options.to) {
        throw new Error('Custom period requires from and to')
      }
      return {
        from: startOfUtcDay(options.from),
        // `to` is treated as inclusive end-day; bump to next-day start (exclusive).
        to: new Date(startOfUtcDay(options.to).getTime() + 86_400_000),
      }
    }
  }
}

export type PeriodQueryResult =
  | { ok: true; period: Period; range: { from: Date; to: Date } }
  | { ok: false; error: string }

// Parses the `period` / `from` / `to` query params shared by the my-time and
// annotator-time routes. `new Date('garbage')` is an Invalid Date that Prisma
// rejects with a 500 deep inside the query, so dates are validated here and
// surfaced as a 400 by the caller.
export function parsePeriodQuery(
  params: Pick<URLSearchParams, 'get'>,
  now: Date = new Date()
): PeriodQueryResult {
  const periodParam = params.get('period') ?? 'month'
  if (!isPeriod(periodParam)) return { ok: false, error: 'Invalid period' }

  const from = parseDateParam(params.get('from'))
  if (from === 'invalid') return { ok: false, error: 'Invalid from date' }
  const to = parseDateParam(params.get('to'))
  if (to === 'invalid') return { ok: false, error: 'Invalid to date' }

  try {
    return { ok: true, period: periodParam, range: periodRange(periodParam, { now, from, to }) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid range' }
  }
}

function parseDateParam(raw: string | null): Date | undefined | 'invalid' {
  if (raw === null || raw === '') return undefined
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? 'invalid' : d
}

// Display time as hours to 1 decimal place (e.g. "1.2 hours"). This matches
// how annotators self-report and how billing periods are calculated.
export function formatDuration(seconds: number): string {
  if (!seconds || seconds < 0) return '0.0 hours'
  return `${(seconds / 3600).toFixed(1)} hours`
}
