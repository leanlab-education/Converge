import 'dotenv/config'
import { PrismaClient } from '../src/generated/prisma/client.js'
import { PrismaNeon } from '@prisma/adapter-neon'
import { compareFeedbackIds } from '../src/lib/feedback-id.js'

/**
 * Generate a realistic mid-flight snapshot for the Test #2 project:
 *
 *   - 2 training batches (everyone scores everything)
 *   - 2 double-scored regular batches (per-team paired scoring → IRR)
 *   - 8 single-scored regular batches (item-split between teammates)
 *
 * Batches cover the lifecycle: COMPLETE → RECONCILING → SCORING → DRAFT.
 * Annotators have distinct accuracy profiles and pacing; rubric-1 dims have
 * realistic per-criterion base rates so disagreements skew where you'd expect.
 *
 * Wipes the project's batches/scores first; preserves teams, rubric, items,
 * project-evaluator memberships.
 */

const projectName = 'Test #2'
const dryRun = !process.argv.includes('--write')

const prisma = new PrismaClient({
  adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL }),
})

const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000

// Realistic per-criterion base rate for "1" (meets criterion).
// Roughly: items mostly meet the easy ones, harder ones have more 0s.
const BASE_RATE: Record<string, number> = {
  'Appropriate Feedback Decision': 0.78,
  'Task Aligned Revision': 0.62,
  'Not Answer Giving': 0.74,
  'Actionable Revision': 0.66,
  Manageable: 0.7,
  'Anchored in Student Response': 0.6,
  'Acknowledges Strength': 0.55,
  'Appropriate Emotional Pitch': 0.82,
}

// Per-annotator: accuracy (probability of agreeing with hidden truth) and
// average per-score duration in seconds. Tweaked so pairwise agreement comes
// out around 75–88% (realistic IRR window).
const ANNOTATOR_PROFILES: Record<
  string,
  { accuracy: number; avgSeconds: number; bias: number }
> = {
  'fake-annotator-1@test.local': { accuracy: 0.9, avgSeconds: 38, bias: 0 },
  'fake-annotator-2@test.local': { accuracy: 0.86, avgSeconds: 50, bias: -0.05 },
  'fake-annotator-3@test.local': { accuracy: 0.84, avgSeconds: 32, bias: 0.04 },
  'fake-annotator-4@test.local': { accuracy: 0.81, avgSeconds: 65, bias: -0.08 },
  'fake-annotator-5@test.local': { accuracy: 0.91, avgSeconds: 42, bias: 0.02 },
  'fake-annotator-6@test.local': { accuracy: 0.85, avgSeconds: 55, bias: 0 },
  'fake-annotator-7@test.local': { accuracy: 0.88, avgSeconds: 36, bias: 0.05 },
  'fake-annotator-8@test.local': { accuracy: 0.89, avgSeconds: 58, bias: -0.03 },
}

interface BatchPlan {
  name: string
  type: 'TRAINING' | 'REGULAR'
  isDoubleScored: boolean
  size: number
  // Status to land on after seeding scores
  finalStatus: 'COMPLETE' | 'RECONCILING' | 'SCORING' | 'DRAFT'
  // 0..1: how much of the expected scoring to actually generate
  completionFraction: number
  // Approximate scoring window (days ago)
  windowEndDaysAgo: number
  windowStartDaysAgo: number
}

