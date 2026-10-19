import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import { prisma } from '@/lib/db'
import { parsePeriodQuery } from '@/lib/activity-tracker-config'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { projectId } = await params

  if (!(await canAdminProject(session.user.id, session.user.role, projectId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const parsed = parsePeriodQuery(new URL(request.url).searchParams)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }
  const { period, range } = parsed

  const evaluators = await prisma.projectEvaluator.findMany({
    where: { projectId },
    select: { userId: true },
  })
  const userIds = evaluators.map((e) => e.userId)
  if (userIds.length === 0) {
    return NextResponse.json({
      period,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      annotators: [],
    })
  }

  const dailyRows = await prisma.activityDaily.findMany({
    where: {
      userId: { in: userIds },
      date: { gte: range.from, lt: range.to },
    },
    select: { userId: true, annotationSeconds: true, otherSeconds: true },
  })

  const totals = new Map<string, { annotationSeconds: number; otherSeconds: number }>()
  for (const uid of userIds) totals.set(uid, { annotationSeconds: 0, otherSeconds: 0 })
  for (const row of dailyRows) {
    const cur = totals.get(row.userId)
    if (!cur) continue
    cur.annotationSeconds += row.annotationSeconds
    cur.otherSeconds += row.otherSeconds
  }

  return NextResponse.json({
    period,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    annotators: userIds.map((userId) => ({
      userId,
      annotationSeconds: totals.get(userId)!.annotationSeconds,
      otherSeconds: totals.get(userId)!.otherSeconds,
    })),
  })
}
