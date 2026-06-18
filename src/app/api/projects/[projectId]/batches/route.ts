import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import { prisma } from '@/lib/db'
import { compareFeedbackIds } from '@/lib/feedback-id'
import { computeBatchIRRSummary } from '@/lib/irr'
import { computeReleaseDiscrepancyStats } from '@/lib/reconciliation'
import {
  getExpectedReleaseUserIds,
  getExpectedScoresPerItemPerDimension,
  syncBatchAssignmentsForRelease,
} from '@/lib/team-batch-releases'
import { assignBatchSlots } from '@/lib/batch-slots'
import { NextRequest, NextResponse } from 'next/server'

interface BatchRangeInput {
  startFeedbackId: string
  endFeedbackId: string
}

interface IndexedItem {
  id: string
  feedbackId: string
  batchId: string | null
  activityId: string | null
  conjunctionId: string | null
}

// GET /api/projects/[projectId]/batches — list batches with stats
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { projectId } = await params

  if (!(await canAdminProject(session.user.id, session.user.role, projectId))) {
    const membership = await prisma.projectEvaluator.findUnique({
      where: { projectId_userId: { projectId, userId: session.user.id } },
    })
    if (!membership) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const batches = await prisma.batch.findMany({
    where: { projectId },
    include: {
      _count: { select: { feedbackItems: true } },
      ranges: {
        orderBy: { sortOrder: 'asc' },
      },
      assignments: {
        include: {
          user: { select: { id: true, email: true, name: true } },
          teamRelease: {
            select: {
              id: true,
              isVisible: true,
            },
          },
        },
      },
      teamReleases: {
        include: {
          scorerUser: {
            select: { id: true, email: true, name: true },
          },
          team: {
            include: {
              members: {
                include: {
                  user: {
                    select: { id: true, email: true, name: true },
                  },
                },
                orderBy: { user: { email: 'asc' } },
              },
              dimensions: {
                include: {
                  dimension: {
                    select: { id: true, label: true, sortOrder: true },
                  },
                },
                orderBy: { dimension: { sortOrder: 'asc' } },
              },
            },
          },
        },
        orderBy: { team: { name: 'asc' } },
      },
    },
    orderBy: { sortOrder: 'asc' },
  })

  const projectDimensions = await prisma.rubricDimension.findMany({
    where: { projectId },
    select: { id: true, label: true },
    orderBy: { sortOrder: 'asc' },
  })

  const batchesWithStats = await Promise.all(
    batches.map(async (batch) => {
      let irrSummary:
        | {
            applicableTeamCount: number
            computedTeamCount: number
            readyTeamCount: number
            averageAgreementPct: number | null
            lowestAgreementPct: number | null
            perDimension: {
              dimensionId: string
              dimensionLabel: string
              agreementPct: number | null
              agreedPairs: number
              totalPairs: number
            }[]
          }
        | null = null
      let teamIrrByReleaseId = new Map<
        string,
        {
          isApplicable: boolean
          isReady: boolean
          agreementPct: number | null
          agreedPairs: number
          totalPairs: number
          perDimension: {
            dimensionId: string
            dimensionLabel: string
            agreementPct: number | null
            agreedPairs: number
            totalPairs: number
          }[]
        }
      >()
      if (
        batch.type === 'REGULAR' &&
        batch.isDoubleScored &&
        (batch.status === 'SCORING' ||
          batch.status === 'RECONCILING' ||
          batch.status === 'COMPLETE')
      ) {
        const irr = await computeBatchIRRSummary(batch.id)
        irrSummary = irr
          ? {
              applicableTeamCount: irr.applicableTeamCount,
              computedTeamCount: irr.computedTeamCount,
              readyTeamCount: irr.readyTeamCount,
              averageAgreementPct: irr.averageAgreementPct,
              lowestAgreementPct: irr.lowestAgreementPct,
              perDimension: irr.perDimension,
            }
          : null
        teamIrrByReleaseId = new Map(
          irr?.teams.map((team) => [
            team.releaseId,
            {
              isApplicable: team.isApplicable,
              isReady: team.isReady,
              agreementPct: team.agreementPct,
              agreedPairs: team.agreedPairs,
              totalPairs: team.totalPairs,
              perDimension: team.perDimension,
            },
          ]) ?? []
        )
      }

      // Batch-level discrepancy/reconciled rollup = sum of the per-release
      // stats from the shared helper (P12). The previous inline copy grouped
      // raw scores batch-wide and only counted pairs of exactly 2, so TRAINING
      // releases (3+ raters) and per-team scoping were mis-counted.
      let discrepancyCount: number | undefined
      let reconciledCount: number | undefined
      if (batch.status === 'RECONCILING') {
        discrepancyCount = 0
        reconciledCount = 0
        for (const release of batch.teamReleases) {
          const stats = await computeReleaseDiscrepancyStats({
            batchId: batch.id,
            batchType: batch.type,
            projectId,
            memberUserIds: release.team.members.map((m) => m.user.id),
            teamDimensionIds: release.team.dimensions.map((d) => d.dimension.id),
          })
          discrepancyCount += stats.discrepancyCount
          reconciledCount += stats.reconciledCount
        }
      }

      const teamReleases = await Promise.all(
        batch.teamReleases.map(async (release) => {
          const releaseContext = {
            ...release,
            isDoubleScored: batch.isDoubleScored,
            batchType: batch.type,
          }
          const expectedUserIds = getExpectedReleaseUserIds(releaseContext)
          const scoresPerItemPerDim = getExpectedScoresPerItemPerDimension(releaseContext)
          const dimensionIds =
            batch.type === 'TRAINING'
              ? projectDimensions.map((dimension) => dimension.id)
              : release.team.dimensions.map((dimension) => dimension.dimensionId)
          const expectedScoreCount =
            batch._count.feedbackItems *
            dimensionIds.length *
            scoresPerItemPerDim

          const actualScoreCount =
            expectedScoreCount > 0
              ? await prisma.score.count({
                  where: {
                    feedbackItem: { batchId: batch.id },
                    userId: { in: expectedUserIds },
                    dimensionId: { in: dimensionIds },
                    isReconciled: false,
                  },
                })
              : 0

          const progressPct =
            expectedScoreCount > 0
              ? Math.min(
                  100,
                  Math.round((actualScoreCount / expectedScoreCount) * 100)
                )
              : 0

          return {
            id: release.id,
            teamId: release.teamId,
            teamName: release.team.name,
            isVisible: release.isVisible,
            status: release.status,
            scorerUserId: release.scorerUserId,
            adjudicatorId: release.adjudicatorId,
            scorer:
              release.scorerUser && !batch.isDoubleScored
                ? {
                    id: release.scorerUser.id,
                    email: release.scorerUser.email,
                    name: release.scorerUser.name,
                  }
                : null,
            members: release.team.members.map((member) => ({
              id: member.user.id,
              email: member.user.email,
              name: member.user.name,
            })),
            dimensions:
              batch.type === 'TRAINING'
                ? projectDimensions.map((dimension) => ({
                    id: dimension.id,
                    label: dimension.label,
                  }))
                : release.team.dimensions.map((dimension) => ({
                    id: dimension.dimension.id,
                    label: dimension.dimension.label,
                  })),
            progressPct,
            actualScoreCount,
            expectedScoreCount,
            irr: teamIrrByReleaseId.get(release.id) ?? null,
          }
        })
      )

      const visibleTeamReleases = teamReleases.filter((release) => release.isVisible)
      const totalExpectedScoreCount = visibleTeamReleases.reduce(
        (sum, release) => sum + release.expectedScoreCount,
        0
      )
      const totalActualScoreCount = visibleTeamReleases.reduce(
        (sum, release) => sum + release.actualScoreCount,
        0
      )
      const progressPct =
        totalExpectedScoreCount > 0
          ? Math.min(
              100,
              Math.round((totalActualScoreCount / totalExpectedScoreCount) * 100)
            )
          : 0
      const scoreCount = await prisma.score.count({
        where: { feedbackItem: { batchId: batch.id } },
      })

      return {
        id: batch.id,
        name: batch.name,
        activityId: batch.activityId,
        conjunctionId: batch.conjunctionId,
        status: batch.status,
        type: batch.type,
        isDoubleScored: batch.isDoubleScored,
        size: batch.size,
        sortOrder: batch.sortOrder,
        isHidden: batch.isHidden,
        createdAt: batch.createdAt,
        itemCount: batch._count.feedbackItems,
        progressPct,
        discrepancyCount,
        reconciledCount,
        canEditBatchType: scoreCount === 0,
        irrSummary,
        ranges: batch.ranges.map((range) => ({
          id: range.id,
          startFeedbackId: range.startFeedbackId,
          endFeedbackId: range.endFeedbackId,
          itemCount: range.itemCount,
        })),
        evaluators: batch.assignments.map((assignment) => ({
          ...assignment.user,
          scoringRole: assignment.scoringRole,
          isVisible: assignment.teamRelease?.isVisible ?? !batch.isHidden,
        })),
        teamReleases,
      }
    })
  )

  return NextResponse.json(batchesWithStats)
}

