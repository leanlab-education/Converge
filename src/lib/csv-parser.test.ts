import { describe, it, expect } from 'vitest'
import {
  findDuplicateFeedbackIds,
  normalizeFeedbackSource,
  parseCSV,
  validateCSVRow,
  type FeedbackCSVRow,
} from '@/lib/csv-parser'

const HEADER =
  'Response_ID,Student_ID,Cycle_ID,Activity_ID,Conjunction_ID,Student_Text,Feedback_Source,Teacher_ID,Feedback_Text,optimal,feedback_type,Feedback_ID'

describe('parseCSV', () => {
  it('parses a simple row into canonical fields', () => {
    const csv = `${HEADER}\nR1,S1,C1,A1,because,The student wrote.,AI,T1,Nice work.,1,praise,F1`
    const rows = parseCSV(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      Response_ID: 'R1',
      Student_ID: 'S1',
      Feedback_Source: 'AI',
      Feedback_Text: 'Nice work.',
      Feedback_ID: 'F1',
    })
  })

  it('keeps commas inside quoted fields', () => {
    const csv = `${HEADER}\nR1,S1,C1,A1,because,"Hello, world, again",HUMAN,T1,"Good, but revise",1,x,F1`
    const rows = parseCSV(csv)
    expect(rows[0].Student_Text).toBe('Hello, world, again')
    expect(rows[0].Feedback_Text).toBe('Good, but revise')
  })

  it('unescapes doubled quotes', () => {
    const csv = `${HEADER}\nR1,S1,C1,A1,because,"She said ""hi""",AI,T1,ok,1,x,F1`
    expect(parseCSV(csv)[0].Student_Text).toBe('She said "hi"')
  })

  it('handles newlines inside quoted fields', () => {
    const csv = `${HEADER}\nR1,S1,C1,A1,because,"line one\nline two",AI,T1,ok,1,x,F1`
    const rows = parseCSV(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0].Student_Text).toBe('line one\nline two')
  })

  it('normalizes CRLF line endings', () => {
    const csv = `${HEADER}\r\nR1,S1,C1,A1,because,text,AI,T1,fb,1,x,F1\r\n`
    expect(parseCSV(csv)).toHaveLength(1)
  })

  it('maps legacy header aliases to canonical names', () => {
    const legacyHeader =
      'response_ID,student_ID,cycle_ID,activity_ID,Prompt_ID,student_response,feedback_source,Annotator_ID,feedback_text,optimal,feedback_type,feedback_ID'
    const csv = `${legacyHeader}\nR1,S1,C1,A1,but,resp,HUMAN,T9,fb,0,y,F1`
    const row = parseCSV(csv)[0]
    expect(row.Conjunction_ID).toBe('but')
    expect(row.Student_Text).toBe('resp')
    expect(row.Teacher_ID).toBe('T9')
    expect(row.Feedback_ID).toBe('F1')
  })

  it('returns [] when there is no data row', () => {
    expect(parseCSV(HEADER)).toEqual([])
    expect(parseCSV('')).toEqual([])
  })
})

