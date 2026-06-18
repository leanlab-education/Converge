export interface RubricContentBlock {
  type: 'paragraph' | 'bullet' | 'label'
  text: string
}

export interface RubricDimensionGuidance {
  prompt: string
  meets: RubricContentBlock[]
  doesNotMeet: RubricContentBlock[]
}

export interface RubricDimensionTemplate {
  key: string
  label: string
  description: string
  scaleMin: number
  scaleMax: number
  scoreLabels: Record<number, { label: string; description: string }>
  guidance: RubricDimensionGuidance
}

export interface RubricTemplateDefinition {
  id: string
  name: string
  version: string
  dimensions: RubricDimensionTemplate[]
}

const STANDARD_SCALE = {
  min: 0,
  max: 1,
} as const

function paragraph(text: string): RubricContentBlock {
  return { type: 'paragraph', text }
}

function bullet(text: string): RubricContentBlock {
  return { type: 'bullet', text }
}

function label(text: string): RubricContentBlock {
  return { type: 'label', text }
}

function createStandardScoreLabels({
  doesNotMeet,
  meets,
}: {
  doesNotMeet: string
  meets: string
}): Record<number, { label: string; description: string }> {
  return {
    0: { label: 'Does Not Meet Criterion', description: doesNotMeet },
    1: { label: 'Meets Criterion', description: meets },
  }
}

function createCriterion(
  key: string,
  labelText: string,
  prompt: string,
  guidance: RubricDimensionGuidance,
  scoreDescriptions: {
    doesNotMeet: string
    meets: string
  }
): RubricDimensionTemplate {
  return {
    key,
    label: labelText,
    description: prompt,
    scaleMin: STANDARD_SCALE.min,
    scaleMax: STANDARD_SCALE.max,
    scoreLabels: createStandardScoreLabels(scoreDescriptions),
    guidance,
  }
}

