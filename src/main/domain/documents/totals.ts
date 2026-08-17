/*
 * What a document adds up to.
 *
 * Rule 4 in types.ts: nothing that can be derived is stored. These are the derivations —
 * a pure fold over the lines, computed every time a document is read, printed or posted.
 * There is no `grand_total` column for this to disagree with.
 *
 * The figures here are also what the posting rule turns into an entry, which is what
 * makes the two impossible to get out of step: an invoice whose printed total differs
 * from what hit receivables would need this function to have been called twice with
 * different answers.
 */

import { ZERO, roundToWholeUnit, sum, type Decimal } from '@main/domain/money'
import type { DocumentLine, DocumentLineTax, RoundingPolicy } from './types'

/** Enough of a document to add it up. Deliberately less than a whole `TradeDocument`. */
export interface Summable {
  roundingPolicy: RoundingPolicy
  lines: readonly DocumentLine[]
}

export interface DocumentTotals {
  /** Sum of the line taxable amounts. Turnover, before tax and after discount. */
  taxableValue: Decimal
  /** Sum of the discounts already taken out of the lines above. For the footer. */
  totalDiscount: Decimal
  totalTax: Decimal
  /** `taxableValue + totalTax`, before any rounding. */
  netTotal: Decimal
  /**
   * What rounding added, positive or negative, and zero when the policy is `none`.
   *
   * This is the figure that posts to the `round-off` account. Its sign is already the
   * sign to post: add it to the net total and you get the grand total.
   */
  roundOff: Decimal
  /** What the customer pays. `netTotal + roundOff`. */
  grandTotal: Decimal
  /**
   * Tax gathered by component and rate, in the order first met on the document.
   *
   * By code AND rate, not by code alone. A document carrying 18% goods and 5% freight
   * has two CGST figures on it, and a single 'CGST' line summing them is a line no
   * customer can check and no return has a box for. It is also exactly what the invoice
   * prints: 'CGST @ 9%', 'CGST @ 2.5%'.
   */
  taxSummary: readonly DocumentLineTax[]
}

/** Tax on one line, across its components. */
export function lineTax(line: DocumentLine): Decimal {
  return sum(line.taxes.map((tax) => tax.amount))
}

/** What one line contributes to the grand total, before document-level rounding. */
export function lineTotal(line: DocumentLine): Decimal {
  return line.taxableAmount.plus(lineTax(line))
}

/**
 * Every figure that appears on the foot of a document.
 *
 * Full precision throughout: the inputs are already at money scale, so the sums are
 * exact and nothing is rounded again on the way through. Rounding happens once, at the
 * grand total, and only when the document says it should.
 */
export function documentTotals(document: Summable): DocumentTotals {
  const taxableValue = sum(document.lines.map((line) => line.taxableAmount))
  const totalDiscount = sum(document.lines.map((line) => line.discount))
  const totalTax = sum(document.lines.map((line) => lineTax(line)))
  const netTotal = taxableValue.plus(totalTax)

  /*
   * `roundToWholeUnit` reports the adjustment rather than the remainder, so this value
   * can be posted as it stands. A policy of `none` is not "round by zero" — it is not
   * rounding at all, and the difference shows the moment a total ends in 50 paise.
   */
  const roundOff =
    document.roundingPolicy === 'whole-unit' ? roundToWholeUnit(netTotal).adjustment : ZERO

  return {
    taxableValue,
    totalDiscount,
    totalTax,
    netTotal,
    roundOff,
    grandTotal: netTotal.plus(roundOff),
    taxSummary: taxSummaryOf(document.lines),
  }
}

/**
 * The tax block, gathered across lines.
 *
 * Keyed by code and rate together — see the note on `DocumentTotals.taxSummary`. The rate
 * is keyed by its own string form so that 9 and 9.000 do not become two rows: `Decimal`
 * normalises trailing zeroes, and two lines carrying the same rate parsed from differently
 * written text must land in one figure.
 */
function taxSummaryOf(lines: readonly DocumentLine[]): DocumentLineTax[] {
  const gathered = new Map<string, DocumentLineTax>()

  for (const line of lines) {
    for (const tax of line.taxes) {
      const key = `${tax.code}@${tax.ratePct.toString()}`
      const existing = gathered.get(key)
      if (existing === undefined) {
        gathered.set(key, { ...tax })
      } else {
        gathered.set(key, { ...existing, amount: existing.amount.plus(tax.amount) })
      }
    }
  }

  return [...gathered.values()]
}
