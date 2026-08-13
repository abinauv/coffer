/*
 * Arithmetic helpers that add something raw decimal.js does not.
 *
 * decimal.js is already correct; wrapping it for its own sake would only add a layer to
 * read through. What is here earns its place by removing a way to be wrong: a `sum`
 * that cannot be seeded with a float, comparisons that validate their operands, and a
 * percentage that keeps full precision so the caller — not this module — decides where
 * the result rounds.
 */

import { assertFinite, D, HUNDRED, ZERO, type Decimal, type DecimalInput } from './decimal'

/**
 * Exact sum. An empty list is zero.
 *
 * The reason this exists rather than `values.reduce((a, b) => a + b, 0)`: that
 * expression, written once with a numeric seed, silently converts the whole chain to
 * floats. Here there is nothing to seed.
 */
export function sum(values: Iterable<DecimalInput>): Decimal {
  let total = ZERO
  for (const value of values) {
    total = total.plus(D(value))
  }
  return assertFinite(total, 'sum')
}

/** Exact difference of a base minus everything in `deductions`. */
export function subtractAll(base: DecimalInput, deductions: Iterable<DecimalInput>): Decimal {
  return assertFinite(D(base).minus(sum(deductions)), 'difference')
}

/** Exact product. Neither operand is rounded, and neither is the result. */
export function multiply(a: DecimalInput, b: DecimalInput): Decimal {
  return assertFinite(D(a).times(D(b)), 'product')
}

/** -1, 0 or 1. Validates both operands, which `<` on raw values does not. */
export function compare(a: DecimalInput, b: DecimalInput): -1 | 0 | 1 {
  return D(a).comparedTo(D(b)) as -1 | 0 | 1
}

/** True when the two values are numerically equal, whatever their trailing zeros. */
export function equals(a: DecimalInput, b: DecimalInput): boolean {
  return D(a).equals(D(b))
}

/** The larger of the two. */
export function max(a: DecimalInput, b: DecimalInput): Decimal {
  const left = D(a)
  const right = D(b)
  return left.greaterThan(right) ? left : right
}

/** The smaller of the two. */
export function min(a: DecimalInput, b: DecimalInput): Decimal {
  const left = D(a)
  const right = D(b)
  return left.lessThan(right) ? left : right
}

/** Constrain a value to `[lower, upper]`. */
export function clamp(value: DecimalInput, lower: DecimalInput, upper: DecimalInput): Decimal {
  return min(max(value, lower), upper)
}

/**
 * Apply a percentage rate to a base: `base * rate / 100`.
 *
 * The result is exact and unrounded. That is deliberate: this is the primitive a tax
 * regime composes with, and a regime that adds two components together needs both at
 * full precision — rounding each one first is how a two-part tax stops matching the
 * single-rate figure it is supposed to equal. Round once, at the end, at a named point.
 *
 * Only the arithmetic lives here. What the rate means, whether it splits, and what it
 * is called are entirely a matter for `regimes/` — see docs/ARCHITECTURE.md §6.2.
 */
export function percentOf(base: DecimalInput, ratePercent: DecimalInput): Decimal {
  return assertFinite(D(base).times(D(ratePercent)).dividedBy(HUNDRED), 'percentage')
}

/**
 * The rate, as a percentage, that `portion` is of `base`. Zero when the base is zero.
 *
 * Exact and unrounded, for the same reason as `percentOf`.
 */
export function percentageRate(portion: DecimalInput, base: DecimalInput): Decimal {
  const denominator = D(base)
  if (denominator.isZero()) {
    return ZERO
  }
  return assertFinite(D(portion).dividedBy(denominator).times(HUNDRED), 'rate')
}
