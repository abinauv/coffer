import { describe, expect, it } from 'vitest'
import { D, MoneyError } from './decimal'
import { roundMoney } from './scale'
import {
  clamp,
  compare,
  equals,
  max,
  min,
  multiply,
  percentOf,
  percentageRate,
  subtractAll,
  sum,
} from './arithmetic'
import fixture from './__fixtures__/percentage.json'

interface PercentageCase {
  base: string
  ratePercent: string
  exact: string
  money: string
  why?: string
}

interface RateCase {
  portion: string
  base: string
  exact: string
  why?: string
}

const golden = fixture as unknown as { cases: PercentageCase[]; rateCases: RateCase[] }

describe('percentOf — golden cases', () => {
  for (const entry of golden.cases) {
    it(`${entry.ratePercent}% of ${entry.base} is exactly ${entry.exact}`, () => {
      expect(percentOf(entry.base, entry.ratePercent).toString()).toBe(entry.exact)
    })

    it(`${entry.ratePercent}% of ${entry.base} stores as ${entry.money}`, () => {
      expect(roundMoney(percentOf(entry.base, entry.ratePercent)).toFixed(2)).toBe(entry.money)
    })
  }

  it('does not round, so composing two halves matches the single rate', () => {
    /* The shape a split tax takes: two components at half the rate must total the same
     * as one component at the full rate. Rounding inside percentOf breaks this. */
    const base = '999.99'
    const full = percentOf(base, '18.00')
    const halves = sum([percentOf(base, '9.00'), percentOf(base, '9.00')])
    expect(halves.equals(full)).toBe(true)
    expect(roundMoney(halves).toFixed(2)).toBe(roundMoney(full).toFixed(2))
  })

  it('rejects a float rate outright', () => {
    expect(() => percentOf('100.00', 18.5)).toThrow(MoneyError)
  })
})

describe('percentageRate — golden cases', () => {
  for (const entry of golden.rateCases) {
    it(`${entry.portion} of ${entry.base} is ${entry.exact}%`, () => {
      expect(percentageRate(entry.portion, entry.base).toString()).toBe(entry.exact)
    })
  }
})

describe('sum', () => {
  it('is zero for an empty list', () => {
    expect(sum([]).toString()).toBe('0')
  })

  it('is exact where a float reduce is not', () => {
    const values = ['0.07', '0.07', '0.07', '0.07', '0.07', '0.07', '0.07', '0.07', '0.07', '0.07']
    expect(sum(values).toString()).toBe('0.7')
    /* The same ten values through a numeric reduce: 0.7000000000000002. Ten lines of a
     * bill, and the total is already wrong in the fifteenth place. */
    expect(values.reduce((total, value) => total + Number(value), 0)).not.toBe(0.7)
  })

  it('refuses a float in the list', () => {
    expect(() => sum(['1.00', 2.5])).toThrow(MoneyError)
  })

  it('accepts any iterable, not just an array', () => {
    expect(sum(new Set(['1.50', '2.50'])).toFixed(2)).toBe('4.00')
  })
})

describe('subtractAll', () => {
  it('takes a list of deductions off a base', () => {
    expect(subtractAll('1000.00', ['100.00', '50.50']).toFixed(2)).toBe('849.50')
    expect(subtractAll('0', []).toString()).toBe('0')
  })
})

describe('multiply', () => {
  it('is exact and unrounded', () => {
    expect(multiply('2.5', '3.5').toString()).toBe('8.75')
    expect(multiply('0.001', '0.001').toString()).toBe('0.000001')
  })
})

describe('comparison helpers', () => {
  it('compare returns -1, 0 or 1', () => {
    expect(compare('1.00', '2.00')).toBe(-1)
    expect(compare('2.00', '1.00')).toBe(1)
    expect(compare('1.00', '1.0')).toBe(0)
  })

  it('equals ignores trailing zeros', () => {
    expect(equals('1.5', '1.50')).toBe(true)
    expect(equals('1.5', '1.51')).toBe(false)
  })

  it('validates its operands, which a raw < does not', () => {
    expect(() => compare('1.00', 'oops')).toThrow(MoneyError)
  })

  it('max, min and clamp', () => {
    expect(max('1.00', '2.00').toFixed(2)).toBe('2.00')
    expect(min('1.00', '2.00').toFixed(2)).toBe('1.00')
    expect(clamp('5.00', '0.00', '3.00').toFixed(2)).toBe('3.00')
    expect(clamp('-5.00', '0.00', '3.00').toFixed(2)).toBe('0.00')
    expect(clamp('1.50', '0.00', '3.00').toFixed(2)).toBe('1.50')
  })

  it('max and min are stable when the values are equal', () => {
    expect(max('1.00', '1.000').toFixed(3)).toBe('1.000')
    expect(min('1.00', '1.000').toFixed(3)).toBe('1.000')
  })
})

describe('non-finite values do not escape', () => {
  it('a sum that overflows to Infinity throws rather than being stored', () => {
    expect(() => sum([D(1).dividedBy(0)])).toThrow(MoneyError)
  })
})
