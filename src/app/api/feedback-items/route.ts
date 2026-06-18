import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { canAdminProject } from '@/lib/authorization'
import { getReleaseItemScope } from '@/lib/team-batch-releases'
import { FeedbackSource } from '@/generated/prisma/client'
import { NextRequest, NextResponse } from 'next/server'

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
  const isAdmin = await canAdminProject(session.user.id, session.user.role, projectId)

  // Per-batch slot filter: when an annotator opens a non-double-scored regular
  // batch, they only see their slot's half of the items.
  let slotFilter: number | null = null
  // Cross-batch path (no batchId): collect per-batch conditions so the user
  // only sees items from batches they're actually assigned to, with the slot
  // filter applied where it matters.
  let crossBatchOr: { batchId: string; slotIndex?: number }[] | null = null

  // Evaluators can only access projects they're assigned to
  if (!isAdmin) {
    const membership = await prisma.projectEvaluator.findUnique({
      where: { projectId_userId: { projectId, userId: session.user.id } },
    })
    if (!membership) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (batchId) {
      const assignment = await prisma.batchAssignment.findFirst({
        where: {
          batchId,
          userId: session.user.id,
          OR: [{ teamReleaseId: null }, { teamRelease: { isVisible: true } }],
        },
        select: {
          id: true,
          teamRelease: {
            select: {
              id: true,
              scorerUserId: true,
              batch: { select: { type: true, isDoubleScored: true } },
              team: {
                select: {
                  members: {
                    select: { userId: true },
                    orderBy: { user: { email: 'asc' } },
                  },
                },
              },
            },
          },
        },
      })

      if (!assignment) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }

      const release = assignment.teamRelease
      if (release) {
        const scope = getReleaseItemScope(
          {
            id: release.id,
            scorerUserId: release.scorerUserId,
            isDoubleScored: release.batch.isDoubleScored,
            batchType: release.batch.type,
            team: { members: release.team.members },
          },
          session.user.id
        )
        if (scope.mode === 'none') {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }
        if (scope.mode === 'slot') {
          slotFilter = scope.slotIndex
        }
      }
    } else {
      // No batchId: build per-batch conditions across the user's batches in
      // this project. Without this, evaluators would see every item in the
      // project (incl. batches they're not assigned to and items their
      // teammate is responsible for).
      const accessibleAssignments = await prisma.batchAssignment.findMany({
        where: {
          userId: session.user.id,
          batch: { projectId, isHidden: false },
          OR: [{ teamReleaseId: null }, { teamRelease: { isVisible: true } }],
        },
        select: {
          batch: { select: { id: true, type: true, isDoubleScored: true } },
          teamRelease: {
            select: {
              scorerUserId: true,
              team: {
                select: {
                  members: {
                    select: { userId: true },
                    orderBy: { user: { email: 'asc' } },
                  },
                },
              },
            },
          },
        },
      })
      crossBatchOr = accessibleAssignments.map((a) => {
        if (!a.teamRelease) return { batchId: a.batch.id }
        const scope = getReleaseItemScope(
          {
            id: a.batch.id,
            scorerUserId: a.teamRelease.scorerUserId,
            isDoubleScored: a.batch.isDoubleScored,
            batchType: a.batch.type,
            team: { members: a.teamRelease.team.members },
          },
          session.user.id
        )
        if (scope.mode === 'slot') {
          return { batchId: a.batch.id, slotIndex: scope.slotIndex }
        }
        if (scope.mode === 'none') {
          // Assigned row but no items for this user (e.g. not the named scorer) —
          // match nothing for this batch.
          return { batchId: a.batch.id, slotIndex: -1 }
        }
        return { batchId: a.batch.id }
      })
      // No accessible batches → return empty list rather than the whole project.
      if (crossBatchOr.length === 0) {
        return NextResponse.json([])
      }
    }
  }

  // Base query: feedback items without feedbackSource (blinded)
  const feedbackItems = await prisma.feedbackItem.findMany({
    where: {
      projectId,
      ...(batchId ? { batchId } : {}),
      ...(slotFilter !== null ? { slotIndex: slotFilter } : {}),
      ...(crossBatchOr ? { OR: crossBatchOr } : {}),
    },
    select: {
      id: true,
      projectId: true,
      responseId: true,
      cycleId: true,
      studentId: true,
      activityId: true,
      conjunctionId: true,
      studentText: true,
      feedbackId: true,
      // teacherId intentionally excluded — blinded
      feedbackText: true,
      batchId: true,
      displayOrder: true,
      createdAt: true,
      // feedbackSource intentionally excluded — blinded
      assignments: !isAdmin
        ? {
            where: {
              evaluator: {
                userId: session.user.id,
              },
            },
            select: {
              id: true,
              status: true,
            },
          }
        : false,
    },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
  })

  return NextResponse.json(feedbackItems)
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const body = await request.json()
  const { projectId, items, filename } = body as {
    projectId?: string
    items?: unknown[]
    filename?: string
  }

  if (!projectId || !(await canAdminProject(session.user.id, session.user.role, projectId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (!projectId || !Array.isArray(items) || items.length === 0) {
    return NextResponse.json(
      { error: 'projectId and items array are required' },
      { status: 400 }
    )
  }

  // Verify project exists
  const project = await prisma.project.findUnique({
    where: { id: projectId },
  })
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  // Identify which Feedback_IDs already exist in this project so we can
  // report a proper skip count AND attach an importId to only the NEW rows.
  // createMany({skipDuplicates: true}) doesn't return ids, so we do the
  // dedupe manually: pre-check existing, insert only new ones, tag with
  // the Import id.
  const incomingIds = (items as { feedbackId: string }[]).map(
    (i) => i.feedbackId
  )
  const existing = await prisma.feedbackItem.findMany({
    where: { projectId, feedbackId: { in: incomingIds } },
    select: { feedbackId: true },
  })
  const existingIds = new Set(existing.map((e) => e.feedbackId))
  const newItems = (items as {
    responseId?: string
    cycleId?: string
    studentId: string
    activityId?: string
    conjunctionId?: string
    studentText: string
    feedbackId: string
    teacherId?: string
    feedbackText: string
    feedbackSource: string
    optimal?: string
    feedbackType?: string
  }[]).filter((i) => !existingIds.has(i.feedbackId))

  // Get the current max displayOrder so this import's items don't collide
  // with pre-existing ones (rolling upload semantics).
  const maxOrder = await prisma.feedbackItem.aggregate({
    where: { projectId },
    _max: { displayOrder: true },
  })
  const startOrder = (maxOrder._max.displayOrder ?? -1) + 1

  // Create an Import row up front so we can tag the new items with its id.
  const importRow = await prisma.import.create({
    data: {
      projectId,
      filename: filename?.toString().slice(0, 255) || 'unnamed.csv',
      itemCount: newItems.length,
      skippedCount: items.length - newItems.length,
    },
  })

  if (newItems.length > 0) {
    const data = newItems.map((item, index) => ({
      projectId,
      importId: importRow.id,
      responseId: item.responseId || null,
      cycleId: item.cycleId || null,
      studentId: item.studentId,
      activityId: item.activityId || null,
      conjunctionId: item.conjunctionId || null,
      studentText: item.studentText,
      feedbackId: item.feedbackId,
      teacherId: item.teacherId || null,
      feedbackText: item.feedbackText,
      feedbackSource: item.feedbackSource.toUpperCase() as FeedbackSource,
      optimal: item.optimal || null,
      feedbackType: item.feedbackType || null,
      displayOrder: startOrder + index,
    }))

    await prisma.feedbackItem.createMany({ data, skipDuplicates: true })
  }

  return NextResponse.json(
    {
      importId: importRow.id,
      imported: newItems.length,
      skipped: items.length - newItems.length,
      total: items.length,
    },
    { status: 201 }
  )
}