// POST /api/projects/[projectId]/batches — create a batch from feedback-id ranges
export async function POST(
  request: Request,
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

  const body = await request.json()

  if (body.mode === 'auto') {
    return handleAutoMode(projectId, body)
  }

  const {
    activityId,
    conjunctionId,
    type = 'REGULAR',
    randomize = true,
    visibleToTeams = false,
    itemIds: trainingItemIds,
    ranges = [],
  } = body as {
    activityId?: string
    conjunctionId?: string
    type?: 'REGULAR' | 'TRAINING'
    randomize?: boolean
    visibleToTeams?: boolean
    itemIds?: string[]
    ranges?: BatchRangeInput[]
  }

  const isDoubleScored =
    type === 'REGULAR' ? Boolean(body.isDoubleScored) : false

  if (
    type === 'TRAINING' &&
    Array.isArray(trainingItemIds) &&
    trainingItemIds.length > 0
  ) {
    const sortOrder = await prisma.batch.count({ where: { projectId } })
    const batchName = `Training Batch ${sortOrder + 1}`

    const teams = await prisma.evaluatorTeam.findMany({
      where: { projectId },
      include: {
        members: {
          include: { user: { select: { email: true } } },
          orderBy: { user: { email: 'asc' } },
        },
      },
      orderBy: { name: 'asc' },
    })

    // Atomic core (P8): the batch, its item migration, and its team releases
    // commit together so a partial failure can't orphan a half-wired batch.
    // Assignment + display-order wiring runs after commit (idempotent).
    const { batch, releaseIds } = await prisma.$transaction(async (tx) => {
      const created = await tx.batch.create({
        data: {
          projectId,
          name: batchName,
          type: 'TRAINING',
          status: visibleToTeams ? 'SCORING' : 'DRAFT',
          size: trainingItemIds.length,
          sortOrder,
        },
      })
      await tx.feedbackItem.updateMany({
        where: { id: { in: trainingItemIds }, projectId },
        data: { batchId: created.id },
      })
      const releaseIds: string[] = []
      for (const team of teams) {
        const release = await tx.teamBatchRelease.create({
          data: {
            batchId: created.id,
            teamId: team.id,
            isVisible: visibleToTeams,
            scorerUserId: null,
          },
        })
        releaseIds.push(release.id)
      }
      return { batch: created, releaseIds }
    })

    for (const releaseId of releaseIds) {
      await syncBatchAssignmentsForRelease(releaseId)
    }

    if (randomize) {
      await randomizeDisplayOrder(batch.id)
    }

    return NextResponse.json(
      { id: batch.id, name: batchName, itemCount: trainingItemIds.length, type },
      { status: 201 }
    )
  }

  if (!Array.isArray(ranges) || ranges.length === 0) {
    return NextResponse.json(
      { error: 'At least one feedback ID range is required' },
      { status: 400 }
    )
  }

  const allProjectItems = await prisma.feedbackItem.findMany({
    where: { projectId },
    select: {
      id: true,
      feedbackId: true,
      batchId: true,
      activityId: true,
      conjunctionId: true,
    },
  })

  if (allProjectItems.length === 0) {
    return NextResponse.json(
      { error: 'No feedback items found for this project' },
      { status: 400 }
    )
  }

  const sortedItems = [...allProjectItems].sort((a, b) =>
    compareFeedbackIds(a.feedbackId, b.feedbackId)
  )
  const indexByFeedbackId = new Map(
    sortedItems.map((item, index) => [item.feedbackId, index])
  )

  let normalizedRanges: {
    startFeedbackId: string
    endFeedbackId: string
    startIndex: number
    endIndex: number
    sortOrder: number
  }[]
  try {
    normalizedRanges = ranges.map((range, index) => {
      const startFeedbackId = range.startFeedbackId?.trim()
      const endFeedbackId = range.endFeedbackId?.trim()

      if (!startFeedbackId || !endFeedbackId) {
        throw new Error(
          `Range ${index + 1} is missing a start or end feedback ID`
        )
      }

      const startIndex = indexByFeedbackId.get(startFeedbackId)
      const endIndex = indexByFeedbackId.get(endFeedbackId)

      if (startIndex === undefined || endIndex === undefined) {
        throw new Error(
          `Range ${index + 1} references a feedback ID that does not exist in this project`
        )
      }

      if (startIndex > endIndex) {
        throw new Error(
          `Range ${index + 1} must start before or at its ending feedback ID`
        )
      }

      return {
        startFeedbackId,
        endFeedbackId,
        startIndex,
        endIndex,
        sortOrder: index,
      }
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid batch ranges' },
      { status: 400 }
    )
  }

  normalizedRanges.sort((a, b) => a.startIndex - b.startIndex)
  for (let i = 1; i < normalizedRanges.length; i++) {
    const previous = normalizedRanges[i - 1]
    const current = normalizedRanges[i]
    if (current.startIndex <= previous.endIndex) {
      return NextResponse.json(
        { error: 'Feedback ID ranges cannot overlap within the same batch' },
        { status: 400 }
      )
    }
  }

  const selectedItemIds = new Set<string>()
  let rangesToCreate: {
    startFeedbackId: string
    endFeedbackId: string
    itemCount: number
    sortOrder: number
  }[]
  try {
    rangesToCreate = normalizedRanges.map((range) => {
      const slice = sortedItems.slice(range.startIndex, range.endIndex + 1)
      const blockedItem = slice.find((item) => item.batchId !== null)

      if (blockedItem) {
        throw new Error(
          `Feedback ID range ${range.startFeedbackId}–${range.endFeedbackId} includes already-batched item ${blockedItem.feedbackId}`
        )
      }

      for (const item of slice) {
        selectedItemIds.add(item.id)
      }

      return {
        startFeedbackId: range.startFeedbackId,
        endFeedbackId: range.endFeedbackId,
        itemCount: slice.length,
        sortOrder: range.sortOrder,
      }
    })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Invalid feedback ID range',
      },
      { status: 400 }
    )
  }

  const selectedItems = sortedItems.filter((item) => selectedItemIds.has(item.id))
  if (selectedItems.length === 0) {
    return NextResponse.json(
      { error: 'No feedback items were selected for this batch' },
      { status: 400 }
    )
  }

  const inferredActivityId = inferSharedValue(selectedItems, 'activityId')
  const inferredConjunctionId = inferSharedValue(selectedItems, 'conjunctionId')

  const sortOrder = await prisma.batch.count({ where: { projectId } })
  const name = `Batch ${sortOrder + 1}`

  const teams =
    type === 'REGULAR' || type === 'TRAINING'
      ? await prisma.evaluatorTeam.findMany({
          where: { projectId },
          include: {
            members: {
              include: { user: { select: { email: true } } },
              orderBy: { user: { email: 'asc' } },
            },
          },
          orderBy: { name: 'asc' },
        })
      : []

  // Atomic core (P8): batch + item migration + ranges + team releases commit
  // together. Slot/assignment/display-order wiring runs after commit; those
  // helpers are idempotent and re-derive from the committed rows.
  const { batch, releaseIds } = await prisma.$transaction(async (tx) => {
    const created = await tx.batch.create({
      data: {
        projectId,
        name,
        activityId: activityId || inferredActivityId,
        conjunctionId: conjunctionId || inferredConjunctionId,
        type,
        isDoubleScored,
        status: visibleToTeams ? 'SCORING' : 'DRAFT',
        size: selectedItems.length,
        sortOrder,
        ranges: { create: rangesToCreate },
      },
    })
    await tx.feedbackItem.updateMany({
      where: { id: { in: Array.from(selectedItemIds) } },
      data: { batchId: created.id },
    })
    const releaseIds: string[] = []
    for (const team of teams) {
      const release = await tx.teamBatchRelease.create({
        data: {
          batchId: created.id,
          teamId: team.id,
          isVisible: visibleToTeams,
          status: visibleToTeams ? 'SCORING' : 'DRAFT',
          // scorerUserId is set later (single-scorer feature); split is default.
          scorerUserId: null,
        },
      })
      releaseIds.push(release.id)
    }
    return { batch: created, releaseIds }
  })

  // Non-double-scored regular: shuffle items into slots A/B (one shuffle,
  // consistent across all team releases). Double-scored/training don't use slots.
  if (type === 'REGULAR' && !isDoubleScored) {
    await assignBatchSlots(batch.id)
  }
  for (const releaseId of releaseIds) {
    await syncBatchAssignmentsForRelease(releaseId)
  }

  if (randomize) {
    await randomizeDisplayOrder(batch.id)
  }

  return NextResponse.json(
    {
      id: batch.id,
      name,
      itemCount: selectedItems.length,
      type,
      isDoubleScored,
    },
    { status: 201 }
  )
}

