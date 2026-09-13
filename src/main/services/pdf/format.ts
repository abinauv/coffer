/*
 * Turning the figures on a print model into the text that goes on the page.
 *
 * ---------------------------------------------------------------------------
 * FORMATTING IS NOT COMPUTING, AND THE LINE BETWEEN THEM IS EXACTLY WHERE §1.7 PUTS IT
 *
 * CONVENTIONS §1.7 says the renderer never computes money and DOES format it — where the
 * separators go is presentation. The same division applies here. Nothing below parses an
 * amount into a `number`, adds anything to anything, or changes a value: every function
 * takes a decimal string that main has already worked out and rearranges its characters.
 *
 * ---------------------------------------------------------------------------
 * THE GROUPING IS A PARAMETER, WITH NO DEFAULT, AND THAT IS DELIBERATE
 *
 * `formatAmount` in the renderer used to hard-code the Indian lakh/crore convention, and
 * 2.2e-2 removed it: a default would have been the same bug with better manners, since
 * the default was silently wrong for everyone outside India. It is required here for the
 * same reason, and the print model carries a `NumberFormat` taken from the regime
 * description so that a call site with no format fails to compile rather than quietly
 * printing 1,234,567 as 12,34,567.
 *
 * ---------------------------------------------------------------------------
 * A VALUE THAT IS NOT A DECIMAL STRING IS RETURNED UNCHANGED
 *
 * The same rule the renderer's formatter follows. A figure main has not vouched for
 * should look wrong on the page rather than be quietly rendered as something plausible —
 * and because it is returned as it arrived, it is still user text and still goes through
 * the escaper on its way into the document. There is a test for exactly that.
 *
 * ---------------------------------------------------------------------------
 * DATES ARE NOT ON `NumberFormat`, SO THE FORM IS CHOSEN HERE AND NAMED
 *
 * `NumberFormat` describes digits and currency and says nothing about dates, so there is
 * no regime rule to read. What this file does instead of inventing one is refuse to be
 * ambiguous: the month is written as a word, so `09 Feb 2027` cannot be read as the 2nd
 * of September by somebody who assumed the other convention. No locale is consulted,
 * because a document rendered on one machine and read on another must not depend on
 * which. When the regime gains a date rule this is where it plugs in — see the report.
 */

import type { DateString, DecimalString, NumberFormat } from '@shared/dto'

/*
 * The same shape the renderer's `formatAmount` accepts, on purpose. It is deliberately
 * looser than `DECIMAL_STRING_PATTERN` in domain/money — which refuses a leading zero —
 * so that the two formatters agree about every input on the day they are merged into
 * `shared/`. See the report.
 */
const DECIMAL_TEXT = /^-?\d+(?:\.\d+)?$/

/** True when `value` is text this file will rearrange rather than pass through. */
export function isFormattableDecimal(value: string): boolean {
  return DECIMAL_TEXT.test(value)
}

/**
 * Group a run of digits the way the regime groups them.
 *
 * `groupSizes` is read from the right and the last entry repeats: `[3, 2]` gives the
 * Indian `12,34,567` and `[3]` gives `1,234,567`. Written on the string rather than by
 * dividing, because an amount can be longer than a `number` represents exactly and this
 * whole file exists so that nothing converts.
 */
export function groupDigits(digits: string, format: NumberFormat): string {
  const parts: string[] = []
  let rest = digits

  for (let index = 0; rest.length > 0; index += 1) {
    const size = format.groupSizes[Math.min(index, format.groupSizes.length - 1)]
    /*
     * No sizes, or a nonsensical one. A size of 0 is harmless — `slice(0, -0)` is `''`,
     * so the loop drains and stops — but a NEGATIVE one never empties `rest` and hangs
     * the render. The rule arrives from a compliance pack the regime loads at runtime, so
     * neither is theoretical. Measured in the renderer's copy of this function.
     */
    if (size === undefined || size <= 0 || rest.length <= size) {
      parts.unshift(rest)
      break
    }
    parts.unshift(rest.slice(-size))
    rest = rest.slice(0, -size)
  }

  return parts.join(format.groupSeparator)
}

