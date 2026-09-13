import { describe, expect, it } from 'vitest'

import {
  parseDebitCredit,
  parseImportAmount,
  parseImportDecimal,
  type DebitCreditSign,
} from './amounts'
import { CsvError } from './errors'

const read = (text: string, options?: Parameters<typeof parseImportAmount>[1]): string => {
  const attempt = parseImportAmount(text, options)
  return attempt.ok ? attempt.value.toFixed() : `FAILED: ${attempt.message}`
}

describe('parseImportAmount — what a bank writes', () => {
  const accepted: readonly [string, string][] = [
    ['1234.56', '1234.56'],
    ['123,456.78', '123456.78'],
    ['1,23,456.78', '123456.78'],
    ['12,34,56,789.01', '123456789.01'],
    ['1,234', '1234'],
    ['(1,234.56)', '-1234.56'],
    ['-450.00', '-450'],
    ['450.00-', '-450'],
    ['+450.00', '450'],
    ['450.00+', '450'],
    ['₹ 2,500.00', '2500'],
    ['₹2,500.00', '2500'],
    ['Rs. 1,000.00', '1000'],
    ['Rs.1,000.00', '1000'],
    ['INR 1,00,000.50', '100000.5'],
    ['1,00,000.50 INR', '100000.5'],
    ['(₹1,234.56)', '-1234.56'],
    ['-₹1,234.56', '-1234.56'],
    ['007.50', '7.5'],
    ['0.00', '0'],
    ['-0.00', '0'],
    ['0', '0'],
  ]

  for (const [text, expected] of accepted) {
    it(`reads ${JSON.stringify(text)} as ${expected}`, () => {
      expect(read(text)).toBe(expected)
    })
  }

  it('never uses parseFloat, which would silently truncate Indian grouping', () => {
    /* The measured reason this file exists: `parseFloat` reads a lakh as a one. */
    expect(Number.parseFloat('1,23,456.78')).toBe(1)
    expect(read('1,23,456.78')).toBe('123456.78')
  })

  it('normalises a signed zero, so a column never shows -0.00', () => {
    const attempt = parseImportAmount('(0.00)')
    expect(attempt.ok && attempt.value.isNegative()).toBe(false)
    expect(read('(0.00)')).toBe('0')
  })
})

describe('parseImportAmount — what it refuses, and what it says', () => {
  const rejected: readonly [string, RegExp][] = [
    ['', /is empty/],
    ['   ', /is empty/],
    ['abc', /not part of a number/],
    ['1,234.56 Cr', /not part of a number/],
    ['5 00', /not part of a number/],
    ['.', /punctuation with no digits/],
    [',', /punctuation with no digits/],
    ['1.2.3', /more than one decimal point/],
    ['1234,56', /comma as the decimal point/],
    ['1.234,56', /comma as the decimal point/],
    ['1,5', /comma as the decimal point/],
    ['1,2345', /neither Indian nor Western/],
    ['12,34,5.67', /neither Indian nor Western/],
    ['1,,234.00', /neither Indian nor Western/],
    ['1234,5678', /neither Indian nor Western/],
    ['1234,567', /neither Indian nor Western/],
    ['.50', /no digits before the decimal point/],
    ['12.', /ends with a decimal point/],
    ['(1234', /bracket that does not close/],
    ['1234)', /bracket that does not close/],
    ['(-1234)', /negative twice/],
    ['-1234-', /minus sign at both ends/],
    ['-', /has a sign but no digits/],
    ['1.234', /3 decimal places where at most 2/],
  ]

  for (const [text, message] of rejected) {
    it(`refuses ${JSON.stringify(text)}`, () => {
      expect(read(text)).toMatch(message)
    })
  }

  it('reads 1,234 as grouping rather than as a European decimal, deliberately', () => {
    /* Both readings are shapes a file could mean. `1,234` is valid grouping and is read
     * as one thousand two hundred; `1234,56` cannot be grouping in either convention and
     * is refused by name instead of being coerced. The two conditions are separate and
     * this pair is what separates them. */
    expect(read('1,234')).toBe('1234')
    expect(read('1234,56')).toMatch(/comma as the decimal point/)
  })
})

describe('parseImportAmount — sign words', () => {
  const marked = { Cr: 'positive', Dr: 'negative' } as const

  it('leaves a Dr/Cr marker unread by default, and names the leftover text', () => {
    /* Whose book the statement is decides what Cr means. Guessing inverts every sign in
     * the file and still reconciles. */
    expect(read('1,234.56 Cr')).toMatch(/not part of a number.*Cr/)
  })

  it('reads a marker when the caller declares one, spaced or glued', () => {
    expect(read('1,234.56 Cr', { signWords: marked })).toBe('1234.56')
    expect(read('1,234.56Dr', { signWords: marked })).toBe('-1234.56')
    expect(read('CR 1,234.56', { signWords: marked })).toBe('1234.56')
  })

  it('does not match a marker that a letter runs into', () => {
    /* `Incr` is not a credit. The boundary rule is on letters only, so a digit before
     * the marker still matches. */
    expect(read('1234Incr', { signWords: marked })).toMatch(/not part of a number/)
  })

  it('refuses a value that is marked positive and also carries a minus', () => {
    expect(read('-1,234.56 Cr', { signWords: marked })).toMatch(/marked .* and also carries/)
  })

  it('accepts a value that is marked negative and also carries a minus', () => {
    expect(read('-1,234.56 Dr', { signWords: marked })).toBe('-1234.56')
  })
})

