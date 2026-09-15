/*
 * Arranging a trial balance for reading.
 *
 * Main returns rows in code order with two columns already decided, and one section per
 * account type with that section's two subtotals. This puts each row under its heading.
 *
 * NOTHING HERE ADDS UP (B23). The section subtotals were summed here once — exactly, in
 * paise on strings — and it was still the renderer computing money, which CONVENTIONS §1.7
 * forbids however carefully it is done. They arrive from main now, beside the totals.
 *
 * WHETHER THE TOTALS AGREE IS NOT COMPUTED HERE EITHER. `TrialBalance.balanced` comes from
 * main, which summed the lines. Re-deriving it in the renderer would be a second opinion
 * about the one fact this report exists to state, and the two could disagree.
 */

import type { DecimalString, TrialBalance, TrialBalanceRow } from '@shared/dto'
import { accountTypeLabel } from './ledger-format'

export interface TrialBalanceSection {
  type: string
  label: string
  rows: TrialBalanceRow[]
  /** The section's own totals, for the subtotal line. Main's. */
  debitTotal: DecimalString
  creditTotal: DecimalString
}

/** Main's sections, in main's order, each holding the rows of its type. */
export function sectionsOf(report: TrialBalance): TrialBalanceSection[] {
  return report.sections.map((section) => ({
    type: section.type,
    label: accountTypeLabel(section.type),
    rows: report.rows.filter((row) => row.type === section.type),
    debitTotal: section.debitTotal,
    creditTotal: section.creditTotal,
  }))
}