const PLAN: BatchPlan[] = [
  // Two training batches — earliest, completed
  {
    name: 'Training Batch 1 (kickoff calibration)',
    type: 'TRAINING',
    isDoubleScored: false,
    size: 50,
    finalStatus: 'COMPLETE',
    completionFraction: 1,
    windowEndDaysAgo: 15,
    windowStartDaysAgo: 18,
  },
  {
    name: 'Training Batch 2 (mid-run drift check)',
    type: 'TRAINING',
    isDoubleScored: false,
    size: 40,
    finalStatus: 'COMPLETE',
    completionFraction: 1,
    windowEndDaysAgo: 9,
    windowStartDaysAgo: 11,
  },

  // Double-scored regular — gives per-team IRR
  {
    name: 'Batch 1 (double-scored)',
    type: 'REGULAR',
    isDoubleScored: true,
    size: 100,
    finalStatus: 'COMPLETE',
    completionFraction: 1,
    windowEndDaysAgo: 12,
    windowStartDaysAgo: 14,
  },
  {
    name: 'Batch 2 (double-scored, reconciling)',
    type: 'REGULAR',
    isDoubleScored: true,
    size: 100,
    finalStatus: 'RECONCILING',
    completionFraction: 1,
    windowEndDaysAgo: 4,
    windowStartDaysAgo: 6,
  },

  // Single-scored regular — most of the volume
  {
    name: 'Batch 3',
    type: 'REGULAR',
    isDoubleScored: false,
    size: 120,
    finalStatus: 'COMPLETE',
    completionFraction: 1,
    windowEndDaysAgo: 10,
    windowStartDaysAgo: 12,
  },
  {
    name: 'Batch 4',
    type: 'REGULAR',
    isDoubleScored: false,
    size: 120,
    finalStatus: 'COMPLETE',
    completionFraction: 1,
    windowEndDaysAgo: 7,
    windowStartDaysAgo: 9,
  },
  {
    name: 'Batch 5',
    type: 'REGULAR',
    isDoubleScored: false,
    size: 120,
    finalStatus: 'COMPLETE',
    completionFraction: 1,
    windowEndDaysAgo: 4,
    windowStartDaysAgo: 6,
  },
  {
    name: 'Batch 6 (in progress, near done)',
    type: 'REGULAR',
    isDoubleScored: false,
    size: 120,
    finalStatus: 'SCORING',
    completionFraction: 0.82,
    windowEndDaysAgo: 0.2,
    windowStartDaysAgo: 3,
  },
  {
    name: 'Batch 7 (in progress, half done)',
    type: 'REGULAR',
    isDoubleScored: false,
    size: 120,
    finalStatus: 'SCORING',
    completionFraction: 0.5,
    windowEndDaysAgo: 0.1,
    windowStartDaysAgo: 2,
  },
  {
    name: 'Batch 8 (just started)',
    type: 'REGULAR',
    isDoubleScored: false,
    size: 120,
    finalStatus: 'SCORING',
    completionFraction: 0.18,
    windowEndDaysAgo: 0,
    windowStartDaysAgo: 1,
  },
  {
    name: 'Batch 9 (queued)',
    type: 'REGULAR',
    isDoubleScored: false,
    size: 120,
    finalStatus: 'DRAFT',
    completionFraction: 0,
    windowEndDaysAgo: 0,
    windowStartDaysAgo: 0,
  },
  {
    name: 'Batch 10 (queued)',
    type: 'REGULAR',
    isDoubleScored: false,
    size: 120,
    finalStatus: 'DRAFT',
    completionFraction: 0,
    windowEndDaysAgo: 0,
    windowStartDaysAgo: 0,
  },
]

function randInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive)
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function bernoulli(p: number): number {
  return Math.random() < p ? 1 : 0
}

// Gamma-ish distribution for durations: skewed positive, mean ≈ avg, occasional outliers
function sampleDuration(avgSeconds: number): number {
  const u = Math.random()
  // Rough log-normal-ish: median near avg, fat right tail
  const factor = Math.exp((Math.random() - 0.5) * 0.8)
  let s = avgSeconds * factor
  if (u < 0.05) s *= 2.5 // occasional re-read
  if (u > 0.97) s *= 4 // got distracted
  return Math.max(8, Math.round(s))
}

function timestampInWindow(startDaysAgo: number, endDaysAgo: number): Date {
  const start = NOW - startDaysAgo * DAY
  const end = NOW - endDaysAgo * DAY
  const ts = start + Math.random() * (end - start)
  return new Date(ts)
}

interface Item {
  id: string
  feedbackId: string
}

interface Dimension {
  id: string
  label: string
}

interface TeamConfig {
  id: string
  name: string
  members: { id: string; email: string }[] // sorted by email asc
  dimensions: Dimension[]
}

