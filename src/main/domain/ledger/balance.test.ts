import { describe, expect, it } from 'vitest'

import { D } from '@main/domain/money'

import {
  checkDraft,
  checkLine,
  isBalanced,
  reverseLines,
  totalsOf,
  type DraftProblem,
} from './balance'
import { MANUAL_SOURCE, type EntryDraft, type EntryLineDraft } from './types'

const debit = (amount: string, accountId = 'a1'): EntryLineDraft => ({
  accountId,
  debit: D(amount),
  credit: D(0),
})

const credit = (amount: string, accountId = 'a2'): EntryLineDraft => ({
  accountId,
  debit: D(0),
  credit: D(amount),
})

const draftOf = (lines: EntryLineDraft[]): EntryDraft => ({
  date: '2026-04-15',
  narration: 'Test entry',
  source: MANUAL_SOURCE,
  lines,
})

const codes = (problems: DraftProblem[]): string[] => problems.map((problem) => problem.code)

describe('totalsOf', () => {
  it('sums both sides and reports the difference', () => {
    const totals = totalsOf([debit('100'), credit('60'), credit('40')])
    expect(totals.debit.toString()).toBe('100')
    expect(totals.credit.toString()).toBe('100')
    expect(totals.difference.isZero()).toBe(true)
  })

  it('is zero on both sides for no lines', () => {
    const totals = totalsOf([])
    expect(totals.debit.isZero()).toBe(true)
    expect(totals.credit.isZero()).toBe(true)
  })

  /* The reason nothing here rounds: a rule that allocates 100 across three ways
   * produces thirds that are already rounded to sum back exactly. Rounding again would
   * be rounding rounded figures. */
  it('does not round', () => {
    const totals = totalsOf([debit('33.34'), debit('33.33'), credit('66.67')])
    expect(totals.difference.isZero()).toBe(true)
  })

  it('detects a difference below the smallest coin', () => {
    const totals = totalsOf([debit('100.001'), credit('100')])
    expect(totals.difference.toString()).toBe('0.001')
    expect(isBalanced([debit('100.001'), credit('100')])).toBe(false)
  })
})

describe('checkLine', () => {
  it('accepts a debit and a credit', () => {
    expect(checkLine(debit('10'))).toBeNull()
    expect(checkLine(credit('10'))).toBeNull()
  })

  it('rejects a line carrying both', () => {
    expect(checkLine({ accountId: 'a1', debit: D(10), credit: D(10) })).toBe('AMBIGUOUS_LINE')
  })

  /* A both-zero line balances and totals correctly, which is exactly what makes it
   * worth refusing — it would sit in the books looking like it said something. */
  it('rejects a line carrying neither', () => {
    expect(checkLine({ accountId: 'a1', debit: D(0), credit: D(0) })).toBe('AMBIGUOUS_LINE')
  })

  it('rejects a negative amount rather than flipping it', () => {
    expect(checkLine({ accountId: 'a1', debit: D(-10), credit: D(0) })).toBe('NEGATIVE_AMOUNT')
    expect(checkLine({ accountId: 'a1', debit: D(0), credit: D(-10) })).toBe('NEGATIVE_AMOUNT')
  })
})

describe('checkDraft', () => {
  it('passes a balanced two-line entry', () => {
    expect(checkDraft(draftOf([debit('100'), credit('100')]))).toEqual([])
  })

  it('passes a balanced entry with many lines', () => {
    const draft = draftOf([debit('1180'), credit('1000'), credit('180')])
    expect(checkDraft(draft)).toEqual([])
  })

  it('refuses fewer than two lines', () => {
    expect(codes(checkDraft(draftOf([])))).toContain('INSUFFICIENT_LINES')
    expect(codes(checkDraft(draftOf([debit('100')])))).toContain('INSUFFICIENT_LINES')
  })

  it('reports an unbalanced entry', () => {
    expect(codes(checkDraft(draftOf([debit('100'), credit('90')])))).toEqual(['UNBALANCED_ENTRY'])
  })

  it('names the line a problem is on', () => {
    const draft = draftOf([debit('100'), { accountId: 'a2', debit: D(0), credit: D(0) }])
    expect(checkDraft(draft)).toEqual([{ code: 'AMBIGUOUS_LINE', lineIndex: 1 }])
  })

  it('reports every bad line, not just the first', () => {
    const draft = draftOf([
      { accountId: 'a1', debit: D(-5), credit: D(0) },
      { accountId: 'a2', debit: D(1), credit: D(1) },
    ])
    expect(codes(checkDraft(draft))).toEqual(['NEGATIVE_AMOUNT', 'AMBIGUOUS_LINE'])
  })

  /* Leading with "unbalanced" here would point at the total rather than at the line
   * that made it wrong, and the user would go looking in the wrong place. */
  it('stays quiet about the balance while a line is malformed', () => {
    const draft = draftOf([{ accountId: 'a1', debit: D(-5), credit: D(0) }, credit('100')])
    expect(codes(checkDraft(draft))).not.toContain('UNBALANCED_ENTRY')
  })
})

describe('reverseLines', () => {
  it('swaps every side', () => {
    const reversed = reverseLines([debit('100'), credit('60'), credit('40')])
    expect(reversed[0]?.debit.isZero()).toBe(true)
    expect(reversed[0]?.credit.toString()).toBe('100')
    expect(reversed[1]?.debit.toString()).toBe('60')
    expect(reversed[2]?.debit.toString()).toBe('40')
  })

  it('keeps the accounts and the notes', () => {
    const original: EntryLineDraft[] = [
      { accountId: 'a1', debit: D(100), credit: D(0), narration: 'Being the original' },
      credit('100'),
    ]
    const reversed = reverseLines(original)
    expect(reversed[0]?.accountId).toBe('a1')
    expect(reversed[0]?.narration).toBe('Being the original')
  })

  it('produces something that still balances', () => {
    const original = [debit('1180'), credit('1000'), credit('180')]
    expect(isBalanced(reverseLines(original))).toBe(true)
  })

  it('is its own inverse', () => {
    const original = [debit('100'), credit('100')]
    const twice = reverseLines(reverseLines(original))
    expect(twice[0]?.debit.toString()).toBe('100')
    expect(twice[1]?.credit.toString()).toBe('100')
  })

  it('does not touch the original', () => {
    const original = [debit('100'), credit('100')]
    reverseLines(original)
    expect(original[0]?.debit.toString()).toBe('100')
  })
})
