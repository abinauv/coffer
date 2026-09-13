/*
 * The formatters.
 *
 * TWO REGIMES IN EVERY GROUPING TEST, and that is the point of the file rather than a
 * flourish. The renderer's formatter hard-coded the Indian lakh/crore convention until
 * 2.2e-2 took it out, and a suite that only ever asks for `[3, 2]` cannot tell a
 * formatter that reads its argument from one that ignores it — both produce 12,34,567.
 * So every case here is asserted against both a `[3, 2]` rule and a `[3]` one.
 */

import { describe, expect, it } from 'vitest'
import type { NumberFormat } from '@shared/dto'

import {
  formatAmount,
  formatPrintDate,
  formatQuantity,
  formatRate,
  groupDigits,
  isFormattableDecimal,
  isZeroAmount,
} from './format'

/** The Indian rule, as `regime.describe()` reports it. */
const INDIA: NumberFormat = {
  groupSizes: [3, 2],
  decimalSeparator: '.',
  groupSeparator: ',',
  currencyCode: 'INR',
  currencySymbol: '₹',
}

/** A rule that is not India's, in every field. See the header. */
const ELSEWHERE: NumberFormat = {
  groupSizes: [3],
  decimalSeparator: ',',
  groupSeparator: '.',
  currencyCode: 'EUR',
  currencySymbol: '€',
}

describe('groupDigits', () => {
  it('groups by threes then twos where the rule says so', () => {
    expect(groupDigits('1234567', INDIA)).toBe('12,34,567')
    expect(groupDigits('123456789', INDIA)).toBe('12,34,56,789')
  })

  it('groups by threes throughout where the rule says that instead', () => {
    expect(groupDigits('1234567', ELSEWHERE)).toBe('1.234.567')
  })

  it('leaves a run shorter than the first group alone', () => {
    expect(groupDigits('12', INDIA)).toBe('12')
    expect(groupDigits('123', INDIA)).toBe('123')
    expect(groupDigits('0', INDIA)).toBe('0')
  })

  /*
   * A negative group size never empties the remainder and hangs the render — measured in
   * the renderer's copy of this function, where a size of 0 turned out to be harmless and
   * a negative one locked the window. The rule arrives out of a compliance pack the
   * regime loads at runtime, so neither is theoretical.
   */
  it('gives up rather than looping on a nonsensical rule', () => {
    expect(groupDigits('1234567', { ...INDIA, groupSizes: [] })).toBe('1234567')
    expect(groupDigits('1234567', { ...INDIA, groupSizes: [0] })).toBe('1234567')
    expect(groupDigits('1234567', { ...INDIA, groupSizes: [-2] })).toBe('1234567')
    expect(groupDigits('1234567', { ...INDIA, groupSizes: [3, -2] })).toBe('1234,567')
  })
})

describe('formatAmount', () => {
  it('groups, keeps two places, and uses the rule it was given', () => {
    expect(formatAmount('1234567.5', INDIA)).toBe('12,34,567.50')
    expect(formatAmount('1234567.5', ELSEWHERE)).toBe('1.234.567,50')
  })

  it('pads and truncates to exactly two places', () => {
    expect(formatAmount('7', INDIA)).toBe('7.00')
    expect(formatAmount('7.1', INDIA)).toBe('7.10')
    expect(formatAmount('7.129', INDIA)).toBe('7.12')
  })

  /*
   * THE SIGN IS ANCHORED, NOT SEARCHED FOR. `toContain('0.28')` is true of '-0.28' as
   * well, so a formatter that dropped the minus would pass a substring assertion — and a
   * dropped minus on a round-off is a document that does not add up.
   */
  it('keeps a minus sign exactly where it arrived', () => {
    expect(formatAmount('-0.28', INDIA)).toBe('-0.28')
    expect(formatAmount('-1234567.89', INDIA)).toBe('-12,34,567.89')
    expect(formatAmount('-1234567.89', ELSEWHERE)).toBe('-1.234.567,89')
  })

  it('returns anything that is not a decimal string unchanged', () => {
    expect(formatAmount('n/a', INDIA)).toBe('n/a')
    expect(formatAmount('1,234.00', INDIA)).toBe('1,234.00')
    expect(formatAmount('<b>0.00</b>', INDIA)).toBe('<b>0.00</b>')
    expect(formatAmount('', INDIA)).toBe('')
  })
})

