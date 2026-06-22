import { CheckCircle, AlertTriangle, type LucideIcon } from 'lucide-react'

// ---------------------------------------------------------------------------
// Quill "optimal" ground-truth indicator
// ---------------------------------------------------------------------------
// `FeedbackItem.optimal` is Quill's system flag for whether a student response
// already meets the goal (i.e. whether it needed revision). It is the ground
// truth for exactly ONE rubric criterion: "Appropriate Feedback Decision".
//
// Per Amber (2026-06-22): the indicator must only be shown to annotators /
// adjudicators who are actually working that criterion — NOT to teams scoring
// other criteria, since the revision decision would bias their judgments. It
// must appear during scoring, reconciliation, AND adjudication for that
// criterion. This module centralizes both the gate and the badge styling so
// every surface stays consistent.

// The criterion key is kept stable across rubric edits (see rubric-templates),
// so it's the most reliable anchor; the label is matched as a fallback in case
// a project keys it differently.
export const APPROPRIATE_FEEDBACK_DECISION_KEY = 'criterion_1'
export const APPROPRIATE_FEEDBACK_DECISION_LABEL = 'Appropriate Feedback Decision'

export function isAppropriateFeedbackDecision(dim: {
  key?: string | null
  label?: string | null
}): boolean {
  return (
    dim.key === APPROPRIATE_FEEDBACK_DECISION_KEY ||
    dim.label?.trim().toLowerCase() ===
      APPROPRIATE_FEEDBACK_DECISION_LABEL.toLowerCase()
  )
}

export interface OptimalFlag {
  label: string
  className: string
  Icon: LucideIcon
}

// Raw values: "1" = meets the goal (no revision needed), "0" = needs revision,
// null/anything else = no flag available (render nothing).
export function getOptimalFlag(
  optimal: string | null | undefined
): OptimalFlag | null {
  if (optimal === '1') {
    return {
      label: 'Quill flag: no revision needed',
      className:
        'bg-score-high-bg text-score-high-text border-score-high-border',
      Icon: CheckCircle,
    }
  }
  if (optimal === '0') {
    return {
      label: 'Quill flag: needs revision',
      className: 'bg-score-mid-bg text-score-mid-text border-score-mid-border',
      Icon: AlertTriangle,
    }
  }
  return null
}
