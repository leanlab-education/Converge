import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { parsePeriodQuery } from '@/lib/activity-tracker-config'
import { NextRequest, NextResponse } from 'next/server'

// Returns the *current user's* aggregated activity time for a period.
// Used by the (currently hidden) self-view on the evaluator dashboard.
export async function GET(request: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id

  const parsed = parsePeriodQuery(new URL(request.url).searchParams)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }
  const { period, range } = parsed

  const dailyRows = await prisma.activityDaily.findMany({
    where: { userId, date: { gte: range.from, lt: range.to } },
    select: { annotationSeconds: true, otherSeconds: true },
  })

  let annotationSeconds = 0
  let otherSeconds = 0
  for (const row of dailyRows) {
    annotationSeconds += row.annotationSeconds
    otherSeconds += row.otherSeconds
  }

  return NextResponse.json({
    period,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    annotationSeconds,
    otherSeconds,
  })
}
