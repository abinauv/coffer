import { describe, expect, it } from 'vitest'
import {
  describeRange,
  fiscalYearOf,
  isContraBalance,
  resultLabel,
  resultTone,
  sectionHeading,
  todayISO,
} from './report-view'

describe('todayISO', () => {
  /*
   * A stand-in whose local and UTC getters disagree, rather than a real Date in a real
   * timezone.
   *
   * The behaviour under test is "reads the local calendar day, not the UTC one", and a
   * real `new Date(2026, 4, 1, 2, 0)` only demonstrates that where the runner sits east
   * of Greenwich. On a UTC CI runner the two are identical and the test proves nothing
   * — worse, an assertion written the obvious way (`expect(d.toISOString()).not.toBe`)
   * would fail there outright, on a machine nobody was looking at.
   */
  function crossing(): Date {
    return {
      getFullYear: () => 2027,
      getMonth: () => 0,
      getDate: () => 1,
      getUTCFullYear: () => 2026,
      getUTCMonth: () => 11,
      getUTCDate: () => 31,
      toISOString: () => '2026-12-31T20:30:00.000Z',
    } as unknown as Date
  }

  it('is the local date, not the UTC one', () => {
    /*
     * The reason this is not `toISOString().slice(0, 10)`. At 02:00 on the first of
     * January in India, UTC is still 20:30 on 31 December — so a balance sheet would
     * default not just to yesterday but to the previous year.
     */
    expect(todayISO(crossing())).toBe('2027-01-01')
    expect(crossing().toISOString().slice(0, 10)).toBe('2026-12-31')
  })

  it('reads the local date for an ordinary instant too', () => {
    expect(todayISO(new Date(2026, 4, 1, 2, 0, 0))).toBe('2026-05-01')
  })

  it('pads the month and the day', () => {
    expect(todayISO(new Date(2026, 0, 5, 12))).toBe('2026-01-05')
  })

  it('handles the last day of a year', () => {
    expect(todayISO(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31')
  })
})

describe('describeRange', () => {
  it('says so when the range is everything', () => {
    expect(describeRange(null, null)).toBe('Everything in the books')
  })

  it('describes each half-open range', () => {
    expect(describeRange('2026-04-01', null)).toBe('From 2026-04-01')
    expect(describeRange(null, '2027-03-31')).toBe('Up to 2027-03-31')
  })

  it('describes a closed range', () => {
    expect(describeRange('2026-04-01', '2027-03-31')).toBe('2026-04-01 to 2027-03-31')
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
