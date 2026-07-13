/**
 * Apply Rubric V12 (July 2026) to the Quill Annotation project.
 *
 * V12 changed exactly two criteria's text (keys/scale unchanged):
 *   - criterion_1  Appropriate Feedback Decision
 *   - criterion_2  Task Aligned Revision
 * All other criteria are untouched. Scores/exports/teams/reconciliations are
 * unaffected because we only edit description / guidanceJson / scoreLabelJson.
 *
 * Idempotent: safe to run multiple times. Runs against whatever DATABASE_URL
 * doppler injects (preview branch now, prod at cutover).
 *
 * Usage: doppler run -p writing-evaluator -c <cfg> -- npx tsx scripts/apply-v12-rubric.ts
 */
import { PrismaClient } from '../src/generated/prisma/client.js'
import { PrismaNeon } from '@prisma/adapter-neon'

const QUILL_PROJECT_ID = 'cmp337i4x0000q2zga4bfjtcp'

type Block = { type: 'paragraph' | 'bullet' | 'label'; text: string }
const p = (text: string): Block => ({ type: 'paragraph', text })
const b = (text: string): Block => ({ type: 'bullet', text })
const l = (text: string): Block => ({ type: 'label', text })

interface V12Criterion {
  key: string
  label: string
  prompt: string
  meets: Block[]
  doesNotMeet: Block[]
  meetsSummary: string
  doesNotMeetSummary: string
}

const V12: V12Criterion[] = [
  {
    key: 'criterion_1',
    label: 'Appropriate Feedback Decision',
    prompt: 'Did the feedback correctly identify whether the student needed to revise?',
    meets: [
      p('Feedback correctly determines that the student response should receive feedback. That is:'),
      b('The response does NOT meet the evidence goal (i.e., does not successfully complete a claim with relevant evidence)'),
      b('If the response meets the evidence goal, but not the grammar goal'),
      l('NOTES:'),
      b('Indicator in the platform that flags “needs revision” or “not” — this comes from the Quill system'),
      b('The optimal indicator will flag “needing revision” if the student response met the evidence goal but can improve grammar'),
      b('Annotator can still override the indicator (“optimal”) decision'),
      b('Annotators should read the Quill activity text for the topic'),
    ],
    doesNotMeet: [
      p('Feedback incorrectly identifies whether the student response should receive feedback.'),
      l('Examples'),
      b('“Great job, you can move on” (when it’s actually wrong)'),
      b('OR “This needs revision” (when it’s actually right)'),
      p('NOTE: Annotator may override the feedback writer’s decision.'),
    ],
    meetsSummary: 'Feedback correctly determines that the student response should receive feedback.',
    doesNotMeetSummary: 'Feedback incorrectly identifies whether the student response should receive feedback.',
  },
  {
    key: 'criterion_2',
    label: 'Task Aligned Revision',
    prompt: 'Does the feedback address the learning objective(s)?',
    meets: [
      p('Feedback is aligned to the task and supports progress toward completing it.'),
      b('Targets the core requirements of the task (i.e., support a claim by using relevant text-based evidence)'),
      b('Tells students to write one sentence if they wrote more than one initially'),
      b('Feedback may also target other relevant improvements (e.g., clarity or grammar)'),
      b('Reinforces students’ effective use of evidence'),
    ],
    doesNotMeet: [
      p('Feedback is not aligned to the task and/or does not support meaningful progress toward completing the task.'),
      b('Feedback focuses on issues unrelated to the task (i.e., feedback is not related to use of evidence or grammar; e.g., asking someone to quote the text)'),
      b('Feedback introduces a requirement that is not specified in the directions (e.g., asking for a particular amount of evidence such as “2 [or more] pieces”)'),
    ],
    meetsSummary: 'Feedback is aligned to the task and supports progress toward completing it.',
    doesNotMeetSummary: 'Feedback is not aligned to the task and/or does not support meaningful progress toward completing the task.',
  },
]

async function main() {
  const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
  const prisma = new PrismaClient({ adapter })

  for (const c of V12) {
    const existing = await prisma.rubricDimension.findUnique({
      where: { projectId_key: { projectId: QUILL_PROJECT_ID, key: c.key } },
      select: { id: true, label: true },
    })
    if (!existing) {
      console.error(`!! ${c.key} (${c.label}) not found in Quill project — skipping`)
      continue
    }

    const guidanceJson = JSON.stringify({ prompt: c.prompt, meets: c.meets, doesNotMeet: c.doesNotMeet })
    const scoreLabelJson = JSON.stringify({
      '0': { label: 'Does Not Meet Criterion', description: c.doesNotMeetSummary },
      '1': { label: 'Meets Criterion', description: c.meetsSummary },
    })

    await prisma.rubricDimension.update({
      where: { id: existing.id },
      data: { label: c.label, description: c.prompt, guidanceJson, scoreLabelJson },
    })
    console.log(`✓ Updated ${c.key} → "${c.label}" (prompt: "${c.prompt}")`)
  }

  console.log('\nV12 applied to Quill Annotation. Other 6 criteria untouched.')
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
