import { describe, expect, it } from 'vitest'
import { MoneyError } from './decimal'
import { scaleOf, type RoundingPoint } from './scale'
import {
  decimalPlacesIn,
  parseAt,
  parseDecimalString,
  parseMoney,
  parseQuantity,
  parseRate,
  toMoneyString,
  toQuantityString,
  toRateString,
  toStorageString,
  tryParseDecimalString,
} from './storage'
import fixture from './__fixtures__/storage.json'

interface StorageFixture {
  accepted: string[]
  rejected: { text: string; why: string }[]
  roundTrip: { point: RoundingPoint; input: string; storage: string; why?: string }[]
  scaleRejected: { point: RoundingPoint; text: string; why: string }[]
  scaleAccepted: { point: RoundingPoint; text: string }[]
}

const golden = fixture as unknown as StorageFixture

describe('parseDecimalString — what a column may contain', () => {
  for (const text of golden.accepted) {
    it(`accepts ${JSON.stringify(text)}`, () => {
      const value = parseDecimalString(text)
      /* '-0' is the one input that does not survive as written: a signed zero is a zero. */
      expect(value.toFixed(decimalPlacesIn(text))).toBe(text === '-0' ? '0' : text)
    })
  }

  for (const { text, why } of golden.rejected) {
    it(`rejects ${JSON.stringify(text)} — ${why}`, () => {
      expect(() => parseDecimalString(text)).toThrow(MoneyError)
      expect(tryParseDecimalString(text)).toBeNull()
    })
  }

  it('names the field it was reading', () => {
    expect(() => parseDecimalString('oops', 'journal_lines.debit')).toThrowError(
      /journal_lines\.debit/,
    )
  })

  it('rejects text that Number() would have silently turned into a value', () => {
    for (const text of ['', ' ', '1e5', ' 1.00', '0x10', '01']) {
      expect(Number.isFinite(Number(text)), text).toBe(true)
      expect(tryParseDecimalString(text), text).toBeNull()
    }
  })
})

describe('tryParseDecimalString', () => {
  it('returns a Decimal for exact text and null for anything else', () => {
    expect(tryParseDecimalString('1.50')?.toFixed(2)).toBe('1.50')
    expect(tryParseDecimalString(1.5)).toBeNull()
    expect(tryParseDecimalString(null)).toBeNull()
    expect(tryParseDecimalString(undefined)).toBeNull()
  })
})

describe('decimalPlacesIn', () => {
  it('counts what is written, not what the value needs', () => {
    expect(decimalPlacesIn('1')).toBe(0)
    expect(decimalPlacesIn('1.0')).toBe(1)
    expect(decimalPlacesIn('1.000')).toBe(3)
    expect(decimalPlacesIn('-0.01')).toBe(2)
  })

  it('rejects text that is not a decimal string', () => {
    expect(() => decimalPlacesIn('1.2.3')).toThrow(MoneyError)
  })
})

describe('toStorageString — golden round trips', () => {
  for (const entry of golden.roundTrip) {
    it(`${entry.point}: ${entry.input} -> ${entry.storage}`, () => {
      expect(toStorageString(entry.point, entry.input)).toBe(entry.storage)
    })
  }

  it('always writes exactly the scale of the point', () => {
    for (const entry of golden.roundTrip) {
      expect(decimalPlacesIn(entry.storage)).toBe(scaleOf(entry.point))
    }
  })

  it('produces text the parser accepts back', () => {
    for (const entry of golden.roundTrip) {
      const stored = toStorageString(entry.point, entry.input)
      expect(parseAt(entry.point, stored).toFixed(scaleOf(entry.point))).toBe(stored)
    }
  })

  it('never emits a signed zero', () => {
    expect(toMoneyString('-0.001')).toBe('0.00')
    expect(toQuantityString('-0.0001')).toBe('0.000')
    expect(toRateString('-0')).toBe('0.000')
  })
})

describe('the named renderers agree with their points', () => {
  it('money is 2dp, quantity 3dp, rate 3dp', () => {
    expect(toMoneyString('1')).toBe('1.00')
    expect(toQuantityString('1')).toBe('1.000')
    expect(toRateString('1')).toBe('1.000')
  })

  /* The reason the rate scale is three and not two. See SCALE in scale.ts. */
  it('holds half of the 0.25% slab exactly', () => {
    expect(toRateString('0.125')).toBe('0.125')
    expect(parseRate('0.125').toFixed(3)).toBe('0.125')
  })
})

describe('parseAt — a stored value must already be at its scale', () => {
  for (const { point, text, why } of golden.scaleRejected) {
    it(`${point} rejects ${text} — ${why}`, () => {
      expect(() => parseAt(point, text)).toThrow(MoneyError)
      try {
        parseAt(point, text)
      } catch (error) {
        expect((error as MoneyError).code).toBe('SCALE_EXCEEDED')
      }
    })
  }

  for (const { point, text } of golden.scaleAccepted) {
    it(`${point} accepts ${text}`, () => {
      expect(() => parseAt(point, text)).not.toThrow()
    })
  }

  it('does not round the extra places away, which would hide the fault', () => {
    expect(() => parseMoney('1.234')).toThrowError(/decimal places/)
    expect(() => parseQuantity('1.2345')).toThrowError(/decimal places/)
    expect(() => parseRate('18.0005')).toThrowError(/decimal places/)
  })

  it('reads a well-formed value', () => {
    expect(parseMoney('-1234.50').toFixed(2)).toBe('-1234.50')
    expect(parseQuantity('12.345').toFixed(3)).toBe('12.345')
    expect(parseRate('18.00').toFixed(2)).toBe('18.00')
  })
})
