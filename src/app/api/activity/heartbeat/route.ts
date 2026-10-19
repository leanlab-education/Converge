import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import {
  recomputeForSessionInterval,
  sweepStaleSessionsForUser,
} from '@/lib/activity-tracker'
import { NextRequest, NextResponse } from 'next/server'

const MAX_SESSION_ID_LENGTH = 64

// Heartbeat contract:
//   - no sessionId   → start a new session, respond { sessionId }.
//   - live sessionId → refresh its lastHeartbeatAt, respond { sessionId }.
//   - any other sessionId (closed, unknown, another user's, other bucket)
//                    → 410 Gone. The client drops the id and starts fresh
//                      explicitly. The route never silently substitutes a new
//                      session: when a heartbeat raced the client's own end
//                      request that used to create a second session whose id
//                      the client had already stopped listening for, leaving
//                      it open until the sweep.
// Every heartbeat also closes this user's other stale sessions, so an orphan
// (crashed browser, dropped request) is fixed the next time they are active
// anywhere rather than only at the daily cron.
export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id

  const body = (await request.json().catch(() => ({}))) as {
    sessionId?: unknown
    bucket?: unknown
  }
  const { sessionId, bucket } = body
  if (bucket !== 'ANNOTATION' && bucket !== 'OTHER') {
    return NextResponse.json({ error: 'Invalid bucket' }, { status: 400 })
  }
  if (
    sessionId !== undefined &&
    (typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      sessionId.length > MAX_SESSION_ID_LENGTH)
  ) {
    return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 })
  }

  const userAgent = request.headers.get('user-agent') ?? null
  const now = new Date()

  if (sessionId) {
    const existing = await prisma.activitySession.findUnique({
      where: { id: sessionId },
      select: { userId: true, bucket: true, startedAt: true, endedAt: true },
    })
    const isLive =
      existing !== null &&
      existing.userId === userId &&
      existing.bucket === bucket &&
      existing.endedAt === null
    if (!isLive) {
      return NextResponse.json({ error: 'Session closed' }, { status: 410 })
    }

    // Close orphans first so the rollups below see their final extents.
    await sweepStaleSessionsForUser(userId, { now, exceptSessionId: sessionId })

    // Conditional on still being open: an end request may have landed between
    // the read above and this write, and a closed session must stay closed.
    const refreshed = await prisma.activitySession.updateMany({
      where: { id: sessionId, endedAt: null },
      data: { lastHeartbeatAt: now },
    })
    if (refreshed.count === 0) {
      return NextResponse.json({ error: 'Session closed' }, { status: 410 })
    }
    await recomputeForSessionInterval(userId, existing.startedAt, now)
    return NextResponse.json({ sessionId })
  }

  await sweepStaleSessionsForUser(userId, { now })

  const created = await prisma.activitySession.create({
    data: {
      userId,
      bucket,
      startedAt: now,
      lastHeartbeatAt: now,
      userAgent,
    },
  })
  await recomputeForSessionInterval(userId, created.startedAt, created.lastHeartbeatAt)
  return NextResponse.json({ sessionId: created.id })
}
