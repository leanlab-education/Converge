import { describe, it, expect } from 'vitest'
import {
  DEFAULT_RUBRIC,
  QUILL_FEEDBACK_RUBRIC_V11,
  type RubricDimensionTemplate,
} from '@/lib/rubric-templates'

const EXPECTED_KEYS = [
  'criterion_1',
  'criterion_2',
  'criterion_3',
  'criterion_4',
  'criterion_5',
  'criterion_6',
  'criterion_7',
  'criterion_8',
]

describe('DEFAULT_RUBRIC', () => {
  it('is the dimensions array of the V11 Quill template', () => {
    expect(DEFAULT_RUBRIC).toBe(QUILL_FEEDBACK_RUBRIC_V11.dimensions)
  })

  it('has exactly 8 dimensions', () => {
    expect(DEFAULT_RUBRIC).toHaveLength(8)
  })

  it('uses stable keys criterion_1..criterion_8 in order', () => {
    expect(DEFAULT_RUBRIC.map((d) => d.key)).toEqual(EXPECTED_KEYS)
  })

  it('has unique keys', () => {
    const keys = DEFAULT_RUBRIC.map((d) => d.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('uses a binary 0-1 scale on every dimension', () => {
    for (const dim of DEFAULT_RUBRIC) {
      expect(dim.scaleMin).toBe(0)
      expect(dim.scaleMax).toBe(1)
    }
  })

  it('provides scoreLabels for exactly the scores 0 and 1 on every dimension', () => {
    for (const dim of DEFAULT_RUBRIC) {
      expect(Object.keys(dim.scoreLabels).map(Number).sort()).toEqual([0, 1])
      expect(dim.scoreLabels[0]).toBeDefined()
      expect(dim.scoreLabels[1]).toBeDefined()
    }
  })

  it('labels score 0 as "Does Not Meet Criterion" and score 1 as "Meets Criterion"', () => {
    for (const dim of DEFAULT_RUBRIC) {
      expect(dim.scoreLabels[0].label).toBe('Does Not Meet Criterion')
      expect(dim.scoreLabels[1].label).toBe('Meets Criterion')
    }
  })

  it('gives every score label a non-empty description', () => {
    for (const dim of DEFAULT_RUBRIC) {
      expect(dim.scoreLabels[0].description.length).toBeGreaterThan(0)
      expect(dim.scoreLabels[1].description.length).toBeGreaterThan(0)
    }
  })

  it('gives every dimension a non-empty label and description', () => {
    for (const dim of DEFAULT_RUBRIC) {
      expect(dim.label.length).toBeGreaterThan(0)
      expect(dim.description.length).toBeGreaterThan(0)
    }
  })

  it('has a guidance block with prompt, meets, and doesNotMeet on every dimension', () => {
    for (const dim of DEFAULT_RUBRIC) {
      expect(dim.guidance).toBeDefined()
      expect(typeof dim.guidance.prompt).toBe('string')
      expect(dim.guidance.prompt.length).toBeGreaterThan(0)
      expect(Array.isArray(dim.guidance.meets)).toBe(true)
      expect(Array.isArray(dim.guidance.doesNotMeet)).toBe(true)
      expect(dim.guidance.meets.length).toBeGreaterThan(0)
      expect(dim.guidance.doesNotMeet.length).toBeGreaterThan(0)
    }
  })

  it('uses only valid content block types in guidance', () => {
    const validTypes = new Set(['paragraph', 'bullet', 'label'])
    for (const dim of DEFAULT_RUBRIC) {
      for (const block of [...dim.guidance.meets, ...dim.guidance.doesNotMeet]) {
        expect(validTypes.has(block.type)).toBe(true)
        expect(block.text.length).toBeGreaterThan(0)
      }
    }
  })

  it('mirrors the guidance prompt in the dimension description', () => {
    for (const dim of DEFAULT_RUBRIC) {
      expect(dim.guidance.prompt).toBe(dim.description)
    }
  })
})

describe('QUILL_FEEDBACK_RUBRIC_V11 metadata', () => {
  it('exposes a stable id, name, and version', () => {
    expect(QUILL_FEEDBACK_RUBRIC_V11.id).toBe('quill-feedback-v11')
    expect(QUILL_FEEDBACK_RUBRIC_V11.name).toBe('Quill Feedback Rubric')
    expect(QUILL_FEEDBACK_RUBRIC_V11.version.length).toBeGreaterThan(0)
  })

  it('matches the RubricDimensionTemplate shape (type smoke check)', () => {
    const first: RubricDimensionTemplate = DEFAULT_RUBRIC[0]
    expect(first.key).toBe('criterion_1')
  })
})
