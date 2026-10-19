import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { Prisma } from '@/generated/prisma/client'
import { NextRequest, NextResponse } from 'next/server'

function pluralize(count: number, singular: string, plural: string) {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : plural}`
}

function joinWithAnd(parts: string[]) {
  if (parts.length <= 1) return parts.join('')
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const session = await auth()
  if (!session?.user || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { userId } = await params
  const { role } = await request.json()

  if (role !== 'ADMIN' && role !== 'EVALUATOR') {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
  }

  if (userId === session.user.id) {
    return NextResponse.json(
      { error: 'Cannot change your own role' },
      { status: 400 }
    )
  }

  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { role },
    select: { id: true, email: true, role: true },
  })

  return NextResponse.json(updated)
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const session = await auth()
  if (!session?.user || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { userId } = await params

  if (userId === session.user.id) {
    return NextResponse.json(
      { error: 'Cannot delete your own account' },
      { status: 400 }
    )
  }

  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // Score rows are paid, irreplaceable annotation data, and reconciled finals
  // are stored under the release owner's userId (team.members[0]), so deleting
  // one annotator can take the whole pair's finals with them. Escalations and
  // criterion re-opens are the audit trail around those finals. Refuse while
  // any of it exists; removing the person from their projects is the supported
  // way to retire an account. The schema's Restrict on Score.user and
  // Escalation.escalatedBy backs this up at the database. (docs/DATA-RESILIENCE.md)
  const [scoreCount, escalationCount, unlockCount] = await Promise.all([
    prisma.score.count({ where: { userId } }),
    prisma.escalation.count({ where: { escalatedById: userId } }),
    prisma.releaseCriterionUnlock.count({ where: { openedById: userId } }),
  ])

  if (scoreCount > 0 || escalationCount > 0 || unlockCount > 0) {
    const footprint: string[] = []
    if (scoreCount > 0) footprint.push(pluralize(scoreCount, 'score', 'scores'))
    if (escalationCount > 0) {
      footprint.push(pluralize(escalationCount, 'escalation', 'escalations'))
    }
    if (unlockCount > 0) {
      footprint.push(pluralize(unlockCount, 'criterion re-open', 'criterion re-opens'))
    }
    return NextResponse.json(
      {
        error: `This account has ${joinWithAnd(footprint)}. Deleting it would destroy annotation data. Remove them from projects instead.`,
      },
      { status: 409 }
    )
  }

  try {
    await prisma.user.delete({ where: { id: userId } })
  } catch (err) {
    // P2003: a Restrict FK (Score.user / Escalation.escalatedBy) refused the
    // delete — a score landed between the counts above and the delete.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2003'
    ) {
      return NextResponse.json(
        {
          error:
            'This account has annotation data attached and cannot be deleted. Remove them from projects instead.',
        },
        { status: 409 }
      )
    }
    throw err
  }

  return NextResponse.json({ success: true })
}
