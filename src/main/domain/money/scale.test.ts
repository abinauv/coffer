import { describe, expect, it } from 'vitest'
import { D, MoneyError } from './decimal'
import {
  ROUNDING_MODE,
  ROUNDING_POINTS,
  SCALE,
  roundAt,
  roundMoney,
  roundQuantity,
  roundRate,
  roundToWholeUnit,
  scaleOf,
  unitAt,
  type RoundingPoint,
} from './scale'
import fixture from './__fixtures__/rounding.json'

interface RoundingCase {
  point: RoundingPoint
  input: string
  expected: string
  why?: string
}

interface WholeUnitCase {
  amount: string
  rounded: string
  adjustment: string
  why?: string
}

interface RoundingFixture {
  roundingMode: string
  scales: Record<string, number>
  points: Record<string, number>
  cases: RoundingCase[]
  wholeUnitCases: WholeUnitCase[]
}

const golden = fixture as unknown as RoundingFixture

describe('the rounding policy is the one the fixture describes', () => {
  it('uses ROUND_HALF_UP', () => {
    expect(golden.roundingMode).toBe('ROUND_HALF_UP')
    expect(ROUNDING_MODE).toBe(4)
  })

  it('has exactly the scales in the fixture', () => {
    expect(SCALE).toEqual(golden.scales)
  })

  /* This is what stops a rounding point being added, removed or rescaled quietly. */
  it('has exactly the rounding points in the fixture, at the same scales', () => {
    const actual = Object.fromEntries(
      Object.keys(ROUNDING_POINTS).map((point) => [point, scaleOf(point as RoundingPoint)]),
    )
    expect(actual).toEqual(golden.points)
  })
})

describe('roundAt — golden cases', () => {
  it('covers every rounding point', () => {
    const covered = new Set(golden.cases.map((entry) => entry.point))
    expect(
      [...Object.keys(ROUNDING_POINTS)].every((point) => covered.has(point as RoundingPoint)),
    ).toBe(true)
  })

  for (const entry of golden.cases) {
    it(`${entry.point}: ${entry.input} -> ${entry.expected}${entry.why === undefined ? '' : ` (${entry.why})`}`, () => {
      expect(roundAt(entry.point, entry.input).toFixed(scaleOf(entry.point))).toBe(entry.expected)
    })
  }
})

describe('roundAt', () => {
  it('refuses a non-finite value rather than storing one', () => {
    expect(() => roundAt('moneyStorage', D(1).dividedBy(0))).toThrow(MoneyError)
  })

  it('is idempotent — rounding an already-rounded value changes nothing', () => {
    for (const entry of golden.cases) {
      const once = roundAt(entry.point, entry.input)
      expect(roundAt(entry.point, once).equals(once)).toBe(true)
    }
  })
})

describe('the named helpers agree with their points', () => {
  it('roundMoney is moneyStorage', () => {
    expect(roundMoney('1.005').toFixed(2)).toBe(roundAt('moneyStorage', '1.005').toFixed(2))
  })
  it('roundQuantity is quantityStorage', () => {
    expect(roundQuantity('1.0005').toFixed(3)).toBe(roundAt('quantityStorage', '1.0005').toFixed(3))
  })
  it('roundRate is rateStorage', () => {
    expect(roundRate('18.0005').toFixed(3)).toBe(roundAt('rateStorage', '18.0005').toFixed(3))
  })
})

describe('unitAt', () => {
  it('is the smallest representable value at the point', () => {
    expect(unitAt('moneyStorage').toString()).toBe('0.01')
    expect(unitAt('quantityStorage').toString()).toBe('0.001')
    expect(unitAt('wholeUnit').toString()).toBe('1')
  })
})

describe('roundToWholeUnit — golden cases', () => {
  for (const entry of golden.wholeUnitCases) {
    it(`${entry.amount} -> ${entry.rounded} with adjustment ${entry.adjustment}`, () => {
      const { rounded, adjustment } = roundToWholeUnit(entry.amount)
      expect(rounded.toFixed(0)).toBe(entry.rounded)
      expect(adjustment.toFixed(2)).toBe(entry.adjustment)
    })
  }

  it('the adjustment always closes the gap exactly', () => {
    for (const entry of golden.wholeUnitCases) {
      const { rounded, adjustment } = roundToWholeUnit(entry.amount)
      expect(D(entry.amount).plus(adjustment).equals(rounded)).toBe(true)
    }
  })

  it('never reports a signed zero for an already-whole amount', () => {
    expect(roundToWholeUnit('5.00').adjustment.isNegative()).toBe(false)
    expect(roundToWholeUnit('-5.00').adjustment.isNegative()).toBe(false)
  })
})
