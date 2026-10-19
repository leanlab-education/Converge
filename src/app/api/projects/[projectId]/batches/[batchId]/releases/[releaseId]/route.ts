import { auth } from '@/lib/auth'
import { canAdminProject } from '@/lib/authorization'
import { prisma } from '@/lib/db'
import { assertProjectMembers } from '@/lib/project-scope'
import {
  syncBatchAssignmentsForRelease,
  syncBatchStatus,
} from '@/lib/team-batch-releases'
import { NextRequest, NextResponse } from 'next/server'

async function getReleaseContext(releaseId: string) {
  return prisma.teamBatchRelease.findUnique({
    where: { id: releaseId },
    include: {
      batch: {
        select: {
          id: true,
          projectId: true,
          type: true,
          isDoubleScored: true,
          status: true,
        },
      },
      team: {
        include: {
          members: {
            select: { userId: true },
          },
          dimensions: {
            select: { dimensionId: true },
          },
        },
      },
    },
  })
}

async function hasReleaseScores(releaseId: string) {
  const release = await getReleaseContext(releaseId)
  if (!release) return false

  const teamUserIds = release.team.members.map((member) => member.userId)
  const dimensionIds =
    release.batch.type === 'TRAINING'
      ? (
          await prisma.rubricDimension.findMany({
            where: { projectId: release.batch.projectId },
            select: { id: true },
          })
        ).map((dimension) => dimension.id)
      : release.team.dimensions.map((dimension) => dimension.dimensionId)

  const scoreCount = await prisma.score.count({
    where: {
      feedbackItem: { batchId: release.batchId },
      userId: { in: teamUserIds },
      dimensionId: { in: dimensionIds },
      isReconciled: false,
    },
  })

  return scoreCount > 0
}

export async function PATCH(
  request: NextRequest,
  {
    params,
  }: {
    params: Promise<{ projectId: string; batchId: string; releaseId: string }>
  }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { projectId, batchId, releaseId } = await params

  if (!(await canAdminProject(session.user.id, session.user.role, projectId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const body = await request.json()
  const { isVisible, scorerUserId, adjudicatorId } = body as {
    isVisible?: boolean
    scorerUserId?: string | null
    adjudicatorId?: string | null
  }

  const release = await getReleaseContext(releaseId)
  if (
    !release ||
    release.batch.projectId !== projectId ||
    release.batchId !== batchId
  ) {
    return NextResponse.json({ error: 'Release not found' }, { status: 404 })
  }

  // COMPLETE only means every discrepancy was resolved — the batch is not
  // frozen (see CLAUDE.md "Batch lock & editable reconciliation"). A pair can
  // still revisit a final while the batch is unlocked, and escalating from
  // there needs an adjudicator (escalate/route.ts accepts COMPLETE releases),
  // so the adjudicator stays editable. Visibility and the scoring assignment
  // are what define a finished release and stay frozen.
  if (
    release.status === 'COMPLETE' &&
    (isVisible !== undefined || scorerUserId !== undefined)
  ) {
    return NextResponse.json(
      {
        error:
          'Cannot change the visibility or scoring assignment of a completed release',
      },
      { status: 400 }
    )
  }

  if (
    release.batch.type === 'REGULAR' &&
    !release.batch.isDoubleScored &&
    scorerUserId !== undefined
  ) {
    // null = split 50/50 between the pair; a userId = single named scorer who
    // must be a member of this team.
    if (scorerUserId) {
      const belongsToTeam = release.team.members.some(
        (member) => member.userId === scorerUserId
      )
      if (!belongsToTeam) {
        return NextResponse.json(
          { error: 'Selected scorer must be a member of this team' },
          { status: 400 }
        )
      }
    }

    if (scorerUserId !== release.scorerUserId && (await hasReleaseScores(releaseId))) {
      return NextResponse.json(
        { error: 'Cannot change the scoring assignment after scoring has begun for this team' },
        { status: 400 }
      )
    }
  }

  // Adjudicator is the per-team/criterion tiebreaker for escalated discrepancies.
  // Only meaningful for double-scored regular batches, but any project user may
  // serve (Amber/Rachel or a peer annotator like Riley) — Amber 2026-06-18.
  if (adjudicatorId !== undefined && adjudicatorId !== null) {
    // Must be on THIS project (audit H-A2) — the Batches tab only offers
    // project annotators, and an outsider could not open the adjudicate view.
    const adjudicatorScope = await assertProjectMembers(projectId, [adjudicatorId])
    if (!adjudicatorScope.ok) {
      return NextResponse.json(
        { error: 'The adjudicator must be an annotator on this project' },
        { status: 400 }
      )
    }
    // The adjudicator is the tiebreaker for THIS pair's escalations — a member
    // of the pair adjudicating their own disputes would let them escalate and
    // then self-resolve to their own score, bypassing the concede-or-escalate
    // rule. Peer annotators from other teams remain allowed (Amber 2026-06-18).
    // (Fable review, 2026-08-11)
    if (release.team.members.some((member) => member.userId === adjudicatorId)) {
      return NextResponse.json(
        { error: 'The adjudicator cannot be a member of the team they adjudicate' },
        { status: 400 }
      )
    }
  }

  const updated = await prisma.teamBatchRelease.update({
    where: { id: releaseId },
    data: {
      ...(isVisible !== undefined
        ? {
            isVisible,
            ...(isVisible && release.status === 'DRAFT'
              ? { status: 'SCORING' }
              : {}),
          }
        : {}),
      ...(adjudicatorId !== undefined ? { adjudicatorId } : {}),
      ...(release.batch.type === 'TRAINING' || release.batch.isDoubleScored
        ? {}
        : scorerUserId !== undefined
          ? { scorerUserId }
          : {}),
    },
  })

  // The adjudicator is not an assignee and does not affect release status, so
  // an adjudicator-only change (the one edit allowed on a COMPLETE release)
  // leaves assignments and batch status alone.
  if (isVisible !== undefined || scorerUserId !== undefined) {
    await syncBatchAssignmentsForRelease(releaseId)
    await syncBatchStatus(batchId)
  }

  return NextResponse.json(updated)
}

export async function DELETE(
  _request: Request,
  {
    params,
  }: {
    params: Promise<{ projectId: string; batchId: string; releaseId: string }>
  }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { projectId, batchId, releaseId } = await params

  if (!(await canAdminProject(session.user.id, session.user.role, projectId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const release = await getReleaseContext(releaseId)
  if (
    !release ||
    release.batch.projectId !== projectId ||
    release.batchId !== batchId
  ) {
    return NextResponse.json({ error: 'Release not found' }, { status: 404 })
  }

  if (await hasReleaseScores(releaseId)) {
    return NextResponse.json(
      { error: 'Cannot remove a team release after scoring has begun' },
      { status: 400 }
    )
  }

  await prisma.$transaction(async (tx) => {
    await tx.batchAssignment.deleteMany({
      where: { teamReleaseId: releaseId },
    })
    await tx.teamBatchRelease.delete({
      where: { id: releaseId },
    })
  })

  await syncBatchStatus(batchId)

  return NextResponse.json({ success: true })
}
