import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import {
  buildDiscrepancyFilename,
  buildExportFilename,
  parseExportKind,
  toCsv,
} from '@/lib/export'
import {
  buildDiscrepancyCsv,
  buildExportCsv,
  getProjectDimensions,
  parseDiscrepancyScope,
  parseExportScope,
  resolveDiscrepancyBatches,
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

  const today = new Date().toISOString().split('T')[0]

  // The discrepancy report has its own shape and its own (batch) scope.
  if (kind === 'discrepancies') {
    const scope = parseDiscrepancyScope(params, projectId)
    if (!scope) {
      return NextResponse.json(
        {
          error:
            'discrepancy export needs batchId or batches=all-double-scored',
        },
        { status: 400 }
      )
    }

    const batches = await resolveDiscrepancyBatches(scope)
    if (scope.kind === 'batch' && batches.length === 0) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
    }

    const { header, rows } = await buildDiscrepancyCsv(
      projectId,
      batches.map((b) => b.id)
    )
    const filename = buildDiscrepancyFilename(
      scope.kind === 'batch'
        ? { kind: 'batch', batchName: batches[0].name }
        : {
            kind: 'all-double-scored',
            completeBatchesOnly: scope.completeBatchesOnly,
          },
      today
    )
    return csvResponse(toCsv(header, rows), filename)
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

  return csvResponse(
    toCsv(header, rows),
    buildExportFilename(kind, scope, today)
  )
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
