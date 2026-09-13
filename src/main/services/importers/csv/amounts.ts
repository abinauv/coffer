/*
 * Reading an amount out of somebody's bank statement.
 *
 * EVERYTHING HERE GOES THROUGH `domain/money`. Not `parseFloat`, not `Number`, not once,
 * not for a length check. CONVENTIONS §1.1 is the rule; the mechanism is that `D()`
 * accepts only exact decimal text, so this file's whole job is to turn what a bank wrote
 * into exact decimal text and hand it over. `parseFloat('1,23,456.78')` returns `1`
 * without complaining, and `Number('₹1234.56')` returns NaN — the first is how a paisa
 * (and a lakh) goes missing, and the second is how a column of amounts becomes a column
 * of zeroes.
 *
 * WHAT A BANK ACTUALLY WRITES, and every one of these is here because a file does it:
 *
 *   1,23,456.78     Indian grouping: last group of three, everything above in twos.
 *   123,456.78      Western grouping. Both are accepted; the shapes are checked, not
 *                   assumed, so `1,2345` and `12,34,5.67` are refused rather than read
 *                   as some number nobody wrote.
 *   (1,234.56)      Parentheses for negative. Accounting convention, and Excel's own
 *                   default number format writes it.
 *   -450.00         Leading minus.
 *   450.00-         Trailing minus. A mainframe convention, still common in statements
 *                   from core banking systems.
 *   ₹ 2,500.00      Currency symbol, with or without a space. Also `Rs.`, `Rs`, `INR`.
 *   1,234.56 Cr     A Dr/Cr marker. NOT read by default — see below.
 *
 * A COMMA IS A GROUP SEPARATOR AND NEVER A DECIMAL POINT. `1.234,56` is a real way to
 * write twelve hundred and thirty-four rupees fifty-six in much of Europe, and reading
 * it as one thousand two hundred would be wrong by a factor of a thousand while looking
 * entirely plausible. So a value whose commas cannot be grouping is refused BY NAME —
 * the message says it looks like European formatting — rather than being coerced.
 *
 * DR/CR MARKERS ARE NOT INTERPRETED BY DEFAULT, and this is the same discipline as the
 * date format. Whether `Cr` means a positive or a negative depends on whose book the
 * statement is: a bank statement is the BANK's ledger, in which your deposit is a credit
 * because the bank owes you more. Guessing gets a whole file's signs inverted, which
 * balances perfectly and is wrong on every row. So `signWords` is an explicit option and
 * an unconfigured `Cr` is a parse failure whose message names the leftover text.
 *
 * THE SAME TRAP, ONE LEVEL UP, IS IN `parseDebitCredit`: `sign` has NO DEFAULT. See its
 * doc comment.
 */

import {
  D,
  normaliseZero,
  SCALE,
  toStorageString,
  type Decimal,
  type DecimalString,
  type RoundingPoint,
  type ScaleName,
} from '@main/domain/money'

import { CsvError, parsed, unparsed, type FieldParse } from './errors'
import { foldText } from './text'

/** Currency markers stripped from either end unless the caller names its own. */
export const DEFAULT_CURRENCY_TOKENS: readonly string[] = [
  '₹',
  'rs.',
  'rs',
  'inr',
  'usd',
  'eur',
  'gbp',
  '$',
  '€',
  '£',
]

export interface AmountOptions {
  /**
   * Words or letters that fix the sign, e.g. `{ Dr: 'negative', Cr: 'positive' }`.
   * Matched at either end, case-insensitively, and only where a letter does not run into
   * them — so `1234Cr` matches and `Incr` does not. Empty by default: see the header.
   */
  readonly signWords?: Readonly<Record<string, 'positive' | 'negative'>>
  /** Overrides `DEFAULT_CURRENCY_TOKENS` entirely rather than adding to it. */
  readonly currencyTokens?: readonly string[]
  /**
   * More decimal places than this is a refusal, not a rounding. Same reasoning as
   * `parseAt` in domain/money/storage.ts: a money column carrying three decimals means
   * something upstream is at the wrong scale, and rounding it away on read hides that
   * until the totals stop reconciling. Defaults to the money scale.
   */
  readonly maxDecimalPlaces?: number
}

/**
 * Read one amount cell as a `Decimal`.
 *
 * The value is exact and unrounded; `parseImportDecimal` is the version that returns the
 * canonical storage string at a named scale.
 */
