/*
 * Formatting figures for the ledger screens.
 *
 * THE RENDERER NEVER COMPUTES WITH MONEY (CONVENTIONS §1). Every amount arriving here is
 * an exact decimal string produced by main, and everything below turns one into text.
 * Nothing parses an amount into a `number` — not even to format it — because that is
 * precisely the conversion the whole storage layer exists to avoid, and a formatter is a
 * plausible-looking place for it to creep back in.
 *
 * GROUPING IS INDIAN, AND THAT IS A PLACEHOLDER. 12,34,567.89 rather than 1,234,567.89.
 * Number format is a property of the tax regime (`TaxRegime.numberFormat`), and the
 * regime is not yet exposed over IPC — so this hard-codes the one regime that exists and
 * will take the grouping from the contract at gate 2.0. Recorded rather than hidden: a
 * user in another jurisdiction would see the wrong separators today.
 */

import type { DecimalString } from '@shared/dto'

/**
 * Group a run of digits the Indian way: the last three, then twos.
 *
 * `1234567` becomes `12,34,567`. Written on the string rather than by dividing, because
 * the input can be longer than a `number` represents exactly and the point of this file
 * is that nothing converts.
 */
export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits
  const last3 = digits.slice(-3)
  const rest = digits.slice(0, -3)
  const pairs: string[] = []
  let remaining = rest
  while (remaining.length > 2) {
    pairs.unshift(remaining.slice(-2))
    remaining = remaining.slice(0, -2)
  }
  if (remaining.length > 0) pairs.unshift(remaining)
  return `${pairs.join(',')},${last3}`
}

/**
 * An amount as it appears in a column: grouped, always two places, minus sign kept.
 *
 * Returns the input unchanged when it is not a decimal string. A figure that main has
 * not vouched for should look wrong rather than be quietly rendered as something
 * plausible.
 */
export function formatAmount(value: DecimalString): string {
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return value

  const isNegative = value.startsWith('-')
  const unsigned = isNegative ? value.slice(1) : value
  const [whole = '0', fraction = ''] = unsigned.split('.')
  const places = fraction.padEnd(2, '0').slice(0, 2)

  return `${isNegative ? '-' : ''}${groupIndian(whole)}.${places}`
}

/**
 * The same, but a zero renders as nothing.
 *
 * A trial balance has a debit column and a credit column, and every row is blank in one
 * of them. Printing `0.00` in every other cell doubles the ink and makes the column that
 * matters harder to scan — the convention on paper is to leave it empty, and the
 * convention is right.
 */
export function formatAmountOrBlank(value: DecimalString): string {
  return isZeroAmount(value) ? '' : formatAmount(value)
}

/** True for any spelling of zero: '0', '0.00', '-0.00'. */
export function isZeroAmount(value: DecimalString): boolean {
  return /^-?0+(?:\.0+)?$/.test(value)
}

/** True when the amount is below zero. Text only — nothing is parsed. */
export function isNegativeAmount(value: DecimalString): boolean {
  return value.startsWith('-') && !isZeroAmount(value)
}

// ---- Words for the ledger's vocabulary ------------------------------------

const ACCOUNT_TYPE_LABELS: Readonly<Record<string, string>> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
  income: 'Income',
  expense: 'Expenses',
}

/** The plural heading a section of the chart or a trial balance sits under. */
export function accountTypeLabel(type: string): string {
  return ACCOUNT_TYPE_LABELS[type] ?? type
}

/**
 * The order the five types are read in.
 *
 * Balance sheet first, then the profit and loss — the order every set of printed
 * accounts uses, and the order the accounting equation is stated in.
 */
export const ACCOUNT_TYPE_ORDER: readonly string[] = [
  'asset',
  'liability',
  'equity',
  'income',
  'expense',
]

export function accountTypeRank(type: string): number {
  const index = ACCOUNT_TYPE_ORDER.indexOf(type)
  return index === -1 ? ACCOUNT_TYPE_ORDER.length : index
}

const PERIOD_STATUS_LABELS: Readonly<Record<string, string>> = {
  open: 'Open',
  closed: 'Closed',
  locked: 'Locked',
}

export function periodStatusLabel(status: string): string {
  return PERIOD_STATUS_LABELS[status] ?? status
}

/** Tone for the badge beside a period. Locked is not a warning — it is a settled state. */
export function periodStatusTone(status: string): 'neutral' | 'positive' | 'info' {
  if (status === 'open') return 'positive'
  if (status === 'locked') return 'info'
  return 'neutral'
}
