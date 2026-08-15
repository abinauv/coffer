/*
 * Scales, and the complete list of places where rounding is allowed to happen.
 *
 * docs/ARCHITECTURE.md §7: "Rounding: ROUND_HALF_UP, applied at defined points only —
 * never incidentally." This module is what makes "defined points" a real thing rather
 * than an aspiration. Every rounding operation in Coffer names the point it happens at,
 * so the answer to "where did this paisa go?" is always a grep away, and adding a new
 * point is a visible change to a fixture rather than an inline `.toDecimalPlaces(2)`
 * somebody slipped into a helper.
 *
 * Intermediate results are never rounded. A line's tax, a discount, a proportional
 * share — all of them carry full precision until they reach one of the points below.
 */

import { D, Decimal, MoneyError, normaliseZero, type DecimalInput } from './decimal'

/**
 * Storage scales, from docs/CONVENTIONS.md §3. These are the decimal places the
 * database columns hold, so they are also the precision the user can ever observe.
 */
export const SCALE = {
  money: 2,
  quantity: 3,
  /*
   * Three, not two, because a tax component's rate is a real stored figure and India
   * has a slab that halves into three places: 0.25% on rough diamonds splits into CGST
   * 0.125% and SGST 0.125%. At 2dp that becomes 0.13%, and the invoice would print a
   * rate the tax was never computed from.
   *
   * Rates a user picks are still whole slabs; the third place exists for what halving
   * produces, and for regimes with rates like 0.1%.
   */
  rate: 3,
} as const

export type ScaleName = keyof typeof SCALE

/** ROUND_HALF_UP — ties away from zero. The single rounding mode in the product. */
export const ROUNDING_MODE = Decimal.ROUND_HALF_UP

/**
 * Every point at which a value may be rounded, and the scale it rounds to.
 *
 * If you are about to round somewhere that is not in this list, either you have found a
 * new legitimate point — add it here, with a comment saying why it exists — or you are
 * about to introduce an incidental rounding. It is nearly always the second one.
 */
export const ROUNDING_POINTS = {
  /** Writing a monetary amount to a 2dp column, or emitting one across IPC. */
  moneyStorage: { scale: SCALE.money },
  /** Writing a quantity to a 3dp column. */
  quantityStorage: { scale: SCALE.quantity },
  /** Writing a rate or percentage to a 2dp column. */
  rateStorage: { scale: SCALE.rate },
  /** A line's extended amount, fixed once before it contributes to any total. */
  lineAmount: { scale: SCALE.money },
  /** A document or ledger total, fixed once at the end of the arithmetic chain. */
  documentTotal: { scale: SCALE.money },
  /** The smallest unit an allocation may hand out. See allocate.ts. */
  allocationUnit: { scale: SCALE.money },
  /** Whole-unit rounding of a grand total, which produces a round-off adjustment. */
  wholeUnit: { scale: 0 },
} as const

export type RoundingPoint = keyof typeof ROUNDING_POINTS

/** The decimal places a given rounding point rounds to. */
export function scaleOf(point: RoundingPoint): number {
  return ROUNDING_POINTS[point].scale
}

/**
 * Round `value` at a named point, ROUND_HALF_UP.
 *
 * This is the only rounding entry point in the codebase. A signed zero is normalised
 * so that `-0.004` at money scale is `0`, not `-0`.
 */
export function roundAt(point: RoundingPoint, value: DecimalInput): Decimal {
  const decimal = D(value)
  if (!decimal.isFinite()) {
    throw new MoneyError('NOT_FINITE', `Cannot round a non-finite value: ${decimal.toString()}`)
  }
  return normaliseZero(decimal.toDecimalPlaces(scaleOf(point), ROUNDING_MODE))
}

/** Round to the money scale (2dp) for storage or transport. */
export function roundMoney(value: DecimalInput): Decimal {
  return roundAt('moneyStorage', value)
}

/** Round to the quantity scale (3dp) for storage or transport. */
export function roundQuantity(value: DecimalInput): Decimal {
  return roundAt('quantityStorage', value)
}

/** Round to the rate scale (2dp) for storage or transport. */
export function roundRate(value: DecimalInput): Decimal {
  return roundAt('rateStorage', value)
}

/** The smallest representable unit at a scale: 0.01 at money scale, 1 at whole units. */
export function unitAt(point: RoundingPoint): Decimal {
  return new Decimal(10).pow(-scaleOf(point))
}

export interface WholeUnitRounding {
  /** The amount rounded to a whole unit, ROUND_HALF_UP. */
  rounded: Decimal
  /**
   * What was added to reach it, so that `amount.plus(adjustment)` equals `rounded`
   * exactly. Negative when the total was rounded down.
   *
   * The sign is chosen so the value can be posted as-is to a round-off line: it is the
   * adjustment, not the discarded remainder. A clean `0` is returned for a total that
   * was already whole, never `-0`.
   */
  adjustment: Decimal
}

/**
 * Round a grand total to a whole unit and report the adjustment that got it there.
 *
 * The adjustment is exact, not rounded — for a 2dp input it is already at money scale,
 * and for a higher-precision input the caller decides where it lands.
 */
export function roundToWholeUnit(amount: DecimalInput): WholeUnitRounding {
  const exact = D(amount)
  const rounded = roundAt('wholeUnit', exact)
  return { rounded, adjustment: normaliseZero(rounded.minus(exact)) }
}
