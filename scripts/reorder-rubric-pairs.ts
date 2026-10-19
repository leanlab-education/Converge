/**
 * Reorders a project's rubric dimensions so scoring pairs sit adjacent.
 *
 * Per Amber (Slack, June 2026), criteria should be paired for team assignment
 * as: Manageable + Actionable Revision, Appropriate Feedback Decision + Not
 * Answer Giving, Task Aligned Revision + Anchored in Student Response,
 * Acknowledges Strength + Appropriate Emotional Pitch. Display order drives
 * pairing everywhere (annotator view, team creation, export columns), so the
 * fix is a sortOrder update.
 *
 * Usage: doppler run -p writing-evaluator -c dev -- npx tsx scripts/reorder-rubric-pairs.ts <projectId> [--allow-prod]
 */
import { prisma } from '../src/lib/db'
import { assertNotProduction, positionalArgs } from './_guard'

const DESIRED_ORDER = [
  'Manageable',
  'Actionable Revision',
  'Appropriate Feedback Decision',
  'Not Answer Giving',
  'Task Aligned Revision',
  'Anchored in Student Response',
  'Acknowledges Strength',
  'Appropriate Emotional Pitch',
]

async function main() {
  const [projectId] = positionalArgs()
  if (!projectId) {
    console.error('Usage: npx tsx scripts/reorder-rubric-pairs.ts <projectId> [--allow-prod]')
    process.exit(1)
  }

  await assertNotProduction('reorder-rubric-pairs')

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true },
  })
  if (!project) {
    console.error(`Project ${projectId} not found`)
    process.exit(1)
  }

  const dimensions = await prisma.rubricDimension.findMany({
    where: { projectId },
    select: { id: true, label: true, sortOrder: true },
    orderBy: { sortOrder: 'asc' },
  })

  const byLabel = new Map(dimensions.map((d) => [d.label, d]))
  const missing = DESIRED_ORDER.filter((label) => !byLabel.has(label))
  const extra = dimensions.filter((d) => !DESIRED_ORDER.includes(d.label))
  if (missing.length > 0 || extra.length > 0) {
    console.error(
      `Rubric for "${project.name}" does not match the expected labels.\n` +
        `  Missing: ${missing.join(', ') || '(none)'}\n` +
        `  Unexpected: ${extra.map((d) => d.label).join(', ') || '(none)'}`
    )
    process.exit(1)
  }

  console.log(`Reordering rubric for "${project.name}" (${projectId}):`)
  await prisma.$transaction(
    DESIRED_ORDER.map((label, index) =>
      prisma.rubricDimension.update({
        where: { id: byLabel.get(label)!.id },
        data: { sortOrder: index },
      })
    )
  )

  const updated = await prisma.rubricDimension.findMany({
    where: { projectId },
    select: { label: true, sortOrder: true },
    orderBy: { sortOrder: 'asc' },
  })
  for (const d of updated) console.log(`  ${d.sortOrder}: ${d.label}`)
  console.log('Done.')
}

main().finally(() => prisma.$disconnect())
