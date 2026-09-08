// Row count for the current export selection, so the Export tab can tell the
// admin what the file will contain before they download it.

import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import {
  discrepancyHeader,
  isItemGrain,
  itemGrainHeader,
  parseExportKind,
  scorerGrainHeader,
} from '@/lib/export'
import {
  countDiscrepancyRows,
  countExportRows,
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
    return NextResponse.json({ error: 'Unknown export type' }, { status: 400 })
  }

  if (kind === 'discrepancies') {
    const scope = parseDiscrepancyScope(params, projectId)
    if (!scope) {
      return NextResponse.json(
        { error: 'discrepancy export needs batchId or batches=all-double-scored' },
        { status: 400 }
      )
    }
    const batches = await resolveDiscrepancyBatches(scope)
    if (scope.kind === 'batch' && batches.length === 0) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
    }
    const rowCount = await countDiscrepancyRows(
      projectId,
      batches.map((b) => b.id)
    )
    return NextResponse.json({
      rowCount,
      columnCount: discrepancyHeader().length,
      batchCount: batches.length,
    })
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
  const rowCount = await countExportRows(kind, scope, dimensionKeys)

  // Derived from the same header builders the download route uses, so the
  // count can't drift from the file.
  const header = isItemGrain(kind)
    ? itemGrainHeader(dimensionLabels)
    : scorerGrainHeader(dimensionLabels)

  return NextResponse.json({ rowCount, columnCount: header.length })
}
