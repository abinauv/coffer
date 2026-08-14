import { describe, expect, it } from 'vitest'
import { D } from '@main/domain/money'
import { amountInWords, numberInWords } from './amount-in-words'
import fixture from './__fixtures__/amount-in-words.json'

interface AmountCase {
  amount: string
  words: string
  why?: string
}

interface NumberCase {
  value: string
  words: string
}

const golden = fixture as unknown as { cases: AmountCase[]; numbers: NumberCase[] }

describe('amountInWords — golden cases', () => {
  for (const entry of golden.cases) {
    it(`${entry.amount} is '${entry.words}'${entry.why === undefined ? '' : ` — ${entry.why}`}`, () => {
      expect(amountInWords(D(entry.amount))).toBe(entry.words)
    })
  }

  it('covers the whole set', () => {
    /* A fixture silently emptied by a bad edit would leave every case above passing
     * vacuously. */
    expect(golden.cases.length).toBeGreaterThan(60)
  })
})

describe('numberInWords — the Indian grouping, independent of the rupee framing', () => {
  for (const entry of golden.numbers) {
    it(`${entry.value} is '${entry.words}'`, () => {
      expect(numberInWords(entry.value)).toBe(entry.words)
    })
  }

  it('rejects a fraction — the caller splits rupees from paise first', () => {
    expect(() => numberInWords('1.5')).toThrow()
  })

  it('rejects a negative — the sign is the framing’s business, not the grouping’s', () => {
    expect(() => numberInWords('-1')).toThrow()
  })
})

describe('the properties the words have to hold', () => {
  it('never says "and Zero Paise"', () => {
    expect(amountInWords(D('500'))).toBe('Rupees Five Hundred Only')
    expect(amountInWords(D('500.00'))).toBe('Rupees Five Hundred Only')
  })

  it('always ends in Only, which is what stops a figure being extended', () => {
    for (const entry of golden.cases) {
      expect(amountInWords(D(entry.amount)).endsWith(' Only')).toBe(true)
    }
  })

  it('uses no hyphen and no connective "and" inside the number', () => {
    for (const entry of golden.numbers) {
      expect(numberInWords(entry.value)).not.toContain('-')
      expect(numberInWords(entry.value).split(' ')).not.toContain('And')
    }
  })

  it('says lakh and crore, never million or billion', () => {
    const words = amountInWords(D('1234567890.12'))
    expect(words).toContain('Crore')
    expect(words).toContain('Lakh')
    expect(words).not.toMatch(/Million|Billion/)
  })

  it('accepts a decimal string as readily as a Decimal', () => {
    expect(amountInWords('1234.50')).toBe(amountInWords(D('1234.50')))
  })

  it('rounds at the money point rather than truncating', () => {
    /* 0.005 is a paisa, not nothing. Truncation here would quietly under-state every
     * amount whose third decimal survived an earlier calculation. */
    expect(amountInWords(D('0.005'))).toBe('Rupees Zero and One Paisa Only')
    expect(amountInWords(D('0.0049'))).toBe('Rupees Zero Only')
  })
})
