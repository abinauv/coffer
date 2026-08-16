/*
 * The four components India's GST can levy, declared once.
 *
 * This is not the computation — `tax.ts` decides which of these a given supply attracts,
 * and never all of them at once. This is the standing list, asked when a company's books
 * are created so that the chart of accounts gets one account per component before a
 * single invoice exists.
 *
 * ---------------------------------------------------------------------------
 * ALL FOUR, INCLUDING THE ONE MOST COMPANIES NEVER USE
 *
 * UTGST applies only in a union territory without its own legislature, so a company in
 * Tamil Nadu will never levy it. It gets an account anyway, and the alternative is worse
 * than an unused row: the accounts a company holds would depend on where it was sitting
 * when the books were made, and moving — or invoicing a customer in Lakshadweep for the
 * first time — would need a chart migration to post an ordinary sale.
 *
 * An account with nothing in it costs a row in a settings screen. Reports already drop
 * anything nothing has been posted to, so an unused tax account is invisible on a
 * balance sheet until the day it matters.
 *
 * ---------------------------------------------------------------------------
 * EVERY COMPONENT IS BOTH OUTPUT AND INPUT
 *
 * Tax charged on a sale is owed to the government; tax paid on a purchase is reclaimable
 * from it. Under GST the second is input tax credit, and the two are set off against
 * each other only when a return is filed — by the return, on the return's own terms, not
 * continuously in the ledger.
 *
 * So they never share an account. Netting them would hide both figures behind their
 * difference, and GSTR-3B asks for each separately: output tax in table 3.1, input tax
 * credit in table 4. A ledger that had already netted them cannot answer.
 */

import type { TaxComponentDefinition } from '@main/regimes/types'

export const GST_COMPONENTS: readonly TaxComponentDefinition[] = [
  /*
   * Order matters, and it is the order a return lists them rather than the alphabet:
   * central first, then the state's half, then the union-territory substitute, then the
   * inter-state levy. The chart of accounts is numbered in this order, so a user reading
   * their `Duties and Taxes` group sees it laid out the way GSTR-3B is.
   */
  { code: 'CGST', label: 'Central GST', levy: 'both' },
  { code: 'SGST', label: 'State GST', levy: 'both' },
  { code: 'UTGST', label: 'Union Territory GST', levy: 'both' },
  { code: 'IGST', label: 'Integrated GST', levy: 'both' },
]

export function taxComponents(): ReadonlyArray<TaxComponentDefinition> {
  return GST_COMPONENTS
}
