/*
 * The four columns every row of every GST return has, and the arithmetic on them.
 *
 * ═══ ROUNDING: WHERE IT HAPPENS, AND — MORE IMPORTANTLY — WHERE IT DOES NOT ════════
 *
 * There are exactly two rounding decisions in this whole folder and both are here.
 *
 * ONE. NOTHING IN A RETURN ROW IS ROUNDED. Every figure arriving from a document is
 * already at money scale: `computeTax` rounded the line's tax once at `lineAmount`, and
 * `taxableAmount` is a stored 2dp column. Adding exact 2dp decimals gives an exact 2dp
 * decimal, so there is nothing to round — and rounding anyway would be precisely the
 * "incidental rounding" `scale.ts` exists to prevent. `sum` is used and never a running
 * `+=` on a number.
 *
 * This is what makes the invariant hold that a return is REJECTED for failing: a section
 * total equals the sum of its rows, exactly, because both are `sum()` over the same
 * exact values and neither has been through a rounding point.
 *
 * TWO. GSTR-3B ROUNDS TO THE RUPEE AT ONE PLACE: THE CASH PAYABLE, PER COMPONENT. And
 * the total payable is the sum of the ROUNDED components, never the rounded sum. Money
 * leaves the bank in whole rupees and the challan has to add up to the cells beside it;
 * rounding the total separately gives a return whose parts do not add to its own total,
 * which is the failure the whole exercise is about.
 *
 * WHY IT ROUNDS NOWHERE ELSE, and this is the one worth reading twice. Round the tax
 * components of a supply separately and the intra-state and inter-state answers stop
 * agreeing: 18% of 100.05 is 18.009, but 9% of it twice is 9.0045 twice, and rounding
 * each gives 9.00 + 9.00 = 18.00 against IGST's 18.01. That is not a hypothetical — it is
 * this project's own measured finding, written into `tax.ts`, and it is why `taxLine`
 * rounds the total once and ALLOCATES it. A return that rounded its CGST and SGST columns
 * would reintroduce the same paisa in the same place, one layer up, and the symptom would
 * be a GSTR-3B that disagreed with the GSTR-1 filed beside it for the same period.
 *
 * So: rounding at the cash payable, because that is where rupees actually change hands,
 * and nowhere upstream of it.
 *
 * ═══ WHY THERE ARE FOUR BUCKETS AND FIVE COMPONENT CODES ═══════════════════════════
 *
 * The regime levies CGST, SGST, UTGST and IGST. The return has one State/UT tax column,
 * so UTGST files where SGST does. A supply attracts one or the other and never both, so a
 * separate column would be empty on every return that had a figure in the other — see the
 * `utgst-files-in-the-state-tax-column` decision.
 *
 * `cess` has no component behind it today: `GST_COMPONENT_ORDER` has no CESS and nothing
 * computes one. The column exists because the return has it, it is zero on every artefact
 * this build produces, and a compliance pack that adds a CESS component flows into it
 * with no change here — which is the whole reason the map is data.
 *
 * AN UNKNOWN COMPONENT CODE IS A REFUSAL. A tax this module has no column for cannot be
 * quietly dropped: the return would understate the liability and every total in it would
 * still tie, which is the exact shape of error this codebase has learned to be afraid of.
 * `bucketFor` therefore TAKES THE MAP AS AN ARGUMENT, so a test can hand it a code the
 * shipped map does not contain — a guard against a state the real data cannot reach is a
 * guard no test can exercise and no mutation can kill (CONVENTIONS §6).
 */

import { D, roundAt, sum, toMoneyString, ZERO, type Decimal } from '@main/domain/money'
import type { DecimalString } from '@shared/scalars'
import { ReturnError } from './errors'
import type { ReturnTaxAmount } from './types'

/** The four tax columns a return row carries, in the order a return lists them. */
export const TAX_BUCKETS = ['igst', 'cgst', 'sgst', 'cess'] as const

export type TaxBucket = (typeof TAX_BUCKETS)[number]

/** The four columns, at full precision. Internal to the arithmetic. */
export type TaxTotals = Readonly<Record<TaxBucket, Decimal>>

/** The four columns, as a return carries them: 2dp decimal strings. */
export type TaxAmounts = Readonly<Record<TaxBucket, DecimalString>>

/**
 * Which column each component code files in.
 *
 * DATA, and a total map rather than a chain of comparisons — CONVENTIONS §1.9. A regime
 * component added to a compliance pack needs a row here and nothing else; a component
 * with no row is refused rather than dropped.
 */