// Keep keys stable so existing score rows, exports, and team assignments remain valid.
export const QUILL_FEEDBACK_RUBRIC_V11: RubricTemplateDefinition = {
  id: 'quill-feedback-v11',
  name: 'Quill Feedback Rubric',
  version: 'V11, June 2026',
  dimensions: [
    createCriterion(
      'criterion_1',
      'Appropriate Feedback Decision',
      'Did the feedback correctly identify whether the student needed to revise?',
      {
        prompt:
          'Did the feedback correctly identify whether the student needed to revise?',
        meets: [
          paragraph(
            'Feedback correctly determines that the student response should receive feedback.'
          ),
          bullet(
            'The response does NOT meet the goal (i.e., does not successfully complete a claim with relevant evidence)'
          ),
          paragraph(
            'If the response meets the goal, feedback indicates that the student can move on (even if extra feedback was given).'
          ),
        ],
        doesNotMeet: [
          paragraph(
            'Feedback incorrectly identifies whether the student has met the task goal.'
          ),
          label('Examples'),
          bullet('“Great job, you can move on” (when it’s actually wrong)'),
          bullet('OR “This needs revision” (when it’s actually right)'),
        ],
      },
      {
        doesNotMeet:
          'Feedback incorrectly identifies whether the student has met the task goal.',
        meets:
          'Feedback correctly determines whether the student should revise or can move on.',
      }
    ),
    createCriterion(
      'criterion_2',
      'Task Aligned Revision',
      'Is the feedback about use of evidence?',
      {
        prompt: 'Is the feedback about use of evidence?',
        meets: [
          paragraph(
            'Feedback is aligned to the task and supports progress toward completing it.'
          ),
          bullet(
            'Targets the core requirements of the task (i.e., support a claim by using relevant text-based evidence)'
          ),
          bullet(
            'Tells students to write one sentence if they wrote more than one initially'
          ),
          paragraph('When the task is already met, feedback may:'),
          bullet('Reinforce effective use of evidence, OR'),
          bullet(
            'Offer optional improvements (e.g., clarity or grammar) that extend the response without implying it is incomplete'
          ),
        ],
        doesNotMeet: [
          paragraph(
            'Feedback is not aligned to the task and/or does not support meaningful progress toward completing the task.'
          ),
          paragraph(
            'Feedback focuses on issues unrelated to the task or addresses lower-priority concerns while higher-priority issues (e.g., missing, incorrect, or unclear evidence) remain unaddressed unless problematic grammar impedes understanding of the student response, then grammar may be the priority.'
          ),
        ],
      },
      {
        doesNotMeet:
          'Feedback is not aligned to the task and/or does not support meaningful progress toward completing the task.',
        meets:
          'Feedback is aligned to the task and supports progress toward completing it.',
      }
    ),
    createCriterion(
      'criterion_3',
      'Not Answer Giving',
      'Does the feedback avoid giving away the answer?',
      {
        prompt: 'Does the feedback avoid giving away the answer?',
        meets: [
          paragraph('Feedback does not give away the full answer.'),
          bullet('Feedback does not provide the solution'),
          bullet(
            'May scaffold for the student (e.g., hints, guiding questions)'
          ),
          bullet('Student did not need to revise'),
        ],
        doesNotMeet: [
          paragraph(
            'Feedback provides the solution or completes the task for the student.'
          ),
          bullet('Supplying the evidence the student should use'),
          bullet(
            'Writing a complete or near-complete version of the response'
          ),
        ],
      },
      {
        doesNotMeet:
          'Feedback provides the solution or completes the task for the student.',
        meets:
          'Feedback does not give away the full answer and may scaffold for the student.',
      }
    ),
    createCriterion(
      'criterion_4',
      'Actionable Revision',
      'Does the feedback give a clear next step?',
      {
        prompt: 'Does the feedback give a clear next step?',
        meets: [
          paragraph(
            'Feedback gives a clear and usable next step for revision.'
          ),
          bullet(
            'It may ask a question or tell the student what to add, explain, clarify, revise, etc.'
          ),
          bullet(
            'The student could reasonably act on the feedback without additional clarification'
          ),
          bullet(
            'If the feedback writer determined the student responses did not need revision, the feedback does not need to include a next step (code this 1 - meeting)'
          ),
        ],
        doesNotMeet: [
          paragraph(
            'The feedback does not give a clear and usable next step.'
          ),
          bullet('Is purely evaluative'),
          bullet('The student could not reasonably act on the feedback'),
          bullet('Too little to go on.'),
        ],
      },
      {
        doesNotMeet:
          'The feedback does not give a clear and usable next step.',
        meets: 'Feedback gives a clear and usable next step for revision.',
      }
    ),
    createCriterion(
      'criterion_5',
      'Manageable',
      'Is the amount of feedback manageable for the student?',
      {
        prompt: 'Is the amount of feedback manageable for the student?',
        meets: [
          paragraph(
            'The feedback is manageable in amount and scope for the learner.'
          ),
          bullet(
            'It is focused enough that the student could realistically process.'
          ),
          bullet(
            'Scope: Feedback addresses no more than two clearly prioritized issues.'
          ),
          bullet(
            'Length: In general, four sentences or fewer will usually count as manageable.'
          ),
          bullet(
            'Student did not need to revise (based on the feedback writer’s decision).'
          ),
          label('Decision tree:'),
          bullet(
            'Start with length — anything over 4 sentences is an automatic “not manageable” (in the context of the Quill product/activity).'
          ),
          bullet(
            'If fewer than 4 sentences, weigh the criteria above, then check scope (see above).'
          ),
          bullet(
            'If the student did not need to revise (based on the feedback writer’s decision), then score “1”.'
          ),
          paragraph(
            'NOTE: This doesn’t necessarily mean the feedback is “good”; the focus of this criterion is to assess the feedback’s scope/size/length. Parameters of manageability are dependent on the product (task).'
          ),
        ],
        doesNotMeet: [
          paragraph(
            'Feedback is not manageable in amount or scope for the learner.'
          ),
          bullet(
            'Task-Specific Requirements: Manageable feedback is defined per task.'
          ),
          bullet(
            'The feedback is too long, too dense, or includes too many suggestions at once.'
          ),
        ],
      },
      {
        doesNotMeet:
          'Feedback is not manageable in amount or scope for the learner.',
        meets:
          'The feedback is manageable in amount and scope for the learner.',
      }
    ),
    createCriterion(
      'criterion_6',
      'Anchored in Student Response',
      'Is the feedback clearly based on the student’s specific response?',
      {
        prompt:
          'Is the feedback clearly based on the student’s specific response?',
        meets: [
          paragraph(
            'Feedback is clearly based on the student’s specific response.'
          ),
          bullet(
            'Feedback specifically references, builds on, or responds to the student’s specific idea, wording, or use of evidence (e.g., echoes the student’s words or is an accurate observation/response to something the student did).'
          ),
          bullet(
            'Demonstrates an accurate understanding of what the student wrote.'
          ),
          label(
            'Re-directing to be task aligned — when feedback directs students to be task aligned when they are not, we consider it anchored:'
          ),
          bullet(
            'If a student plagiarises, and the feedback tells the student to use their own words, this counts as a “1” because it’s responsive to the student’s wording choice of plagiarizing.'
          ),
          bullet(
            'If a student uses evidence (or opinion) that is OUTSIDE the text and the feedback writer addresses that, re-directing the student, this can count as “1” because it’s responding specifically to the student’s choice of bringing in superfluous info.'
          ),
          bullet(
            'If a student writes more than one sentence and the feedback writer tells the student to write one sentence, then that is a “1”.'
          ),
        ],
        doesNotMeet: [
          paragraph(
            'Feedback is not clearly based on the student’s specific response.'
          ),
          bullet(
            'It is generic and could apply to any response (e.g., template-like comments).'
          ),
          bullet(
            'It is based on a misinterpretation or misunderstanding of the student’s response'
          ),
          bullet(
            'It addresses something the student did not actually say or attempt'
          ),
        ],
      },
      {
        doesNotMeet:
          'Feedback is not clearly based on the student’s specific response.',
        meets:
          'Feedback is clearly based on the student’s specific response.',
      }
    ),
    createCriterion(
      'criterion_7',
      'Acknowledges Strength',
      'Does the feedback identify what the student did well?',
      {
        prompt: 'Does the feedback identify what the student did well?',
        meets: [
          paragraph(
            'Feedback appropriately acknowledges strength when applicable.'
          ),
          bullet(
            'Feedback accurately identifies a specific strength in the student’s response'
          ),
          bullet(
            'The strength is relevant to the task (e.g., use and specificity of evidence)'
          ),
          bullet(
            "Feedback is tied to something particular in this student's response, not a feature that could apply to any response"
          ),
          bullet(
            'The student response does not contain anything that warrants positive acknowledgement. For example, when a student writes “IDK.”'
          ),
        ],
        doesNotMeet: [
          paragraph(
            'Feedback does not appropriately acknowledge a strength when one is present.'
          ),
          bullet(
            'Feedback provides only generic or vague praise (e.g., “Good job,” “Nice work”) without specifying what was done well'
          ),
          bullet('Feedback includes inaccurate or misleading praise'),
        ],
      },
      {
        doesNotMeet:
          'Feedback does not appropriately acknowledge a strength when one is present.',
        meets:
          'Feedback appropriately acknowledges strength when applicable.',
      }
    ),
    createCriterion(
      'criterion_8',
      'Appropriate Emotional Pitch',
      'Is the tone appropriate and constructive for the student?',
      {
        prompt: 'Is the tone appropriate and constructive for the student?',
        meets: [
          paragraph('The tone appropriate and constructive for the student'),
          bullet('Feedback uses neutral, professional language throughout.'),
          bullet(
            'Word choice does not carry negative judgment of the student as a person, does not shame or dismiss, and does not use exaggerated positive language that misrepresents the quality of the work.'
          ),
          bullet(
            'Feedback is neutral and/or respectful and/or supportive, even when pointing out areas for improvement'
          ),
          bullet(
            'Encourages continued effort without overstating or discouraging'
          ),
        ],
        doesNotMeet: [
          paragraph(
            'The tone is not appropriate or constructive for the student, or evaluates the student rather than the work'
          ),
          bullet(
            'Language is evaluative of the student rather than the work ("this is a weak response," "you clearly didn\'t read the text"), dismissive ("this makes no sense"), or uses praise so inflated it is inaccurate ("this is excellent" when the response is incomplete).'
          ),
          bullet(
            'Tone is harsh, overly negative, or discouraging (e.g., shaming, dismissive language).'
          ),
          bullet(
            'Tone is inappropriately exaggerated or misleading (e.g., overly enthusiastic praise that does not match the quality of the response)'
          ),
        ],
      },
      {
        doesNotMeet:
          'The tone is not appropriate or constructive for the student, or evaluates the student rather than the work.',
        meets:
          'The tone is appropriate and constructive for the student.',
      }
    ),
  ],
}

export const DEFAULT_RUBRIC = QUILL_FEEDBACK_RUBRIC_V11.dimensions