async function main() {
  const project = await prisma.project.findFirst({ where: { name: projectName } })
  if (!project) throw new Error(`Project "${projectName}" not found`)

  const allItemsRaw = await prisma.feedbackItem.findMany({
    where: { projectId: project.id },
    select: { id: true, feedbackId: true },
  })
  const allItems = allItemsRaw
    .slice()
    .sort((a, b) => compareFeedbackIds(a.feedbackId, b.feedbackId))

  const totalNeeded = PLAN.reduce((s, p) => s + p.size, 0)
  console.log(
    `Project ${project.name}: ${allItems.length} items available, plan needs ${totalNeeded}`
  )
  if (totalNeeded > allItems.length) {
    throw new Error('Not enough items to satisfy plan')
  }

  const teams = await prisma.evaluatorTeam.findMany({
    where: { projectId: project.id },
    include: {
      members: {
        include: { user: { select: { id: true, email: true } } },
        orderBy: { user: { email: 'asc' } },
      },
      dimensions: {
        include: { dimension: true },
        orderBy: { dimension: { sortOrder: 'asc' } },
      },
    },
    orderBy: { name: 'asc' },
  })

  if (teams.length !== 4) throw new Error('Expected 4 teams on Test #2')
  for (const t of teams) {
    if (t.members.length !== 2) {
      throw new Error(`Team ${t.name} doesn't have exactly 2 members`)
    }
  }

  const teamConfigs: TeamConfig[] = teams.map((t) => ({
    id: t.id,
    name: t.name,
    members: t.members.map((m) => ({ id: m.user.id, email: m.user.email })),
    dimensions: t.dimensions.map((d) => ({ id: d.dimension.id, label: d.dimension.label })),
  }))

  const allDimensions = await prisma.rubricDimension.findMany({
    where: { projectId: project.id },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, label: true },
  })

  if (dryRun) {
    console.log('\nPlan:')
    let cursor = 0
    for (const p of PLAN) {
      const slice = allItems.slice(cursor, cursor + p.size)
      console.log(
        `  ${p.name} → ${p.size} items (${slice[0]?.feedbackId}…${slice[slice.length - 1]?.feedbackId}), final=${p.finalStatus}, completion=${p.completionFraction}`
      )
      cursor += p.size
    }
    console.log(`\nUnbatched leftover: ${allItems.length - cursor} items`)
    console.log('\nDry run — pass --write to apply.')
    await prisma.$disconnect()
    return
  }

  console.log('\nWiping existing batches/scores in project…')
  await prisma.batch.deleteMany({ where: { projectId: project.id } })
  // Scores cascade off feedbackItem; items still exist. Make sure no orphan scores remain.
  await prisma.score.deleteMany({
    where: { feedbackItem: { projectId: project.id } },
  })
  await prisma.feedbackItem.updateMany({
    where: { projectId: project.id },
    data: { batchId: null, slotIndex: null },
  })

  console.log('Creating batches…')
  let cursor = 0
  for (let i = 0; i < PLAN.length; i++) {
    const plan = PLAN[i]
    const slice = allItems.slice(cursor, cursor + plan.size)
    cursor += plan.size

    await seedBatch(plan, slice, project.id, teamConfigs, allDimensions, i)
  }

  console.log('\nDone.')
  await prisma.$disconnect()
}

