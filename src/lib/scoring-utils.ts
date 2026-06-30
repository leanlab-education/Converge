/**
 * Shared scoring utilities used by both the evaluate and reconcile UIs.
 */

/**
 * Build a windowed list of page indices for item navigation.
 * Returns numbers and '...' ellipsis markers for collapsed ranges.
 */
export function buildNavWindow(
  current: number,
  total: number,
  wing: number
): (number | '...')[] {
  if (total <= wing * 2 + 3) {
    return Array.from({ length: total }, (_, i) => i)
  }
  const result: (number | '...')[] = []
  const start = Math.max(1, current - wing)
  const end = Math.min(total - 2, current + wing)

  result.push(0)
  if (start > 1) result.push('...')
  for (let i = start; i <= end; i++) result.push(i)
  if (end < total - 2) result.push('...')
  result.push(total - 1)

  return result
}

/**
 * Neutral styling for an UNSELECTED selectable score option. The score's
 * color (green/red) only appears once chosen (getSelectedScoreColor) — this
 * keeps the option row quiet by default and makes the picked answer pop,
 * reducing mis-clicks. (Luofan/Amber, 2026-06-25.)
 *
 * Note: this is for the clickable option buttons only. The read-only chips that
 * show what each annotator already scored (the reconcile/adjudicate comparison)
 * still use getScoreColor so disagreements stay visible at a glance.
 */
export function getUnselectedOptionColor(): string {
  return 'border-border bg-background text-foreground hover:bg-muted hover:border-foreground/30'
}

/** Unselected score button colors based on value ratio within scale. */
export function getScoreColor(value: number, min: number, max: number): string {
  if (max === min)
    return 'border-score-mid-border bg-score-mid-bg text-score-mid-text'
  const ratio = (value - min) / (max - min)
  if (ratio <= 0.25)
    return 'border-score-low-border bg-score-low-bg text-score-low-text'
  if (ratio < 0.75)
    return 'border-score-mid-border bg-score-mid-bg text-score-mid-text'
  return 'border-score-high-border bg-score-high-bg text-score-high-text'
}

/** Selected (active) score button colors based on value ratio within scale. */
export function getSelectedScoreColor(
  value: number,
  min: number,
  max: number
): string {
  if (max === min)
    return 'bg-score-mid-solid text-white border-score-mid-solid'
  const ratio = (value - min) / (max - min)
  if (ratio <= 0.25)
    return 'bg-score-low-solid text-white border-score-low-solid'
  if (ratio < 0.75)
    return 'bg-score-mid-solid text-white border-score-mid-solid'
  return 'bg-score-high-solid text-white border-score-high-solid'
}
