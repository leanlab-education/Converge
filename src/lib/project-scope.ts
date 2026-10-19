import { prisma } from '@/lib/db'

// Cross-project id guards (audit H-A2).
//
// Team and release routes take user and dimension ids straight from the
// request body. Nothing in the schema ties an EvaluatorTeamMember's user, or an
// EvaluatorTeamDimension's dimension, to the team's project, so a stale UI or
// a crafted request could wire another project's annotator or criterion into
// this project's team. These helpers answer "do all of these ids belong to
// projectId?" with a structured result that the routes turn into a 400.

export type ProjectScopeResult =
  | { ok: true }
  | { ok: false; error: string }

function uniqueIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids))
}

/**
 * Every id must have a ProjectEvaluator row on this project (any project
 * role). An empty list passes: the caller decides whether it needs members.
 */
export async function assertProjectMembers(
  projectId: string,
  userIds: readonly string[]
): Promise<ProjectScopeResult> {
  const ids = uniqueIds(userIds)
  if (ids.length === 0) return { ok: true }

  const rows = await prisma.projectEvaluator.findMany({
    where: { projectId, userId: { in: ids } },
    select: { userId: true },
  })
  const present = new Set(rows.map((row) => row.userId))
  const missing = ids.filter((id) => !present.has(id))
  if (missing.length === 0) return { ok: true }

  return {
    ok: false,
    error:
      missing.length === 1
        ? 'One of the selected users is not an annotator on this project.'
        : `${missing.length} of the selected users are not annotators on this project.`,
  }
}

/**
 * Every id must be a RubricDimension of this project's rubric. An empty list
 * passes: the caller decides whether it needs dimensions.
 */
export async function assertProjectDimensions(
  projectId: string,
  dimensionIds: readonly string[]
): Promise<ProjectScopeResult> {
  const ids = uniqueIds(dimensionIds)
  if (ids.length === 0) return { ok: true }

  const count = await prisma.rubricDimension.count({
    where: { projectId, id: { in: ids } },
  })
  if (count === ids.length) return { ok: true }

  const missing = ids.length - count
  return {
    ok: false,
    error:
      missing === 1
        ? "One of the selected criteria is not part of this project's rubric."
        : `${missing} of the selected criteria are not part of this project's rubric.`,
  }
}
