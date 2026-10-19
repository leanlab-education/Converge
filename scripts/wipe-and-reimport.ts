import 'dotenv/config'
import { readFileSync } from 'fs'
import { PrismaClient } from '../src/generated/prisma/client.js'
import { PrismaNeon } from '@prisma/adapter-neon'
import { parseCSV, validateCSVRow } from '../src/lib/csv-parser.js'
import {
  ALLOW_PROD_FLAG,
  assertNotProduction,
  hasAllowProdFlag,
  positionalArgs,
} from './_guard.js'

const [projectName, csvPath] = positionalArgs()
const dryRun = !process.argv.includes('--write')
const allowProd = hasAllowProdFlag()

if (!projectName || !csvPath) {
  console.error(
    'Usage: wipe-and-reimport.ts "Project Name" /path/to/file.csv [--write] [--allow-prod]'
  )
  process.exit(1)
}

const prisma = new PrismaClient({
  adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL }),
})

async function main() {
  const project = await prisma.project.findFirst({ where: { name: projectName } })
  if (!project) {
    console.error(`Project "${projectName}" not found`)
    process.exit(1)
  }
  console.log(`Project: ${project.name} (${project.id})`)

  const text = readFileSync(csvPath, 'utf8')
  const rows = parseCSV(text)
  console.log(`Parsed ${rows.length} rows from ${csvPath}`)

  for (let i = 0; i < rows.length; i++) {
    const err = validateCSVRow(rows[i], i)
    if (err) {
      console.error('Validation error:', err)
      process.exit(1)
    }
  }

  const beforeCounts = {
    feedbackItems: await prisma.feedbackItem.count({ where: { projectId: project.id } }),
    batches: await prisma.batch.count({ where: { projectId: project.id } }),
    scores: await prisma.score.count({ where: { feedbackItem: { projectId: project.id } } }),
    imports: await prisma.import.count({ where: { projectId: project.id } }),
    teams: await prisma.evaluatorTeam.count({ where: { projectId: project.id } }),
    rubric: await prisma.rubricDimension.count({ where: { projectId: project.id } }),
    evaluators: await prisma.projectEvaluator.count({ where: { projectId: project.id } }),
  }
  console.log('Before:', beforeCounts)

  if (dryRun) {
    console.log('\n(dry run — pass --write to apply)')
    console.log(`Would delete: ${beforeCounts.feedbackItems} items, ${beforeCounts.batches} batches, ${beforeCounts.scores} scores, ${beforeCounts.imports} imports`)
    console.log(`Would keep: ${beforeCounts.teams} teams, ${beforeCounts.rubric} rubric dimensions, ${beforeCounts.evaluators} project-evaluator memberships`)
    console.log(`Would import: ${rows.length} new items`)
    await prisma.$disconnect()
    return
  }

  // Writes start here. The dry run above is read-only and may preview any host.
  await assertNotProduction('wipe-and-reimport', { allowProd })
  if (beforeCounts.scores > 0 && !allowProd) {
    console.error(
      `\nRefusing: ${beforeCounts.scores} scores exist on this project and deleting its feedback items would cascade-delete them. Pass ${ALLOW_PROD_FLAG} to proceed anyway.`
    )
    await prisma.$disconnect()
    process.exit(1)
  }

  console.log('\nWiping...')
  // Order: batches first (cascades batch_assignments, batch_ranges, team_releases, escalations).
  // Then feedback items (cascades scores, assignments, escalations).
  // Imports last (no FK to FeedbackItem, but tied to project).
  await prisma.batch.deleteMany({ where: { projectId: project.id } })
  await prisma.feedbackItem.deleteMany({ where: { projectId: project.id } })
  await prisma.import.deleteMany({ where: { projectId: project.id } })
  console.log('Wipe complete.')

  console.log(`\nImporting ${rows.length} items...`)
  const importRow = await prisma.import.create({
    data: {
      projectId: project.id,
      filename: csvPath.split('/').pop() ?? 'unnamed.csv',
      itemCount: rows.length,
      skippedCount: 0,
    },
  })

  const data = rows.map((r, index) => ({
    projectId: project.id,
    importId: importRow.id,
    responseId: r.Response_ID || null,
    cycleId: r.Cycle_ID || null,
    studentId: (r.Student_ID || '').replace(/,/g, ''),
    activityId: r.Activity_ID || null,
    conjunctionId: r.Conjunction_ID || null,
    studentText: r.Student_Text,
    feedbackId: r.Feedback_ID,
    teacherId: r.Teacher_ID || null,
    feedbackText: r.Feedback_Text,
    feedbackSource: (r.Feedback_Source || '').toUpperCase() as 'AI' | 'HUMAN',
    optimal: r.optimal || null,
    feedbackType: r.feedback_type || null,
    displayOrder: index,
  }))

  // Chunk to avoid statement size limits
  const CHUNK = 500
  for (let i = 0; i < data.length; i += CHUNK) {
    const chunk = data.slice(i, i + CHUNK)
    await prisma.feedbackItem.createMany({ data: chunk, skipDuplicates: true })
    console.log(`  inserted ${Math.min(i + CHUNK, data.length)} / ${data.length}`)
  }

  const afterCounts = {
    feedbackItems: await prisma.feedbackItem.count({ where: { projectId: project.id } }),
    batches: await prisma.batch.count({ where: { projectId: project.id } }),
  }
  console.log('After:', afterCounts)

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
