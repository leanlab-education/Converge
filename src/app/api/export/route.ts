import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { canAdminProject } from '@/lib/authorization'
import { buildExportFilename, csvEscape, parseExportKind, toCsv } from '@/lib/export'
import {
  buildExportCsv,
  getProjectDimensions,
  parseExportScope,
} from '@/lib/export-query'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const params = request.nextUrl.searchParams
  const projectId = params.get('projectId')
  const kind = parseExportKind(params.get('type'))

  if (!projectId) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
  }

  if (!(await canAdminProject(session.user.id, session.user.role, projectId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (!kind) {
    return NextResponse.json(
      {
        error:
          'type must be "raw-by-scorer", "final-by-scorer", "final-by-item", or "discrepancies"',
      },
      { status: 400 }
    )
  }

  // The discrepancy report is batch-scoped and has its own shape.
  if (kind === 'discrepancies') {
    const batchId = params.get('batchId')
    if (!batchId) {
      return NextResponse.json(
        { error: 'batchId is required for discrepancy export' },
        { status: 400 }
      )
    }
    return handleDiscrepancyExport(projectId, batchId)
  }

  const { dimensionKeys, dimensionLabels } =
    await getProjectDimensions(projectId)

  if (dimensionKeys.length === 0) {
    return NextResponse.json(
      { error: 'No rubric dimensions found for this project' },
      { status: 404 }
    )
  }

  const scope = parseExportScope(params, projectId)
  const { header, rows } = await buildExportCsv(
    kind,
    scope,
    dimensionKeys,
    dimensionLabels
  )

  const filename = buildExportFilename(
    kind,
    scope,
    new Date().toISOString().split('T')[0]
  )

  return csvResponse(toCsv(header, rows), filename)
}

function csvResponse(csv: string, filename: string) {
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}

// ---------------------------------------------------------------------------
// Discrepancy report (behaviour unchanged)
// ---------------------------------------------------------------------------

async function handleDiscrepancyExport(projectId: string, batchId: string) {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    select: { name: true, projectId: true },
  })

  if (!batch || batch.projectId !== projectId) {
    return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
  }

  // Fetch all original scores for this batch. Notes are per-item (same
  // value repeated across every dimension row for an item/user pair), so
  // we collapse to first non-empty per (item, user).
  const scores = await prisma.score.findMany({
    where: {
      feedbackItem: { batchId },
      isReconciled: false,
    },
    include: {
      feedbackItem: {
        select: {
          responseId: true,
          studentId: true,
          activityId: true,
          conjunctionId: true,
          feedbackId: true,
        },
      },
      user: { select: { id: true, email: true } },
      dimension: { select: { key: true, label: true } },
    },
  })

  // (feedbackItemId, userId) -> coder's original notes
  const notesByItemUser = new Map<string, string>()
  for (const score of scores) {
    const key = `${score.feedbackItemId}::${score.userId}`
    if (score.notes && score.notes.trim() && !notesByItemUser.has(key)) {
      notesByItemUser.set(key, score.notes)
    }
  }

  // Reconciliation notes live on isReconciled Score rows. The reconcile
  // API writes the same rationale to every reconciled dimension row for
  // an item, so we collapse to one rationale per item.
  const reconciledScores = await prisma.score.findMany({
    where: {
      feedbackItem: { batchId },
      isReconciled: true,
    },
    select: { feedbackItemId: true, notes: true },
  })
  const reconciliationNotesByItem = new Map<string, string>()
  for (const r of reconciledScores) {
    if (
      r.notes &&
      r.notes.trim() &&
      !reconciliationNotesByItem.has(r.feedbackItemId)
    ) {
      reconciliationNotesByItem.set(r.feedbackItemId, r.notes)
    }
  }

  // Group by (feedbackItemId, dimensionId) and find discrepancies
  const groups = new Map<
    string,
    {
      feedbackItemId: string
      feedbackItem: (typeof scores)[0]['feedbackItem']
      dimension: (typeof scores)[0]['dimension']
      evaluators: { userId: string; email: string; value: number }[]
    }
  >()

  for (const score of scores) {
    const key = `${score.feedbackItemId}::${score.dimensionId}`
    if (!groups.has(key)) {
      groups.set(key, {
        feedbackItemId: score.feedbackItemId,
        feedbackItem: score.feedbackItem,
        dimension: score.dimension,
        evaluators: [],
      })
    }
    groups.get(key)!.evaluators.push({
      userId: score.user.id,
      email: score.user.email,
      value: score.value,
    })
  }

  const headerRow = [
    'Response_ID',
    'Student_ID',
    'Activity_ID',
    'Conjunction_ID',
    'Feedback_ID',
    'Dimension_Key',
    'Dimension_Label',
    'Evaluator_A_Email',
    'Evaluator_A_Score',
    'Evaluator_A_Notes',
    'Evaluator_B_Email',
    'Evaluator_B_Score',
    'Evaluator_B_Notes',
    'Reconciliation_Notes',
    'Difference',
  ]

  const csvRows: string[][] = []

  for (const [, group] of groups) {
    const evals = group.evaluators
    if (evals.length !== 2) continue
    if (evals[0].value === evals[1].value) continue

    const notesA =
      notesByItemUser.get(`${group.feedbackItemId}::${evals[0].userId}`) || ''
    const notesB =
      notesByItemUser.get(`${group.feedbackItemId}::${evals[1].userId}`) || ''
    const reconciliationNotes =
      reconciliationNotesByItem.get(group.feedbackItemId) || ''

    csvRows.push([
      csvEscape(group.feedbackItem.responseId || ''),
      csvEscape(group.feedbackItem.studentId),
      csvEscape(group.feedbackItem.activityId || ''),
      csvEscape(group.feedbackItem.conjunctionId || ''),
      csvEscape(group.feedbackItem.feedbackId),
      csvEscape(group.dimension.key),
      csvEscape(group.dimension.label),
      csvEscape(evals[0].email),
      String(evals[0].value),
      csvEscape(notesA),
      csvEscape(evals[1].email),
      String(evals[1].value),
      csvEscape(notesB),
      csvEscape(reconciliationNotes),
      String(Math.abs(evals[0].value - evals[1].value)),
    ])
  }

  const safeBatchName = (batch.name || 'batch').replace(/[^a-zA-Z0-9_-]/g, '-')
  const filename = `discrepancies-${safeBatchName}-${new Date().toISOString().split('T')[0]}.csv`

  return csvResponse(toCsv(headerRow, csvRows), filename)
}
