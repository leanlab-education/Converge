/**
 * One-off backfill: persist `TeamBatchRelease.ownerUserId` and
 * `BatchAssignment.slotIndex` for rows written before those columns existed.
 *
 * Until a row has a value, the app falls back to the legacy rule (team members
 * ordered by email ascending: members[0] is the owner, each member's slot is
 * its index). This script writes exactly that rule into the columns, so
 * nothing changes for annotators — it only stops the values from moving if an
 * email is ever edited. Rules live in src/lib/release-ownership.ts and are the
 * same code syncBatchAssignmentsForRelease uses for new releases.
 *
 * Prerequisite: `npx prisma db push` has added the two nullable columns.
 *
 * Usage (always under doppler so DATABASE_URL is set):
 *
 *   # 1. Dry run — lists what would be written, writes nothing.
 *   doppler run -p writing-evaluator -c dev -- npx tsx scripts/backfill-release-ownership.ts
 *
 *   # 2. Apply. Every Doppler config points at the production Neon database, so
 *   #    --allow-prod is required and the guard asks you to type the host back.
 *   doppler run -p writing-evaluator -c dev -- npx tsx scripts/backfill-release-ownership.ts --write --allow-prod
 *
 *   # 3. Acceptance check — every persisted value must equal the legacy rule
 *   #    and nothing may be left null. Exit code 1 otherwise.
 *   doppler run -p writing-evaluator -c dev -- npx tsx scripts/backfill-release-ownership.ts --verify
 *
 * Fill-nulls-only: a non-null value is never overwritten (disagreements are
 * printed as conflicts and left alone), so running it twice is a no-op the
 * second time. Run --verify again after any deliberate email change; mismatches
 * there are then expected and are the whole point of persisting.
 */
import 'dotenv/config'
import { prisma } from '../src/lib/db'
import {
  getExpectedReleaseUserIds,
  isSlotSplitRelease,
} from '../src/lib/team-batch-releases'
import {
  findLegacyRuleMismatches,
  planBackfillWrites,
  type OwnershipMismatch,
} from '../src/lib/release-ownership'
import { assertNotProduction, hostOf } from './_guard'

const SCRIPT = 'backfill-release-ownership'

