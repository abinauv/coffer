/*
 * The GST split: which taxes apply to a line, and how much of each.
 *
 * One rule, stated once:
 *
 *   intra-state   CGST at half the rate + SGST at half the rate
 *                 (UTGST in place of SGST in a union territory without a legislature)
 *   inter-state   IGST at the full rate
 *   export        IGST, because a supply leaving India is inter-state —
 *                 UNLESS it went out under an LUT or bond, when it carries none
 *
 * Never all three. A line carries either the pair or IGST, and the total is the same
 * either way — which is exactly the property the arithmetic below is arranged to keep.
 *
 * ── The export under LUT, which is the one exception and is not a rate ────────────
 *
 * An export is zero-rated under section 16 of the IGST Act, and there are two ways to
 * make it so: pay the IGST and claim it back, or give a letter of undertaking and charge
 * nothing. Until `exportTaxPayment` existed this function could only produce the first,
 * because a supply leaving India is inter-state and IGST at the full rate is the honest
 * answer to "what tax does this attract".
 *
 * SO AN LUT EXPORT COULD NOT BE REPRESENTED IN THESE BOOKS AT ALL. The only way to get a
 * nil figure was to set the line's rate to zero — and a supply at a rate of zero is
 * NIL-RATED, which is section 2(47) and a different thing: it is inside the tax, and rule
 * 42 makes the taxpayer reverse the credit on its inputs. A zero-rated supply keeps that
 * credit and may claim it as a refund. Two different supplies, two different boxes on the
 * return, and opposite answers about a taxpayer's own money — with every total still
 * adding up either way.
 *
 * WHAT THIS FUNCTION DOES ABOUT IT: the line keeps its RATE and its components come out
 * at NOTHING. `zeroRatedLine` is the shape, and it is deliberately not the same shape as
 * a nil-rated line: a nil-rated line carries NO components, because "which taxes would
 * have applied" is not a fact about an exempt supply, while a zero-rated line carries
 * IGST at the full rate for an amount of zero, because IGST is exactly the tax that would
 * have applied and did not. A return reads the rate off the line either way, so the two
 * remain distinguishable downstream without anything re-deriving them.
 *
 * IT IS HONOURED ONLY WHERE THE PLACE OF SUPPLY IS AN EXPORT. `without-payment` on a
 * domestic invoice is a decision recorded against the wrong document, and letting it
 * zero the tax there would turn a data-entry mistake into an unpaid liability. The
 * document repository refuses to store one; this refuses to act on one. Two layers, and
 * the second is the one that matters, because it is the only one that can see the
 * regime's own answer about where the supply took place.
 *
 * ── Rounding ──────────────────────────────────────────────────────────────────────
 *
 * The obvious implementation rounds each component: 9% of 100.05 is 9.0045, so CGST
 * 9.00 and SGST 9.00, total 18.00. But 18% of 100.05 is 18.009, which is 18.01. The
 * same supply now has two different tax figures depending on which side of a state line
 * the customer sits, and neither the invoice nor GSTR-1 will reconcile with the other.
 *
 * So the rate is applied once, at full precision — `percentOf` returns unrounded for
 * this reason — the line's total tax is rounded once at `lineAmount`, and that rounded
 * total is *allocated* across the components in proportion to their rates. The
 * allocation is the largest-remainder split from `domain/money`, so the components sum
 * to the total exactly, always, and an odd paisa lands on CGST deterministically rather
 * than wherever the arithmetic happened to drop it.
 *
 * Two invariants follow, and both are pinned in fixtures:
 *   - a line's components sum to its total tax, exactly;
 *   - a line's total tax does not depend on how the tax splits.
 *
 * ── What this function does not decide ────────────────────────────────────────────
 *
 * Whether a line is taxed. The rate arrives on the line, from the caller. Freight,
 * packing and insurance are charge lines like any other: `isCharge` says what a line is,
 * not whether it is taxable. Hardcoding "freight is never taxed" inside a tax function
 * would be one business's policy wearing the costume of a rule, and a business with a
 * different policy would have nowhere to put it. Here a charge that should
 * not be taxed arrives with a rate of 0, which is a decision the user can see and change.
 */

