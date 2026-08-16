import { describe, expect, it } from 'vitest'
import {
  accountTypeLabel,
  accountTypeRank,
  formatAmount,
  formatAmountOrBlank,
  groupIndian,
  isNegativeAmount,
  isZeroAmount,
  periodStatusLabel,
  periodStatusTone,
} from './ledger-format'

describe('groupIndian', () => {
  it('groups the last three, then twos', () => {
    expect(groupIndian('1234567')).toBe('12,34,567')
    expect(groupIndian('123456789')).toBe('12,34,56,789')
  })

  it('leaves short runs alone', () => {
    expect(groupIndian('1')).toBe('1')
    expect(groupIndian('123')).toBe('123')
  })

  it('handles the boundary where the first group is a single digit', () => {
    expect(groupIndian('1234')).toBe('1,234')
    expect(groupIndian('12345')).toBe('12,345')
    expect(groupIndian('123456')).toBe('1,23,456')
  })
})

describe('formatAmount', () => {
  it('always shows two places', () => {
    expect(formatAmount('1000')).toBe('1,000.00')
    expect(formatAmount('1000.5')).toBe('1,000.50')
    expect(formatAmount('0.00')).toBe('0.00')
  })

  it('keeps the sign in front of the grouping', () => {
    expect(formatAmount('-1234567.89')).toBe('-12,34,567.89')
  })

  /*
   * The reason nothing here parses. 9007199254740993 is the first integer a JS number
   * cannot represent — via `Number` it comes back as ...992, and a books figure that
   * changed by one on its way to the screen is the failure this file exists to rule out.
   */
  it('formats an amount larger than a JS number represents exactly', () => {
    expect(formatAmount('9007199254740993.01')).toBe('9,00,71,99,25,47,40,993.01')
    /* Via a number the last digits come back as ...992, which is the whole point. */
    expect(String(Number('9007199254740993'))).not.toBe('9007199254740993')
  })

  it('returns anything it does not recognise untouched', () => {
    expect(formatAmount('not an amount')).toBe('not an amount')
    expect(formatAmount('1e5')).toBe('1e5')
  })
})

describe('formatAmountOrBlank', () => {
  it('leaves a zero cell empty, as a printed trial balance does', () => {
    expect(formatAmountOrBlank('0.00')).toBe('')
    expect(formatAmountOrBlank('-0.00')).toBe('')
    expect(formatAmountOrBlank('0')).toBe('')
  })

  it('shows anything else', () => {
    expect(formatAmountOrBlank('0.01')).toBe('0.01')
  })
})

describe('isZeroAmount and isNegativeAmount', () => {
  it('recognises every spelling of zero', () => {
    for (const value of ['0', '0.00', '-0.00', '000.0']) {
      expect(isZeroAmount(value), value).toBe(true)
    }
    expect(isZeroAmount('0.01')).toBe(false)
  })

  it('does not call a negative zero negative', () => {
    expect(isNegativeAmount('-0.00')).toBe(false)
    expect(isNegativeAmount('-0.01')).toBe(true)
    expect(isNegativeAmount('0.01')).toBe(false)
  })
})

describe('the ledger vocabulary', () => {
  it('gives each account type a plural heading', () => {
    expect(accountTypeLabel('asset')).toBe('Assets')
    expect(accountTypeLabel('liability')).toBe('Liabilities')
    expect(accountTypeLabel('equity')).toBe('Equity')
  })

  it('falls back to the raw value rather than showing nothing', () => {
    expect(accountTypeLabel('mystery')).toBe('mystery')
  })

  it('orders the balance sheet before the profit and loss', () => {
    const order = ['asset', 'liability', 'equity', 'income', 'expense']
    const ranks = order.map(accountTypeRank)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    expect(accountTypeRank('asset')).toBeLessThan(accountTypeRank('income'))
  })

  it('sorts an unknown type last rather than first', () => {
    expect(accountTypeRank('mystery')).toBeGreaterThan(accountTypeRank('expense'))
  })

  it('names the three period states, and does not call a lock a warning', () => {
    expect(periodStatusLabel('open')).toBe('Open')
    expect(periodStatusLabel('locked')).toBe('Locked')
    expect(periodStatusTone('open')).toBe('positive')
    expect(periodStatusTone('closed')).toBe('neutral')
    expect(periodStatusTone('locked')).toBe('info')
  })
})
