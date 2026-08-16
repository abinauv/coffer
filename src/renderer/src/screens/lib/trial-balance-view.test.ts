import { describe, expect, it } from 'vitest'
import type { TrialBalance, TrialBalanceRow } from '@shared/dto'
import { describeRange, sectionsOf, sumAmounts } from './trial-balance-view'

function row(
  over: Partial<TrialBalanceRow> & Pick<TrialBalanceRow, 'code' | 'type'>,
): TrialBalanceRow {
  return {
    accountId: over.code,
    name: over.code,
    debit: '0.00',
    credit: '0.00',
    debitBalance: '0.00',
    creditBalance: '0.00',
    ...over,
  }
}

function report(rows: TrialBalanceRow[], over: Partial<TrialBalance> = {}): TrialBalance {
  return {
    fromDate: null,
    toDate: null,
    rows,
    totalDebit: '0.00',
    totalCredit: '0.00',
    balanced: true,
    ...over,
  }
}

describe('sumAmounts', () => {
  /* The reason this is not `reduce((a, b) => a + Number(b), 0)`. */
  it('adds tenths without drifting', () => {
    expect(sumAmounts(Array.from({ length: 10 }, () => '0.10'))).toBe('1.00')
  })

  it('gets the case floating point gets wrong', () => {
    expect(sumAmounts(['0.07', '0.07', '0.07', '1234567.89', '0.01'])).toBe('1234568.11')
    /* What a float would have said, for the record. */
    expect(
      ['0.07', '0.07', '0.07', '1234567.89', '0.01'].reduce((a, b) => a + Number(b), 0),
    ).not.toBe(1234568.11)
  })

  it('handles negatives and an empty list', () => {
    expect(sumAmounts([])).toBe('0.00')
    expect(sumAmounts(['100.00', '-40.50'])).toBe('59.50')
    expect(sumAmounts(['-100.00', '100.00'])).toBe('0.00')
    expect(sumAmounts(['-1.00', '-2.00'])).toBe('-3.00')
  })

  it('stays exact past what a JS number represents', () => {
    expect(sumAmounts(['9007199254740992.00', '0.01'])).toBe('9007199254740992.01')
  })

  it('ignores anything that is not an amount rather than producing NaN', () => {
    expect(sumAmounts(['1.00', 'nonsense'])).toBe('1.00')
  })
})

describe('sectionsOf', () => {
  const rows = [
    row({ code: '6200', type: 'expense', debitBalance: '15000.00' }),
    row({ code: '1210', type: 'asset', debitBalance: '85000.00' }),
    row({ code: '4100', type: 'income', creditBalance: '23600.00' }),
    row({ code: '1300', type: 'asset', debitBalance: '23600.00' }),
    row({ code: '3100', type: 'equity', creditBalance: '100000.00' }),
  ]

  it('orders the balance sheet before the profit and loss', () => {
    expect(sectionsOf(report(rows)).map((section) => section.type)).toEqual([
      'asset',
      'equity',
      'income',
      'expense',
    ])
  })

  it('keeps the rows of a section in the order they arrived', () => {
    const assets = sectionsOf(report(rows)).find((section) => section.type === 'asset')
    expect(assets?.rows.map((r) => r.code)).toEqual(['1210', '1300'])
  })

  it('totals each section exactly', () => {
    const assets = sectionsOf(report(rows)).find((section) => section.type === 'asset')
    expect(assets?.debitTotal).toBe('108600.00')
    expect(assets?.creditTotal).toBe('0.00')
  })

  it('drops a heading with nothing under it', () => {
    expect(sectionsOf(report(rows)).map((s) => s.type)).not.toContain('liability')
  })

  it('gives each section a plural heading', () => {
    expect(sectionsOf(report(rows)).map((s) => s.label)).toEqual([
      'Assets',
      'Equity',
      'Income',
      'Expenses',
    ])
  })

  it('returns nothing for an empty report', () => {
    expect(sectionsOf(report([]))).toEqual([])
  })

  /*
   * `balanced` is main's answer, summed from the lines. Re-deriving it here would be a
   * second opinion about the one fact this report exists to state.
   */
  it('does not recompute whether the report balances', () => {
    const sections = sectionsOf(report(rows, { balanced: false }))
    expect(sections).not.toHaveProperty('balanced')
    for (const section of sections) {
      expect(section).not.toHaveProperty('balanced')
    }
  })
})

describe('describeRange', () => {
  it('says so when the range is everything', () => {
    expect(describeRange(report([]))).toBe('Everything in the books')
  })

  it('describes each half-open range', () => {
    expect(describeRange(report([], { fromDate: '2026-04-01' }))).toBe('From 2026-04-01')
    expect(describeRange(report([], { toDate: '2027-03-31' }))).toBe('Up to 2027-03-31')
  })

  it('describes a closed range', () => {
    expect(describeRange(report([], { fromDate: '2026-04-01', toDate: '2027-03-31' }))).toBe(
      '2026-04-01 to 2027-03-31',
    )
  })
})
