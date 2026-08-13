/*
 * Splitting an amount without losing or inventing a paisa.
 *
 * The problem: 100.00 shared three ways. Each share is 33.333..., which at money scale
 * is 33.33, which sums to 99.99. A paisa has vanished. Round up instead and 100.02
 * appears from nowhere. Either way the ledger stops balancing, and it does so for an
 * amount too small for anyone to notice until a reconciliation fails months later.
 *
 * The fix is the largest-remainder method:
 *
 *   1. Give every part its exact share, truncated toward zero at the target scale.
 *      Truncation guarantees the shares never exceed the total, so the residue always
 *      has the same sign as the total and is smaller than one unit per part.
 *   2. Hand the residue out one unit at a time, to the parts whose truncated share gave
 *      up the most, ties broken by position.
 *   3. Assert the result sums back to the total exactly. It always does; the assertion
 *      is there so that if it ever does not, it fails here rather than in a report.
 *
 * So 100.00 three ways is [33.34, 33.33, 33.33] — the first part absorbs the paisa, and
 * the sum is 100.00. The result is deterministic: the same inputs always produce the
 * same split, which matters when the split is persisted and recomputed later.
 *
 * This is the primitive behind payment allocation across invoices and behind
 * distributing a tax amount over its components. Neither of those rules lives here.
 */

import { D, Decimal, MoneyError, type DecimalInput } from './decimal'
import { sum } from './arithmetic'
import { roundAt, scaleOf, unitAt, type RoundingPoint } from './scale'

export interface AllocationOptions {
  /**
   * The rounding point that fixes the smallest unit each part may receive. Defaults to
   * `allocationUnit` — money scale, 0.01. Use `quantityStorage` to split a quantity.
   */
  point?: RoundingPoint
}

const DEFAULT_POINT: RoundingPoint = 'allocationUnit'

/**
 * Split `total` into `parts` equal shares whose sum is exactly `total`.
 *
 * Any residue goes to the earliest parts, one unit each.
 */
export function allocate(
  total: DecimalInput,
  parts: number,
  options: AllocationOptions = {},
): Decimal[] {
  if (!Number.isSafeInteger(parts) || parts < 1) {
    throw new MoneyError(
      'INVALID_ALLOCATION',
      `Cannot split into ${String(parts)} parts; expected a positive whole number.`,
    )
  }
  return allocateByWeights(total, new Array<number>(parts).fill(1), options)
}

/**
 * Split `total` in proportion to `weights`, so that the shares sum to exactly `total`.
 *
 * Weights may be any non-negative values in any unit — line amounts, days, ratios. A
 * weight of zero receives nothing (before residue), and at least one weight must be
 * non-zero. A negative weight is rejected: it would let a share point away from the
 * total and break the guarantee this function exists to provide.
 */
export function allocateByWeights(
  total: DecimalInput,
  weights: readonly DecimalInput[],
  options: AllocationOptions = {},
): Decimal[] {
  const point = options.point ?? DEFAULT_POINT

  if (weights.length === 0) {
    throw new MoneyError('INVALID_ALLOCATION', 'Cannot allocate across zero parts.')
  }

  const parsedWeights = weights.map((weight, index) => {
    const value = D(weight)
    if (!value.isFinite()) {
      throw new MoneyError(
        'INVALID_ALLOCATION',
        `Weight ${String(index)} is not finite: ${value.toString()}`,
      )
    }
    if (value.isNegative() && !value.isZero()) {
      throw new MoneyError(
        'INVALID_ALLOCATION',
        `Weight ${String(index)} is negative: ${value.toString()}`,
      )
    }
    return value
  })

  const totalWeight = sum(parsedWeights)
  if (totalWeight.isZero()) {
    throw new MoneyError('INVALID_ALLOCATION', 'Cannot allocate across weights that sum to zero.')
  }

  /* The amount actually being split. Fixing it at the target scale here is what makes
   * the exactness guarantee meaningful: the shares sum to this, not to whatever
   * higher-precision value the caller happened to hold. */
  const amount = roundAt(point, total)
  const unit = unitAt(point)
  const scale = scaleOf(point)

  const shares: Decimal[] = []
  const shortfalls: { index: number; shortfall: Decimal }[] = []

  parsedWeights.forEach((weight, index) => {
    const exactShare = amount.times(weight).dividedBy(totalWeight)
    /* Truncate toward zero, never away: the residue must not change sign. */
    const share = exactShare.toDecimalPlaces(scale, Decimal.ROUND_DOWN)
    shares.push(share)
    shortfalls.push({ index, shortfall: exactShare.minus(share).abs() })
  })

  const residue = amount.minus(sum(shares))
  const steps = residue.dividedBy(unit).abs().toNumber()

  if (!Number.isSafeInteger(steps) || steps >= shares.length) {
    /* Unreachable: truncation loses strictly less than one unit per part. */
    throw new MoneyError(
      'ALLOCATION_INVARIANT',
      `Residue ${residue.toString()} is not distributable across ${String(shares.length)} parts.`,
    )
  }

  /* Largest shortfall first; ties go to the earlier part, so the split is stable. */
  const order = [...shortfalls].sort(
    (a, b) => b.shortfall.comparedTo(a.shortfall) || a.index - b.index,
  )
  const direction = residue.isNegative() ? unit.negated() : unit
  const bumped = new Set(order.slice(0, steps).map((entry) => entry.index))

  const allocated = shares.map((share, index) =>
    bumped.has(index) ? share.plus(direction) : share,
  )

  if (!sum(allocated).equals(amount)) {
    /* Unreachable. Kept because a silent failure here is a silent failure everywhere. */
    throw new MoneyError(
      'ALLOCATION_INVARIANT',
      `Allocation of ${amount.toString()} summed to ${sum(allocated).toString()}.`,
    )
  }

  return allocated
}
