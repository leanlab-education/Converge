import { prisma } from '@/lib/db'

/**
 * Computes exact-match inter-rater reliability (IRR) for each team release in a
 * batch, plus a simple batch-level rollup for admin display.
 *
 * Returns percentage of (item, dimension) pairs where both evaluators gave the
 * same value, out of total pairs where both evaluators scored.
 * Per Amber's 2026-04-09 meeting: "exact match required" — no tolerance band.
 *
 * Per Amber's answer to Q2: display this to admins; there is no automatic
 * gate. Admins decide when to release Independent batches based on IRR.
 *
 * IRR is defined for REGULAR double-scored batches only: per-team comparison
 * of that team's two members across that team's assigned criteria.
 *
 * Single-scored regular batches have no IRR.
 */
export const IRR_READY_THRESHOLD_PCT = 80

export interface TeamReleaseIRR {
  releaseId: string
  teamId: string
  teamName: string
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

export interface BatchIRRSummary {
  applicableTeamCount: number
  computedTeamCount: number
  readyTeamCount: number
  averageAgreementPct: number | null
  lowestAgreementPct: number | null
  // Batch-level per-criterion rollup, aggregated across team releases.
  perDimension: {
    dimensionId: string
    dimensionLabel: string
    agreementPct: number | null
    agreedPairs: number
    totalPairs: number
  }[]
  teams: TeamReleaseIRR[]
}

export async function computeBatchIRRSummary(
  batchId: string
): Promise<BatchIRRSummary | null> {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    include: {
      teamReleases: {
        include: {
          team: {
            include: {
              members: {
                select: { userId: true },
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
  })
  if (!batch) return null

  const isApplicableBatch = batch.type === 'REGULAR' && batch.isDoubleScored

  const applicableReleases = batch.teamReleases.filter((release) => {
    if (!isApplicableBatch) return false
    if (release.team.members.length !== 2) return false
    return release.team.dimensions.length > 0
  })

  if (!isApplicableBatch) {
    return {
      applicableTeamCount: 0,
      computedTeamCount: 0,
      readyTeamCount: 0,
      averageAgreementPct: null,
      lowestAgreementPct: null,
      perDimension: [],
      teams: batch.teamReleases.map((release) => ({
        releaseId: release.id,
        teamId: release.teamId,
        teamName: release.team.name,
        isApplicable: false,
        isReady: false,
        agreementPct: null,
        agreedPairs: 0,
        totalPairs: 0,
        perDimension: [],
      })),
    }
  }

  const relevantUserIds = [
    ...new Set(
      applicableReleases.flatMap((release) =>
        release.team.members.map((member) => member.userId)
      )
    ),
  ]
  const relevantDimensionIds = [
    ...new Set(
      applicableReleases.flatMap((release) =>
        release.team.dimensions.map((dimension) => dimension.dimensionId)
      )
    ),
  ]

  const scores = await prisma.score.findMany({
    where: {
      feedbackItem: { batchId },
      userId: { in: relevantUserIds },
      dimensionId: { in: relevantDimensionIds },
      isReconciled: false,
    },
    select: {
      feedbackItemId: true,
      dimensionId: true,
      value: true,
      userId: true,
      dimension: { select: { id: true, label: true, sortOrder: true } },
    },
  })

  const teams = batch.teamReleases.map((release): TeamReleaseIRR => {
    const dimensionSource = release.team.dimensions.map(
      (dimension) => dimension.dimension
    )
    const userIds = release.team.members.map((member) => member.userId)

    if (
      !isApplicableBatch ||
      userIds.length !== 2 ||
      dimensionSource.length === 0
    ) {
      return {
        releaseId: release.id,
        teamId: release.teamId,
        teamName: release.team.name,
        isApplicable: false,
        isReady: false,
        agreementPct: null,
        agreedPairs: 0,
        totalPairs: 0,
        perDimension: [],
      }
    }

    const userIdSet = new Set(userIds)
    const dimensionIdSet = new Set(dimensionSource.map((dimension) => dimension.id))
    const groups = new Map<
      string,
      {
        dimensionId: string
        dimensionLabel: string
        sortOrder: number
        valuesByUser: Map<string, number>
      }
    >()

    for (const score of scores) {
      if (!userIdSet.has(score.userId) || !dimensionIdSet.has(score.dimensionId)) {
        continue
      }

      const key = `${score.feedbackItemId}::${score.dimensionId}`
      if (!groups.has(key)) {
        groups.set(key, {
          dimensionId: score.dimension.id,
          dimensionLabel: score.dimension.label,
          sortOrder: score.dimension.sortOrder,
          valuesByUser: new Map(),
        })
      }

      groups.get(key)!.valuesByUser.set(score.userId, score.value)
    }

    let agreedPairs = 0
    let totalPairs = 0
    const perDim = new Map<
      string,
      { label: string; sortOrder: number; agreed: number; total: number }
    >()

    for (const [, group] of groups) {
      if (group.valuesByUser.size !== 2) continue

      const values = Array.from(group.valuesByUser.values())
      const agreed = values[0] === values[1]

      totalPairs++
      if (agreed) agreedPairs++

      const entry = perDim.get(group.dimensionId) ?? {
        label: group.dimensionLabel,
        sortOrder: group.sortOrder,
        agreed: 0,
        total: 0,
      }
      entry.total++
      if (agreed) entry.agreed++
      perDim.set(group.dimensionId, entry)
    }

    const agreementPct =
      totalPairs > 0 ? Math.round((agreedPairs / totalPairs) * 100) : null

    return {
      releaseId: release.id,
      teamId: release.teamId,
      teamName: release.team.name,
      isApplicable: true,
      isReady:
        agreementPct !== null && agreementPct >= IRR_READY_THRESHOLD_PCT,
      agreementPct,
      agreedPairs,
      totalPairs,
      perDimension: Array.from(perDim.entries())
        .sort((a, b) => a[1].sortOrder - b[1].sortOrder)
        .map(([dimensionId, entry]) => ({
          dimensionId,
          dimensionLabel: entry.label,
          agreementPct:
            entry.total > 0 ? Math.round((entry.agreed / entry.total) * 100) : null,
          agreedPairs: entry.agreed,
          totalPairs: entry.total,
        })),
    }
  })

  const computedTeams = teams.filter((team) => team.agreementPct !== null)

  // Batch-level per-criterion rollup across all team releases.
  const dimensionSortOrder = new Map<string, number>(
    batch.teamReleases
      .flatMap((release) =>
        release.team.dimensions.map((dimension) => dimension.dimension)
      )
      .map((dimension) => [dimension.id, dimension.sortOrder])
  )
  const batchPerDim = new Map<
    string,
    { label: string; agreed: number; total: number }
  >()
  for (const team of teams) {
    for (const dimension of team.perDimension) {
      const entry = batchPerDim.get(dimension.dimensionId) ?? {
        label: dimension.dimensionLabel,
        agreed: 0,
        total: 0,
      }
      entry.agreed += dimension.agreedPairs
      entry.total += dimension.totalPairs
      batchPerDim.set(dimension.dimensionId, entry)
    }
  }
  const perDimension = Array.from(batchPerDim.entries())
    .sort(
      (a, b) =>
        (dimensionSortOrder.get(a[0]) ?? 0) - (dimensionSortOrder.get(b[0]) ?? 0)
    )
    .map(([dimensionId, entry]) => ({
      dimensionId,
      dimensionLabel: entry.label,
      agreementPct:
        entry.total > 0 ? Math.round((entry.agreed / entry.total) * 100) : null,
      agreedPairs: entry.agreed,
      totalPairs: entry.total,
    }))

  return {
    applicableTeamCount: teams.filter((team) => team.isApplicable).length,
    computedTeamCount: computedTeams.length,
    readyTeamCount: teams.filter((team) => team.isReady).length,
    averageAgreementPct:
      computedTeams.length > 0
        ? Math.round(
            computedTeams.reduce(
              (sum, team) => sum + (team.agreementPct ?? 0),
              0
            ) / computedTeams.length
          )
        : null,
    lowestAgreementPct:
      computedTeams.length > 0
        ? Math.min(...computedTeams.map((team) => team.agreementPct ?? 100))
        : null,
    perDimension,
    teams,
  }
}
