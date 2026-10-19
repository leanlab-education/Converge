import { sweepStaleSessions } from '@/lib/activity-tracker'
import { NextRequest, NextResponse } from 'next/server'

// Closes every ActivitySession whose last heartbeat is older than
// SWEEP_STALE_AFTER_MS, booking each one through its last heartbeat.
//
// Schedule: Vercel cron calls this once a day at 04:00 UTC (see vercel.json —
// the Hobby plan allows only daily crons). It is a backstop, not the primary
// mechanism: the heartbeat route also sweeps the calling user's own stale
// sessions on every heartbeat, so an orphan is normally closed the next time
// that annotator is active anywhere. Locally the route can be invoked by hand.
//
// Auth: CRON_SECRET must be set in production. Vercel sends
// `Authorization: Bearer <CRON_SECRET>` on scheduled invocations when the env
// var exists; without it this route refuses to run in production (500) rather
// than sit open on the public internet. In dev (no CRON_SECRET) the route is
// open — the sweep is idempotent and only ever shortens sessions.
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const isProd = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production'

  if (cronSecret) {
    const authHeader = request.headers.get('authorization')
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  } else if (isProd) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
  }

  const result = await sweepStaleSessions()
  return NextResponse.json(result)
}