async function seedBatch(
  plan: BatchPlan,
  items: Item[],
  projectId: string,
  teamConfigs: TeamConfig[],
  allDimensions: Dimension[],
  sortOrder: number
) {
  console.log(`\n• ${plan.name} — ${items.length} items`)

  const isVisible = plan.finalStatus !== 'DRAFT'

  const batch = await prisma.batch.create({
    data: {
      projectId,
      name: plan.name,
      activityId: '1',
      conjunctionId: 'Because',
      type: plan.type,
      isDoubleScored: plan.isDoubleScored,
      status: 'DRAFT', // we'll set the right status at the end
      size: items.length,
      sortOrder,
      ranges: {
        create: [
          {
            startFeedbackId: items[0].feedbackId,
            endFeedbackId: items[items.length - 1].feedbackId,
            itemCount: items.length,
            sortOrder: 0,
          },
        ],
      },
    },
  })

  // Attach items to batch and assign displayOrder shuffle
  const shuffledIds = shuffle(items.map((i) => i.id))
  await prisma.$transaction(
    shuffledIds.map((id, idx) =>
      prisma.feedbackItem.update({
        where: { id },
        data: { batchId: batch.id, displayOrder: idx },
      })
    )
  )

  // Slots for non-double-scored regular: split into 0/1
  if (plan.type === 'REGULAR' && !plan.isDoubleScored) {
    const halfway = Math.ceil(items.length / 2)
    const reshuffle = shuffle(items.map((i) => i.id))
    await prisma.$transaction([
      prisma.feedbackItem.updateMany({
        where: { id: { in: reshuffle.slice(0, halfway) } },
        data: { slotIndex: 0 },
      }),
      prisma.feedbackItem.updateMany({
        where: { id: { in: reshuffle.slice(halfway) } },
        data: { slotIndex: 1 },
      }),
    ])
  }

  // Create team releases (all 4 teams, all visible unless DRAFT)
  const releases: { id: string; teamConfig: TeamConfig }[] = []
  for (const teamCfg of teamConfigs) {
    const release = await prisma.teamBatchRelease.create({
      data: {
        batchId: batch.id,
        teamId: teamCfg.id,
        isVisible,
        status: 'DRAFT',
        scorerUserId: null,
      },
    })
    // BatchAssignment per member
    await prisma.batchAssignment.createMany({
      data: teamCfg.members.map((m, idx) => ({
        batchId: batch.id,
        userId: m.id,
        teamReleaseId: release.id,
        scoringRole:
          plan.isDoubleScored && idx > 0 ? ('DOUBLE' as const) : ('PRIMARY' as const),
      })),
    })
    releases.push({ id: release.id, teamConfig: teamCfg })
  }

  // Mark batch as assigned, set batch status appropriately
  await prisma.batch.update({
    where: { id: batch.id },
    data: { isAssigned: isVisible },
  })

  if (plan.finalStatus === 'DRAFT') {
    return // no scoring
  }

  // Generate scores per release
  const slot0Items = await prisma.feedbackItem.findMany({
    where: { batchId: batch.id, slotIndex: 0 },
    select: { id: true, feedbackId: true },
  })
  const slot1Items = await prisma.feedbackItem.findMany({
    where: { batchId: batch.id, slotIndex: 1 },
    select: { id: true, feedbackId: true },
  })
  const allBatchItems = await prisma.feedbackItem.findMany({
    where: { batchId: batch.id },
    select: { id: true, feedbackId: true },
  })

  // Hidden truth per (item, dim)
  const truthByItemDim = new Map<string, number>()
  for (const item of allBatchItems) {
    for (const dim of allDimensions) {
      const rate = BASE_RATE[dim.label] ?? 0.65
      truthByItemDim.set(`${item.id}::${dim.id}`, bernoulli(rate))
    }
  }

  for (const { id: releaseId, teamConfig } of releases) {
    let scoringTargets: { itemId: string; dimensionId: string; userId: string }[] = []

    if (plan.type === 'TRAINING') {
      // All members of this team score every item × every dimension in the project.
      // (Across the 4 teams, this means every annotator scores every item × every dim.)
      for (const item of allBatchItems) {
        for (const dim of allDimensions) {
          for (const member of teamConfig.members) {
            scoringTargets.push({
              itemId: item.id,
              dimensionId: dim.id,
              userId: member.id,
            })
          }
        }
      }
    } else if (plan.isDoubleScored) {
      // Both team members score every item × team's dimensions
      for (const item of allBatchItems) {
        for (const dim of teamConfig.dimensions) {
          for (const member of teamConfig.members) {
            scoringTargets.push({
              itemId: item.id,
              dimensionId: dim.id,
              userId: member.id,
            })
          }
        }
      }
    } else {
      // Non-double-scored regular: split between members by slot
      for (const item of slot0Items) {
        for (const dim of teamConfig.dimensions) {
          scoringTargets.push({
            itemId: item.id,
            dimensionId: dim.id,
            userId: teamConfig.members[0].id, // slot A
          })
        }
      }
      for (const item of slot1Items) {
        for (const dim of teamConfig.dimensions) {
          scoringTargets.push({
            itemId: item.id,
            dimensionId: dim.id,
            userId: teamConfig.members[1].id, // slot B
          })
        }
      }
    }

    // Apply completion fraction (incomplete batches don't have all targets scored).
    // Bias toward earlier items being scored first (annotators work top-down).
    if (plan.completionFraction < 1) {
      // Group by user, sort by item displayOrder, keep first N per user
      const byUser = new Map<string, typeof scoringTargets>()
      for (const t of scoringTargets) {
        if (!byUser.has(t.userId)) byUser.set(t.userId, [])
        byUser.get(t.userId)!.push(t)
      }
      const kept: typeof scoringTargets = []
      for (const [, targets] of byUser) {
        const userKeep = Math.floor(targets.length * plan.completionFraction)
        // a little jitter: ±10% so users aren't lockstep
        const jitter = Math.round(targets.length * 0.05 * (Math.random() * 2 - 1))
        kept.push(...targets.slice(0, Math.max(0, userKeep + jitter)))
      }
      scoringTargets = kept
    }

    // Generate Score rows
    const scoreData = scoringTargets.map((t) => {
      const profile = ANNOTATOR_PROFILES[
        Object.entries(ANNOTATOR_PROFILES).find(
          ([email]) =>
            teamConfig.members.find((m) => m.email === email)?.id === t.userId
        )?.[0] ?? ''
      ] ?? { accuracy: 0.85, avgSeconds: 45, bias: 0 }

      const truth = truthByItemDim.get(`${t.itemId}::${t.dimensionId}`) ?? 1
      const flip = Math.random() > profile.accuracy + profile.bias
      const value = flip ? 1 - truth : truth
      const duration = sampleDuration(profile.avgSeconds)
      const scoredAt = timestampInWindow(plan.windowStartDaysAgo, plan.windowEndDaysAgo)
      const startedAt = new Date(scoredAt.getTime() - duration * 1000)
      return {
        feedbackItemId: t.itemId,
        userId: t.userId,
        dimensionId: t.dimensionId,
        value,
        scoredAt,
        startedAt,
        durationSeconds: duration,
        isReconciled: false,
      }
    })

    // Insert in chunks
    const CHUNK = 500
    for (let i = 0; i < scoreData.length; i += CHUNK) {
      await prisma.score.createMany({
        data: scoreData.slice(i, i + CHUNK),
        skipDuplicates: true,
      })
    }
    console.log(
      `    ${teamConfig.name}: ${scoreData.length} scores inserted`
    )

    // Set release status
    let releaseStatus: 'DRAFT' | 'SCORING' | 'RECONCILING' | 'COMPLETE' = 'SCORING'
    if (plan.finalStatus === 'COMPLETE') {
      const needsReconcile = plan.type === 'TRAINING' || plan.isDoubleScored
      releaseStatus = needsReconcile ? 'COMPLETE' : 'COMPLETE'
    } else if (plan.finalStatus === 'RECONCILING') {
      releaseStatus = 'RECONCILING'
    } else {
      releaseStatus = 'SCORING'
    }
    await prisma.teamBatchRelease.update({
      where: { id: releaseId },
      data: { status: releaseStatus },
    })

    // Auto-reconcile agreed scores for COMPLETE training/DS releases
    if (
      (plan.type === 'TRAINING' || plan.isDoubleScored) &&
      plan.finalStatus === 'COMPLETE'
    ) {
      await autoReconcile(releaseId, teamConfig, allDimensions, plan)
    }
    // For RECONCILING: also auto-reconcile the agreed ones, leave discrepancies
    if (
      (plan.type === 'TRAINING' || plan.isDoubleScored) &&
      plan.finalStatus === 'RECONCILING'
    ) {
      await autoReconcile(releaseId, teamConfig, allDimensions, plan)
    }
  }

  // Set batch status from release statuses
  const allReleaseStatuses = await prisma.teamBatchRelease.findMany({
    where: { batchId: batch.id },
    select: { status: true },
  })
  const statuses = allReleaseStatuses.map((r) => r.status)
  let batchStatus: 'DRAFT' | 'SCORING' | 'RECONCILING' | 'COMPLETE' = 'DRAFT'
  if (statuses.every((s) => s === 'COMPLETE')) batchStatus = 'COMPLETE'
  else if (statuses.some((s) => s === 'RECONCILING')) batchStatus = 'RECONCILING'
  else if (statuses.some((s) => s === 'SCORING')) batchStatus = 'SCORING'
  await prisma.batch.update({
    where: { id: batch.id },
    data: { status: batchStatus },
  })
}