export function parseImportAmount(text: string, options: AmountOptions = {}): FieldParse<Decimal> {
  const maxDecimalPlaces = options.maxDecimalPlaces ?? SCALE.money
  if (!Number.isSafeInteger(maxDecimalPlaces) || maxDecimalPlaces < 0) {
    throw new CsvError(
      'CSV_SPEC_INVALID',
      `maxDecimalPlaces must be zero or a positive whole number, not ${String(maxDecimalPlaces)}.`,
    )
  }
  const currencyTokens = byLengthDescending(options.currencyTokens ?? DEFAULT_CURRENCY_TOKENS)
  const signWords = options.signWords ?? {}

  let value = foldText(text)
  if (value === '') {
    return unparsed('is empty')
  }

  const word = stripSignWord(value, signWords)
  value = word.value
  value = stripTokens(value, currencyTokens)

  let bracketed = false
  if (value.startsWith('(') && value.endsWith(')') && value.length >= 2) {
    bracketed = true
    value = value.slice(1, -1).trim()
  } else if (value.includes('(') || value.includes(')')) {
    return unparsed(`has a bracket that does not close: ${JSON.stringify(foldText(text))}`)
  }

  /* Again, because `(₹1,234.56)` puts the symbol inside the brackets. */
  value = stripTokens(value, currencyTokens)

  const leadingMinus = value.startsWith('-')
  const leadingPlus = value.startsWith('+')
  if (leadingMinus || leadingPlus) {
    value = value.slice(1).trim()
  }
  const trailingMinus = value.endsWith('-')
  const trailingPlus = value.endsWith('+')
  if (trailingMinus || trailingPlus) {
    value = value.slice(0, -1).trim()
  }
  if (leadingMinus && trailingMinus) {
    return unparsed('carries a minus sign at both ends')
  }
  if (bracketed && (leadingMinus || trailingMinus)) {
    return unparsed('is written as negative twice, in brackets and with a minus sign')
  }

  /* And once more, because `-₹500` puts the sign OUTSIDE the symbol. Three passes reads
   * like superstition and is not: each one is a different nesting a real file uses —
   * `₹500`, `(₹500)` and `-₹500` — and stripping is idempotent, so a value with none of
   * them is untouched. */
  value = stripTokens(value, currencyTokens)

  const signedNegative = bracketed || leadingMinus || trailingMinus
  let negative = signedNegative
  if (word.sign !== null) {
    if (word.sign === 'positive' && signedNegative) {
      return unparsed(`is marked ${JSON.stringify(word.token)} and also carries a minus sign`)
    }
    negative = word.sign === 'negative' || signedNegative
  }

  if (value === '') {
    return unparsed('has a sign but no digits')
  }
  if (!/^[0-9.,]+$/.test(value)) {
    return unparsed(`has characters in it that are not part of a number: ${JSON.stringify(value)}`)
  }
  if (!/[0-9]/.test(value)) {
    return unparsed(`is punctuation with no digits in it: ${JSON.stringify(value)}`)
  }

  /* Before the shape checks, so that `1.234,56` gets the message that names the problem
   * instead of the generic one about grouping. */
  if (looksEuropean(value)) {
    return unparsed(
      `uses a comma as the decimal point (${JSON.stringify(value)}); Coffer reads a comma only as a ` +
        'thousands separator, so the file has to be exported with a dot',
    )
  }

  const points = value.split('.')
  if (points.length > 2) {
    return unparsed('has more than one decimal point')
  }
  const integerText = points[0] ?? ''
  const fractionText = points[1] ?? ''

  if (integerText === '') {
    return unparsed('has no digits before the decimal point')
  }
  if (points.length === 2 && fractionText === '') {
    return unparsed('ends with a decimal point and no digits after it')
  }
  if (!/^\d*$/.test(fractionText)) {
    /* Only reachable for a comma AFTER the decimal point, which `looksEuropean` has
     * already claimed — kept so that the fraction below is digits by construction and
     * not by an argument two branches away. */
    return unparsed(`has a separator after the decimal point: ${JSON.stringify(value)}`)
  }
  if (!groupingIsValid(integerText)) {
    return unparsed(
      `groups its digits in a way that is neither Indian nor Western: ${JSON.stringify(integerText)}`,
    )
  }
  if (fractionText.length > maxDecimalPlaces) {
    return unparsed(
      `has ${String(fractionText.length)} decimal places where at most ${String(maxDecimalPlaces)} are allowed`,
    )
  }

  /* `D()` refuses leading zeros, so `007.50` has to become `7.50` here rather than
   * throwing three layers down with a message about a decimal string. */
  const digits = integerText.replace(/,/g, '').replace(/^0+(?=\d)/, '')
  const decimalText = `${negative ? '-' : ''}${digits}${fractionText === '' ? '' : `.${fractionText}`}`

  /* `-0.00` is a zero. Left alone it prints as `-0.00` in a column and sorts oddly. */
  return parsed(normaliseZero(D(decimalText)))
}

