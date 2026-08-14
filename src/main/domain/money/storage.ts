/*
 * The boundary between a Decimal in memory and a decimal string on disk or on the wire.
 *
 * docs/CONVENTIONS.md §3: money is a `Decimal` in TypeScript and a decimal string in
 * SQLite, at 2dp / 3dp / 2dp for money / quantity / rate. That conversion happens here
 * and nowhere else, in both directions.
 *
 * Reading is strict. A column that holds `'12.345'` where money was expected, or an
 * empty string, or `'NaN'`, is corruption — and the one thing worse than a loud failure
 * at that point is a quiet `NaN` propagating into a trial balance. So parsing throws.
 */

import {
  D,
  DECIMAL_STRING_PATTERN,
  isDecimalString,
  MoneyError,
  type Decimal,
  type DecimalInput,
} from './decimal'
import { roundAt, scaleOf, type RoundingPoint } from './scale'

/** An exact decimal as text — the storage and transport representation. */
import type { DecimalString } from '@shared/scalars'
export type { DecimalString }

/**
 * Parse exact decimal text into a Decimal. Throws on anything else.
 *
 * `what` names the column or field for the error message; a parse failure is a
 * data-integrity report, so it should say what it was reading.
 */
export function parseDecimalString(text: string, what = 'value'): Decimal {
  if (!isDecimalString(text)) {
    throw new MoneyError(
      'INVALID_DECIMAL_STRING',
      `${what} is not an exact decimal string: ${JSON.stringify(text)}`,
    )
  }
  return D(text)
}

/** Parse exact decimal text, or return null. For validating untrusted input. */
export function tryParseDecimalString(text: unknown): Decimal | null {
  return isDecimalString(text) ? D(text) : null
}

/** The number of decimal places written in a decimal string, 0 when there is no point. */
export function decimalPlacesIn(text: string): number {
  const match = DECIMAL_STRING_PATTERN.exec(text)
  if (match === null) {
    throw new MoneyError(
      'INVALID_DECIMAL_STRING',
      `Not an exact decimal string: ${JSON.stringify(text)}`,
    )
  }
  const pointIndex = text.indexOf('.')
  return pointIndex === -1 ? 0 : text.length - pointIndex - 1
}

/**
 * Parse a stored value that is expected to be at a given scale.
 *
 * Extra decimal places are rejected rather than rounded away: a money column holding
 * three decimals means something upstream wrote at the wrong scale, and rounding it on
 * read would hide that for as long as it takes for the totals to stop reconciling.
 */
export function parseAt(point: RoundingPoint, text: string, what = 'value'): Decimal {
  const decimal = parseDecimalString(text, what)
  const scale = scaleOf(point)
  const places = decimalPlacesIn(text)
  if (places > scale) {
    throw new MoneyError(
      'SCALE_EXCEEDED',
      `${what} has ${String(places)} decimal places but ${point} allows ${String(scale)}: ${text}`,
    )
  }
  return decimal
}

/** Read a money column. Rejects more than 2 decimal places. */
export function parseMoney(text: string, what = 'money'): Decimal {
  return parseAt('moneyStorage', text, what)
}

/** Read a quantity column. Rejects more than 3 decimal places. */
export function parseQuantity(text: string, what = 'quantity'): Decimal {
  return parseAt('quantityStorage', text, what)
}

/** Read a rate column. Rejects more than 2 decimal places. */
export function parseRate(text: string, what = 'rate'): Decimal {
  return parseAt('rateStorage', text, what)
}

/**
 * Render a value as the fixed-scale decimal string a column holds.
 *
 * This rounds, at the named point — it is one of the defined points, and the last one
 * in any chain. The result always carries exactly `scale` decimal places so that
 * stored text sorts and compares consistently, and never carries a signed zero.
 */
export function toStorageString(point: RoundingPoint, value: DecimalInput): DecimalString {
  return roundAt(point, value).toFixed(scaleOf(point))
}

/** Render for a money column: exactly 2 decimal places. */
export function toMoneyString(value: DecimalInput): DecimalString {
  return toStorageString('moneyStorage', value)
}

/** Render for a quantity column: exactly 3 decimal places. */
export function toQuantityString(value: DecimalInput): DecimalString {
  return toStorageString('quantityStorage', value)
}

/** Render for a rate column: exactly 2 decimal places. */
export function toRateString(value: DecimalInput): DecimalString {
  return toStorageString('rateStorage', value)
}
