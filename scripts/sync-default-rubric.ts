import 'dotenv/config'
import { PrismaClient } from '../src/generated/prisma/client.js'
import { PrismaNeon } from '@prisma/adapter-neon'
import { DEFAULT_RUBRIC } from '../src/lib/rubric-templates.js'

function getArg(name: string): string | null {
  const prefix = `${name}=`
  const arg = process.argv.find((value) => value.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : null
}

async function main() {
  const projectId = getArg('--projectId')
  const shouldWrite = process.argv.includes('--write')

  if (!projectId) {
    throw new Error(
      'Usage: tsx scripts/sync-default-rubric.ts --projectId=<projectId> [--write]'
    )
  }

  const adapter = new PrismaNeon({
    connectionString: process.env.DATABASE_URL!,
  })
  const prisma = new PrismaClient({ adapter })

  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        rubric: {
          orderBy: { sortOrder: 'asc' },
        },
      },
    })

    if (!project) {
      throw new Error(`Project not found: ${projectId}`)
    }

    const existingByKey = new Map(
      project.rubric.map((dimension) => [dimension.key, dimension])
    )
    const updates = DEFAULT_RUBRIC.map((template) => {
      const existing = existingByKey.get(template.key)

      if (!existing) {
        throw new Error(
          `Project ${project.name} is missing rubric dimension ${template.key}. Aborting to avoid creating mismatched criteria.`
        )
      }

      // Note: sortOrder is intentionally NOT synced — criterion ordering is
      // managed per-project (it drives team/criterion pairings via
      // scripts/reorder-rubric-pairs.ts). This script only syncs content.
      return {
        id: existing.id,
        before: {
          label: existing.label,
          description: existing.description,
          scoreLabelJson: existing.scoreLabelJson,
          guidanceJson: existing.guidanceJson,
        },
        after: {
          label: template.label,
          description: template.description,
          scaleMin: template.scaleMin,
          scaleMax: template.scaleMax,
          scoreLabelJson: JSON.stringify(template.scoreLabels),
          guidanceJson: JSON.stringify(template.guidance),
        },
      }
    })

    console.log(`Project: ${project.name} (${project.id})`)
    console.log(`Mode: ${shouldWrite ? 'write' : 'dry-run'}`)

    for (const update of updates) {
      console.log(`\n${update.id}`)
      console.log(`  label: ${update.before.label} -> ${update.after.label}`)
      console.log(
        `  description: ${update.before.description ?? '(empty)'} -> ${update.after.description}`
      )
    }

    if (!shouldWrite) {
      console.log('\nDry run complete. Re-run with --write to apply changes.')
      return
    }

    await prisma.$transaction(
      updates.map((update) =>
        prisma.rubricDimension.update({
          where: { id: update.id },
          data: update.after,
        })
      )
    )

    console.log(`\nUpdated ${updates.length} rubric dimensions.`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