/** The scale a mapped decimal is stored at, and the rounding point that writes it. */
const STORAGE_POINT: Readonly<Record<ScaleName, RoundingPoint>> = {
  money: 'moneyStorage',
  quantity: 'quantityStorage',
  rate: 'rateStorage',
}

/**
 * Read one amount cell as the canonical storage string at a named scale.
 *
 * The string is what crosses a boundary and what the duplicate fingerprint hashes, so it
 * is fixed-width by scale: `1234.5`, `1,234.50` and `+1234.5` all become `1234.50`, and
 * a re-export that changes only the formatting does not read as a new transaction.
 *
 * No rounding happens in practice — anything with more places than the scale allows was
 * already refused — but the value passes through the named rounding point so that the
 * output is exactly the text a 2dp column holds.
 */
export function parseImportDecimal(
  text: string,
  scale: ScaleName = 'money',
  options: AmountOptions = {},
): FieldParse<DecimalString> {
  const attempt = parseImportAmount(text, {
    ...options,
    maxDecimalPlaces: options.maxDecimalPlaces ?? SCALE[scale],
  })
  return attempt.ok ? parsed(toStorageString(STORAGE_POINT[scale], attempt.value)) : attempt
}

/**
 * Which way a debit points.
 *
 * NO DEFAULT, EVER, AND THE REASON IS WORTH THE SENTENCE. A bank statement is the BANK's
 * book, not yours: money you paid out appears in its "debit" column because the bank's
 * liability to you went down. An importer building YOUR ledger from that statement wants
 * `credit-positive`. An importer reading an export of your own accounting system wants
 * `debit-positive`. Choose the wrong one and every amount in the file has the wrong
 * sign, the file still reconciles against itself, and the closing balance is out by
 * exactly twice the net movement — which reads like a starting-balance problem.
 */
export type DebitCreditSign = 'debit-positive' | 'credit-positive'

/** An amount, and which of the two columns it came out of. */
export interface SignedAmount {
  readonly amount: DecimalString
  readonly side: 'debit' | 'credit'
}

export interface DebitCreditOptions {
  readonly sign: DebitCreditSign
  readonly scale?: ScaleName
  readonly amount?: AmountOptions
}

/**
 * Read a pair of Debit and Credit columns as one signed amount.
 *
 * A BLANK SIDE AND A ZERO SIDE ARE THE SAME THING. Statements are split roughly evenly
 * between leaving the unused column empty and writing `0.00` in it, and a few do both in
 * one file. Treating `0.00` as a real amount would report every row of the second kind
 * as "has both a debit and a credit". A row that is zero on BOTH sides is therefore "has
 * neither": a movement of nothing is not a transaction.
 *
 * A NEGATIVE IN ONE COLUMN IS KEPT AND IS NOT AN ERROR. Reversals are written that way.
 * `side` still names the column the value came from, and the column's direction is
 * applied on top of whatever sign the value carried — so a `-500` in a debit column of a
 * `debit-positive` file is a credit of 500, which is what the bank meant.
 */
export function parseDebitCredit(
  debitText: string,
  creditText: string,
  options: DebitCreditOptions,
): FieldParse<SignedAmount> {
  const scale = options.scale ?? 'money'
  const amountOptions = options.amount ?? {}

  const debit = readSide(debitText, 'debit', amountOptions)
  if (!debit.ok) {
    return debit
  }
  const credit = readSide(creditText, 'credit', amountOptions)
  if (!credit.ok) {
    return credit
  }

  if (debit.value !== null && credit.value !== null) {
    return unparsed('has an amount in both the debit and the credit column')
  }
  const present = debit.value ?? credit.value
  if (present === null) {
    return unparsed('has no amount in either the debit or the credit column')
  }

  const side: 'debit' | 'credit' = debit.value === null ? 'credit' : 'debit'
  const positiveSide = options.sign === 'debit-positive' ? 'debit' : 'credit'
  const signed = side === positiveSide ? present : present.negated()

  return parsed({
    amount: toStorageString(STORAGE_POINT[scale], normaliseZero(signed)),
    side,
  })
}

