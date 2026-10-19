/**
 * Seed realistic-looking ActivitySession + ActivityDaily data for a project's
 * annotators so the time-tracking UI has something to show.
 *
 * Usage:
 *   doppler run -p writing-evaluator -c dev -- npx tsx scripts/fake-activity.ts <projectId> [--allow-prod]
 *
 * Idempotency: this script clears existing ActivitySession + ActivityDaily
 * rows for the project's annotators before inserting new ones. Re-running
 * regenerates fresh fake data.
 *
 * DESTRUCTIVE: it deletes every real activity row for those annotators too.
 * The production guard refuses the production host unconditionally and
 * requires --allow-prod plus a typed host confirmation for any other Neon
 * host (e.g. a preview branch). Note that `-c dev` points at production.
 */

import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import { assertNotProduction, positionalArgs } from './_guard'

type Bucket = 'ANNOTATION' | 'OTHER'

interface Profile {
  label: string
  weeklyHours: number
  sessionMinutes: [number, number]
  annotationFraction: number
  workDayProbability: number // 0..1 — chance of working on any given day in the window
}

const PROFILES: Profile[] = [
  // engaged — active most weekdays
  { label: 'engaged', weeklyHours: 9, sessionMinutes: [30, 75], annotationFraction: 0.93, workDayProbability: 0.7 },
  // moderate — a few sessions per week
  { label: 'moderate', weeklyHours: 4, sessionMinutes: [25, 55], annotationFraction: 0.87, workDayProbability: 0.45 },
  // low — sporadic
  { label: 'low', weeklyHours: 2, sessionMinutes: [20, 40], annotationFraction: 0.78, workDayProbability: 0.25 },
  // starter — just trying it out
  { label: 'starter', weeklyHours: 0.6, sessionMinutes: [10, 25], annotationFraction: 0.65, workDayProbability: 0.12 },
]

const DAYS_BACK = 21

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function mergeIntervals(intervals: [number, number][]): [number, number][] {
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

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

interface SessionDraft {
  userId: string
  bucket: Bucket
  startedAt: Date
  lastHeartbeatAt: Date
  endedAt: Date
  endReason: string
}

function generateUserSessions(userId: string, profile: Profile): SessionDraft[] {
  const sessions: SessionDraft[] = []
  const now = new Date()
  // Cap each annotator at a target total to avoid unrealistic overshoot.
  const targetTotalSeconds = Math.round(profile.weeklyHours * (DAYS_BACK / 7) * 3600)
  let accumulated = 0

  for (let dayOffset = 0; dayOffset < DAYS_BACK; dayOffset++) {
    if (Math.random() > profile.workDayProbability) continue
    if (accumulated >= targetTotalSeconds) break

    const day = new Date(startOfUtcDay(now).getTime() - dayOffset * 86_400_000)
    // 1–3 work blocks within the day, separated.
    const blocks = Math.floor(rand(1, 3.99))
    let cursorMinutes = Math.floor(rand(8 * 60, 14 * 60)) // start somewhere 08:00–14:00 UTC

    for (let b = 0; b < blocks; b++) {
      if (accumulated >= targetTotalSeconds) break
      const sessionMin = rand(profile.sessionMinutes[0], profile.sessionMinutes[1])
      // Decide bucket per block.
      const bucket: Bucket = Math.random() < profile.annotationFraction ? 'ANNOTATION' : 'OTHER'
      // OTHER blocks are typically much shorter (just navigation/dashboard).
      const finalMin = bucket === 'OTHER' ? Math.max(2, sessionMin / 4) : sessionMin

      const startedAt = new Date(day.getTime() + cursorMinutes * 60_000)
      const endedAt = new Date(startedAt.getTime() + finalMin * 60_000)
      sessions.push({
        userId,
        bucket,
        startedAt,
        // simulate a heartbeat right before the end
        lastHeartbeatAt: new Date(endedAt.getTime() - rand(5_000, 20_000)),
        endedAt,
        endReason: 'beacon',
      })
      accumulated += Math.round(finalMin * 60)
      // Gap between blocks: 15–90 min
      cursorMinutes += Math.round(finalMin) + Math.floor(rand(15, 90))
      if (cursorMinutes > 22 * 60) break // wrap up before midnight
    }
  }
  return sessions
}

async function computeDailyActivity(prisma: PrismaClient, userId: string, date: Date) {
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
    select: { bucket: true, startedAt: true, lastHeartbeatAt: true, endedAt: true },
  })

  const byBucket: Record<Bucket, [number, number][]> = { ANNOTATION: [], OTHER: [] }
  for (const s of sessions) {
    const sStart = Math.max(s.startedAt.getTime(), dayStart.getTime())
    const sEnd = Math.min((s.endedAt ?? s.lastHeartbeatAt).getTime(), dayEnd.getTime())
    if (sEnd > sStart) byBucket[s.bucket].push([sStart, sEnd])
  }

  const annotationSeconds = totalSeconds(mergeIntervals(byBucket.ANNOTATION))
  const otherSeconds = totalSeconds(mergeIntervals(byBucket.OTHER))

  await prisma.activityDaily.upsert({
    where: { userId_date: { userId, date: dayStart } },
    create: { userId, date: dayStart, annotationSeconds, otherSeconds },
    update: { annotationSeconds, otherSeconds },
  })
}

async function main() {
  const [projectId] = positionalArgs()
  if (!projectId) {
    console.error('Usage: tsx scripts/fake-activity.ts <projectId> [--allow-prod]')
    process.exit(1)
  }

  await assertNotProduction('fake-activity', { neverProduction: true })

  const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
  const prisma = new PrismaClient({ adapter })

  try {
    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project) {
      console.error(`Project ${projectId} not found.`)
      process.exit(1)
    }
    console.log(`Project: ${project.name}`)

    const annotators = await prisma.projectEvaluator.findMany({
      where: { projectId },
      include: { user: { select: { id: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    })

    if (annotators.length === 0) {
      console.error('No annotators on this project.')
      process.exit(0)
    }

    const userIds = annotators.map((a) => a.user.id)

    // Wipe existing fake data for these users.
    const cleared = await prisma.activitySession.deleteMany({
      where: { userId: { in: userIds } },
    })
    await prisma.activityDaily.deleteMany({ where: { userId: { in: userIds } } })
    console.log(`Cleared ${cleared.count} existing sessions for ${userIds.length} users.`)

    // Assign profiles round-robin so output is varied but deterministic by order.
    for (let i = 0; i < annotators.length; i++) {
      const a = annotators[i]
      const profile = PROFILES[i % PROFILES.length]
      const drafts = generateUserSessions(a.user.id, profile)
      if (drafts.length === 0) {
        console.log(`  ${a.user.email} → ${profile.label}: 0 sessions`)
        continue
      }
      await prisma.activitySession.createMany({ data: drafts })
      const totalMin = Math.round(
        drafts.reduce(
          (acc, s) => acc + (s.endedAt.getTime() - s.startedAt.getTime()) / 60_000,
          0
        )
      )
      console.log(
        `  ${a.user.email} → ${profile.label}: ${drafts.length} sessions, ~${(totalMin / 60).toFixed(1)} hours`
      )

      // Recompute daily aggregates for every UTC day touched by this user.
      const daysTouched = new Set<number>()
      for (const d of drafts) {
        daysTouched.add(startOfUtcDay(d.startedAt).getTime())
        daysTouched.add(startOfUtcDay(d.endedAt).getTime())
      }
      for (const dayMs of daysTouched) {
        await computeDailyActivity(prisma, a.user.id, new Date(dayMs))
      }
    }

    console.log('Done.')
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
