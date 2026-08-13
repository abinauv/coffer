/*
 * The one configured decimal.js in Coffer.
 *
 * Every monetary, quantity and rate value in the application is an instance produced
 * here. Nothing else calls `Decimal.set`, `Decimal.clone`, or imports `decimal.js`
 * directly — a second configuration is a second set of rounding rules, and the whole
 * point of this module is that there is exactly one.
 *
 * Configuration, and why:
 *
 *   precision 40   Significant digits for intermediate results. Division and
 *                  percentage chains (`base * rate / 100`) are the only operations
 *                  that can produce a non-terminating result; 40 digits leaves ample
 *                  headroom above the ~15 digits a crore-scale invoice actually uses,
 *                  so nothing rounds until a named rounding point says so.
 *   ROUND_HALF_UP  Ties go away from zero: 0.5 -> 1, -0.5 -> -1, 1.005 -> 1.01.
 *                  Not banker's rounding. This is the rule the rest of the product is
 *                  specified against — see docs/ARCHITECTURE.md §7.
 *   toExpNeg/Pos   Pushed out to ±40 so `toString()` never surprises a caller with
 *                  exponential notation for a value that has to survive as text.
 *
 * The float rule (docs/CONVENTIONS.md §1.1) is enforced at the door: `D()` accepts a
 * strict decimal string, a safe integer, a bigint, or another Decimal. A `number` that
 * carries a fractional part is a runtime error, because by the time it reaches here the
 * error it carries is already baked in and unrecoverable.
 */

import DecimalJs from 'decimal.js'

/** Significant digits carried through intermediate arithmetic. */
export const PRECISION = 40

/**
 * The configured constructor. `Decimal` names both the runtime constructor and the
 * instance type, so `import { Decimal }` gives callers both.
 */
export const Decimal = DecimalJs.clone({
  precision: PRECISION,
  rounding: DecimalJs.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
})

export type Decimal = DecimalJs

/**
 * Anything that can become a Decimal without losing exactness.
 *
 * `number` is present only for whole numbers — counts, part sizes, years. Passing a
 * fractional `number` throws; write the value as a string instead.
 */
export type DecimalInput = string | number | bigint | Decimal

export type MoneyErrorCode =
  | 'INVALID_DECIMAL_STRING'
  | 'FRACTIONAL_NUMBER'
  | 'UNSAFE_NUMBER'
  | 'INVALID_INPUT'
  | 'NOT_FINITE'
  | 'SCALE_EXCEEDED'
  | 'NEGATIVE_NOT_ALLOWED'
  | 'INVALID_ALLOCATION'
  | 'ALLOCATION_INVARIANT'

/**
 * A misuse of the money primitives: a value that is not an exact decimal, or an
 * allocation that cannot be satisfied. These are programmer or data-integrity errors,
 * never something the user can act on, so they throw rather than returning a Result —
 * see docs/CONVENTIONS.md §5.
 */
export class MoneyError extends Error {
  readonly code: MoneyErrorCode

  constructor(code: MoneyErrorCode, message: string) {
    super(message)
    this.name = 'MoneyError'
    this.code = code
  }
}

/**
 * The only decimal text Coffer accepts or produces.
 *
 * Optional leading `-`, no leading `+`, no leading zeros beyond a bare `0`, at least
 * one digit either side of the point, no exponent, no separators, no whitespace.
 * `NaN` and `Infinity` are not decimals and are rejected with everything else.
 */
export const DECIMAL_STRING_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

/** True when `value` is exact decimal text this module will accept. */
export function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_STRING_PATTERN.test(value)
}

/** True when `value` is a Decimal instance. */
export function isDecimal(value: unknown): value is Decimal {
  return Decimal.isDecimal(value)
}

/**
 * Construct a Decimal.
 *
 * Strings must be exact decimal text; a malformed string throws rather than producing
 * NaN, which is the failure mode that lets bad data reach a ledger unnoticed.
 * Decimals are re-wrapped so that subsequent arithmetic uses this module's precision
 * and rounding even if the value arrived from a differently configured constructor.
 */
export function D(value: DecimalInput): Decimal {
  if (typeof value === 'string') {
    if (!DECIMAL_STRING_PATTERN.test(value)) {
      throw new MoneyError(
        'INVALID_DECIMAL_STRING',
        `Not an exact decimal string: ${JSON.stringify(value)}`,
      )
    }
    return new Decimal(value)
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new MoneyError('NOT_FINITE', `Not a finite number: ${String(value)}`)
    }
    if (!Number.isInteger(value)) {
      throw new MoneyError(
        'FRACTIONAL_NUMBER',
        `A fractional number cannot be exact: ${String(value)}. Pass the value as a string, e.g. D('${String(value)}').`,
      )
    }
    if (!Number.isSafeInteger(value)) {
      throw new MoneyError(
        'UNSAFE_NUMBER',
        `Integer beyond the safe range: ${String(value)}. Pass the value as a string.`,
      )
    }
    return new Decimal(value)
  }

  if (typeof value === 'bigint') {
    return new Decimal(value.toString())
  }

  if (!isDecimal(value)) {
    throw new MoneyError('INVALID_INPUT', `Not a decimal value: ${String(value)}`)
  }

  return new Decimal(value)
}

export const ZERO = D(0)
export const ONE = D(1)
export const HUNDRED = D(100)

/** Throw unless `value` is finite — a guard against NaN/Infinity from an earlier divide. */
export function assertFinite(value: Decimal, what = 'value'): Decimal {
  if (!value.isFinite()) {
    throw new MoneyError('NOT_FINITE', `${what} is not finite: ${value.toString()}`)
  }
  return value
}

/** Throw unless `value` is zero or positive. */
export function assertNonNegative(value: DecimalInput, what = 'value'): Decimal {
  const decimal = assertFinite(D(value), what)
  if (decimal.isNegative() && !decimal.isZero()) {
    throw new MoneyError(
      'NEGATIVE_NOT_ALLOWED',
      `${what} must not be negative: ${decimal.toString()}`,
    )
  }
  return decimal
}

/**
 * Normalise a signed zero to a plain zero.
 *
 * decimal.js preserves the sign of zero, so `-0.001` rounded to 2dp is `-0`. Left
 * alone it becomes the string `-0.00` in a column and `-0` in a report.
 */
export function normaliseZero(value: Decimal): Decimal {
  return value.isZero() ? ZERO : value
}
