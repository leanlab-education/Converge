import 'dotenv/config'
import { PrismaClient } from '../src/generated/prisma/client.js'
import { PrismaNeon } from '@prisma/adapter-neon'
import { randomInt } from 'crypto'
import { ALLOW_PROD_FLAG, assertNotProduction, hasAllowProdFlag } from './_guard.js'

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter })

async function backfillBatchSlots(batchId: string) {
  const items = await prisma.feedbackItem.findMany({
    where: { batchId },
    select: { id: true, slotIndex: true },
  })
  if (items.length === 0) return 0

  const allAssigned = items.every((item) => item.slotIndex !== null)
  if (allAssigned) return 0

  const ids = items.map((item) => item.id)
  for (let i = ids.length - 1; i > 0; i--) {
    const swap = randomInt(i + 1)
    ;[ids[i], ids[swap]] = [ids[swap], ids[i]]
  }

  const halfway = Math.ceil(ids.length / 2)
  const slotA = ids.slice(0, halfway)
  const slotB = ids.slice(halfway)

  await prisma.$transaction([
    prisma.feedbackItem.updateMany({
      where: { id: { in: slotA } },
      data: { slotIndex: 0 },
    }),
    prisma.feedbackItem.updateMany({
      where: { id: { in: slotB } },
      data: { slotIndex: 1 },
    }),
  ])

  return ids.length
}

async function syncReleaseAssignments(releaseId: string) {
  const release = await prisma.teamBatchRelease.findUnique({
    where: { id: releaseId },
    include: {
      batch: { select: { id: true, isDoubleScored: true } },
      team: {
        include: {
          members: {
            select: { userId: true },
            orderBy: { user: { email: 'asc' } },
          },
        },
      },
    },
  })

  if (!release) return

  const userIds = release.team.members.map((m) => m.userId)

  await prisma.$transaction(async (tx) => {
    await tx.batchAssignment.deleteMany({ where: { teamReleaseId: releaseId } })
    if (userIds.length === 0) return
    await tx.batchAssignment.createMany({
      data: userIds.map((userId, index) => ({
        batchId: release.batch.id,
        userId,
        teamReleaseId: releaseId,
        scoringRole:
          release.batch.isDoubleScored && index > 0 ? 'DOUBLE' : 'PRIMARY',
      })),
      skipDuplicates: true,
    })
  })
}

async function main() {
  const dryRun = !process.argv.includes('--write')
  const allowProd = hasAllowProdFlag()

  const batches = await prisma.batch.findMany({
    where: { type: 'REGULAR', isDoubleScored: false },
    select: {
      id: true,
      name: true,
      teamReleases: { select: { id: true } },
    },
  })

  console.log(
    `Found ${batches.length} non-double-scored regular batches${dryRun ? ' (dry run, pass --write to apply)' : ''}`
  )

  if (!dryRun && batches.length > 0) {
    await assertNotProduction('backfill-batch-slots', { allowProd })
    // Slotting reshuffles EVERY item in a batch (not only the unslotted ones)
    // and rebuilds its batch assignments, so an item that already carries
    // scores can move to the other annotator. Refuse unless the operator
    // explicitly accepted that.
    const scoredCount = await prisma.score.count({
      where: { feedbackItem: { batchId: { in: batches.map((b) => b.id) } } },
    })
    if (scoredCount > 0 && !allowProd) {
      console.error(
        `\nRefusing: ${scoredCount} scores exist on these batches; re-randomizing slots would move scored items between annotators. Pass ${ALLOW_PROD_FLAG} to proceed anyway.`
      )
      await prisma.$disconnect()
      process.exit(1)
    }
  }

  for (const batch of batches) {
    const itemCount = await prisma.feedbackItem.count({
      where: { batchId: batch.id, slotIndex: null },
    })
    const assignmentDelta = batch.teamReleases.length
    console.log(
      `  • ${batch.name} (${batch.id}): ${itemCount} items need slots, ${assignmentDelta} releases to re-sync`
    )

    if (!dryRun) {
      const slotted = await backfillBatchSlots(batch.id)
      for (const release of batch.teamReleases) {
        await syncReleaseAssignments(release.id)
      }
      console.log(`    → slotted ${slotted}, re-synced ${batch.teamReleases.length} releases`)
    }
  }

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
