import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { canAdminProject } from '@/lib/authorization'
import { getReleaseItemScope } from '@/lib/team-batch-releases'
import { normalizeFeedbackSource } from '@/lib/csv-parser'
import type { FeedbackSource } from '@/generated/prisma/client'
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
          // Same visibility rule as the cross-batch path and the annotator
          // project page: a hidden batch is not reachable by direct URL either.
          batch: { isHidden: false },
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
      // Quill's ground-truth flag (whether the response already meets the goal).
      // Surfaced during scoring so annotators can judge the "Appropriate
      // Feedback Decision" criterion. Not a blinded field.
      optimal: true,
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

interface ImportItemInput {
  responseId?: string | null
  cycleId?: string | null
  studentId: string
  activityId?: string | null
  conjunctionId?: string | null
  studentText: string
  feedbackId: string
  teacherId?: string | null
  feedbackText: string
  feedbackSource: FeedbackSource
  optimal?: string | null
  feedbackType?: string | null
}

const REQUIRED_TEXT_FIELDS = [
  'studentId',
  'studentText',
  'feedbackId',
  'feedbackText',
] as const

/**
 * Server-side validation of the import payload. The client validates the CSV
 * too, but this route is the last line before the blinded Feedback_Source is
 * written, so it does not trust the caller: every item must carry a non-empty
 * AI/HUMAN source (never defaulted) and the required text fields, and no
 * Feedback_ID may repeat within the file (it is the project-wide unique key, so
 * a repeat could only ever import once).
 */
function validateImportItems(
  items: unknown[]
): { items: ImportItemInput[]; errors: string[] } {
  const errors: string[] = []
  const valid: ImportItemInput[] = []
  const rowsByFeedbackId = new Map<string, number[]>()

  items.forEach((raw, index) => {
    const row = index + 1
    if (!raw || typeof raw !== 'object') {
      errors.push(`Row ${row}: not an object`)
      return
    }
    const item = raw as Record<string, unknown>
    for (const field of REQUIRED_TEXT_FIELDS) {
      const value = item[field]
      if (typeof value !== 'string' || value.trim() === '') {
        errors.push(`Row ${row}: missing ${field}`)
        return
      }
    }
    const feedbackSource = normalizeFeedbackSource(item.feedbackSource)
    if (!feedbackSource) {
      errors.push(
        `Row ${row} (${String(item.feedbackId)}): feedbackSource must be "AI" or "HUMAN", got ${JSON.stringify(item.feedbackSource ?? '')}`
      )
      return
    }
    const feedbackId = (item.feedbackId as string).trim()
    const list = rowsByFeedbackId.get(feedbackId) ?? []
    list.push(row)
    rowsByFeedbackId.set(feedbackId, list)

    const optionalText = (key: string) =>
      typeof item[key] === 'string' && (item[key] as string).trim() !== ''
        ? (item[key] as string)
        : null

    valid.push({
      responseId: optionalText('responseId'),
      cycleId: optionalText('cycleId'),
      studentId: item.studentId as string,
      activityId: optionalText('activityId'),
      conjunctionId: optionalText('conjunctionId'),
      studentText: item.studentText as string,
      feedbackId,
      teacherId: optionalText('teacherId'),
      feedbackText: item.feedbackText as string,
      feedbackSource,
      optimal: optionalText('optimal'),
      feedbackType: optionalText('feedbackType'),
    })
  })

  for (const [feedbackId, rows] of rowsByFeedbackId) {
    if (rows.length > 1) {
      errors.push(
        `Feedback_ID "${feedbackId}" appears ${rows.length} times in this file (rows ${rows.join(', ')})`
      )
    }
  }

  return { items: valid, errors }
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

  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json(
      { error: 'projectId and items array are required' },
      { status: 400 }
    )
  }

  const validated = validateImportItems(items)
  if (validated.errors.length > 0) {
    return NextResponse.json(
      {
        error: `Import rejected: ${validated.errors.length} validation ${validated.errors.length === 1 ? 'error' : 'errors'}. Nothing was imported.`,
        details: validated.errors,
      },
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
  // createMany doesn't return ids, so the dedupe is manual: pre-check existing,
  // insert only new ones, tag with the Import id. In-file repeats were already
  // rejected above, so every surviving row is a distinct Feedback_ID.
  const incomingIds = validated.items.map((i) => i.feedbackId)
  const existing = await prisma.feedbackItem.findMany({
    where: { projectId, feedbackId: { in: incomingIds } },
    select: { feedbackId: true },
  })
  const existingIds = new Set(existing.map((e) => e.feedbackId))
  const newItems = validated.items.filter((i) => !existingIds.has(i.feedbackId))

  // The Import row and its items commit together: an Import must never claim
  // items that were not written (and a failed insert must not leave a
  // provenance row behind). displayOrder continues from the current max so a
  // rolling upload doesn't collide with earlier ones.
  const importRow = await prisma.$transaction(async (tx) => {
    const maxOrder = await tx.feedbackItem.aggregate({
      where: { projectId },
      _max: { displayOrder: true },
    })
    const startOrder = (maxOrder._max.displayOrder ?? -1) + 1

    const created = await tx.import.create({
      data: {
        projectId,
        filename: filename?.toString().slice(0, 255) || 'unnamed.csv',
        itemCount: newItems.length,
        skippedCount: validated.items.length - newItems.length,
      },
    })

    if (newItems.length > 0) {
      const result = await tx.feedbackItem.createMany({
        data: newItems.map((item, index) => ({
          projectId,
          importId: created.id,
          responseId: item.responseId,
          cycleId: item.cycleId,
          studentId: item.studentId,
          activityId: item.activityId,
          conjunctionId: item.conjunctionId,
          studentText: item.studentText,
          feedbackId: item.feedbackId,
          teacherId: item.teacherId,
          feedbackText: item.feedbackText,
          feedbackSource: item.feedbackSource,
          optimal: item.optimal,
          feedbackType: item.feedbackType,
          displayOrder: startOrder + index,
        })),
      })
      if (result.count !== newItems.length) {
        // Cannot happen without skipDuplicates (a collision throws instead),
        // but the Import's itemCount must never overstate what was written.
        throw new Error(
          `Expected to import ${newItems.length} items but wrote ${result.count}`
        )
      }
    }

    return created
  })

  return NextResponse.json(
    {
      importId: importRow.id,
      imported: newItems.length,
      skipped: validated.items.length - newItems.length,
      total: validated.items.length,
    },
    { status: 201 }
  )
}
