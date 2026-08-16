/*
 * What the report screens need to decide before they can draw anything.
 *
 * Pure, testable, and holding no money arithmetic — every figure on a statement arrives
 * already totalled from main (CONVENTIONS §1.7). What is decided here is wording, dates
 * and which of two sentences a figure deserves.
 */

import type { DecimalString } from '@shared/dto'
import { isNegativeAmount, isZeroAmount } from './ledger-format'

/** Today as `YYYY-MM-DD`, in the user's own timezone. */
export function todayISO(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  /*
   * Not `toISOString().slice(0, 10)`, which converts to UTC first. For a user in India
   * that is five and a half hours earlier, so any time before 05:30 local would default
   * a balance sheet to yesterday — and on the first of the month, to the previous month.
   */
  return `${year}-${month}-${day}`
}

/** What a range covers, in a sentence. */
export function describeRange(fromDate: string | null, toDate: string | null): string {
  if (fromDate === null && toDate === null) return 'Everything in the books'
  if (fromDate === null) return `Up to ${toDate}`
  if (toDate === null) return `From ${fromDate}`
  return `${fromDate} to ${toDate}`
}

/**
 * A profit or a loss, said in words.
 *
 * The figure is signed and stays signed; this only decides what to call it. A statement
 * that printed "Net profit: -15,000.00" is asking the reader to notice a minus sign in a
 * column of figures, which is exactly what they will not do.
 */
export function resultLabel(netProfit: DecimalString): string {
  if (isZeroAmount(netProfit)) return 'Neither profit nor loss'
  return isNegativeAmount(netProfit) ? 'Net loss' : 'Net profit'
}

export function resultTone(netProfit: DecimalString): 'positive' | 'danger' | 'neutral' {
  if (isZeroAmount(netProfit)) return 'neutral'
  return isNegativeAmount(netProfit) ? 'danger' : 'positive'
}

/**
 * The label a balance-sheet section sits under.
 *
 * Not `accountTypeLabel`. On a balance sheet the equity section carries the unclosed
 * profit as well as the capital accounts, and calling that block "Equity" alone would
 * misname what is in it — which matters, because the profit line is the one a reader
 * will look for and not find under a heading they did not expect.
 */
export function sectionHeading(type: string): string {
  switch (type) {
    case 'asset':
      return 'Assets'
    case 'liability':
      return 'Liabilities'
    case 'equity':
      return 'Equity and reserves'
    case 'income':
      return 'Income'
    case 'expense':
      return 'Expenses'
    default:
      return type
  }
}

/**
 * Whether an amount should be shown as a bare figure or with what it means.
 *
 * A negative on a statement is real and is never hidden, but it is worth a word: an
 * asset in credit is an overdraft, and a reader scanning a column will otherwise read
 * `(15,000.00)` as a formatting quirk.
 */
export function isContraBalance(amount: DecimalString): boolean {
  return isNegativeAmount(amount)
}

/** The fiscal year containing a date, given the month it starts in. April is 4. */
export function fiscalYearOf(date: string, startMonth: number): { from: string; to: string } {
  const [year = 0, month = 1] = date.split('-').map(Number)
  const startYear = month >= startMonth ? year : year - 1
  const pad = (value: number) => String(value).padStart(2, '0')

  const endMonth = startMonth === 1 ? 12 : startMonth - 1
  const endYear = startMonth === 1 ? startYear : startYear + 1
  /* The last day of the month before the year starts again. Day 0 of the next month is
   * the last day of this one, which handles February and leap years without a table. */
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate()

  return {
    from: `${startYear}-${pad(startMonth)}-01`,
    to: `${endYear}-${pad(endMonth)}-${pad(lastDay)}`,
  }
}