function inferSharedValue<T extends 'activityId' | 'conjunctionId'>(
  items: IndexedItem[],
  key: T
) {
  const values = new Set(items.map((item) => item[key]).filter(Boolean))
  return values.size === 1 ? (Array.from(values)[0] ?? null) : null
}

// Shuffle displayOrder for items in a batch (Fisher-Yates via DB)
async function randomizeDisplayOrder(batchId: string) {
  const items = await prisma.feedbackItem.findMany({
    where: { batchId },
    select: { id: true },
  })

  const { randomInt } = await import('crypto')
  const indices = items.map((_, index) => index)
  for (let index = indices.length - 1; index > 0; index--) {
    const swapIndex = randomInt(index + 1)
    ;[indices[index], indices[swapIndex]] = [
      indices[swapIndex],
      indices[index],
    ]
  }

  await Promise.all(
    items.map((item, index) =>
      prisma.feedbackItem.update({
        where: { id: item.id },
        data: { displayOrder: indices[index] },
      })
    )
  )
}

// Legacy auto-group mode (kept for backward compat)
async function handleAutoMode(
  projectId: string,
  body: { batchSize?: number }
) {
  const batchSize = body.batchSize || 250

  const unbatchedItems = await prisma.feedbackItem.findMany({
    where: { projectId, batchId: null },
    orderBy: { displayOrder: 'asc' },
  })

  if (unbatchedItems.length === 0) {
    return NextResponse.json(
      { error: 'No unbatched items found' },
      { status: 400 }
    )
  }

  const groups = new Map<string, typeof unbatchedItems>()
  for (const item of unbatchedItems) {
    const key = `${item.activityId ?? 'unknown'}::${item.conjunctionId ?? 'unknown'}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(item)
  }

  const createdBatches: { id: string; name: string; itemCount: number }[] = []
  let sortOrder = await prisma.batch.count({ where: { projectId } })

  for (const [key, groupItems] of groups) {
    const [activityId, conjunctionId] = key.split('::')
    const chunks: (typeof groupItems)[] = []

    for (let index = 0; index < groupItems.length; index += batchSize) {
      chunks.push(groupItems.slice(index, index + batchSize))
    }

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const chunk = chunks[chunkIdx]
      const batchName =
        chunks.length > 1
          ? `Activity ${activityId} / ${conjunctionId} / Batch ${chunkIdx + 1}`
          : `Activity ${activityId} / ${conjunctionId}`

      // Batch + its item migration commit together (P8).
      const batch = await prisma.$transaction(async (tx) => {
        const created = await tx.batch.create({
          data: {
            projectId,
            name: batchName,
            activityId: activityId === 'unknown' ? null : activityId,
            conjunctionId: conjunctionId === 'unknown' ? null : conjunctionId,
            size: batchSize,
            sortOrder: sortOrder++,
          },
        })
        await tx.feedbackItem.updateMany({
          where: { id: { in: chunk.map((item) => item.id) } },
          data: { batchId: created.id },
        })
        return created
      })

      createdBatches.push({
        id: batch.id,
        name: batch.name,
        itemCount: chunk.length,
      })
    }
  }

  return NextResponse.json(
    { created: createdBatches.length, batches: createdBatches },
    { status: 201 }
  )
}
