// Parse CSV text with quote-aware field splitting
// Handles: quoted fields, commas inside quotes, escaped quotes

export interface FeedbackCSVRow {
  Response_ID: string
  Student_ID: string
  Cycle_ID: string
  Activity_ID: string
  Conjunction_ID: string
  Student_Text: string
  Feedback_Source: string // "AI" or "HUMAN"
  Teacher_ID: string
  Feedback_Text: string
  optimal: string
  feedback_type: string
  Feedback_ID: string
}

// Column name mapping — supports both new format and legacy aliases
const COLUMN_ALIASES: Record<string, keyof FeedbackCSVRow> = {
  Response_ID: 'Response_ID',
  Student_ID: 'Student_ID',
  Cycle_ID: 'Cycle_ID',
  Activity_ID: 'Activity_ID',
  Conjunction_ID: 'Conjunction_ID',
  Student_Text: 'Student_Text',
  Feedback_Source: 'Feedback_Source',
  Teacher_ID: 'Teacher_ID',
  Feedback_Text: 'Feedback_Text',
  optimal: 'optimal',
  feedback_type: 'feedback_type',
  Feedback_ID: 'Feedback_ID',
  // Legacy aliases
  response_ID: 'Response_ID',
  student_ID: 'Student_ID',
  cycle_ID: 'Cycle_ID',
  activity_ID: 'Activity_ID',
  Prompt_ID: 'Conjunction_ID',
  prompt_ID: 'Conjunction_ID',
  student_response: 'Student_Text',
  feedback_source: 'Feedback_Source',
  Annotator_ID: 'Teacher_ID',
  annotator_ID: 'Teacher_ID',
  feedback_text: 'Feedback_Text',
  feedback_ID: 'Feedback_ID',
}

export function parseCSV(text: string): FeedbackCSVRow[] {
  // Normalize line endings
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  // Parse all records at once — handles multi-line quoted fields
  const records = parseRecords(normalized)
  if (records.length < 2) return []

  const rawHeaders = records[0].map((h) => h.trim())

  // Map raw headers to canonical names via aliases
  const mappedHeaders = rawHeaders.map(
    (h) => COLUMN_ALIASES[h] ?? (h as keyof FeedbackCSVRow)
  )

  const rows: FeedbackCSVRow[] = []

  for (let i = 1; i < records.length; i++) {
    const values = records[i]
    if (values.length === 0) continue

    const row: Record<string, string> = {}
    mappedHeaders.forEach((header, idx) => {
      row[header] = (values[idx] || '').trim()
    })

    rows.push(row as unknown as FeedbackCSVRow)
  }

  return rows
}

// Parse entire CSV text into records, correctly handling multi-line quoted fields
function parseRecords(text: string): string[][] {
  const records: string[][] = []
  let fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          current += '"'
          i++ // skip escaped quote
        } else {
          inQuotes = false
        }
      } else {
        current += char // includes newlines inside quoted fields
      }
    } else {
      if (char === '"') {
        inQuotes = true
      } else if (char === ',') {
        fields.push(current)
        current = ''
      } else if (char === '\n') {
        fields.push(current)
        current = ''
        if (fields.some((f) => f.trim())) {
          records.push(fields)
        }
        fields = []
      } else {
        current += char
      }
    }
  }

  // Handle last field/record
  fields.push(current)
  if (fields.some((f) => f.trim())) {
    records.push(fields)
  }

  return records
}

// Validate required fields
export function validateCSVRow(
  row: FeedbackCSVRow,
  index: number
): string | null {
  if (!row.Student_ID) return `Row ${index + 1}: missing Student_ID`
  if (!row.Feedback_ID) return `Row ${index + 1}: missing Feedback_ID`
  if (!row.Feedback_Text) return `Row ${index + 1}: missing Feedback_Text`
  if (!row.Student_Text) return `Row ${index + 1}: missing Student_Text`

  // Feedback_Source is the one column the study is blind to and the export
  // later reveals as fact, so it is required: a blank (or a header the alias
  // table does not recognise) must fail here, never default to AI.
  if (!row.Feedback_Source) {
    return `Row ${index + 1}: missing Feedback_Source (must be "AI" or "HUMAN")`
  }
  if (normalizeFeedbackSource(row.Feedback_Source) === null) {
    return `Row ${index + 1}: Feedback_Source must be "AI" or "HUMAN", got "${row.Feedback_Source}"`
  }

  return null
}

export type NormalizedFeedbackSource = 'AI' | 'HUMAN'

/** Case-insensitive AI/HUMAN parse; null for anything else (incl. blank). */
export function normalizeFeedbackSource(
  value: unknown
): NormalizedFeedbackSource | null {
  if (typeof value !== 'string') return null
  const upper = value.trim().toUpperCase()
  return upper === 'AI' || upper === 'HUMAN' ? upper : null
}

/**
 * In-file duplicate Feedback_IDs. Within one project Feedback_ID is the unique
 * key, so a file that repeats one can only import one of the rows — rather than
 * silently keeping the first, surface it so the researcher fixes the file.
 * Returns one message per duplicated id, naming every 1-based row it occurs on.
 */
export function findDuplicateFeedbackIds(rows: { Feedback_ID: string }[]): string[] {
  const rowsById = new Map<string, number[]>()
  rows.forEach((row, index) => {
    const id = row.Feedback_ID?.trim()
    if (!id) return
    const list = rowsById.get(id) ?? []
    list.push(index + 1)
    rowsById.set(id, list)
  })
  return [...rowsById.entries()]
    .filter(([, rowNumbers]) => rowNumbers.length > 1)
    .map(
      ([id, rowNumbers]) =>
        `Feedback_ID "${id}" appears ${rowNumbers.length} times (rows ${rowNumbers.join(', ')})`
    )
}
