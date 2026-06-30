import { describe, it, expect } from 'vitest'
import {
  evaluateReconciliationAccess,
  isReconcilableStatus,
  BATCH_LOCKED_MESSAGE,
  NOT_RECONCILABLE_MESSAGE,
} from '@/lib/reconciliation-access'

describe('isReconcilableStatus', () => {
  it('allows RECONCILING and COMPLETE', () => {
    expect(isReconcilableStatus('RECONCILING')).toBe(true)
    expect(isReconcilableStatus('COMPLETE')).toBe(true)
  })

  it('rejects pre-reconciliation and unknown statuses', () => {
    expect(isReconcilableStatus('DRAFT')).toBe(false)
    expect(isReconcilableStatus('SCORING')).toBe(false)
    expect(isReconcilableStatus('')).toBe(false)
    expect(isReconcilableStatus(null)).toBe(false)
    expect(isReconcilableStatus(undefined)).toBe(false)
  })
})

describe('evaluateReconciliationAccess', () => {
  it('allows editing while actively reconciling', () => {
    expect(
      evaluateReconciliationAccess({ isLocked: false, status: 'RECONCILING' })
    ).toEqual({ ok: true })
  })

  it('allows editing after the release auto-completed (the Luofan case)', () => {
    // A pair revisiting a COMPLETE release to correct a final score.
    expect(
      evaluateReconciliationAccess({ isLocked: false, status: 'COMPLETE' })
    ).toEqual({ ok: true })
  })

  it('blocks with 423 when the batch is locked, even mid-reconciliation', () => {
    const res = evaluateReconciliationAccess({
      isLocked: true,
      status: 'RECONCILING',
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected blocked')
    expect(res.reason).toBe('locked')
    expect(res.httpStatus).toBe(423)
    expect(res.error).toBe(BATCH_LOCKED_MESSAGE)
  })

  it('lock takes precedence over status — locked + COMPLETE is still 423', () => {
    const res = evaluateReconciliationAccess({
      isLocked: true,
      status: 'COMPLETE',
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected blocked')
    expect(res.reason).toBe('locked')
    expect(res.httpStatus).toBe(423)
  })

  it('lock blocks even for a not-yet-reconcilable status', () => {
    // Locked wins over the status check regardless of which status it is.
    const res = evaluateReconciliationAccess({
      isLocked: true,
      status: 'SCORING',
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected blocked')
    expect(res.reason).toBe('locked')
    expect(res.httpStatus).toBe(423)
  })

  it('blocks with 400 when unlocked but not in a reconcilable status', () => {
    for (const status of ['DRAFT', 'SCORING', '']) {
      const res = evaluateReconciliationAccess({ isLocked: false, status })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('expected blocked')
      expect(res.reason).toBe('status')
      expect(res.httpStatus).toBe(400)
      expect(res.error).toBe(NOT_RECONCILABLE_MESSAGE)
    }
  })
})