import {
  allocateByWeights,
  compare,
  parseMoney,
  parseRate,
  percentOf,
  roundAt,
  sum,
  toMoneyString,
  type Decimal,
} from '@main/domain/money'
import { isDateString } from '@main/domain/time'
import type {
  PlaceOfSupply,
  TaxableLine,
  TaxComponent,
  TaxComputationInput,
  TaxComputationResult,
  TaxedLine,
} from '@main/regimes/types'
import type { ExportTaxPayment } from '@shared/dto'
import { intraStateComponentFor } from './jurisdictions'

/** Every component code this regime can emit, in the order returns and invoices list them. */
export const GST_COMPONENT_ORDER = ['CGST', 'SGST', 'UTGST', 'IGST'] as const

export type GstComponentCode = (typeof GST_COMPONENT_ORDER)[number]

const ORDER_OF = new Map<string, number>(GST_COMPONENT_ORDER.map((code, index) => [code, index]))

/** A component before any amount is attached: the name and the rate it carries. */
interface ComponentSplit {
  code: GstComponentCode
  ratePct: Decimal
}

/**
 * The components a supply attracts, and the rate each carries.
 *
 * The intra-state pair splits the rate exactly in half — at full precision, so a 0.25%
 * supply yields two components of 0.125% rather than two of 0.13% that do not add up.
 */
export function splitComponents(place: PlaceOfSupply, ratePct: Decimal): ComponentSplit[] {
  if (!place.isIntraJurisdiction) {
    return [{ code: 'IGST', ratePct }]
  }

  const half = ratePct.dividedBy(2)
  const stateComponent = intraStateComponentFor(place.jurisdictionCode ?? '')
  return [
    { code: 'CGST', ratePct: half },
    { code: stateComponent, ratePct: half },
  ]
}

/**
 * How a rate is written in a component and its label: exactly, not at storage scale.
 *
 * Half of 0.25% is 0.125%, which a 2dp rate column cannot hold. Rounding it to 0.13%
 * would print a rate that was never applied, so the component reports the rate the
 * amount was actually computed from.
 */
function rateText(ratePct: Decimal): string {
  return ratePct.toString()
}

function labelFor(code: GstComponentCode, ratePct: Decimal): string {
  return `${code} @ ${rateText(ratePct)}%`
}

/**
 * Whether this supply is zero-rated and carries no tax: an export under an LUT or bond.
 *
 * BOTH HALVES ARE LOAD-BEARING AND THE ORDER OF THE `&&` IS NOT AN OPTIMISATION. The
 * place of supply is what says a supply left the country, and it is the regime's own
 * answer rather than anything a caller asserted; the flavour is what says it left under
 * an undertaking. A flavour with no export behind it zeroes nothing, which is what stops
 * a value recorded against the wrong document from becoming an unpaid liability.
 */
function isZeroRatedWithoutPayment(
  place: PlaceOfSupply,
  taxPayment: ExportTaxPayment | null | undefined,
): boolean {
  return place.isExport && taxPayment === 'without-payment'
}

/**
 * A supply that carries its rate and no tax.
 *
 * NOT THE SAME AS A NIL-RATED LINE, and the difference is the components. A nil-rated
 * line carries none, because which taxes would have applied is not a fact about an exempt
 * supply. This one carries IGST at the full rate for an amount of zero, because IGST is
 * precisely the tax that would have applied and did not — which is what "zero-rated"
 * means, and what an invoice under an LUT is required to show.
 */
function zeroRatedLine(line: TaxableLine, taxable: Decimal, ratePct: Decimal): TaxedLine {
  return {
    lineId: line.lineId,
    taxableAmount: toMoneyString(taxable),
    components: [
      {
        code: 'IGST',
        label: labelFor('IGST', ratePct),
        ratePct: rateText(ratePct),
        amount: toMoneyString(0),
      },
    ],
    totalTax: toMoneyString(0),
  }
}

