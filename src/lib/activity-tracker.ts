// Server-only activity-tracking helpers.
// Source of truth: ActivitySession rows. ActivityDaily is a derived rollup.

import { prisma } from '@/lib/db'
import {
  END_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  SWEEP_STALE_AFTER_MS,
  SWEPT_END_REASON,
  startOfUtcDay,
  type ActivityBucket,
  type ActivityEndReason,
} from '@/lib/activity-tracker-config'

interface SessionLike {
  startedAt: Date
  lastHeartbeatAt: Date
  endedAt: Date | null
  bucket: ActivityBucket
}

function sessionEndMs(s: SessionLike): number {
  return (s.endedAt ?? s.lastHeartbeatAt).getTime()
}

// Standard interval-merge over [start, end) pairs in ms. Exported for tests.
export function mergeIntervals(intervals: [number, number][]): [number, number][] {
  if (intervals.length === 0) return []
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = [[sorted[0][0], sorted[0][1]]]
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1]
    const [s, e] = sorted[i]
    if (s <= last[1]) {
      if (e > last[1]) last[1] = e
    } else {
      merged.push([s, e])
    }
  }
  return merged
}

function totalSeconds(intervals: [number, number][]): number {
  let totalMs = 0
  for (const [s, e] of intervals) totalMs += e - s
  return Math.round(totalMs / 1000)
}

export interface SessionEndInput {
  startedAt: Date
  lastHeartbeatAt: Date
  // Server clock at the time the end request arrived.
  now: Date
  reason: ActivityEndReason
  // The client's last observed input event. Honored only for 'idle' ends, and
  // only to shorten the session — the client can never extend one.
  clientLastActiveAt?: Date | null
}

// Decide when a session actually ended.
//
// 1. Never more than one heartbeat interval (plus grace) past the last
//    heartbeat. A heartbeat is the only proof the tab was alive; a laptop that
//    sleeps with the tab open sends its end request on wake, and without this
//    cap the whole sleep would be booked as active time.
// 2. For 'idle' ends, back up to the client's last input event. The hook keeps
//    heartbeating until IDLE_THRESHOLD_MS has passed with no input, so the
//    first five minutes of every idle gap would otherwise count as work.
// 3. Never before the session started.
export function resolveSessionEnd(input: SessionEndInput): Date {
  const { startedAt, lastHeartbeatAt, now, reason, clientLastActiveAt } = input
  const heartbeatCap = lastHeartbeatAt.getTime() + HEARTBEAT_INTERVAL_MS + END_GRACE_MS
  let endMs = Math.min(now.getTime(), heartbeatCap)
  if (reason === 'idle' && clientLastActiveAt) {
    endMs = Math.min(endMs, clientLastActiveAt.getTime())
  }
  return new Date(Math.max(endMs, startedAt.getTime()))
}

// Recompute one user-day's ActivityDaily row from sessions.
// Multi-tab / multi-device dedup happens here via mergeIntervals.
export async function computeDailyActivity(userId: string, date: Date): Promise<void> {
  const dayStart = startOfUtcDay(date)
  const dayEnd = new Date(dayStart.getTime() + 86_400_000)

  const sessions = await prisma.activitySession.findMany({
    where: {
      userId,
      startedAt: { lt: dayEnd },
      OR: [
        { endedAt: { gt: dayStart } },
        { endedAt: null, lastHeartbeatAt: { gt: dayStart } },
      ],
    },
    select: {
      bucket: true,
      startedAt: true,
      lastHeartbeatAt: true,
      endedAt: true,
    },
  })

  const byBucket: Record<ActivityBucket, [number, number][]> = {
    ANNOTATION: [],
    OTHER: [],
  }
  for (const s of sessions) {
    const start = Math.max(s.startedAt.getTime(), dayStart.getTime())
    const end = Math.min(sessionEndMs(s), dayEnd.getTime())
    if (end > start) byBucket[s.bucket].push([start, end])
  }

  const annotationSeconds = totalSeconds(mergeIntervals(byBucket.ANNOTATION))
  const otherSeconds = totalSeconds(mergeIntervals(byBucket.OTHER))

  await prisma.activityDaily.upsert({
    where: { userId_date: { userId, date: dayStart } },
    create: { userId, date: dayStart, annotationSeconds, otherSeconds },
    update: { annotationSeconds, otherSeconds },
  })
}

// Recompute every UTC day touched by a session interval (handles cross-midnight).
export async function recomputeForSessionInterval(
  userId: string,
  startedAt: Date,
  endRef: Date
): Promise<void> {
  const startDay = startOfUtcDay(startedAt).getTime()
  const endDay = startOfUtcDay(endRef).getTime()
  const days: Date[] = []
  for (let d = startDay; d <= endDay; d += 86_400_000) days.push(new Date(d))
  await Promise.all(days.map((day) => computeDailyActivity(userId, day)))
}

interface StaleSession {
  id: string
  userId: string
  startedAt: Date
  lastHeartbeatAt: Date
}

const STALE_SESSION_SELECT = {
  id: true,
  userId: true,
  startedAt: true,
  lastHeartbeatAt: true,
} as const

// A swept session ends at its last heartbeat — the last moment we know the
// tab was alive. Recomputes the affected daily aggregates.
async function closeStaleSessions(stale: StaleSession[]): Promise<number> {
  if (stale.length === 0) return 0

  await prisma.$transaction(
    stale.map((s) =>
      prisma.activitySession.update({
        where: { id: s.id },
        data: { endedAt: s.lastHeartbeatAt, endReason: SWEPT_END_REASON },
      })
    )
  )

  await Promise.all(
    stale.map((s) => recomputeForSessionInterval(s.userId, s.startedAt, s.lastHeartbeatAt))
  )

  return stale.length
}

// Close every session (any user) whose last heartbeat is older than the sweep
// threshold. Run by the daily cron.
export async function sweepStaleSessions(now: Date = new Date()): Promise<{ closed: number }> {
  const threshold = new Date(now.getTime() - SWEEP_STALE_AFTER_MS)
  const stale = await prisma.activitySession.findMany({
    where: { endedAt: null, lastHeartbeatAt: { lt: threshold } },
    select: STALE_SESSION_SELECT,
  })
  return { closed: await closeStaleSessions(stale) }
}

// Close one user's orphaned sessions. Run on every heartbeat so a session
// left open by a crashed browser, a dropped end request or a lost create
// response is closed the next time that user is active anywhere — not only
// at the daily sweep. `exceptSessionId` is the session the heartbeat is about
// to refresh; it is never stale from the caller's point of view.
export async function sweepStaleSessionsForUser(
  userId: string,
  options: { now?: Date; exceptSessionId?: string } = {}
): Promise<{ closed: number }> {
  const now = options.now ?? new Date()
  const threshold = new Date(now.getTime() - SWEEP_STALE_AFTER_MS)
  const stale = await prisma.activitySession.findMany({
    where: {
      userId,
      endedAt: null,
      lastHeartbeatAt: { lt: threshold },
      ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
    },
    select: STALE_SESSION_SELECT,
  })
  return { closed: await closeStaleSessions(stale) }
}
