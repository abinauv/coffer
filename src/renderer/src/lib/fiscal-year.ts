/*
 * The financial years a company's books keep, and which one is current.
 *
 * Here rather than beside the numbering screen that first needed it, because the title bar
 * names the current year as well and the shell does not import from `screens/`.
 */

import type { AccountingPeriod, DateString } from '@shared/dto'

/** One financial year these books keep, and the days it covers. */
export interface FiscalYear {
  /** As the regime spells it — '2026-27' in India. Main's word, never composed here. */
  label: string
  from: DateString
  to: DateString
}

/**
 * The financial years these books keep, earliest first.
 *
 * Derived from the periods rather than computed from a date, because the label is the
 * regime's and the renderer does not know how a year is named — '2026-27' in India,
 * '2026' where the year is the calendar one. Working one out here would be a second
 * spelling that agrees with main until somebody's books start in July.
 *
 * Dates are `YYYY-MM-DD`, so a string comparison is a date comparison (CONVENTIONS §3).
 */
export function fiscalYearsFrom(periods: readonly AccountingPeriod[]): readonly FiscalYear[] {
  const byLabel = new Map<string, FiscalYear>()

  for (const period of periods) {
    const existing = byLabel.get(period.fiscalYearLabel)
    if (existing === undefined) {
      byLabel.set(period.fiscalYearLabel, {
        label: period.fiscalYearLabel,
        from: period.startDate,
        to: period.endDate,
      })
      continue
    }
    if (period.startDate < existing.from) existing.from = period.startDate
    if (period.endDate > existing.to) existing.to = period.endDate
  }

  return [...byLabel.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
}

/**
 * The year to name when nobody has chosen one: in a numbering preview, and in the title bar.
 *
 * The year today falls in, because that is the year the next document will be raised in.
 * Failing that the latest the books keep — a file whose periods all lie in the past still
 * has a most recent year, and naming that is more use than naming nothing.
 *
 * Both ends inclusive: a period's `endDate` is documented as inclusive, and the last day
 * of a financial year is a day on which invoices are raised.
 */
export function currentFiscalYear(years: readonly FiscalYear[], today: DateString): string | null {
  const containing = years.find((year) => year.from <= today && today <= year.to)
  return containing?.label ?? years.at(-1)?.label ?? null
}