// ---- Internals ------------------------------------------------------------

function readSide(
  text: string,
  what: 'debit' | 'credit',
  options: AmountOptions,
): FieldParse<Decimal | null> {
  if (foldText(text) === '') {
    return parsed(null)
  }
  const attempt = parseImportAmount(text, options)
  if (!attempt.ok) {
    return unparsed(`has a ${what} value that ${attempt.message}`)
  }
  return parsed(attempt.value.isZero() ? null : attempt.value)
}

function byLengthDescending(tokens: readonly string[]): readonly string[] {
  /* `Rs.` has to be tried before `Rs`, or the dot is left behind and the value stops
   * being a number for a reason the message cannot explain. */
  return [...tokens].sort((a, b) => b.length - a.length)
}

/** True when the character is a letter, for the boundary rule on alphabetic tokens. */
function isLetter(character: string): boolean {
  return /[A-Za-z]/.test(character)
}

function stripTokens(value: string, tokens: readonly string[]): string {
  let result = value
  /* Bounded: at most one token from each end, twice over, so `Rs. 500 INR` reduces and a
   * pathological value cannot spin the loop. */
  for (let pass = 0; pass < 2; pass += 1) {
    for (const token of tokens) {
      const lower = result.toLowerCase()
      const key = token.toLowerCase()
      if (lower.startsWith(key) && !isLetter(result.charAt(key.length))) {
        result = result.slice(key.length).trim()
        continue
      }
      if (lower.endsWith(key) && !isLetter(result.charAt(result.length - key.length - 1))) {
        result = result.slice(0, result.length - key.length).trim()
      }
    }
  }
  return result
}

function stripSignWord(
  value: string,
  words: Readonly<Record<string, 'positive' | 'negative'>>,
): { value: string; sign: 'positive' | 'negative' | null; token: string } {
  for (const token of byLengthDescending(Object.keys(words))) {
    const sign = words[token]
    if (sign === undefined) {
      continue
    }
    const lower = value.toLowerCase()
    const key = token.toLowerCase()
    if (lower.endsWith(key) && !isLetter(value.charAt(value.length - key.length - 1))) {
      return { value: value.slice(0, value.length - key.length).trim(), sign, token }
    }
    if (lower.startsWith(key) && !isLetter(value.charAt(key.length))) {
      return { value: value.slice(key.length).trim(), sign, token }
    }
  }
  return { value, sign: null, token: '' }
}

/**
 * True when the commas in `numeric` cannot be thousands separators.
 *
 * Three cases, and each excludes something the others do not:
 *   a dot AFTER the last comma  -> `1,234.56`, ordinary grouping, not European.
 *   a dot BEFORE the last comma -> `1.234,56`, European for certain.
 *   no dot at all               -> European only when one or two digits follow the last
 *                                  comma, because no grouping ends in a short group.
 *                                  `1,234` therefore reads as grouping, which is the
 *                                  documented choice for this product.
 */
function looksEuropean(numeric: string): boolean {
  const lastComma = numeric.lastIndexOf(',')
  if (lastComma === -1) {
    return false
  }
  const lastDot = numeric.lastIndexOf('.')
  if (lastDot > lastComma) {
    return false
  }
  if (lastDot !== -1) {
    return true
  }
  const digitsAfter = numeric.length - lastComma - 1
  return digitsAfter === 1 || digitsAfter === 2
}

/**
 * True when the integer part is grouped the Indian way, the Western way, or not at all.
 *
 * Indian: the last group is three digits and every group above it is two — `12,34,567`.
 * Western: every group after the first is three — `12,345,678`.
 * The first group is one to three digits under both. A number with no comma at all is
 * accepted whatever its length, because ungrouped is not mis-grouped.
 */
function groupingIsValid(integerText: string): boolean {
  const groups = integerText.split(',')
  if (groups.some((group) => !/^\d+$/.test(group))) {
    return false
  }
  if (groups.length === 1) {
    return true
  }
  const first = groups[0] ?? ''
  if (first.length < 1 || first.length > 3) {
    return false
  }
  const rest = groups.slice(1)
  const western = rest.every((group) => group.length === 3)
  const last = rest[rest.length - 1] ?? ''
  const indian = last.length === 3 && rest.slice(0, -1).every((group) => group.length === 2)
  return western || indian
}
