/*
 * Rupees in words — the line at the foot of every Indian invoice.
 *
 * The Indian numbering system groups after the first three digits in twos: thousand,
 * then lakh (10^5), then crore (10^7). So 12,34,567 is "twelve lakh thirty four thousand
 * five hundred sixty seven", and the western "million" never appears. Getting this wrong
 * is not a cosmetic bug — the words are the human-readable check on the figures, and a
 * cheque or an invoice whose words disagree with its numerals is disputed, not paid.
 *
 * Conventions, matching what `num2words(…, lang='en_IN')` produces once its stylistic
 * choices are normalised away:
 *
 *   - no hyphen inside a compound number: "twenty one", not "twenty-one";
 *   - no connective "and" before the tens: "one hundred one", not "one hundred and one";
 *   - Title Case throughout;
 *   - singular where the count is one: one Rupee, one Paisa.
 *
 * The framing — the rupee word after the number, then the paise tail, then "Only" — is
 * the one documented on `TaxRegime.amountInWords`. "Only" is not decoration: it is what
 * stops a figure being extended after it was signed.
 *
 * Above 999 crore the grouping recurses rather than stopping, so 10^10 is
 * "One Thousand Crore" and 10^12 is "One Lakh Crore", which is how the amounts are said.
 * Nothing here converts through a JS number, so the ceiling is decimal.js's, not 2^53's.
 */

import { D, roundAt, ZERO, type Decimal, type DecimalInput } from '@main/domain/money'

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
] as const

const TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
] as const

const CRORE = D('10000000')
const LAKH = D('100000')
const THOUSAND = D('1000')
const HUNDRED_UNITS = D('100')

function wordAt(table: readonly string[], index: number): string {
  const word = table[index]
  if (word === undefined) {
    /* Unreachable: every caller has already constrained the index to the table. */
    throw new Error(`No word for index ${String(index)}.`)
  }
  return word
}

/** 1-99 in words. Zero returns '' so a caller can drop an empty group. */
function under100(value: number): string {
  if (value === 0) {
    return ''
  }
  if (value < 20) {
    return wordAt(ONES, value)
  }
  const tens = wordAt(TENS, Math.floor(value / 10))
  const units = value % 10
  return units === 0 ? tens : `${tens} ${wordAt(ONES, units)}`
}

/** 1-999 in words. Zero returns ''. */
function under1000(value: number): string {
  if (value === 0) {
    return ''
  }
  const hundreds = Math.floor(value / 100)
  const rest = value % 100
  const parts: string[] = []
  if (hundreds > 0) {
    parts.push(`${wordAt(ONES, hundreds)} hundred`)
  }
  if (rest > 0) {
    parts.push(under100(rest))
  }
  return parts.join(' ')
}

/**
 * A whole non-negative Decimal in Indian-system words, lower case.
 *
 * The crore group recurses through this same function, which is what makes
 * "one lakh crore" fall out rather than needing a table of larger scale words.
 */
function wordsForWholeNumber(value: Decimal): string {
  if (value.isZero()) {
    return 'zero'
  }

  const crore = value.divToInt(CRORE)
  const belowCrore = value.mod(CRORE)
  const lakh = belowCrore.divToInt(LAKH)
  const belowLakh = belowCrore.mod(LAKH)
  const thousand = belowLakh.divToInt(THOUSAND)
  const remainder = belowLakh.mod(THOUSAND)

  const parts: string[] = []
  if (!crore.isZero()) {
    parts.push(`${wordsForWholeNumber(crore)} crore`)
  }
  if (!lakh.isZero()) {
    parts.push(`${under100(lakh.toNumber())} lakh`)
  }
  if (!thousand.isZero()) {
    parts.push(`${under100(thousand.toNumber())} thousand`)
  }
  if (!remainder.isZero()) {
    parts.push(under1000(remainder.toNumber()))
  }
  return parts.join(' ')
}

function titleCase(text: string): string {
  return text
    .split(' ')
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * A whole number in Indian-system words, Title Cased. Exported because the number words
 * are the part worth pinning against a generated fixture, independently of the framing.
 */
export function numberInWords(value: DecimalInput): string {
  const whole = D(value)
  if (!whole.isInteger() || whole.isNegative()) {
    throw new Error(`Expected a whole non-negative number, got ${whole.toString()}.`)
  }
  return titleCase(wordsForWholeNumber(whole))
}

/**
 * An amount in rupees and paise, as an Indian tax invoice says it.
 *
 * `1234.50` becomes 'Rupees One Thousand Two Hundred Thirty Four and Fifty Paise Only'.
 *
 * The currency word leads. That is the convention on Indian tax invoices and what every
 * accountant and CA reading a Coffer invoice will expect, and what
 * `num2words(lang='en_IN')` produces. An earlier draft of the `TaxRegime`
 * jsdoc put the rupee word after the number — that was a slip in the contract, corrected
 * there rather than here.
 *
 * The value is rounded to the paise at `moneyStorage` first, so 0.005 is one paisa and
 * not a silently discarded fraction, and a negative amount — a credit note — is spoken
 * as 'Minus …' rather than shown with a sign a reader can miss.
 */
export function amountInWords(value: DecimalInput): string {
  const amount = roundAt('moneyStorage', value)
  const isNegative = amount.lessThan(ZERO)
  const magnitude = amount.abs()

  /* Exact, not rounded again: the value is already at paise scale, so the fractional
   * part times 100 is a whole number of paise and nothing is left to discard. */
  const rupees = magnitude.floor()
  const paise = magnitude.minus(rupees).times(HUNDRED_UNITS)

  const rupeeWord = rupees.equals(1) ? 'Rupee' : 'Rupees'
  const parts = [`${rupeeWord} ${numberInWords(rupees)}`]

  if (!paise.isZero()) {
    const paiseWord = paise.equals(1) ? 'Paisa' : 'Paise'
    parts.push(`and ${numberInWords(paise)} ${paiseWord}`)
  }

  parts.push('Only')

  const words = parts.join(' ')
  return isNegative ? `Minus ${words}` : words
}
