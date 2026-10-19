import { prisma } from '@/lib/db'
import type { Prisma } from '@/generated/prisma/client'

/**
 * Either the shared Prisma client or the `tx` handed to an interactive
 * `$transaction` callback. Lifecycle helpers accept this so a route can run the
 * write that changes the truth AND the status re-derivation that reads it
 * inside one transaction; a read on the shared client would not see the
 * transaction's uncommitted writes.
 */
export type DbClient = Prisma.TransactionClient

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

/**
 * True when a non-double-scored regular release is assigned to ONE named scorer
 * (release.scorerUserId) rather than split 50/50 between the pair. Only regular
 * non-double batches can use a single scorer; training/double always use every
 * member.
 */
export function usesSingleScorer(release: ReleaseWithContext): boolean {
  const batchType = release.batch?.type ?? release.batchType
  const isDoubleScored = release.batch?.isDoubleScored ?? release.isDoubleScored
  return (
    batchType === 'REGULAR' && !isDoubleScored && Boolean(release.scorerUserId)
  )
}

export function getExpectedReleaseUserIds(release: ReleaseWithContext): string[] {
  // Single named scorer (non-double regular): only that person is assigned.
  if (usesSingleScorer(release)) {
    return release.team.members.some((m) => m.userId === release.scorerUserId)
      ? [release.scorerUserId as string]
      : []
  }
  // Otherwise every team member is assigned to the release.
  //   - TRAINING & double-scored: every member scores every item.
  //   - Non-double-scored regular (split): every member scores half (by slotIndex).
  return release.team.members.map((member) => member.userId)
}

export type ReleaseItemScope =
  | { mode: 'all' }
  | { mode: 'slot'; slotIndex: number }
  | { mode: 'none' }

/**
 * The single source of truth for "which of a release's items does this user
 * score": everything, just their slot half, or none. Replaces the slot logic
 * that used to be inlined in the feedback-items route.
 */
export function getReleaseItemScope(
  release: ReleaseWithContext,
  userId: string
): ReleaseItemScope {
  const isMember = release.team.members.some((m) => m.userId === userId)
  if (usesSingleScorer(release)) {
    return userId === release.scorerUserId ? { mode: 'all' } : { mode: 'none' }
  }
  if (isSlotSplitRelease(release)) {
    const idx = release.team.members.findIndex((m) => m.userId === userId)
    return idx === -1 ? { mode: 'none' } : { mode: 'slot', slotIndex: idx }
  }
  return isMember ? { mode: 'all' } : { mode: 'none' }
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
    !release.scorerUserId &&
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

export type DerivedBatchStatus = 'DRAFT' | 'SCORING' | 'RECONCILING' | 'COMPLETE'

/**
 * Roll a batch's status up from its team releases. Pure; `syncBatchStatus`
 * persists the result.
 *
 * A DRAFT release has never been worked: either nobody has published the batch
 * yet, or it is a hidden stub that `ensureTeamReleasesForBatch` back-filled for
 * a team created after the batch existed. Stubs must not drag a batch
 * backwards. The previous rule ("every COMPLETE → COMPLETE, else any
 * RECONCILING, else any SCORING, else DRAFT") turned [COMPLETE, COMPLETE, DRAFT]
 * into DRAFT, so adding a fifth team to a project demoted every finished batch
 * to DRAFT — dropping them from the final-by-item and discrepancy exports
 * (status ≠ DRAFT scope), showing them as inactive, and making them deletable.
 *
 * So DRAFT releases are ignored as soon as any release has progressed:
 *
 *   no release past DRAFT              → DRAFT
 *   every progressed release COMPLETE  → COMPLETE
 *   any progressed release RECONCILING → RECONCILING
 *   otherwise                          → SCORING
 *
 * Unpublishing a SCORING release next to a finished one ([COMPLETE,
 * SCORING→DRAFT]) therefore leaves the batch COMPLETE: the only team that ever
 * started is done. Visibility is deliberately not an input — a DRAFT release is
 * never visible, and a hidden release that has progressed still holds work.
 */
export function deriveBatchStatus(
  releases: { status: string }[]
): DerivedBatchStatus {
  const progressed = releases.filter((release) => release.status !== 'DRAFT')
  if (progressed.length === 0) return 'DRAFT'
  if (progressed.every((release) => release.status === 'COMPLETE')) {
    return 'COMPLETE'
  }
  if (progressed.some((release) => release.status === 'RECONCILING')) {
    return 'RECONCILING'
  }
  return 'SCORING'
}

export async function syncBatchStatus(batchId: string, db: DbClient = prisma) {
  const batch = await db.batch.findUnique({
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

  return db.batch.update({
    where: { id: batchId },
    data: {
      status: deriveBatchStatus(batch.teamReleases),
      isAssigned: batch.teamReleases.some((release) => release.status !== 'DRAFT'),
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
 *
 * Finished work is left alone: a batch that is COMPLETE or admin-locked gets
 * no stub releases. A new team has nothing to do on a batch whose scoring is
 * over, and the stub would only exist to be mis-read — it is what used to
 * demote finished batches to DRAFT (see deriveBatchStatus) and what makes a
 * COMPLETE batch look like it has an unstarted team.
 */
export async function ensureTeamReleasesForBatch(
  batchId: string
): Promise<string[]> {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    select: {
      id: true,
      projectId: true,
      status: true,
      isLocked: true,
      teamReleases: { select: { teamId: true } },
    },
  })
  if (!batch) {
    throw new Error('Batch not found')
  }
  if (batch.status === 'COMPLETE' || batch.isLocked) {
    return []
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

/**
 * Re-sync a team across every batch in its project after its membership or
 * dimensions change. Without this, BatchAssignment rows (and, for a brand-new
 * team, the existence of any TeamBatchRelease at all) go stale: new members
 * can't score, removed members still can, and a team created after batching is
 * invisible on existing batches. (P11)
 *
 * Safe because team member/dimension edits are blocked once scoring has begun,
 * so there is no scored data to orphan.
 */
export async function syncTeamAcrossBatches(teamId: string) {
  const team = await prisma.evaluatorTeam.findUnique({
    where: { id: teamId },
    select: { projectId: true },
  })
  if (!team) return

  const batches = await prisma.batch.findMany({
    where: { projectId: team.projectId },
    select: { id: true },
  })
  // Create any missing releases (covers a newly-created team) + wire their
  // assignments. Skips COMPLETE / locked batches — nothing to start there.
  for (const batch of batches) {
    await ensureTeamReleasesForBatch(batch.id)
  }
  // Re-sync assignments for this team's existing releases (covers membership
  // changes on a team that already had releases). This still runs for releases
  // on finished batches, so an existing release is never left stale.
  const releases = await prisma.teamBatchRelease.findMany({
    where: { teamId, batch: { projectId: team.projectId } },
    select: { id: true },
  })
  for (const release of releases) {
    await syncBatchAssignmentsForRelease(release.id)
  }
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
