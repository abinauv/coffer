/*
 * Arranging a trial balance for reading.
 *
 * Main returns rows in code order with two columns already decided. This groups them
 * under the five headings, in the order printed accounts use, and totals each section.
 *
 * THE SECTION TOTALS ARE SUMMED AS TEXT. Every figure is an exact decimal string and the
 * renderer never turns one into a `number` — not even to add up a column of five. The
 * arithmetic below is integer paise on strings, which is exact for the same reason the
 * database triggers do it that way, and it is a dozen lines rather than a dependency.
 *
 * WHETHER THE TOTALS AGREE IS NOT COMPUTED HERE. `TrialBalance.balanced` comes from main,
 * which summed the lines. Re-deriving it in the renderer would be a second opinion about
 * the one fact this report exists to state, and the two could disagree.
 */

import type { TrialBalance, TrialBalanceRow } from '@shared/dto'
import { accountTypeLabel, accountTypeRank } from './ledger-format'

export interface TrialBalanceSection {
  type: string
  label: string
  rows: TrialBalanceRow[]
  /** The section's own totals, for the subtotal line. */
  debitTotal: string
  creditTotal: string
}

/** Group the rows under their five headings, dropping any heading with no rows. */
export function sectionsOf(report: TrialBalance): TrialBalanceSection[] {
  const byType = new Map<string, TrialBalanceRow[]>()
  for (const row of report.rows) {
    const existing = byType.get(row.type)
    if (existing === undefined) byType.set(row.type, [row])
    else existing.push(row)
  }

  return [...byType.entries()]
    .sort(([a], [b]) => accountTypeRank(a) - accountTypeRank(b))
    .map(([type, rows]) => ({
      type,
      label: accountTypeLabel(type),
      rows,
      debitTotal: sumAmounts(rows.map((row) => row.debitBalance)),
      creditTotal: sumAmounts(rows.map((row) => row.creditBalance)),
    }))
}

/**
 * Add exact decimal amounts without going near a `number`.
 *
 * Paise as integers, held in a `bigint` so a large set of books cannot overflow. This is
 * the same trick migration 0004 uses in SQL, and it is here for the same reason: summing
 * '0.07' three times as a float and getting 0.21000000000000002 is not a hypothetical.
 */
export function sumAmounts(values: readonly string[]): string {
  let paise = 0n
  for (const value of values) {
    paise += toPaise(value)
  }
  return fromPaise(paise)
}

function toPaise(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(value.trim())
  if (match === null) return 0n

  const [, sign = '', whole = '0', fraction = ''] = match
  const places = fraction.padEnd(2, '0').slice(0, 2)
  const magnitude = BigInt(whole) * 100n + BigInt(places === '' ? '0' : places)
  return sign === '-' ? -magnitude : magnitude
}

function fromPaise(paise: bigint): string {
  const isNegative = paise < 0n
  const magnitude = isNegative ? -paise : paise
  const whole = magnitude / 100n
  const remainder = magnitude % 100n
  return `${isNegative ? '-' : ''}${whole}.${remainder.toString().padStart(2, '0')}`
}

/**
 * What the range at the top of the report says.
 *
 * An unbounded range is "everything", which is the classic trial balance and the default
 * — so it is worth saying out loud rather than leaving the header blank.
 */
export function describeRange(report: TrialBalance): string {
  const { fromDate, toDate } = report
  if (fromDate === null && toDate === null) return 'Everything in the books'
  if (fromDate === null) return `Up to ${toDate ?? ''}`
  if (toDate === null) return `From ${fromDate}`
  return `${fromDate} to ${toDate}`
}