export const RETURN_TAX_BUCKETS: Readonly<Record<string, TaxBucket>> = {
  IGST: 'igst',
  CGST: 'cgst',
  SGST: 'sgst',
  /* Not a typo and not a fallback: the return has one State/UT column. See the header. */
  UTGST: 'sgst',
  CESS: 'cess',
}

/**
 * The column a component code files in.
 *
 * Takes the map so a test can hand it one the shipped table cannot produce.
 */
export function bucketFor(
  code: string,
  buckets: Readonly<Record<string, TaxBucket>> = RETURN_TAX_BUCKETS,
): TaxBucket {
  const bucket = buckets[code]
  if (bucket === undefined) {
    throw new ReturnError(
      'RETURN_COMPONENT_UNKNOWN',
      `The tax component '${code}' has no column in this return, so its amount would be ` +
        'left out of a figure that would still add up. Add it to RETURN_TAX_BUCKETS.',
    )
  }
  return bucket
}

/** Nothing, in all four columns. */
export function zeroTotals(): TaxTotals {
  return { igst: ZERO, cgst: ZERO, sgst: ZERO, cess: ZERO }
}

/** Nothing, as a return carries it. */
export function zeroAmounts(): TaxAmounts {
  return toTaxAmounts(zeroTotals())
}

/** Two sets of columns, added. */
export function addTotals(a: TaxTotals, b: TaxTotals): TaxTotals {
  return {
    igst: a.igst.plus(b.igst),
    cgst: a.cgst.plus(b.cgst),
    sgst: a.sgst.plus(b.sgst),
    cess: a.cess.plus(b.cess),
  }
}

/** Any number of sets of columns, added. Exact — see the header on rounding. */
export function sumTotals(all: Iterable<TaxTotals>): TaxTotals {
  let running = zeroTotals()
  for (const each of all) {
    running = addTotals(running, each)
  }
  return running
}

/** The same columns with the opposite sign. What a refund contributes to a net figure. */
export function negateTotals(totals: TaxTotals): TaxTotals {
  return {
    igst: totals.igst.negated(),
    cgst: totals.cgst.negated(),
    sgst: totals.sgst.negated(),
    cess: totals.cess.negated(),
  }
}

/** True when every column is zero. */
export function isZeroTotals(totals: TaxTotals): boolean {
  return TAX_BUCKETS.every((bucket) => totals[bucket].isZero())
}

/** All four columns added together — the tax on a row, however it split. */
export function grandTotalOf(totals: TaxTotals): Decimal {
  return sum(TAX_BUCKETS.map((bucket) => totals[bucket]))
}

/** The columns as a return carries them. The only place these become strings. */
export function toTaxAmounts(totals: TaxTotals): TaxAmounts {
  return {
    igst: toMoneyString(totals.igst),
    cgst: toMoneyString(totals.cgst),
    sgst: toMoneyString(totals.sgst),
    cess: toMoneyString(totals.cess),
  }
}

/** The columns back from a return, for a caller that wants to add two artefacts up. */
export function fromTaxAmounts(amounts: TaxAmounts): TaxTotals {
  return {
    igst: D(amounts.igst),
    cgst: D(amounts.cgst),
    sgst: D(amounts.sgst),
    cess: D(amounts.cess),
  }
}

/**
 * The columns rounded to whole rupees, one at a time.
 *
 * THE ONLY ROUNDING IN THIS FOLDER, and it is used at exactly one call site: GSTR-3B's
 * cash payable. Each column is rounded on its own and the total is then the SUM OF THE
 * ROUNDED COLUMNS — computed by the caller from this result, never by rounding the total.
 */
export function roundTotalsToRupees(totals: TaxTotals): TaxTotals {
  return {
    igst: roundAt('wholeUnit', totals.igst),
    cgst: roundAt('wholeUnit', totals.cgst),
    sgst: roundAt('wholeUnit', totals.sgst),
    cess: roundAt('wholeUnit', totals.cess),
  }
}

/**
 * The tax on a set of components, bucketed.
 *
 * Addition only. Nothing here multiplies a rate by anything — see `types.ts` on why the
 * figures are carried rather than recomputed.
 */
export function totalsOfComponents(
  taxes: readonly ReturnTaxAmount[],
  buckets: Readonly<Record<string, TaxBucket>> = RETURN_TAX_BUCKETS,
): TaxTotals {
  const running: Record<TaxBucket, Decimal> = {
    igst: ZERO,
    cgst: ZERO,
    sgst: ZERO,
    cess: ZERO,
  }
  for (const tax of taxes) {
    const bucket = bucketFor(tax.code, buckets)
    running[bucket] = running[bucket].plus(D(tax.amount))
  }
  return running
}
