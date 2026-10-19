import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { recomputeForSessionInterval, resolveSessionEnd } from '@/lib/activity-tracker'
import { isActivityEndReason } from '@/lib/activity-tracker-config'
import { NextRequest, NextResponse } from 'next/server'

const MAX_SESSION_ID_LENGTH = 64

interface EndBody {
  sessionId?: unknown
  reason?: unknown
  lastActiveAt?: unknown
}

// sendBeacon Blobs arrive as application/json text just like fetch bodies, so
// a single text read + JSON.parse covers both transports. A body can only be
// read once, so there is no second-chance parse.
async function readBody(request: NextRequest): Promise<EndBody | null> {
  try {
    const text = await request.text()
    if (!text) return {}
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as EndBody) : null
  } catch {
    return null
  }
}

export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id

  const body = await readBody(request)
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const { sessionId, reason, lastActiveAt } = body

  if (
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    sessionId.length > MAX_SESSION_ID_LENGTH
  ) {
    return NextResponse.json({ error: 'sessionId required' }, { status: 400 })
  }
  if (!isActivityEndReason(reason)) {
    return NextResponse.json({ error: 'Invalid reason' }, { status: 400 })
  }
  // Epoch milliseconds from the client's Date.now(). Optional; only consulted
  // for 'idle' ends (see resolveSessionEnd).
  let clientLastActiveAt: Date | null = null
  if (lastActiveAt !== undefined && lastActiveAt !== null) {
    if (typeof lastActiveAt !== 'number' || !Number.isFinite(lastActiveAt)) {
      return NextResponse.json({ error: 'Invalid lastActiveAt' }, { status: 400 })
    }
    clientLastActiveAt = new Date(lastActiveAt)
  }

  const existing = await prisma.activitySession.findUnique({
    where: { id: sessionId },
  })
  if (!existing || existing.userId !== userId) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }
  if (existing.endedAt) {
    return NextResponse.json({ ok: true, alreadyEnded: true })
  }

  const now = new Date()
  const endedAt = resolveSessionEnd({
    startedAt: existing.startedAt,
    lastHeartbeatAt: existing.lastHeartbeatAt,
    now,
    reason,
    clientLastActiveAt,
  })

  // Conditional on endedAt still being null so two end requests for the same
  // session (fetch + beacon, or a racing partner request) cannot both write.
  const closed = await prisma.activitySession.updateMany({
    where: { id: sessionId, endedAt: null },
    data: { endedAt, endReason: reason },
  })
  if (closed.count === 0) {
    return NextResponse.json({ ok: true, alreadyEnded: true })
  }

  // While open, the session was rolled up through lastHeartbeatAt. If the
  // resolved end is earlier (idle truncation, sleep clamp) the days between
  // the two must be recomputed as well, so recompute through the later one.
  const recomputeThrough =
    endedAt.getTime() >= existing.lastHeartbeatAt.getTime() ? endedAt : existing.lastHeartbeatAt
  await recomputeForSessionInterval(userId, existing.startedAt, recomputeThrough)
  return NextResponse.json({ ok: true, endedAt: endedAt.toISOString() })
}