function split(value: string): { sign: string; whole: string; fraction: string } {
  const sign = value.startsWith('-') ? '-' : ''
  const unsigned = sign === '' ? value : value.slice(1)
  const [whole = '0', fraction = ''] = unsigned.split('.')
  return { sign, whole, fraction }
}

/**
 * An amount as it appears in a money column: grouped, always two places, sign kept.
 *
 * THE MINUS SIGN IS NOT THE REGIME'S TO CHOOSE and is written the way it arrived. A
 * round-off of minus forty paise is a real negative on the face of a document, and a
 * locale that put it in brackets would have to be taught to everything that reads a
 * figure back — CONVENTIONS §1.7 keeps that scan to one place.
 */
export function formatAmount(value: DecimalString, format: NumberFormat): string {
  if (!isFormattableDecimal(value)) return value

  const { sign, whole, fraction } = split(value)
  const places = fraction.padEnd(2, '0').slice(0, 2)
  return `${sign}${groupDigits(whole, format)}${format.decimalSeparator}${places}`
}

/**
 * A quantity: grouped, and with the trailing zeros of its storage scale taken off.
 *
 * Quantities are stored at 3dp because a unit may allow three (CONVENTIONS §3), so a
 * count of ten arrives as `10.000`. Printing that in a Qty column claims a precision
 * nobody stated; `10` and `2.5` are what a store-keeper and a customer both expect.
 * Nothing is rounded — only zeros carrying no information go, so `2.505` stays `2.505`.
 */
export function formatQuantity(value: DecimalString, format: NumberFormat): string {
  if (!isFormattableDecimal(value)) return value

  const { sign, whole, fraction } = split(value)
  const kept = fraction.replace(/0+$/, '')
  const tail = kept === '' ? '' : `${format.decimalSeparator}${kept}`
  return `${sign}${groupDigits(whole, format)}${tail}`
}

/**
 * A rate, as a percentage.
 *
 * Trailing zeros go for the same reason as on a quantity, and the third place stays where
 * it matters: half of India's 0.25% slab is 0.125%, and ARCHITECTURE §7 records that
 * printing it as 0.13% would show a rate the tax was never computed from.
 *
 * No grouping, and this is not an oversight. A percentage is never large enough to need
 * it, and a rate carrying a thousands separator would read as two numbers.
 */
export function formatRate(value: DecimalString): string {
  if (!isFormattableDecimal(value)) return value

  const { sign, whole, fraction } = split(value)
  const kept = fraction.replace(/0+$/, '')
  return `${sign}${whole}${kept === '' ? '' : `.${kept}`}%`
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * A date on the face of a document: `2027-02-09` becomes `09 Feb 2027`.
 *
 * Deterministic and clock-free — the date arrives on the model, is never taken from
 * `new Date()`, and is never handed to `Intl`. A month written as a word is what makes it
 * unreadable as anything but what it is; see the header.
 *
 * Anything that is not a `YYYY-MM-DD` string comes back unchanged, and the month index is
 * checked rather than trusted, so `2027-13-09` prints as itself rather than as
 * `09 undefined 2027`.
 */
export function formatPrintDate(value: DateString): string {
  const match = ISO_DATE.exec(value)
  if (match === null) return value

  const [, year, month, day] = match
  if (year === undefined || month === undefined || day === undefined) return value

  const name = MONTHS[Number(month) - 1]
  if (name === undefined) return value

  return `${day} ${name} ${year}`
}

/** True for any spelling of zero: '0', '0.00', '-0.00'. Text only; nothing is parsed. */
export function isZeroAmount(value: DecimalString): boolean {
  return /^-?0+(?:\.0+)?$/.test(value)
}
