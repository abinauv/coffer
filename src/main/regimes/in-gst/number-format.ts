/*
 * How Indian numbers are grouped.
 *
 * The first group from the right is three digits, and every group after it is two:
 * 1,23,45,678 rather than 12,345,678. That is `groupSizes: [3, 2]` — the last entry
 * repeating for as long as digits remain, which is what makes one rule describe both
 * this and the plain-thousands `[3]` used elsewhere.
 *
 * The rule is data, not a formatter. Formatting is presentation, and presentation is the
 * renderer's job (ARCHITECTURE §4); what a regime owes it is the grouping, the
 * separators and the currency, so that a screen can format any regime's numbers without
 * knowing which one is loaded.
 */

import type { NumberFormatRule } from '@main/regimes/types'

export const INDIA_NUMBER_FORMAT: NumberFormatRule = {
  groupSizes: [3, 2],
  decimalSeparator: '.',
  groupSeparator: ',',
  currencyCode: 'INR',
  currencySymbol: '₹',
}
