import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { canAdminProject } from '@/lib/authorization'
import { maybeAdvanceReleaseAfterScore } from '@/lib/reconciliation'
import { evaluateScoreWrite } from '@/lib/score-write-scope'
import { NextRequest, NextResponse } from 'next/server'

// GET /api/scores?projectId=…[&batchId=…][&feedbackItemId=…]
//
// The caller's own RAW scores, for hydrating the scoring screen — its only
// caller. Never returns reconciled finals: those are stored under the release
// owner's userId, so the owner would otherwise receive the pair's final next
// to their own raw row, and the screen showed (and, through the revise flow,
// wrote back as raw) the final instead of what they actually scored. Admins
// get their own rows too; the cross-annotator views live in the reconcile and
// export routes.
export async function GET(request: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const projectId = request.nextUrl.searchParams.get('projectId')
  if (!projectId) {
    return NextResponse.json(
      { error: 'projectId is required' },
      { status: 400 }
    )
  }
  const batchId = request.nextUrl.searchParams.get('batchId')
  const feedbackItemId = request.nextUrl.searchParams.get('feedbackItemId')

  const isAdmin = await canAdminProject(session.user.id, session.user.role, projectId)
  if (!isAdmin) {
    const membership = await prisma.projectEvaluator.findUnique({
      where: { projectId_userId: { projectId, userId: session.user.id } },
    })
    if (!membership) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const scores = await prisma.score.findMany({
    where: {
      feedbackItem: { projectId, ...(batchId ? { batchId } : {}) },
      ...(feedbackItemId ? { feedbackItemId } : {}),
      userId: session.user.id,
      isReconciled: false,
    },
    select: {
      id: true,
      feedbackItemId: true,
      dimensionId: true,
      value: true,
      notes: true,
      startedAt: true,
      scoredAt: true,
      isReconciled: true,
    },
    orderBy: [{ feedbackItemId: 'asc' }, { scoredAt: 'asc' }],
  })

  return NextResponse.json(scores)
}

interface ScoreWrite {
  dimensionId: string
  value: number
}

function isScoreWrite(value: unknown): value is ScoreWrite {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { dimensionId?: unknown; value?: unknown }
  return (
    typeof candidate.dimensionId === 'string' &&
    typeof candidate.value === 'number' &&
    Number.isInteger(candidate.value)
  )
}

// PUT /api/scores — the single raw-score write path (auto-save and Continue
// both use it): upserts the caller's own raw row per criterion, partial or
// full. Who may write what is decided by evaluateScoreWrite, so an admin
// without an assignment, a teammate outside their slot, or a criterion
// outside the team is refused with a 403 that says why.
export async function PUT(request: Request) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await request.json()) as {
    feedbackItemId?: unknown
    scores?: unknown
    notes?: unknown
    startedAt?: unknown
  }
  const { feedbackItemId, notes, startedAt } = body

  if (typeof feedbackItemId !== 'string' || !feedbackItemId) {
    return NextResponse.json(
      { error: 'feedbackItemId is required' },
      { status: 400 }
    )
  }
  const scores: ScoreWrite[] = Array.isArray(body.scores) ? body.scores : []
  if (!scores.every(isScoreWrite)) {
    return NextResponse.json(
      { error: 'Each score needs a dimensionId and an integer value' },
      { status: 400 }
    )
  }
  if (notes !== undefined && typeof notes !== 'string') {
    return NextResponse.json({ error: 'notes must be a string' }, { status: 400 })
  }
  const startedAtDate =
    typeof startedAt === 'string' && startedAt ? new Date(startedAt) : null
  if (startedAtDate && Number.isNaN(startedAtDate.getTime())) {
    return NextResponse.json({ error: 'startedAt must be a date' }, { status: 400 })
  }

  const feedbackItem = await prisma.feedbackItem.findUnique({
    where: { id: feedbackItemId },
    select: { projectId: true, batchId: true, slotIndex: true },
  })
  if (!feedbackItem) {
    return NextResponse.json({ error: 'Feedback item not found' }, { status: 404 })
  }
  const membership = await prisma.projectEvaluator.findUnique({
    where: { projectId_userId: { projectId: feedbackItem.projectId, userId: session.user.id } },
  })
  if (!membership) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // The batch and the caller's assignment on it, with the release context the
  // scope rules need (members in email order = slot order).
  const [batch, assignment] = feedbackItem.batchId
    ? await Promise.all([
        prisma.batch.findUnique({
          where: { id: feedbackItem.batchId },
          select: { status: true, isHidden: true, isLocked: true },
        }),
        prisma.batchAssignment.findUnique({
          where: {
            batchId_userId: {
              batchId: feedbackItem.batchId,
              userId: session.user.id,
            },
          },
          select: {
            teamReleaseId: true,
            teamRelease: {
              select: {
                id: true,
                scorerUserId: true,
                isVisible: true,
                status: true,
                batch: { select: { type: true, isDoubleScored: true } },
                team: {
                  select: {
                    members: {
                      select: { userId: true },
                      orderBy: { user: { email: 'asc' } },
                    },
                    dimensions: { select: { dimensionId: true } },
                  },
                },
              },
            },
          },
        }),
      ])
    : [null, null]
  if (feedbackItem.batchId && !batch) {
    return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
  }

  // Every criterion must be one of the project's, with a value on its scale.
  const dimensions = await prisma.rubricDimension.findMany({
    where: { projectId: feedbackItem.projectId },
    select: { id: true, scaleMin: true, scaleMax: true },
  })
  const dimMap = new Map(dimensions.map((d) => [d.id, d]))
  for (const score of scores) {
    const dim = dimMap.get(score.dimensionId)
    if (!dim) {
      return NextResponse.json({ error: `Invalid dimension: ${score.dimensionId}` }, { status: 400 })
    }
    if (score.value < dim.scaleMin || score.value > dim.scaleMax) {
      return NextResponse.json({ error: `Score value must be between ${dim.scaleMin} and ${dim.scaleMax}` }, { status: 400 })
    }
  }

  const access = evaluateScoreWrite({
    item: { batchId: feedbackItem.batchId, slotIndex: feedbackItem.slotIndex },
    batch,
    assignment,
    userId: session.user.id,
    dimensionIds: scores.map((s) => s.dimensionId),
    projectDimensionIds: dimensions.map((d) => d.id),
  })
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.httpStatus })
  }

  // Upsert each criterion — sequentially, so two saves for the same item
  // cannot interleave their rows.
  const now = new Date()
  for (const score of scores) {
    const rowWhere = {
      feedbackItemId,
      userId: session.user.id,
      dimensionId: score.dimensionId,
      isReconciled: false,
    }
    const update = {
      value: score.value,
      scoredAt: now,
      ...(notes !== undefined ? { notes } : {}),
    }
    try {
      await prisma.score.upsert({
        where: { feedbackItemId_userId_dimensionId_isReconciled: rowWhere },
        update,
        create: {
          ...rowWhere,
          value: score.value,
          notes: notes || null,
          startedAt: startedAtDate,
        },
      })
    } catch (e: unknown) {
      // P2002: a concurrent request inserted this row first — update it instead.
      if ((e as { code?: string }).code === 'P2002') {
        await prisma.score.updateMany({ where: rowWhere, data: update })
      } else {
        throw e
      }
    }
  }

  // startedAt records when the annotator first touched the item. It is set on
  // create and never moved, so revisiting an item does not reset its timing;
  // rows written before the client sent one are back-filled once.
  if (startedAtDate) {
    await prisma.score.updateMany({
      where: {
        feedbackItemId,
        userId: session.user.id,
        isReconciled: false,
        startedAt: null,
      },
      data: { startedAt: startedAtDate },
    })
  }

  // Notes-only save: apply to the criteria already scored.
  if (notes !== undefined && scores.length === 0) {
    await prisma.score.updateMany({
      where: {
        feedbackItemId,
        userId: session.user.id,
        isReconciled: false,
      },
      data: { notes },
    })
  }

  if (assignment?.teamReleaseId) {
    try {
      await maybeAdvanceReleaseAfterScore(assignment.teamReleaseId)
    } catch (err) {
      console.error('Release advancement check failed:', err)
    }
  }

  return NextResponse.json({ saved: true })
}
