import { describe, it, expect } from 'vitest'
import {
  evaluateConcessionRule,
  CONCESSION_BLOCKED_MESSAGE,
} from '@/lib/reconcile-concession'

describe('evaluateConcessionRule', () => {
  it('blocks re-selecting your own original on a discrepancy (the misclick case)', () => {
    const res = evaluateConcessionRule({
      submittedValue: 1,
      submitterOriginal: 1,
      partnerOriginal: 0,
      existingFinal: null,
    })
    expect(res).toEqual({
      ok: false,
      httpStatus: 403,
      error: CONCESSION_BLOCKED_MESSAGE,
    })
  })

  it("allows conceding to the partner's value", () => {
    expect(
      evaluateConcessionRule({
        submittedValue: 0,
        submitterOriginal: 1,
        partnerOriginal: 0,
        existingFinal: null,
      })
    ).toEqual({ ok: true })
  })

  it('allows a third value on wider scales (not self, not partner)', () => {
    // 1–3 scale: submitter said 3, partner said 1, final recorded as 2.
    expect(
      evaluateConcessionRule({
        submittedValue: 2,
        submitterOriginal: 3,
        partnerOriginal: 1,
        existingFinal: null,
      })
    ).toEqual({ ok: true })
  })

  it('blocks re-asserting your own value on wider scales too', () => {
    const res = evaluateConcessionRule({
      submittedValue: 3,
      submitterOriginal: 3,
      partnerOriginal: 1,
      existingFinal: null,
    })
    expect(res.ok).toBe(false)
  })

  it('allows agreed dimensions (no discrepancy) even though value == own original', () => {
    // Agreed dims are auto-filled client-side and re-sent on every save.
    expect(
      evaluateConcessionRule({
        submittedValue: 1,
        submitterOriginal: 1,
        partnerOriginal: 1,
        existingFinal: null,
      })
    ).toEqual({ ok: true })
  })

  it("allows a no-op resave of an existing final that equals the submitter's original", () => {
    // Partner previously conceded TO the submitter's value; submitter re-opens
    // the item and hits Save & Continue without changing anything.
    expect(
      evaluateConcessionRule({
        submittedValue: 1,
        submitterOriginal: 1,
        partnerOriginal: 0,
        existingFinal: 1,
      })
    ).toEqual({ ok: true })
  })

  it('allows deliberately correcting an existing final to your own original', () => {
    // Final currently = partner's value (e.g. an accidental concession —
    // Luofan's scenario 2). Editing a recorded final is a deliberate act, not
    // a habit-click, so any value is allowed; reconciledById records who did
    // it. Only the FIRST recording of a discrepancy is constrained.
    expect(
      evaluateConcessionRule({
        submittedValue: 1,
        submitterOriginal: 1,
        partnerOriginal: 0,
        existingFinal: 0,
      })
    ).toEqual({ ok: true })
  })

  it('allows users with no original score (admins / non-pair members)', () => {
    expect(
      evaluateConcessionRule({
        submittedValue: 1,
        submitterOriginal: null,
        partnerOriginal: 0,
        existingFinal: null,
      })
    ).toEqual({ ok: true })
  })

  it('allows when the partner has no original score (not a real pair discrepancy)', () => {
    expect(
      evaluateConcessionRule({
        submittedValue: 1,
        submitterOriginal: 1,
        partnerOriginal: null,
        existingFinal: null,
      })
    ).toEqual({ ok: true })
  })
})