/** Tax one line. Components sum to `totalTax` exactly. */
export function taxLine(
  line: TaxableLine,
  place: PlaceOfSupply,
  taxPayment?: ExportTaxPayment | null,
): TaxedLine {
  const taxable = parseMoney(line.taxableAmount, `taxable amount on line ${line.lineId}`)
  const ratePct = parseRate(line.ratePct, `tax rate on line ${line.lineId}`)

  /* A nil-rated line attracts no tax at all, so it carries no components rather than a
   * row of zeroes. Which taxes *would* have applied is not a fact about an exempt
   * supply, and a nil row on an invoice reads as an oversight.
   *
   * CHECKED BEFORE THE LUT ARM, deliberately: a nil-rated line on an export under an
   * undertaking is nil-rated, not zero-rated at 0%, and a component of `IGST @ 0%` for
   * nothing would be a row asserting a rate the supply never had. */
  if (ratePct.isZero()) {
    return {
      lineId: line.lineId,
      taxableAmount: toMoneyString(taxable),
      components: [],
      totalTax: toMoneyString(0),
    }
  }

  if (isZeroRatedWithoutPayment(place, taxPayment)) {
    return zeroRatedLine(line, taxable, ratePct)
  }

  const splits = splitComponents(place, ratePct)

  /* Unrounded through the rate, rounded once here. Everything downstream divides this
   * figure up; nothing recomputes it. */
  const totalTax = roundAt('lineAmount', percentOf(taxable, ratePct))

  /* Weights are the component rates, so an equal split stays equal and a future
   * unequal one would need no change here. The default allocation unit is money
   * scale — the smallest amount a component may be moved by. */
  const amounts = allocateByWeights(
    totalTax,
    splits.map((split) => split.ratePct),
  )

  const components = splits.map((split, index) => {
    const amount = amounts[index]
    if (amount === undefined) {
      /* Unreachable: allocateByWeights returns one share per weight. */
      throw new Error(`No allocated share for component ${split.code} on line ${line.lineId}.`)
    }
    return {
      code: split.code,
      label: labelFor(split.code, split.ratePct),
      ratePct: rateText(split.ratePct),
      amount: toMoneyString(amount),
    }
  })

  return {
    lineId: line.lineId,
    taxableAmount: toMoneyString(taxable),
    components,
    totalTax: toMoneyString(totalTax),
  }
}

/**
 * Aggregate line components into the document's tax summary.
 *
 * Grouped by code *and* rate, because that is what a tax summary means: an invoice with
 * a 5% line and an 18% line shows 'CGST @ 2.5%' and 'CGST @ 9%' as separate rows, and
 * collapsing them into one 'CGST' row would lose the figure every return asks for.
 */
export function summarise(lines: readonly TaxedLine[]): TaxComponent[] {
  const buckets = new Map<string, { component: TaxComponent; amounts: string[] }>()

  for (const line of lines) {
    for (const component of line.components) {
      const key = `${component.code}@${component.ratePct}`
      const bucket = buckets.get(key)
      if (bucket === undefined) {
        buckets.set(key, { component, amounts: [component.amount] })
      } else {
        bucket.amounts.push(component.amount)
      }
    }
  }

  return [...buckets.values()]
    .map(({ component, amounts }) => ({
      code: component.code,
      label: component.label,
      ratePct: component.ratePct,
      amount: toMoneyString(sum(amounts)),
    }))
    .sort((a, b) => {
      const byCode = (ORDER_OF.get(a.code) ?? 0) - (ORDER_OF.get(b.code) ?? 0)
      if (byCode !== 0) {
        return byCode
      }
      /* Compared as decimals, not as numbers: a rate is a Decimal everywhere else and a
       * float comparison here would be the one place it was not. */
      return compare(a.ratePct, b.ratePct)
    })
}

/** Tax a document: every line, plus the summary the invoice and the return both need. */
export function computeTax(input: TaxComputationInput): TaxComputationResult {
  if (!isDateString(input.date)) {
    /* The date decides which schedule applies once compliance packs carry more than
     * one. Accepting a malformed one now would make that change silently wrong. */
    throw new Error(`Not a document date: ${JSON.stringify(input.date)}`)
  }

  const lines = input.lines.map((line) =>
    taxLine(line, input.placeOfSupply, input.exportTaxPayment),
  )
  const summary = summarise(lines)

  /* Summed from the already-rounded line totals, so the document total is the sum of
   * what the lines say rather than a separately rounded figure that differs by a paisa. */
  const totalTax = roundAt('documentTotal', sum(lines.map((line) => line.totalTax)))

  return { lines, summary, totalTax: toMoneyString(totalTax) }
}
