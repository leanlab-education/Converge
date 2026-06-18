'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Upload, ArrowLeft, CheckCircle, Loader2, FileText } from 'lucide-react'
import { parseCSV, validateCSVRow, type FeedbackCSVRow } from '@/lib/csv-parser'
import { AppShell } from '@/components/app-shell'

export function ImportClient({ projectId }: { projectId: string }) {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [rows, setRows] = useState<FeedbackCSVRow[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [fileName, setFileName] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{
    importId: string
    imported: number
    skipped: number
    total: number
  } | null>(null)
  const [importError, setImportError] = useState('')
  const [dragOver, setDragOver] = useState(false)

  function processFile(file: File) {
    setImportResult(null)
    setImportError('')

    // Reject files larger than 10MB to prevent client-side memory issues
    const MAX_CSV_SIZE = 10 * 1024 * 1024
    if (file.size > MAX_CSV_SIZE) {
      setErrors(['File too large. Maximum size is 10MB.'])
      return
    }

    setFileName(file.name)

    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target?.result as string
      const parsed = parseCSV(text)

      const validationErrors: string[] = []
      parsed.forEach((row, i) => {
        const err = validateCSVRow(row, i)
        if (err) validationErrors.push(err)
      })

      setRows(parsed)
      setErrors(validationErrors)
    }
    reader.readAsText(file)
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) processFile(file)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file && file.name.endsWith('.csv')) {
      processFile(file)
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
  }

  async function handleImport() {
    if (rows.length === 0 || errors.length > 0) return
    setImporting(true)
    setImportError('')

    try {
      const res = await fetch('/api/feedback-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          filename: fileName,
          items: rows.map((row) => ({
            responseId: row.Response_ID || null,
            cycleId: row.Cycle_ID || null,
            studentId: row.Student_ID,
            activityId: row.Activity_ID || null,
            conjunctionId: row.Conjunction_ID || null,
            studentText: row.Student_Text,
            feedbackId: row.Feedback_ID,
            teacherId: row.Teacher_ID || null,
            feedbackText: row.Feedback_Text,
            feedbackSource: row.Feedback_Source || 'AI',
            optimal: row.optimal || null,
            feedbackType: row.feedback_type || null,
          })),
        }),
      })

      if (res.ok) {
        const data = await res.json()
        setImportResult(data)
      } else {
        const err = await res.json()
        setImportError(err.error || 'Import failed')
      }
    } catch (err) {
      console.error('Import failed:', err)
      setImportError('Something went wrong during import')
    } finally {
      setImporting(false)
    }
  }

  const previewRows = rows.slice(0, 5)

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-6">
          <Button
            variant="ghost"
            size="sm"
            className="mb-2"
            onClick={() => router.push(`/admin/${projectId}`)}
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back to Project
          </Button>
          <h1 className="text-2xl font-bold tracking-tight">Import CSV Data</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload a CSV file with feedback items for evaluation.
          </p>
        </div>

        {/* Success state */}
        {importResult && (
          <Card className="mb-6">
            <CardContent className="py-8 text-center">
              <CheckCircle className="mx-auto h-12 w-12 text-success" />
              <h3 className="mt-4 text-lg font-medium">Import Complete</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">
                  {importResult.imported}
                </span>{' '}
                new items imported
                {importResult.skipped > 0 && (
                  <>
                    ,{' '}
                    <span className="font-medium text-foreground">
                      {importResult.skipped}
                    </span>{' '}
                    skipped as duplicates (Feedback_ID already existed in this
                    project)
                  </>
                )}
                .
              </p>
              <div className="mt-4 flex justify-center gap-3">
                <Button
                  variant="outline"
                  onClick={() => router.push(`/admin/${projectId}`)}
                >
                  Back to Project
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setRows([])
                    setErrors([])
                    setFileName('')
                    setImportResult(null)
                  }}
                >
                  Import More
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Upload area */}
        {!importResult && (
          <>
            <div
              className={`mb-6 cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition-all duration-200 ${
                dragOver
                  ? 'scale-[1.01] border-primary bg-primary/5 ring-2 ring-primary/20'
                  : 'border-muted-foreground/25 hover:border-muted-foreground/50'
              }`}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={handleFileChange}
              />
              <Upload className="mx-auto h-10 w-10 text-muted-foreground/50" />
              <p className="mt-3 text-sm font-medium">
                {fileName
                  ? `Selected: ${fileName}`
                  : 'Drop a CSV file here or click to browse'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Expected columns: Response_ID, Student_ID, Cycle_ID,
                Activity_ID, Conjunction_ID, Student_Text, Feedback_Source,
                Teacher_ID, Feedback_Text, optimal, feedback_type, Feedback_ID
              </p>
            </div>

            {/* Validation errors */}
            {errors.length > 0 && (
              <Alert variant="destructive" className="mb-6">
                <AlertDescription>
                  <p className="mb-2 font-medium">
                    {errors.length} validation error{errors.length > 1 ? 's' : ''}
                    found:
                  </p>
                  <ul className="list-inside list-disc space-y-1">
                    {errors.slice(0, 10).map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                    {errors.length > 10 && (
                      <li>...and {errors.length - 10} more</li>
                    )}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {/* Import error */}
            {importError && (
              <Alert variant="destructive" className="mb-6">
                <AlertDescription>{importError}</AlertDescription>
              </Alert>
            )}

            {/* Preview table */}
            {rows.length > 0 && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">
                      Preview ({rows.length} total rows)
                    </span>
                  </div>
                  <Button
                    onClick={handleImport}
                    disabled={importing || errors.length > 0}
                  >
                    {importing ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Importing...
                      </>
                    ) : (
                      <>
                        <Upload className="mr-2 h-4 w-4" />
                        Import {rows.length} items
                      </>
                    )}
                  </Button>
                </div>

                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12">#</TableHead>
                        <TableHead>Response_ID</TableHead>
                        <TableHead>Activity_ID</TableHead>
                        <TableHead>Conjunction_ID</TableHead>
                        <TableHead>Feedback_Source</TableHead>
                        <TableHead className="max-w-[200px]">
                          Student_Text
                        </TableHead>
                        <TableHead className="max-w-[200px]">
                          Feedback_Text
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {previewRows.map((row, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-muted-foreground">
                            {i + 1}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {row.Response_ID}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {row.Activity_ID}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {row.Conjunction_ID}
                          </TableCell>
                          <TableCell>{row.Feedback_Source}</TableCell>
                          <TableCell className="max-w-[200px] truncate">
                            {row.Student_Text}
                          </TableCell>
                          <TableCell className="max-w-[200px] truncate">
                            {row.Feedback_Text}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {rows.length > 5 && (
                  <p className="text-center text-xs text-muted-foreground">
                    Showing first 5 of {rows.length} rows
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  )
}
