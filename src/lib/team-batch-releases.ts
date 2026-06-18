import { prisma } from '@/lib/db'

interface ReleaseWithContext {
  id: string
  scorerUserId: string | null
  batch?: {
    id: string
    isDoubleScored: boolean
    type?: string
  }
  isDoubleScored?: boolean
  batchType?: string
  status?: string
  team: {
    members: {
      userId: string
    }[]
    dimensions?: {
      dimensionId: string
    }[]
  }
}

export function getExpectedReleaseUserIds(release: ReleaseWithContext): string[] {
  // Every team member is assigned to the release.
  //   - TRAINING & double-scored: every member scores every item.
  //   - Non-double-scored regular: every member scores half the items (split by slotIndex).
  return release.team.members.map((member) => member.userId)
}

/**
 * How many scores are expected per (item × dimension) for this release.
 *
 *   - TRAINING:                 members.length (all members score everything)
 *   - Double-scored regular:    2 (both members score everything)
 *   - Non-double-scored regular: 1 (each item scored once, split across members)
 */
export function getExpectedScoresPerItemPerDimension(
  release: ReleaseWithContext
): number {
  const batchType = release.batch?.type ?? release.batchType
  const isDoubleScored = release.batch?.isDoubleScored ?? release.isDoubleScored

  if (batchType === 'TRAINING') {
    return release.team.members.length
  }
  if (isDoubleScored) {
    return release.team.members.length >= 2 ? 2 : release.team.members.length
  }
  return release.team.members.length > 0 ? 1 : 0
}

export function releaseNeedsReconciliation(release: ReleaseWithContext): boolean {
  const batchType = release.batch?.type ?? release.batchType
  const isDoubleScored = release.batch?.isDoubleScored ?? release.isDoubleScored

  return batchType === 'TRAINING' || Boolean(isDoubleScored)
}

export function getExpectedReleaseDimensionIds(
  release: ReleaseWithContext,
  projectDimensionIds: string[]
): string[] {
  const batchType = release.batch?.type ?? release.batchType

  if (batchType === 'TRAINING') {
    return projectDimensionIds
  }

  return release.team.dimensions?.map((dimension) => dimension.dimensionId) ?? []
}

export function getReleaseOwnerUserId(release: ReleaseWithContext): string | null {
  return release.team.members[0]?.userId ?? null
}

/**
 * True when this release splits items by slotIndex between two team members
 * (non-double-scored regular with ≥2 members). Training and double-scored
 * batches do not split — every member scores everything.
 */
export function isSlotSplitRelease(release: ReleaseWithContext): boolean {
  const batchType = release.batch?.type ?? release.batchType
  const isDoubleScored = release.batch?.isDoubleScored ?? release.isDoubleScored
  return (
    batchType === 'REGULAR' &&
    !isDoubleScored &&
    release.team.members.length >= 2
  )
}

/**
 * Returns 0/1 for the given user on a slot-split release (based on the team's
 * email-asc ordering). Returns null if the user isn't a team member or the
 * release doesn't split.
 */
export function getReleaseUserSlotIndex(
  release: ReleaseWithContext,
  userId: string
): number | null {
  if (!isSlotSplitRelease(release)) return null
  const idx = release.team.members.findIndex((m) => m.userId === userId)
  return idx === -1 ? null : idx
}

export async function syncBatchStatus(batchId: string) {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    select: {
      id: true,
      teamReleases: {
        select: {
          status: true,
        },
      },
    },
  })

  if (!batch) {
    return null
  }

  const statuses = batch.teamReleases.map((release) => release.status)
  const nextStatus =
    statuses.length === 0
      ? 'DRAFT'
      : statuses.every((status) => status === 'COMPLETE')
        ? 'COMPLETE'
        : statuses.some((status) => status === 'RECONCILING')
          ? 'RECONCILING'
          : statuses.some((status) => status === 'SCORING')
            ? 'SCORING'
            : 'DRAFT'

  return prisma.batch.update({
    where: { id: batchId },
    data: {
      status: nextStatus,
      isAssigned: statuses.some((status) => status !== 'DRAFT'),
    },
  })
}

/**
 * Ensure every team in the batch's project has a TeamBatchRelease for this
 * batch, creating any that are missing (hidden, DRAFT) and wiring up their
 * assignments. Returns the ids of releases created.
 *
 * Releases are normally created at batch-creation time for the teams that
 * exist then — so a batch created before its teams existed (or before a team
 * was added) ends up with missing releases and can't be assigned/scored.
 * This back-fills them. It never removes releases for teams that no longer
 * exist. New releases are hidden (isVisible=false) so assignment stays
 * decoupled from visibility.
 */
export async function ensureTeamReleasesForBatch(
  batchId: string
): Promise<string[]> {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    select: {
      id: true,
      projectId: true,
      teamReleases: { select: { teamId: true } },
    },
  })
  if (!batch) {
    throw new Error('Batch not found')
  }

  const existingTeamIds = new Set(batch.teamReleases.map((r) => r.teamId))
  const teams = await prisma.evaluatorTeam.findMany({
    where: { projectId: batch.projectId },
    select: { id: true },
  })
  const missingTeams = teams.filter((team) => !existingTeamIds.has(team.id))
  if (missingTeams.length === 0) {
    return []
  }

  const created: string[] = []
  for (const team of missingTeams) {
    const release = await prisma.teamBatchRelease.create({
      data: {
        batchId,
        teamId: team.id,
        isVisible: false,
        status: 'DRAFT',
        scorerUserId: null,
      },
    })
    created.push(release.id)
    await syncBatchAssignmentsForRelease(release.id)
  }

  await syncBatchStatus(batchId)
  return created
}

export async function syncBatchAssignmentsForRelease(releaseId: string) {
  const release = await prisma.teamBatchRelease.findUnique({
    where: { id: releaseId },
    include: {
      batch: {
        select: {
          id: true,
          isDoubleScored: true,
          type: true,
        },
      },
      team: {
        include: {
          members: {
            select: {
              userId: true,
            },
            orderBy: {
              user: { email: 'asc' },
            },
          },
          dimensions: {
            select: {
              dimensionId: true,
            },
          },
        },
      },
    },
  })

  if (!release) {
    throw new Error('Release not found')
  }

  const userIds = getExpectedReleaseUserIds(release)

  await prisma.$transaction(async (tx) => {
    await tx.batchAssignment.deleteMany({
      where: { teamReleaseId: releaseId },
    })

    if (userIds.length === 0) {
      return
    }

    await tx.batchAssignment.createMany({
      data: userIds.map((userId, index) => ({
        batchId: release.batch.id,
        userId,
        teamReleaseId: releaseId,
        // Only double-scored uses the PRIMARY/DOUBLE distinction. For
        // non-double-scored regular the two members each own half the items,
        // so both are PRIMARY for their own slot.
        scoringRole:
          release.batch.isDoubleScored && index > 0 ? 'DOUBLE' : 'PRIMARY',
      })),
      skipDuplicates: true,
    })

    await tx.batch.update({
      where: { id: release.batch.id },
      data: { isAssigned: true },
    })
  })

  await syncBatchStatus(release.batch.id)
}
