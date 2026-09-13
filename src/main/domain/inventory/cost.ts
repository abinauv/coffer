/*
 * The two pieces of arithmetic every valuation strategy needs, and the precision
 * decision behind them.
 *
 * ---------------------------------------------------------------------------
 * WHY A UNIT COST IS NOT MONEY
 *
 * Money is 2dp and quantity is 3dp (CONVENTIONS §3). A unit cost is neither: it is money
 * PER UNIT, and rounding it to paise before multiplying by a quantity loses rupees on
 * any stock file worth keeping.
 *
 *   100.00 over 3.000 units. At money scale the unit cost is 33.33, three units leave at
 *   99.99, and a paisa is stranded in an item that is now empty. Two of those a day for
 *   a year is a stock register that no longer agrees with the ledger, by an amount too
 *   small for anyone to chase and large enough to fail a reconciliation.
 *
 * This project has already been bitten twice by exactly this shape — `SUM()` over
 * decimal text going through floating point and losing a paisa, and tax components
 * rounded separately so that two totals disagreed. Both had the same cause: a figure was
 * rounded on the way THROUGH a calculation rather than at the end of one.
 *
 * ---------------------------------------------------------------------------
 * SO THE UNIT COST IS NOT THE RECORD. THE VALUE IS.
 *
 * The fix is not a cleverer scale, it is to stop the unit cost carrying state at all.
 * An item's stock file holds QUANTITY and VALUE; the unit cost is `value / quantity`,
 * computed for a column and never fed back in. Two consequences, and both are the reason
 * this module is written the way it is:
 *
 *   - AN ISSUE COSTS A SHARE OF THE VALUE, NOT A QUANTITY TIMES A RATE. `shareOfCost`
 *     computes `value × quantity / quantityOnHand`, which for a full issue is
 *     `value × Q / Q` — exactly the value, at any precision, with nothing left behind.
 *     Written the other way round as `quantity × (value / quantityOnHand)` it is the
 *     same number for every input this domain can hold, and it stops being obviously
 *     exact for the one case that matters most.
 *
 *   - THE ROUNDING ERROR CANNOT ACCUMULATE. Because the unit cost is re-derived from the
 *     value after every movement, a paisa gained or lost on one issue is absorbed by the
 *     next one instead of compounding. An implementation that carried the unit cost
 *     forward would compound it, which is the failure this arrangement exists to remove.
 *
 * ---------------------------------------------------------------------------
 * THE WORKING PRECISION: SIX PLACES
 *
 * `UNIT_COST_SCALE = 6`. Six, and the reasoning is a bound rather than a preference:
 *
 *   - Not 2. See above; it is not money.
 *   - Not 3. Quantity is 3dp, so a unit cost at 3dp is as lossy against a fractional
 *     quantity as 2dp is against a whole one.
 *   - Six gives `roundMoney(quantity × unitCost) === value` — the reconciliation a stock
 *     card is read for — for every quantity below 10,000 units, since the reported unit
 *     cost is out by at most 5e-7 and 10,000 × 5e-7 is half a paisa. Above that the
 *     COLUMN is a display rounding and the VALUE is still exact, because no value in
 *     this module was ever computed from a unit cost. That is invariant 1 stated as a
 *     measurement.
 *
 * ROUNDING POINTS. `roundAt` in `domain/money` is the only rounding entry point in the
 * codebase and its list of named points has no unit-cost entry. That is correct today —
 * nothing stores a unit cost in Phase 4.1, so there is no column for a point to name —
 * and it is a change to `domain/money/scale.ts` when the stock ledger table lands, not a
 * change this module may make on its own (CONVENTIONS §8: own your paths). Until then
 * the scale lives here, with the mode taken from `domain/money` rather than invented, so
 * that a unit cost rounds half-up like everything else in the product.
 */

import { ROUNDING_MODE, ZERO, normaliseZero, roundMoney, type Decimal } from '@main/domain/money'

/** Decimal places a reported unit cost carries. See the header for the bound behind it. */
export const UNIT_COST_SCALE = 6

/** Round a unit cost to its reporting scale, half-up, with no signed zero. */
export function roundUnitCost(value: Decimal): Decimal {
  return normaliseZero(value.toDecimalPlaces(UNIT_COST_SCALE, ROUNDING_MODE))
}

/**
 * Average cost per unit of what is on hand.
 *
 * ZERO when nothing is on hand — not NaN, not Infinity, and emphatically not the last
 * average. An item that has run down to nothing has no average cost, and the next
 * receipt sets a fresh one; carrying the old figure forward is the bug that makes a
 * re-stocked item report the price it sold at last season.
 *
 * A caller reaching here with a diverged state (value against no quantity) still gets
 * ZERO rather than a division by zero. `checkState` is what names that state; this
 * function's job is only to never be the place a NaN is born.
 */
export function unitCostOf(quantity: Decimal, value: Decimal): Decimal {
  if (quantity.isZero() || !quantity.isFinite() || !value.isFinite()) {
    return ZERO
  }
  return roundUnitCost(value.dividedBy(quantity))
}

/**
 * The share of `total` that `portion` out of `whole` carries, at money scale.
 *
 * The primitive behind two rules that look different and are the same arithmetic:
 *
 *   - What an issue costs: the share of the value on hand that the quantity leaving
 *     represents. `portion === whole` gives back `total` exactly, so an item issued down
 *     to nothing has a value of exactly nothing.
 *   - What a PARTIAL sales return brings back: the share of the original issue's cost
 *     that the returned quantity represents. The caller holds the original row; this is
 *     the arithmetic it needs, so that returning 10 of 60 does not have to be worked out
 *     twice in two places and rounded differently each time.
 *
 * A `whole` of zero returns ZERO. It is reachable — issuing a quantity of zero from an
 * item holding nothing is a legal no-op — and it is the only division here that could
 * otherwise produce a NaN.
 */
export function shareOfCost(total: Decimal, portion: Decimal, whole: Decimal): Decimal {
  if (whole.isZero()) {
    return ZERO
  }
  return roundMoney(total.times(portion).dividedBy(whole))
}