describe('validateCSVRow', () => {
  const valid: FeedbackCSVRow = {
    Response_ID: 'R1', Student_ID: 'S1', Cycle_ID: 'C1', Activity_ID: 'A1',
    Conjunction_ID: 'because', Student_Text: 'resp', Feedback_Source: 'AI',
    Teacher_ID: 'T1', Feedback_Text: 'fb', optimal: '1', feedback_type: 'x', Feedback_ID: 'F1',
  }

  it('accepts a valid AI/HUMAN row (case-insensitive)', () => {
    expect(validateCSVRow(valid, 0)).toBeNull()
    expect(validateCSVRow({ ...valid, Feedback_Source: 'human' }, 0)).toBeNull()
  })

  it('flags missing required fields', () => {
    expect(validateCSVRow({ ...valid, Student_ID: '' }, 0)).toMatch(/missing Student_ID/)
    expect(validateCSVRow({ ...valid, Feedback_ID: '' }, 1)).toMatch(/missing Feedback_ID/)
    expect(validateCSVRow({ ...valid, Feedback_Text: '' }, 2)).toMatch(/missing Feedback_Text/)
    expect(validateCSVRow({ ...valid, Student_Text: '' }, 3)).toMatch(/missing Student_Text/)
  })

  it('rejects a Feedback_Source that is not AI or HUMAN', () => {
    expect(validateCSVRow({ ...valid, Feedback_Source: 'robot' }, 0)).toMatch(/must be "AI" or "HUMAN"/)
  })

  // Feedback_Source is the blinded column the export later reveals as fact. A
  // blank used to pass validation and the client defaulted it to AI, so a whole
  // file could be mislabeled without a single error.
  it('rejects a blank Feedback_Source instead of letting it default to AI', () => {
    expect(validateCSVRow({ ...valid, Feedback_Source: '' }, 0)).toMatch(/missing Feedback_Source/)
    expect(validateCSVRow({ ...valid, Feedback_Source: '   ' }, 0)).toMatch(/Feedback_Source/)
  })

  it('rejects every row when the source column header is misspelled', () => {
    // "Feedback_Src" is not in the alias table, so Feedback_Source is never set.
    const header =
      'Response_ID,Student_ID,Cycle_ID,Activity_ID,Conjunction_ID,Student_Text,Feedback_Src,Teacher_ID,Feedback_Text,optimal,feedback_type,Feedback_ID'
    const rows = parseCSV(`${header}\nR1,S1,C1,A1,because,resp,AI,T1,fb,1,x,F1\nR2,S2,C1,A1,because,resp,HUMAN,T1,fb,1,x,F2`)
    expect(rows).toHaveLength(2)
    const errors = rows.map((row, i) => validateCSVRow(row, i))
    expect(errors[0]).toMatch(/Row 1: missing Feedback_Source/)
    expect(errors[1]).toMatch(/Row 2: missing Feedback_Source/)
  })

  it('accepts a correctly labeled file with no errors', () => {
    const rows = parseCSV(
      `${HEADER}\nR1,S1,C1,A1,because,resp,AI,T1,fb,1,x,F1\nR2,S2,C1,A1,because,resp,human,T1,fb,1,x,F2`
    )
    expect(rows.map((row, i) => validateCSVRow(row, i))).toEqual([null, null])
  })

  it('uses 1-based row numbers in messages', () => {
    expect(validateCSVRow({ ...valid, Student_ID: '' }, 4)).toMatch(/Row 5:/)
  })
})

describe('normalizeFeedbackSource', () => {
  it('accepts AI/HUMAN in any case, trimmed', () => {
    expect(normalizeFeedbackSource('AI')).toBe('AI')
    expect(normalizeFeedbackSource(' human ')).toBe('HUMAN')
  })

  it('returns null for blank, unknown, or non-string values', () => {
    expect(normalizeFeedbackSource('')).toBeNull()
    expect(normalizeFeedbackSource('robot')).toBeNull()
    expect(normalizeFeedbackSource(undefined)).toBeNull()
    expect(normalizeFeedbackSource(1)).toBeNull()
  })
})

describe('findDuplicateFeedbackIds', () => {
  it('returns nothing for a file with unique ids', () => {
    expect(findDuplicateFeedbackIds([{ Feedback_ID: 'F1' }, { Feedback_ID: 'F2' }])).toEqual([])
  })

  it('names each duplicated id with every row it appears on', () => {
    const errors = findDuplicateFeedbackIds([
      { Feedback_ID: 'F1' },
      { Feedback_ID: 'F2' },
      { Feedback_ID: 'F1' },
      { Feedback_ID: 'F2' },
      { Feedback_ID: 'F1' },
    ])
    expect(errors).toEqual([
      'Feedback_ID "F1" appears 3 times (rows 1, 3, 5)',
      'Feedback_ID "F2" appears 2 times (rows 2, 4)',
    ])
  })

  it('ignores blank ids (validateCSVRow reports those)', () => {
    expect(findDuplicateFeedbackIds([{ Feedback_ID: '' }, { Feedback_ID: '' }])).toEqual([])
  })
})
