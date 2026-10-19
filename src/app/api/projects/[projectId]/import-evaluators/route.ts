import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import { prisma } from '@/lib/db'
import { normalizeEmail, parseEmail } from '@/lib/email-address'
import { fetchStudyFlowParticipants } from '@/lib/studyflow-client'
import { NextRequest, NextResponse } from 'next/server'

// GET: fetch participants from StudyFlow for preview
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { projectId } = await params

  if (!(await canAdminProject(session.user.id, session.user.role, projectId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { studyflowStudyId: true },
  })

  if (!project?.studyflowStudyId) {
    return NextResponse.json(
      { error: 'No StudyFlow study linked to this project' },
      { status: 400 }
    )
  }

  try {
    const participants = await fetchStudyFlowParticipants(project.studyflowStudyId)

    // Check which emails already exist as evaluators on this project. Stored
    // addresses are lowercased; StudyFlow's may not be.
    const existingEvaluators = await prisma.projectEvaluator.findMany({
      where: { projectId },
      include: { user: { select: { email: true } } },
    })
    const existingEmails = new Set(existingEvaluators.map((e) => e.user.email))

    const result = participants.map((p) => ({
      ...p,
      alreadyImported:
        typeof p.email === 'string' && existingEmails.has(normalizeEmail(p.email)),
    }))

    return NextResponse.json(result)
  } catch (err) {
    // The upstream error carries StudyFlow's raw response body (and, on a
    // misconfiguration, the names of our own env vars). That belongs in the
    // server log, not in the browser.
    console.error('[import-evaluators] failed to fetch StudyFlow participants', {
      projectId,
      error: err,
    })
    return NextResponse.json(
      { error: 'Could not fetch participants from StudyFlow. Please try again in a few minutes.' },
      { status: 502 }
    )
  }
}

function participantName(p: Record<string, unknown>): string | null {
  const parts = [p.firstName, p.lastName]
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .map((v) => v.trim())
  return parts.length > 0 ? parts.join(' ') : null
}

// Human-readable label for a rejected row, so the admin can find it in the
// StudyFlow roster.
function describeParticipant(p: Record<string, unknown>, index: number): string {
  const label =
    participantName(p) ?? (typeof p.id === 'string' && p.id ? p.id : `row ${index + 1}`)
  const rawEmail = typeof p.email === 'string' ? p.email.trim() : ''
  return rawEmail ? `${label} ("${rawEmail}")` : `${label} (no email)`
}

// POST: import selected participants as evaluators
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { projectId } = await params

  if (!(await canAdminProject(session.user.id, session.user.role, projectId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const participants: unknown = body?.participants

  if (!Array.isArray(participants) || participants.length === 0) {
    return NextResponse.json({ error: 'No participants selected' }, { status: 400 })
  }

  // The body is whatever the browser sent back from the preview, so validate
  // every row before writing anything: one participant without an email must
  // not leave the import half-applied.
  const rows: { email: string; name: string | null }[] = []
  const invalid: string[] = []
  participants.forEach((raw, index) => {
    const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const email = parseEmail(p.email)
    if (!email) {
      invalid.push(describeParticipant(p, index))
      return
    }
    rows.push({ email, name: participantName(p) })
  })

  if (invalid.length > 0) {
    return NextResponse.json(
      {
        error: `${invalid.length} selected participant(s) have no valid email address, so nothing was imported: ${invalid.join(', ')}`,
      },
      { status: 400 }
    )
  }

  for (const { email, name } of rows) {
    // Find or create user (no password — they'll use StudyFlow magic link)
    let user = await prisma.user.findUnique({ where: { email } })
    if (!user) {
      user = await prisma.user.create({
        data: { email, name, role: 'EVALUATOR' },
      })
    }

    // Assign to project (skip if already assigned)
    await prisma.projectEvaluator.upsert({
      where: { projectId_userId: { projectId, userId: user.id } },
      create: { projectId, userId: user.id },
      update: {},
    })
  }

  return NextResponse.json(
    { imported: rows.length, total: participants.length },
    { status: 201 }
  )
}