describe('formatQuantity', () => {
  it('drops the zeros the 3dp storage scale added, and only those', () => {
    expect(formatQuantity('40.000', INDIA)).toBe('40')
    expect(formatQuantity('2.500', INDIA)).toBe('2.5')
    expect(formatQuantity('2.505', INDIA)).toBe('2.505')
    expect(formatQuantity('0.001', INDIA)).toBe('0.001')
  })

  it('groups a large count, by the rule it was given', () => {
    expect(formatQuantity('1234567.000', INDIA)).toBe('12,34,567')
    expect(formatQuantity('1234567.500', ELSEWHERE)).toBe('1.234.567,5')
  })

  it('keeps a negative quantity negative — a return line is a real one', () => {
    expect(formatQuantity('-12.500', INDIA)).toBe('-12.5')
  })

  it('returns anything that is not a decimal string unchanged', () => {
    expect(formatQuantity('a few', INDIA)).toBe('a few')
  })
})

describe('formatRate', () => {
  it('writes a percentage and drops the storage zeros', () => {
    expect(formatRate('18.000')).toBe('18%')
    expect(formatRate('18')).toBe('18%')
    expect(formatRate('0')).toBe('0%')
  })

  /*
   * The third place survives, and ARCHITECTURE §7 says why: half of India's 0.25% slab is
   * 0.125%, and printing 0.13% would show a rate the tax was never computed from.
   */
  it('keeps the third decimal place where the rate actually has one', () => {
    expect(formatRate('0.125')).toBe('0.125%')
    expect(formatRate('2.500')).toBe('2.5%')
  })

  it('does not group — a rate with a thousands separator reads as two numbers', () => {
    expect(formatRate('1234')).toBe('1234%')
  })

  it('returns anything that is not a decimal string unchanged, with no per cent sign', () => {
    expect(formatRate('exempt')).toBe('exempt')
    expect(formatRate('18%')).toBe('18%')
  })
})

describe('formatPrintDate', () => {
  /*
   * Every date in this suite is in 2027 or later, so no assertion can pass by
   * coincidence with the machine's clock.
   */
  it('writes the month as a word, so the order cannot be misread', () => {
    expect(formatPrintDate('2027-11-04')).toBe('04 Nov 2027')
    expect(formatPrintDate('2028-01-17')).toBe('17 Jan 2028')
  })

  it('covers both ends of the month table', () => {
    expect(formatPrintDate('2027-01-01')).toBe('01 Jan 2027')
    expect(formatPrintDate('2027-12-31')).toBe('31 Dec 2027')
  })

  it('returns anything that is not a YYYY-MM-DD date unchanged', () => {
    expect(formatPrintDate('04/11/2027')).toBe('04/11/2027')
    expect(formatPrintDate('2027-11-04T05:40:00.000Z')).toBe('2027-11-04T05:40:00.000Z')
    expect(formatPrintDate('')).toBe('')
  })

  /* The month index is checked rather than trusted: a bad month must print as itself, not
   * as `04 undefined 2027`. */
  it('returns a month outside the table unchanged', () => {
    expect(formatPrintDate('2027-13-04')).toBe('2027-13-04')
    expect(formatPrintDate('2027-00-04')).toBe('2027-00-04')
  })
})

describe('the two predicates', () => {
  it('recognises what will be rearranged', () => {
    expect(isFormattableDecimal('0')).toBe(true)
    expect(isFormattableDecimal('-1.5')).toBe(true)
    expect(isFormattableDecimal('1,000')).toBe(false)
    expect(isFormattableDecimal('')).toBe(false)
  })

  it('recognises every spelling of zero, and nothing else', () => {
    expect(isZeroAmount('0')).toBe(true)
    expect(isZeroAmount('0.00')).toBe(true)
    expect(isZeroAmount('-0.00')).toBe(true)
    expect(isZeroAmount('0.01')).toBe(false)
    expect(isZeroAmount('-0.01')).toBe(false)
    expect(isZeroAmount('10.00')).toBe(false)
  })
})