describe('parseImportAmount — currency tokens', () => {
  it('takes a caller list that REPLACES the defaults rather than adding to them', () => {
    expect(read('AED 500', { currencyTokens: ['AED'] })).toBe('500')
    expect(read('₹500', { currencyTokens: ['AED'] })).toMatch(/not part of a number/)
  })

  it('strips the longer token first, so Rs. does not leave a stray dot', () => {
    expect(read('Rs.500')).toBe('500')
  })
})

describe('parseImportAmount — decimal places', () => {
  it('refuses more places than the scale allows rather than rounding them away', () => {
    /* Same reasoning as domain/money/storage.ts: a money column with three decimals
     * means something upstream is at the wrong scale, and rounding hides it. */
    expect(read('1.234')).toMatch(/3 decimal places/)
  })

  it('accepts fewer places than the scale allows', () => {
    expect(read('1.5')).toBe('1.5')
    expect(read('1')).toBe('1')
  })

  it('lets a caller raise the limit for a column that is not money', () => {
    expect(read('0.125', { maxDecimalPlaces: 3 })).toBe('0.125')
  })

  it('refuses a nonsensical limit rather than treating it as a default', () => {
    expect(() => parseImportAmount('1.00', { maxDecimalPlaces: -1 })).toThrow(CsvError)
    expect(() => parseImportAmount('1.00', { maxDecimalPlaces: 1.5 })).toThrow(CsvError)
    /* Zero IS meaningful here — whole units only — so it is accepted, unlike a size cap
     * where zero would silently disable the cap. Probed rather than assumed. */
    expect(read('1', { maxDecimalPlaces: 0 })).toBe('1')
    expect(read('1.5', { maxDecimalPlaces: 0 })).toMatch(/1 decimal places where at most 0/)
  })
})

describe('parseImportDecimal — the storage string', () => {
  it('renders at the money scale, so formatting differences collapse to one value', () => {
    const canonical = ['1234.5', '1,234.50', '+1234.5', '₹1,234.50'].map((text) => {
      const attempt = parseImportDecimal(text)
      return attempt.ok ? attempt.value : attempt.message
    })
    expect(canonical).toEqual(['1234.50', '1234.50', '1234.50', '1234.50'])
  })

  it('renders at the rate and quantity scales when asked', () => {
    const rate = parseImportDecimal('0.125', 'rate')
    expect(rate.ok && rate.value).toBe('0.125')
    const quantity = parseImportDecimal('2.5', 'quantity')
    expect(quantity.ok && quantity.value).toBe('2.500')
  })

  it('still refuses a money value with three decimals', () => {
    const attempt = parseImportDecimal('1.234', 'money')
    expect(attempt.ok).toBe(false)
  })

  it('passes a failure through with its message intact', () => {
    const attempt = parseImportDecimal('1.234,56')
    expect(attempt.ok ? '' : attempt.message).toMatch(/comma as the decimal point/)
  })
})

describe('parseDebitCredit', () => {
  const pair = (debit: string, credit: string, sign: DebitCreditSign): string => {
    const attempt = parseDebitCredit(debit, credit, { sign })
    return attempt.ok ? `${attempt.value.amount} (${attempt.value.side})` : attempt.message
  }

  it('signs a debit and a credit opposite ways round, and the convention is the caller import', () => {
    /* The pair of assertions that would catch a whole file imported with inverted signs.
     * Same two cells, two conventions, opposite answers. */
    expect(pair('1000.00', '', 'debit-positive')).toBe('1000.00 (debit)')
    expect(pair('1000.00', '', 'credit-positive')).toBe('-1000.00 (debit)')
    expect(pair('', '2000.00', 'debit-positive')).toBe('-2000.00 (credit)')
    expect(pair('', '2000.00', 'credit-positive')).toBe('2000.00 (credit)')
  })

  it('treats a written 0.00 in the unused column exactly like a blank one', () => {
    /* Statements are split roughly evenly between the two, and a few do both in one
     * file. Reading 0.00 as an amount would report every such row as having both. */
    expect(pair('0.00', '2000.00', 'credit-positive')).toBe('2000.00 (credit)')
    expect(pair('1000.00', '0.00', 'credit-positive')).toBe('-1000.00 (debit)')
    expect(pair('0', '2000.00', 'credit-positive')).toBe('2000.00 (credit)')
  })

  it('refuses a row with an amount on both sides', () => {
    expect(pair('1000.00', '2000.00', 'credit-positive')).toMatch(/both the debit and the credit/)
  })

  it('refuses a row with an amount on neither side, blank or zero', () => {
    expect(pair('', '', 'credit-positive')).toMatch(/no amount in either/)
    expect(pair('0.00', '0.00', 'credit-positive')).toMatch(/no amount in either/)
  })

  it('keeps a negative in one column and applies the column direction on top of it', () => {
    /* A reversal is written this way. `side` still names the column it came from. */
    expect(pair('-500.00', '', 'debit-positive')).toBe('-500.00 (debit)')
    expect(pair('-500.00', '', 'credit-positive')).toBe('500.00 (debit)')
  })

  it('names which of the two columns could not be read', () => {
    expect(pair('abc', '', 'credit-positive')).toMatch(/debit value that/)
    expect(pair('', 'abc', 'credit-positive')).toMatch(/credit value that/)
  })

  it('renders at the scale the caller asked for', () => {
    const attempt = parseDebitCredit('2.5', '', { sign: 'debit-positive', scale: 'quantity' })
    expect(attempt.ok && attempt.value.amount).toBe('2.500')
  })

  it('passes amount options through to both columns', () => {
    const attempt = parseDebitCredit('', '1,234.56 Cr', {
      sign: 'credit-positive',
      amount: { signWords: { Cr: 'positive' } },
    })
    expect(attempt.ok && attempt.value.amount).toBe('1234.56')
  })
})
