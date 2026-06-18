import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import { prisma } from '@/lib/db'
import {
  getExpectedReleaseDimensionIds,
  getReleaseOwnerUserId,
} from '@/lib/team-batch-releases'
import { NextRequest, NextResponse } from 'next/server'

// GET /api/projects/[projectId]/batches/[batchId]/discrepancies?releaseId=...
// Returns items with scoring discrepancies for one team release.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; batchId: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { projectId, batchId } = await params
  const releaseId = request.nextUrl.searchParams.get('releaseId')
  if (!releaseId) {
    return NextResponse.json({ error: 'releaseId is required' }, { status: 400 })
  }

  if (!(await canAdminProject(session.user.id, session.user.role, projectId))) {
    const assignment = await prisma.batchAssignment.findFirst({
      where: {
        batchId,
        userId: session.user.id,
        teamReleaseId: releaseId,
      },
      select: { id: true },
    })
    if (!assignment) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const release = await prisma.teamBatchRelease.findUnique({
    where: { id: releaseId },
    include: {
      batch: {
        select: {
          id: true,
          projectId: true,
          type: true,
          isDoubleScored: true,
        },
      },
      team: {
        include: {
          members: {
            include: {
              user: { select: { id: true, name: true, email: true } },
            },
            orderBy: { user: { email: 'asc' } },
          },
          dimensions: {
            include: {
              dimension: {
                select: {
                  id: true,
                  key: true,
                  label: true,
                  sortOrder: true,
                  scaleMin: true,
                  scaleMax: true,
                  scoreLabelJson: true,
                },
              },
            },
            orderBy: { dimension: { sortOrder: 'asc' } },
          },
        },
      },
    },
  })

  if (
    !release ||
    release.batchId !== batchId ||
    release.batch.projectId !== projectId
  ) {
    return NextResponse.json({ error: 'Release not found' }, { status: 404 })
  }

  if (release.status !== 'RECONCILING') {
    return NextResponse.json(
      { error: 'Release must be in RECONCILING status' },
      { status: 400 }
    )
  }

  const projectDimensionIds =
    release.batch.type === 'TRAINING'
      ? (
          await prisma.rubricDimension.findMany({
            where: { projectId },
            select: {
              id: true,
              key: true,
              label: true,
              sortOrder: true,
              scaleMin: true,
              scaleMax: true,
              scoreLabelJson: true,
            },
            orderBy: { sortOrder: 'asc' },
          })
        ).map((dimension) => dimension.id)
      : []

  const dimensionIds = getExpectedReleaseDimensionIds(release, projectDimensionIds)
  const userIds = release.team.members.map((member) => member.userId)
  const ownerUserId = getReleaseOwnerUserId(release)
  const hasAdjudicator = release.adjudicatorId != null

  const scores = await prisma.score.findMany({
    where: {
      feedbackItem: { batchId },
      userId: { in: userIds },
      dimensionId: { in: dimensionIds },
      isReconciled: false,
    },
    include: {
      feedbackItem: {
        select: {
          id: true,
          studentText: true,
          feedbackText: true,
          activityId: true,
          conjunctionId: true,
          displayOrder: true,
        },
      },
      user: { select: { id: true, name: true, email: true } },
      dimension: {
        select: {
          id: true,
          key: true,
          label: true,
          sortOrder: true,
          scaleMin: true,
          scaleMax: true,
          scoreLabelJson: true,
        },
      },
    },
  })

  const notesByItemUser = new Map<string, string>()
  for (const score of scores) {
    const key = `${score.feedbackItemId}::${score.userId}`
    if (score.notes && score.notes.trim() && !notesByItemUser.has(key)) {
      notesByItemUser.set(key, score.notes)
    }
  }

  const openEscalations = await prisma.escalation.findMany({
    where: { batchId, teamReleaseId: releaseId, resolvedAt: null },
    select: {
      id: true,
      feedbackItemId: true,
      dimensionId: true,
      createdAt: true,
      escalatedBy: { select: { id: true, name: true, email: true } },
    },
  })
  const escalationByKey = new Map<
    string,
    {
      id: string
      escalatedBy: { id: string; name: string | null; email: string }
      createdAt: Date
    }
  >()
  for (const esc of openEscalations) {
    escalationByKey.set(`${esc.feedbackItemId}::${esc.dimensionId}`, {
      id: esc.id,
      escalatedBy: esc.escalatedBy,
      createdAt: esc.createdAt,
    })
  }

  const groupMap = new Map<
    string,
    {
      feedbackItem: (typeof scores)[0]['feedbackItem']
      dimension: (typeof scores)[0]['dimension']
      evaluators: {
        userId: string
        name: string | null
        email: string
        value: number
        scoreId: string
      }[]
    }
  >()

  for (const score of scores) {
    const key = `${score.feedbackItemId}::${score.dimensionId}`
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        feedbackItem: score.feedbackItem,
        dimension: score.dimension,
        evaluators: [],
      })
    }
    groupMap.get(key)!.evaluators.push({
      userId: score.user.id,
      name: score.user.name,
      email: score.user.email,
      value: score.value,
      scoreId: score.id,
    })
  }

  type ItemCoder = {
    userId: string
    name: string | null
    email: string
    notes: string | null
  }

  const itemMap = new Map<
    string,
    {
      feedbackItemId: string
      studentText: string
      feedbackText: string
      activityId: string | null
      conjunctionId: string | null
      displayOrder: number | null
      coders: ItemCoder[]
      discrepancies: {
        dimensionId: string
        dimensionLabel: string
        dimensionKey: string
        sortOrder: number
        scaleMin: number
        scaleMax: number
        scoreLabelJson: string | null
        evaluatorA: {
          userId: string
          name: string | null
          email: string
          value: number
          scoreId: string
        }
        evaluatorB: {
          userId: string
          name: string | null
          email: string
          value: number
          scoreId: string
        }
        escalation: {
          id: string
          escalatedByName: string | null
          escalatedByEmail: string
        } | null
      }[]
      agreements: {
        dimensionId: string
        dimensionLabel: string
        value: number
      }[]
    }
  >()

  for (const [, group] of groupMap) {
    if (group.evaluators.length !== 2) continue
    if (group.evaluators[0].userId === group.evaluators[1].userId) continue

    const fid = group.feedbackItem.id
    if (!itemMap.has(fid)) {
      itemMap.set(fid, {
        feedbackItemId: fid,
        studentText: group.feedbackItem.studentText,
        feedbackText: group.feedbackItem.feedbackText,
        activityId: group.feedbackItem.activityId,
        conjunctionId: group.feedbackItem.conjunctionId,
        displayOrder: group.feedbackItem.displayOrder,
        coders: [],
        discrepancies: [],
        agreements: [],
      })
    }

    const item = itemMap.get(fid)!
    for (const ev of group.evaluators) {
      if (!item.coders.some((coder) => coder.userId === ev.userId)) {
        item.coders.push({
          userId: ev.userId,
          name: ev.name,
          email: ev.email,
          notes: notesByItemUser.get(`${fid}::${ev.userId}`) ?? null,
        })
      }
    }

    const [evaluatorA, evaluatorB] = group.evaluators
    if (evaluatorA.value !== evaluatorB.value) {
      const escalation = escalationByKey.get(
        `${group.feedbackItem.id}::${group.dimension.id}`
      )
      item.discrepancies.push({
        dimensionId: group.dimension.id,
        dimensionLabel: group.dimension.label,
        dimensionKey: group.dimension.key,
        sortOrder: group.dimension.sortOrder,
        scaleMin: group.dimension.scaleMin,
        scaleMax: group.dimension.scaleMax,
        scoreLabelJson: group.dimension.scoreLabelJson,
        evaluatorA,
        evaluatorB,
        escalation: escalation
          ? {
              id: escalation.id,
              escalatedByName: escalation.escalatedBy.name,
              escalatedByEmail: escalation.escalatedBy.email,
            }
          : null,
      })
    } else {
      item.agreements.push({
        dimensionId: group.dimension.id,
        dimensionLabel: group.dimension.label,
        value: evaluatorA.value,
      })
    }
  }

  const items = Array.from(itemMap.values())
    .filter((item) => item.discrepancies.length > 0)
    .sort((a, b) => {
      const aOrder = a.displayOrder ?? Number.MAX_SAFE_INTEGER
      const bOrder = b.displayOrder ?? Number.MAX_SAFE_INTEGER
      if (aOrder !== bOrder) return aOrder - bOrder
      return a.feedbackItemId.localeCompare(b.feedbackItemId)
    })

  const reconciledCount =
    ownerUserId == null
      ? 0
      : await prisma.score.count({
          where: {
            feedbackItem: { batchId },
            userId: ownerUserId,
            dimensionId: { in: dimensionIds },
            isReconciled: true,
          },
        })

  const totalDiscrepancies = items.reduce(
    (sum, item) => sum + item.discrepancies.length,
    0
  )
  const totalDimensionPairs = Array.from(groupMap.keys()).length

  return NextResponse.json({
    items,
    hasAdjudicator,
    summary: {
      totalItems: itemMap.size,
      discrepantItems: items.length,
      totalDiscrepancies,
      totalDimensionPairs,
      reconciledCount,
    },
  })
}