async function autoReconcile(
  releaseId: string,
  teamConfig: TeamConfig,
  allDimensions: Dimension[],
  plan: BatchPlan
) {
  const dimensionsToReconcile =
    plan.type === 'TRAINING' ? allDimensions : teamConfig.dimensions
  const userIds = teamConfig.members.map((m) => m.id)
  const ownerUserId = userIds[0] // first by email asc

  const release = await prisma.teamBatchRelease.findUnique({
    where: { id: releaseId },
    select: { batchId: true },
  })
  if (!release) return

  const scores = await prisma.score.findMany({
    where: {
      feedbackItem: { batchId: release.batchId },
      userId: { in: userIds },
      dimensionId: { in: dimensionsToReconcile.map((d) => d.id) },
      isReconciled: false,
    },
    select: {
      id: true,
      feedbackItemId: true,
      userId: true,
      dimensionId: true,
      value: true,
    },
  })

  const groups = new Map<string, typeof scores>()
  for (const s of scores) {
    const key = `${s.feedbackItemId}::${s.dimensionId}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(s)
  }

  const reconciled: {
    feedbackItemId: string
    userId: string
    dimensionId: string
    value: number
    isReconciled: boolean
    reconciledFrom: string
    notes: string
  }[] = []

  for (const [, group] of groups) {
    if (group.length < 2) continue
    const userSet = new Set(group.map((g) => g.userId))
    if (userSet.size < 2) continue
    const allEqual = group.every((g) => g.value === group[0].value)
    if (!allEqual) continue
    reconciled.push({
      feedbackItemId: group[0].feedbackItemId,
      userId: ownerUserId,
      dimensionId: group[0].dimensionId,
      value: group[0].value,
      isReconciled: true,
      reconciledFrom: group.map((g) => g.id).join(','),
      notes: 'Auto-reconciled (scores matched)',
    })
  }

  // For COMPLETE batches: also reconcile the disagreements (simulate manual reconciliation)
  if (plan.finalStatus === 'COMPLETE') {
    for (const [, group] of groups) {
      if (group.length < 2) continue
      const userSet = new Set(group.map((g) => g.userId))
      if (userSet.size < 2) continue
      const allEqual = group.every((g) => g.value === group[0].value)
      if (allEqual) continue
      // disagreement → resolve to majority/random
      const counts = new Map<number, number>()
      for (const g of group) counts.set(g.value, (counts.get(g.value) ?? 0) + 1)
      const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
      const winner = sorted[0][0]
      reconciled.push({
        feedbackItemId: group[0].feedbackItemId,
        userId: ownerUserId,
        dimensionId: group[0].dimensionId,
        value: winner,
        isReconciled: true,
        reconciledFrom: group.map((g) => g.id).join(','),
        notes: 'Manually reconciled by team',
      })
    }
  }

  if (reconciled.length === 0) return

  // Use upsert to avoid duplicate-key conflicts on the unique
  // [feedbackItemId, userId, dimensionId, isReconciled] index.
  for (let i = 0; i < reconciled.length; i += 200) {
    const chunk = reconciled.slice(i, i + 200)
    await prisma.$transaction(
      chunk.map((data) =>
        prisma.score.upsert({
          where: {
            feedbackItemId_userId_dimensionId_isReconciled: {
              feedbackItemId: data.feedbackItemId,
              userId: data.userId,
              dimensionId: data.dimensionId,
              isReconciled: true,
            },
          },
          update: {
            value: data.value,
            reconciledFrom: data.reconciledFrom,
            notes: data.notes,
          },
          create: data,
        })
      )
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
