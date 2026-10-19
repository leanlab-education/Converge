// What an annotator's batch card says and does, derived from the release's
// server-side status PLUS the annotator's own completion — never from the
// scored count alone. A release stays SCORING until every member has scored
// everything, so "I'm done" and "the batch is done" are different facts and
// the card must show both (Batch 65: Jonathan saw "Complete" while the batch
// was still waiting on Luofan's last criterion; Amber 2026-10-19).

export interface AnnotatorBatchProgress {
  // TeamBatchRelease.status (or Batch.status for a teamless assignment).
  status: string
  itemCount: number
  // Items this annotator has scored on EVERY criterion they owe.
  scoredCount: number
  // Double-scored or training: a partner must finish too before the release
  // moves on, so a finished annotator is "waiting on partner", not "scored".
  isPaired: boolean
}

export type AnnotatorBatchPhase =
  // Release not SCORING yet (draft / hidden). Nothing to do.
  | 'not-open'
  // Release SCORING and this annotator still has items to score.
  | 'scoring'
  // Release SCORING but this annotator's own share is fully scored — the
  // release is waiting on someone else. They can still get back in.
  | 'scored'
  | 'reconciling'
  | 'complete'

export function isOwnScoringComplete(b: Pick<AnnotatorBatchProgress, 'itemCount' | 'scoredCount'>): boolean {
  return b.itemCount > 0 && b.scoredCount >= b.itemCount
}

export function getAnnotatorBatchPhase(b: AnnotatorBatchProgress): AnnotatorBatchPhase {
  switch (b.status) {
    case 'SCORING':
      return isOwnScoringComplete(b) ? 'scored' : 'scoring'
    case 'RECONCILING':
      return 'reconciling'
    case 'COMPLETE':
      return 'complete'
    default:
      return 'not-open'
  }
}

export type AnnotatorBatchTone = 'active' | 'waiting' | 'reconciliation' | 'complete' | 'muted'

export interface AnnotatorBatchBadge {
  label: string
  tone: AnnotatorBatchTone
}

export function getAnnotatorBatchBadge(b: AnnotatorBatchProgress): AnnotatorBatchBadge {
  switch (getAnnotatorBatchPhase(b)) {
    case 'scoring':
      return { label: 'Open', tone: 'active' }
    case 'scored':
      return b.isPaired
        ? { label: 'Waiting on partner', tone: 'waiting' }
        : { label: 'Scored', tone: 'waiting' }
    case 'reconciling':
      return { label: 'Reconciling', tone: 'reconciliation' }
    case 'complete':
      return { label: 'Complete', tone: 'complete' }
    case 'not-open':
      return { label: 'Not Open', tone: 'muted' }
  }
}

export type AnnotatorBatchAction = 'score' | 'reconcile' | 'none'

export interface AnnotatorBatchButton {
  label: string
  variant: 'default' | 'outline'
  disabled: boolean
  action: AnnotatorBatchAction
}

// A SCORING release always gets an enabled button: Start/Continue while there
// is work left, Review once the annotator's own share is done.
export function getAnnotatorBatchButton(b: AnnotatorBatchProgress): AnnotatorBatchButton {
  switch (getAnnotatorBatchPhase(b)) {
    case 'scoring':
      return {
        label: b.scoredCount > 0 ? 'Continue' : 'Start',
        variant: 'default',
        disabled: false,
        action: 'score',
      }
    case 'scored':
      return { label: 'Review', variant: 'outline', disabled: false, action: 'score' }
    case 'reconciling':
      return { label: 'Reconcile', variant: 'default', disabled: false, action: 'reconcile' }
    case 'complete':
      return { label: 'Done', variant: 'outline', disabled: true, action: 'none' }
    case 'not-open':
      return { label: 'Not Open', variant: 'outline', disabled: true, action: 'none' }
  }
}

// "To do" on the Scoring list means this annotator still has scoring to do
// (or the batch hasn't opened yet). Once their share is scored the batch moves
// to "Completed" even while the release waits on a partner, reconciles, or is
// done.
export function isAnnotatorScoringTodo(b: AnnotatorBatchProgress): boolean {
  const phase = getAnnotatorBatchPhase(b)
  return phase === 'scoring' || phase === 'not-open'
}