async function loadReleases() {
  return prisma.teamBatchRelease.findMany({
    select: {
      id: true,
      scorerUserId: true,
      ownerUserId: true,
      batch: { select: { id: true, name: true, type: true, isDoubleScored: true } },
      team: {
        select: {
          name: true,
          members: {
            select: { userId: true },
            orderBy: { user: { email: 'asc' } },
          },
        },
      },
      assignments: { select: { id: true, userId: true, slotIndex: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
}

type LoadedRelease = Awaited<ReturnType<typeof loadReleases>>[number]

function label(release: LoadedRelease) {
  return `${release.batch.name} / ${release.team.name} (${release.id})`
}

function printMismatches(mismatches: OwnershipMismatch[]) {
  for (const m of mismatches) {
    console.log(
      `    ! ${m.kind} ${m.userId ? `user ${m.userId} ` : ''}persisted=${m.persisted} derived=${m.derived} (release ${m.releaseId})`
    )
  }
}

async function verify(releases: LoadedRelease[]) {
  let mismatchCount = 0
  let nullOwners = 0
  let nullSlots = 0
  let checkedAssignments = 0

  for (const release of releases) {
    const isSlotSplit = isSlotSplitRelease(release)
    const expected = new Set(getExpectedReleaseUserIds(release))
    const mismatches = findLegacyRuleMismatches({
      id: release.id,
      ownerUserId: release.ownerUserId,
      membersEmailAsc: release.team.members,
      isSlotSplit,
      assignments: release.assignments,
    })
    if (mismatches.length > 0) {
      console.log(`  ${label(release)}`)
      printMismatches(mismatches)
      mismatchCount += mismatches.length
    }
    if (release.ownerUserId === null && release.team.members.length > 0) nullOwners++
    if (isSlotSplit) {
      for (const assignment of release.assignments) {
        if (!expected.has(assignment.userId)) continue
        checkedAssignments++
        if (assignment.slotIndex === null) nullSlots++
      }
    }
  }

  console.log(
    `[${SCRIPT}] verify: ${releases.length} releases, ${checkedAssignments} slot-split assignments; ` +
      `${mismatchCount} mismatches vs the legacy rule, ${nullOwners} releases without owner, ${nullSlots} assignments without slot`
  )
  if (mismatchCount > 0 || nullOwners > 0 || nullSlots > 0) {
    process.exitCode = 1
  }
}

async function backfill(releases: LoadedRelease[], write: boolean) {
  let ownerWrites = 0
  let slotWrites = 0
  let conflicts = 0
  let touchedReleases = 0

  for (const release of releases) {
    const writes = planBackfillWrites({
      id: release.id,
      ownerUserId: release.ownerUserId,
      membersEmailAsc: release.team.members,
      expectedUserIds: getExpectedReleaseUserIds(release),
      isSlotSplit: isSlotSplitRelease(release),
      assignments: release.assignments,
    })

    if (writes.conflicts.length > 0) {
      console.log(`  ${label(release)}: ${writes.conflicts.length} conflict(s), left untouched`)
      printMismatches(writes.conflicts)
      conflicts += writes.conflicts.length
    }
    if (writes.ownerUserId === null && writes.slotIndexByUserId.size === 0) continue

    touchedReleases++
    const slotSummary = Array.from(writes.slotIndexByUserId.entries())
      .map(([userId, slot]) => `${userId}→${slot}`)
      .join(', ')
    console.log(
      `  ${label(release)}: ` +
        [
          writes.ownerUserId ? `owner → ${writes.ownerUserId}` : null,
          slotSummary ? `slots ${slotSummary}` : null,
        ]
          .filter(Boolean)
          .join('; ')
    )
    if (writes.ownerUserId) ownerWrites++
    slotWrites += writes.slotIndexByUserId.size

    if (!write) continue

    // Iterate the loaded rows (not the plan) so every update carries a concrete
    // assignment id; `slotIndex: null` / `ownerUserId: null` in the where keeps
    // each write fill-only even if a sync ran between our read and this write.
    const slotUpdates = release.assignments.flatMap((assignment) => {
      const slotIndex = writes.slotIndexByUserId.get(assignment.userId)
      if (slotIndex === undefined) return []
      return [
        prisma.batchAssignment.updateMany({
          where: { id: assignment.id, slotIndex: null },
          data: { slotIndex },
        }),
      ]
    })
    await prisma.$transaction([
      ...(writes.ownerUserId
        ? [
            prisma.teamBatchRelease.updateMany({
              where: { id: release.id, ownerUserId: null },
              data: { ownerUserId: writes.ownerUserId },
            }),
          ]
        : []),
      ...slotUpdates,
    ])
  }

  console.log(
    `[${SCRIPT}] ${write ? 'wrote' : 'would write'}: ${ownerWrites} owners and ${slotWrites} slots across ${touchedReleases} of ${releases.length} releases; ${conflicts} conflicts` +
      (write ? '' : ' (dry run — pass --write to apply)')
  )
  if (conflicts > 0) process.exitCode = 1
}

async function main() {
  const write = process.argv.includes('--write')
  const verifyOnly = process.argv.includes('--verify')
  if (write && verifyOnly) {
    throw new Error('--write and --verify are mutually exclusive')
  }

  if (write) {
    await assertNotProduction(SCRIPT)
  } else {
    console.log(
      `[${SCRIPT}] database host: ${hostOf(process.env.DATABASE_URL) ?? '(none)'} (read-only ${verifyOnly ? 'verify' : 'dry run'})`
    )
  }

  const releases = await loadReleases()
  if (verifyOnly) {
    await verify(releases)
  } else {
    await backfill(releases, write)
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
