import 'dotenv/config'
import { PrismaClient } from '../src/generated/prisma/client.js'
import { PrismaNeon } from '@prisma/adapter-neon'
import * as XLSX from 'xlsx'

async function main() {
  const adapter = new PrismaNeon({
    connectionString: process.env.DATABASE_URL!,
  })
  const prisma = new PrismaClient({ adapter })

  // Read xlsx (more reliable than the CSV which has Stata export issues)
  const wb = XLSX.readFile('test-data/amber-cycle1.xlsx')
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const records: Record<string, string>[] = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  console.log(`Parsed ${records.length} rows from xlsx`)

  console.log('Columns:', Object.keys(records[0]))
  console.log('Sample row:', JSON.stringify(records[0], null, 2))

  // Check unique values
  const sources = new Set(records.map((r) => r.Feedback_Source))
  const activities = new Set(records.map((r) => r.Activity_ID))
  const conjunctions = new Set(records.map((r) => r.Conjunction_ID || r.Prompt_ID))
  console.log('Unique Feedback_Source:', [...sources])
  console.log('Unique Activity_ID:', [...activities])
  console.log('Unique Conjunction_ID:', [...conjunctions])

  // Delete the empty project from the failed CSV attempt
  const emptyProjects = await prisma.project.findMany({
    where: { name: 'Amber Cycle 1 — Test Import' },
    include: { _count: { select: { feedbackItems: true } } },
  })
  for (const p of emptyProjects) {
    if (p._count.feedbackItems === 0) {
      // Delete rubric dimensions first, then project
      await prisma.rubricDimension.deleteMany({ where: { projectId: p.id } })
      await prisma.project.delete({ where: { id: p.id } })
      console.log(`Deleted empty project: ${p.id}`)
    }
  }

  // Create project
  const project = await prisma.project.create({
    data: {
      name: 'Amber Cycle 1 — Test Import',
      description:
        '582 feedback items from Amber (Cycle 1, Activity 1). Because + But prompt types. 291 Human (Annotator 1) + 291 AI.',
      rubric: {
        create: [
          {
            key: 'affective_support',
            label: 'Affective Support',
            description:
              'Encourages and/or addresses the emotional needs of the learner.',
            sortOrder: 0,
            scaleMin: 1,
            scaleMax: 3,
            scoreLabelJson: JSON.stringify({
              1: { label: 'Not Present', description: 'Negative, discouraging, dismissive, or absent.' },
              2: { label: 'Unclear', description: 'Neutral or inconsistent encouragement.' },
              3: { label: 'Present', description: 'Supportive; acknowledges strengths and effort.' },
            }),
          },
          {
            key: 'alignment',
            label: 'Alignment',
            description: 'Addresses the task at hand.',
            sortOrder: 1,
            scaleMin: 1,
            scaleMax: 3,
            scoreLabelJson: JSON.stringify({
              1: { label: 'Not Present', description: 'Irrelevant or misaligned to the task.' },
              2: { label: 'Unclear', description: 'Vague or partially misaligned to the task.' },
              3: { label: 'Present', description: 'Relevant, and aligned with task.' },
            }),
          },
          {
            key: 'accuracy',
            label: 'Accuracy',
            description: 'The feedback is factually correct.',
            sortOrder: 2,
            scaleMin: 1,
            scaleMax: 3,
            scoreLabelJson: JSON.stringify({
              1: { label: 'Not Present', description: 'Incorrect or misleading.' },
              2: { label: 'Unclear', description: 'Some correct elements, but not all.' },
              3: { label: 'Present', description: 'Accurate / factually correct.' },
            }),
          },
          {
            key: 'clarity',
            label: 'Clarity',
            description: 'It makes sense.',
            sortOrder: 3,
            scaleMin: 1,
            scaleMax: 3,
            scoreLabelJson: JSON.stringify({
              1: { label: 'Not Present', description: 'Confusing, ambiguous, or overly technical.' },
              2: { label: 'Unclear', description: 'Some clarity, but possible misunderstandings.' },
              3: { label: 'Present', description: 'Clear and accessible to the learner.' },
            }),
          },
          {
            key: 'scaffolding',
            label: 'Scaffolding / Cognitive Load',
            description:
              'Provides step-by-step guidance that is of the appropriate grain size, logically chunked, and amount for the learner to respond to the task.',
            sortOrder: 4,
            scaleMin: 1,
            scaleMax: 3,
            scoreLabelJson: JSON.stringify({
              1: {
                label: 'Not Present',
                description:
                  'Only evaluative ("right/wrong"); no guidance; too much guidance/reveals answers.',
              },
              2: {
                label: 'Unclear',
                description:
                  'Vague or generic suggestions. Some useful info, but underdeveloped or cluttered.',
              },
              3: {
                label: 'Present',
                description:
                  'Clear, specific steps to progress. Balanced; enough info without overload.',
              },
            }),
          },
        ],
      },
    },
  })

  console.log(`Created project: ${project.name} (${project.id})`)

  // Import feedback items
  const data = records.map((row, index) => ({
    projectId: project.id,
    responseId: String(row.Response_ID || '') || null,
    cycleId: String(row.Cycle_ID || '') || null,
    studentId: String(row.Student_ID),
    activityId: String(row.Activity_ID || '') || null,
    conjunctionId: String(row.Conjunction_ID || row.Prompt_ID || '') || null,
    studentText: String(row.Student_Text),
    feedbackId: String(row.Feedback_ID),
    teacherId: String(row.Teacher_ID || row.Annotator_ID || '') || null,
    feedbackText: String(row.Feedback_Text),
    feedbackSource: (String(row.Feedback_Source) || 'AI').toUpperCase() as
      | 'AI'
      | 'HUMAN',
    displayOrder: index,
  }))

  // Validate
  const invalid = data.filter(
    (d) =>
      !d.studentId || !d.feedbackId || !d.feedbackText || !d.studentText
  )
  if (invalid.length > 0) {
    console.error(`WARNING: ${invalid.length} rows with missing required fields`)
    invalid.slice(0, 3).forEach((d) => console.error('  ', JSON.stringify(d)))
  }

  const valid = data.filter(
    (d) => d.studentId && d.feedbackId && d.feedbackText && d.studentText
  )

  const result = await prisma.feedbackItem.createMany({
    data: valid,
    skipDuplicates: true,
  })

  console.log(
    `Imported ${result.count} / ${records.length} feedback items (${records.length - valid.length} skipped)`
  )

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
