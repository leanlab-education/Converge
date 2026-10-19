import { describe, it, expect } from 'vitest'
import {
  getAnnotatorBatchBadge,
  getAnnotatorBatchButton,
  getAnnotatorBatchPhase,
  isAnnotatorScoringTodo,
  type AnnotatorBatchProgress,
} from '@/lib/annotator-batch-state'

function b(over: Partial<AnnotatorBatchProgress> = {}): AnnotatorBatchProgress {
  return { status: 'SCORING', itemCount: 55, scoredCount: 0, isPaired: true, ...over }
}

describe('getAnnotatorBatchPhase', () => {
  it('is scoring while the release is SCORING and items remain', () => {
    expect(getAnnotatorBatchPhase(b({ scoredCount: 54 }))).toBe('scoring')
  })

  it('is scored once every item is scored but the release is still SCORING', () => {
    expect(getAnnotatorBatchPhase(b({ scoredCount: 55 }))).toBe('scored')
  })

  it('follows the release status past scoring', () => {
    expect(getAnnotatorBatchPhase(b({ status: 'RECONCILING', scoredCount: 55 }))).toBe('reconciling')
    expect(getAnnotatorBatchPhase(b({ status: 'COMPLETE', scoredCount: 55 }))).toBe('complete')
  })

  it('is not-open for anything before SCORING', () => {
    expect(getAnnotatorBatchPhase(b({ status: 'DRAFT' }))).toBe('not-open')
  })

  it('never treats an empty batch as scored', () => {
    expect(getAnnotatorBatchPhase(b({ itemCount: 0, scoredCount: 0 }))).toBe('scoring')
  })
})

describe('getAnnotatorBatchBadge', () => {
  it('says Open while scoring, even at 54 of 55 (the Batch 65 case for Luofan)', () => {
    expect(getAnnotatorBatchBadge(b({ scoredCount: 54 }))).toEqual({ label: 'Open', tone: 'active' })
  })

  it('says Waiting on partner when done on a paired batch (the Batch 65 case for Jonathan)', () => {
    expect(getAnnotatorBatchBadge(b({ scoredCount: 55 }))).toEqual({
      label: 'Waiting on partner',
      tone: 'waiting',
    })
  })

  it('says Scored when done on an independent batch', () => {
    expect(getAnnotatorBatchBadge(b({ scoredCount: 55, isPaired: false }))).toEqual({
      label: 'Scored',
      tone: 'waiting',
    })
  })

  it('only says Complete once the release is COMPLETE', () => {
    expect(getAnnotatorBatchBadge(b({ status: 'RECONCILING', scoredCount: 55 })).label).toBe('Reconciling')
    expect(getAnnotatorBatchBadge(b({ status: 'COMPLETE', scoredCount: 55 })).label).toBe('Complete')
  })
})

describe('getAnnotatorBatchButton', () => {
  it('never disables the button while the release is SCORING', () => {
    expect(getAnnotatorBatchButton(b({ scoredCount: 0 }))).toEqual({
      label: 'Start',
      variant: 'default',
      disabled: false,
      action: 'score',
    })
    expect(getAnnotatorBatchButton(b({ scoredCount: 54 }))).toEqual({
      label: 'Continue',
      variant: 'default',
      disabled: false,
      action: 'score',
    })
    expect(getAnnotatorBatchButton(b({ scoredCount: 55 }))).toEqual({
      label: 'Review',
      variant: 'outline',
      disabled: false,
      action: 'score',
    })
  })

  it('sends a RECONCILING release to reconciliation', () => {
    expect(getAnnotatorBatchButton(b({ status: 'RECONCILING', scoredCount: 55 }))).toEqual({
      label: 'Reconcile',
      variant: 'default',
      disabled: false,
      action: 'reconcile',
    })
  })

  it('disables only when there is nothing to do', () => {
    expect(getAnnotatorBatchButton(b({ status: 'COMPLETE', scoredCount: 55 }))).toMatchObject({
      label: 'Done',
      disabled: true,
    })
    expect(getAnnotatorBatchButton(b({ status: 'DRAFT' }))).toMatchObject({
      label: 'Not Open',
      disabled: true,
    })
  })
})

describe('isAnnotatorScoringTodo', () => {
  it('keeps a batch in To do until this annotator has scored every item', () => {
    expect(isAnnotatorScoringTodo(b({ scoredCount: 54 }))).toBe(true)
    expect(isAnnotatorScoringTodo(b({ status: 'DRAFT' }))).toBe(true)
  })

  it('moves it to Completed once their share is scored, whatever the release is doing', () => {
    expect(isAnnotatorScoringTodo(b({ scoredCount: 55 }))).toBe(false)
    expect(isAnnotatorScoringTodo(b({ status: 'RECONCILING', scoredCount: 55 }))).toBe(false)
    expect(isAnnotatorScoringTodo(b({ status: 'COMPLETE', scoredCount: 55 }))).toBe(false)
  })
})
