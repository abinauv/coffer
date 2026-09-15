import { describe, expect, it } from 'vitest'
import {
  describeRange,
  fiscalYearOf,
  isContraBalance,
  resultLabel,
  resultTone,
  sectionHeading,
} from './report-view'

describe('describeRange', () => {
  it('says so when the range is everything', () => {
    expect(describeRange(null, null)).toBe('Everything in the books')
  })

  /* A report writes its dates the way the rest of the app does: `1 Apr 2026`, not ISO. */
  it('describes each half-open range', () => {
    expect(describeRange('2026-04-01', null)).toBe('From 1 Apr 2026')
    expect(describeRange(null, '2027-03-31')).toBe('Up to 31 Mar 2027')
  })

  it('describes a closed range', () => {
    expect(describeRange('2026-04-01', '2027-03-31')).toBe('1 Apr 2026 to 31 Mar 2027')
  })
})

describe('resultLabel', () => {
  /* A signed figure in a column is not read as a loss. The word is what says so. */
  it('calls a negative result a loss', () => {
    expect(resultLabel('-15000.00')).toBe('Net loss')
    expect(resultTone('-15000.00')).toBe('danger')
  })

  it('calls a positive result a profit', () => {
    expect(resultLabel('44999.50')).toBe('Net profit')
    expect(resultTone('44999.50')).toBe('positive')
  })

  it('calls exactly zero neither', () => {
    expect(resultLabel('0.00')).toBe('Neither profit nor loss')
    expect(resultTone('0.00')).toBe('neutral')
  })

  it('treats a signed zero as zero', () => {
    expect(resultLabel('-0.00')).toBe('Neither profit nor loss')
  })
})

describe('sectionHeading', () => {
  /*
   * Equity is not called "Equity" on a balance sheet, because the block also carries the
   * unclosed profit — and the profit line is the one a reader will look for and not find
   * under a heading they did not expect.
   */
  it('names the equity block for what is actually in it', () => {
    expect(sectionHeading('equity')).toBe('Equity and reserves')
  })

  it('names the other four plainly', () => {
    expect(sectionHeading('asset')).toBe('Assets')
    expect(sectionHeading('liability')).toBe('Liabilities')
    expect(sectionHeading('income')).toBe('Income')
    expect(sectionHeading('expense')).toBe('Expenses')
  })

  it('falls back to the type rather than to an empty heading', () => {
    expect(sectionHeading('something-new')).toBe('something-new')
  })
})

describe('isContraBalance', () => {
  it('is true only for a negative', () => {
    expect(isContraBalance('-15000.00')).toBe(true)
    expect(isContraBalance('15000.00')).toBe(false)
    expect(isContraBalance('0.00')).toBe(false)
    expect(isContraBalance('-0.00')).toBe(false)
  })
})

describe('fiscalYearOf', () => {
  it('puts a date after the start month in the year that began that April', () => {
    expect(fiscalYearOf('2026-06-15', 4)).toEqual({ from: '2026-04-01', to: '2027-03-31' })
  })

  it('puts a date before the start month in the year that began the previous April', () => {
    expect(fiscalYearOf('2027-02-15', 4)).toEqual({ from: '2026-04-01', to: '2027-03-31' })
  })

  it('includes the first day of the year', () => {
    expect(fiscalYearOf('2026-04-01', 4).from).toBe('2026-04-01')
  })

  it('includes the last day of the year', () => {
    expect(fiscalYearOf('2027-03-31', 4)).toEqual({ from: '2026-04-01', to: '2027-03-31' })
  })

  it('handles a calendar fiscal year', () => {
    expect(fiscalYearOf('2026-06-15', 1)).toEqual({ from: '2026-01-01', to: '2026-12-31' })
  })

  /* February is why the last day is computed rather than looked up in a table. */
  it('ends on the right day of February in a leap year', () => {
    expect(fiscalYearOf('2028-01-15', 3)).toEqual({ from: '2027-03-01', to: '2028-02-29' })
  })

  it('ends on the right day of February in a common year', () => {
    expect(fiscalYearOf('2027-01-15', 3)).toEqual({ from: '2026-03-01', to: '2027-02-28' })
  })

  it('handles a year starting in July', () => {
    expect(fiscalYearOf('2026-08-01', 7)).toEqual({ from: '2026-07-01', to: '2027-06-30' })
  })
})
