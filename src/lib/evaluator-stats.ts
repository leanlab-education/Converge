import { prisma } from '@/lib/db'
import { getReleaseUserSlotIndex, isSlotSplitRelease } from '@/lib/team-batch-releases'

// ---------------------------------------------------------------------------
// Shared helpers for slot-aware item counting
// ---------------------------------------------------------------------------

// Minimal shape needed from a BatchAssignment to compute slot context. The
// caller is responsible for fetching teamRelease.team.members + the batch's
// {id, isDoubleScored, type}.
export interface BatchAssignmentForStats {
  userId: string
  teamRelease: {
    id: string
    scorerUserId: string | null
    team: { members: { userId: string }[] }
  } | null
  batch: {
    id: string
    isDoubleScored: boolean
    type: string
  }
}

interface SlotMaps {
  itemCountByBatchSlot: Map<string, Map<number | null, number>>
  scoredCountByBatchSlot?: Map<string, Map<number | null, number>>
}

// Bulk-load item counts (and optionally scored-by-user counts) keyed by
// (batchId, slotIndex). One groupBy query for items; one findMany for scored.
export async function loadSlotMaps(
  batchIds: string[],
  scoredByUserId?: string
): Promise<SlotMaps> {
  const ids = Array.from(new Set(batchIds))
  if (ids.length === 0) {
    return { itemCountByBatchSlot: new Map(), scoredCountByBatchSlot: scoredByUserId ? new Map() : undefined }
  }

  const itemSlotCounts = await prisma.feedbackItem.groupBy({
    by: ['batchId', 'slotIndex'],
    where: { batchId: { in: ids } },
    _count: { _all: true },
  })

  const itemCountByBatchSlot = new Map<string, Map<number | null, number>>()
  for (const row of itemSlotCounts) {
    if (row.batchId === null) continue
    if (!itemCountByBatchSlot.has(row.batchId)) {
      itemCountByBatchSlot.set(row.batchId, new Map())
    }
    itemCountByBatchSlot.get(row.batchId)!.set(row.slotIndex, row._count._all)
  }

  if (!scoredByUserId) {
    return { itemCountByBatchSlot }
  }

  const scoredItems = await prisma.feedbackItem.findMany({
    where: {
      batchId: { in: ids },
      scores: { some: { userId: scoredByUserId } },
    },
    select: { batchId: true, slotIndex: true },
  })

  const scoredCountByBatchSlot = new Map<string, Map<number | null, number>>()
  for (const item of scoredItems) {
    if (item.batchId === null) continue
    if (!scoredCountByBatchSlot.has(item.batchId)) {
      scoredCountByBatchSlot.set(item.batchId, new Map())
    }
    const slotMap = scoredCountByBatchSlot.get(item.batchId)!
    slotMap.set(item.slotIndex, (slotMap.get(item.slotIndex) ?? 0) + 1)
  }

  return { itemCountByBatchSlot, scoredCountByBatchSlot }
}

// Look up the slot-adjusted count for a single (assignment, slotMap) pair.
// Used inside loops where the caller already has the assignment in hand.
export function countForAssignment(
  ba: BatchAssignmentForStats,
  forUserId: string,
  slotMap: Map<string, Map<number | null, number>>
): number {
  const releaseContext = ba.teamRelease
    ? {
        id: ba.teamRelease.id,
        // Honor a single named scorer: such a release is NOT slot-split, so the
        // scorer is counted for ALL items, not half (P7 — was hardcoded null).
        scorerUserId: ba.teamRelease.scorerUserId,
        batch: ba.batch,
        team: { members: ba.teamRelease.team.members },
      }
    : null
  const slotSplit = releaseContext ? isSlotSplitRelease(releaseContext) : false
  const userSlot =
    releaseContext && slotSplit ? getReleaseUserSlotIndex(releaseContext, forUserId) : null

  const slots = slotMap.get(ba.batch.id)
  if (!slots) return 0
  if (slotSplit && userSlot !== null) {
    return slots.get(userSlot) ?? 0
  }
  let total = 0
  for (const c of slots.values()) total += c
  return total
}
