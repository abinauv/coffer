import { describe, expect, it } from 'vitest'
import {
  assertFinite,
  assertNonNegative,
  D,
  Decimal,
  HUNDRED,
  isDecimal,
  isDecimalString,
  MoneyError,
  normaliseZero,
  ONE,
  PRECISION,
  ZERO,
} from './decimal'

describe('the configured constructor', () => {
  it('rounds half up, away from zero', () => {
    expect(Decimal.rounding).toBe(Decimal.ROUND_HALF_UP)
    expect(D('0.5').toDecimalPlaces(0).toString()).toBe('1')
    expect(D('-0.5').toDecimalPlaces(0).toString()).toBe('-1')
    expect(D('2.5').toDecimalPlaces(0).toString()).toBe('3')
    /* Banker's rounding would give 2 for the line above. */
  })

  it('carries 40 significant digits through a division', () => {
    expect(Decimal.precision).toBe(PRECISION)
    expect(D(1).dividedBy(3).precision()).toBe(40)
  })

  it('never stringifies to exponential notation at any realistic magnitude', () => {
    expect(D('0.00000001').toString()).toBe('0.00000001')
    expect(D('100000000000000000000').toString()).toBe('100000000000000000000')
  })

  it('is exact where a float is not', () => {
    expect(D('0.1').plus(D('0.2')).toString()).toBe('0.3')
    expect(0.1 + 0.2).not.toBe(0.3)
    expect(D('1.005').toDecimalPlaces(2).toString()).toBe('1.01')
  })
})

describe('D — what may become a Decimal', () => {
  it('accepts exact decimal strings', () => {
    expect(D('0').toString()).toBe('0')
    expect(D('-1234.5678').toString()).toBe('-1234.5678')
  })

  it('accepts whole numbers, which cannot carry float error', () => {
    expect(D(0).toString()).toBe('0')
    expect(D(1000).toString()).toBe('1000')
    expect(D(-7).toString()).toBe('-7')
  })

  it('accepts bigints', () => {
    expect(D(12345678901234567890n).toString()).toBe('12345678901234567890')
  })

  it('rejects a fractional number, which is the whole point', () => {
    expect(() => D(0.1)).toThrow(MoneyError)
    expect(() => D(19.99)).toThrowError(/fractional/i)
    try {
      D(19.99)
    } catch (error) {
      expect(error).toBeInstanceOf(MoneyError)
      expect((error as MoneyError).code).toBe('FRACTIONAL_NUMBER')
    }
  })

  it('rejects an integer beyond the safe range, where a number is already approximate', () => {
    expect(() => D(2 ** 53)).toThrowError(/safe range/i)
  })

  it('rejects NaN and Infinity rather than propagating them', () => {
    expect(() => D(Number.NaN)).toThrowError(/finite/i)
    expect(() => D(Number.POSITIVE_INFINITY)).toThrowError(/finite/i)
    expect(() => D('NaN')).toThrowError(/exact decimal string/i)
    expect(() => D('Infinity')).toThrowError(/exact decimal string/i)
  })

  it('rejects a malformed string instead of producing NaN', () => {
    for (const text of ['', ' ', '1,000', '1e5', '.5', '5.', '+1', '01', 'abc']) {
      expect(() => D(text), text).toThrow(MoneyError)
    }
  })

  it("re-wraps a Decimal so this module's precision governs what happens next", () => {
    const foreign = new Decimal('1')
    expect(D(foreign).dividedBy(3).precision()).toBe(40)
    expect(D(foreign)).not.toBe(foreign)
  })

  it('rejects anything else', () => {
    expect(() => D(null as unknown as string)).toThrow(MoneyError)
    expect(() => D({} as unknown as string)).toThrow(MoneyError)
    expect(() => D([] as unknown as string)).toThrow(MoneyError)
  })
})

describe('isDecimalString', () => {
  it('accepts exact decimal text', () => {
    expect(isDecimalString('0')).toBe(true)
    expect(isDecimalString('-0.01')).toBe(true)
  })

  it('rejects everything else, including non-strings', () => {
    expect(isDecimalString('1e5')).toBe(false)
    expect(isDecimalString(1)).toBe(false)
    expect(isDecimalString(null)).toBe(false)
    expect(isDecimalString(undefined)).toBe(false)
  })
})

describe('isDecimal', () => {
  it('recognises a Decimal and nothing else', () => {
    expect(isDecimal(D('1'))).toBe(true)
    expect(isDecimal('1')).toBe(false)
    expect(isDecimal(1)).toBe(false)
    expect(isDecimal(null)).toBe(false)
  })
})

describe('constants', () => {
  it('are the values they say they are', () => {
    expect(ZERO.toString()).toBe('0')
    expect(ONE.toString()).toBe('1')
    expect(HUNDRED.toString()).toBe('100')
  })
})

describe('guards', () => {
  it('assertFinite passes a finite value through and rejects the rest', () => {
    const value = D('1.5')
    expect(assertFinite(value)).toBe(value)
    expect(() => assertFinite(D(1).dividedBy(0), 'quotient')).toThrowError(/quotient is not finite/)
  })

  it('assertNonNegative allows zero and rejects a negative', () => {
    expect(assertNonNegative('0').toString()).toBe('0')
    expect(assertNonNegative('-0').isZero()).toBe(true)
    expect(assertNonNegative('0.01').toString()).toBe('0.01')
    expect(() => assertNonNegative('-0.01', 'quantity')).toThrowError(
      /quantity must not be negative/,
    )
  })
})

describe('normaliseZero', () => {
  it('turns a signed zero into a plain zero and leaves everything else alone', () => {
    expect(D('-0').isNegative()).toBe(true)
    expect(normaliseZero(D('-0')).isNegative()).toBe(false)
    expect(normaliseZero(D('-1')).toString()).toBe('-1')
  })
})
