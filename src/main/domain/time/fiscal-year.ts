/*
 * Fiscal years, as a rule you plug in rather than a constant you assume.
 *
 * The Indian April-to-March year is one rule among several, and it is not the default —
 * there is no default. Every function here takes a `FiscalYearRule`, which a tax regime
 * supplies (`TaxRegime.fiscalYear`, docs/ARCHITECTURE.md §6.2). Nothing in `domain/`
 * knows which regime is loaded, so nothing in `domain/` can quietly assume April.
 *
 * A rule is three facts and a label: the month and day the year starts on, and how that
 * year is written. Everything else — start and end dates, which year a date falls in,
 * the months and quarters inside it — is derived here, once, for every rule.
 *
 * The awkward cases this is written around:
 *
 *   - A date and its fiscal year need not share a calendar year. 31 March 2026 belongs
 *     to the April-to-March year labelled 2025-26.
 *   - A fiscal year's last day is the day before the next one starts, which is how
 *     29 February and 30-day months take care of themselves.
 *   - A year may start on a day other than the 1st (the UK's 6 April is the usual
 *     example), in which case its months run from the 6th to the 5th.
 */

import {
  addDays,
  addMonths,
  compareDates,
  formatDate,
  isWithin,
  parseDate,
  TimeError,
  type DateString,
} from './calendar-date'

/**
 * How a fiscal year is positioned in the calendar and how it is written.
 *
 * A fiscal year is identified throughout by its **start year**: the calendar year its
 * first day falls in. The April-to-March year running 1 April 2026 to 31 March 2027 has
 * start year 2026 and, by convention, the label '2026-27'.
 */
export interface FiscalYearRule {
  /** Stable identifier, e.g. 'april-march'. Persisted and compared; not shown to users. */
  readonly id: string
  /** Calendar month the year starts in, 1-12. */
  readonly startMonth: number
  /** Day of that month the year starts on, 1-28. */
  readonly startDay: number
  /** How the year with this start year is written. */
  label(startYear: number): string
}

/** A resolved fiscal year. Maps directly onto a `fiscal_periods` row. */
export interface FiscalYear {
  /** The rule this was derived from. */
  ruleId: string
  /** Calendar year the fiscal year starts in. The year's identity. */
  startYear: number
  /** Display label, e.g. '2026-27' or '2026'. */
  label: string
  startDate: DateString
  /** Inclusive. The day before the next fiscal year begins. */
  endDate: DateString
}

export type PeriodGranularity = 'month' | 'quarter'

/** One period inside a fiscal year. Twelve months, or four quarters. */
export interface FiscalPeriod {
  /** Position within the fiscal year, 1-based. Period 1 starts on the year's first day. */
  index: number
  granularity: PeriodGranularity
  /** Label of the fiscal year this period belongs to. */
  fiscalYearLabel: string
  /** Display label, e.g. 'Apr 2026' or 'Q1 2026-27'. */
  label: string
  startDate: DateString
  /** Inclusive. */
  endDate: DateString
}

const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

/**
 * The latest day of a month a fiscal year may start on.
 *
 * Capped at 28 so that stepping a period forward by a month can never need to clamp:
 * a year starting on the 29th, 30th or 31st would have periods of inconsistent length
 * and a last period that did not end the day before the next year began. No real
 * regime starts a year that late.
 */
const MAX_START_DAY = 28

export interface FiscalYearRuleSpec {
  id: string
  /** 1-12. */
  startMonth: number
  /** 1-28. Defaults to 1. */
  startDay?: number
  /** Overrides the default label. Receives the start year. */
  label?: (startYear: number) => string
}

/**
 * Default label: '2026' for a year that sits inside one calendar year, '2026-27' for one
 * that spans two. A rule may override it.
 */
function defaultLabel(startMonth: number, startDay: number, startYear: number): string {
  const spansTwoCalendarYears = !(startMonth === 1 && startDay === 1)
  if (!spansTwoCalendarYears) {
    return String(startYear)
  }
  return `${String(startYear)}-${String((startYear + 1) % 100).padStart(2, '0')}`
}

/** Build a fiscal-year rule. A new regime defines its year here, not in `domain/`. */
export function createFiscalYearRule(spec: FiscalYearRuleSpec): FiscalYearRule {
  const startDay = spec.startDay ?? 1

  if (spec.id.trim() === '') {
    throw new TimeError('INVALID_FISCAL_YEAR_RULE', 'A fiscal-year rule needs an id.')
  }
  if (!Number.isInteger(spec.startMonth) || spec.startMonth < 1 || spec.startMonth > 12) {
    throw new TimeError(
      'INVALID_FISCAL_YEAR_RULE',
      `${spec.id}: startMonth must be 1-12, got ${String(spec.startMonth)}.`,
    )
  }
  if (!Number.isInteger(startDay) || startDay < 1 || startDay > MAX_START_DAY) {
    throw new TimeError(
      'INVALID_FISCAL_YEAR_RULE',
      `${spec.id}: startDay must be 1-${String(MAX_START_DAY)}, got ${String(startDay)}.`,
    )
  }

  const label =
    spec.label ?? ((startYear: number) => defaultLabel(spec.startMonth, startDay, startYear))

  return {
    id: spec.id,
    startMonth: spec.startMonth,
    startDay,
    label,
  }
}

/** 1 April to 31 March, labelled '2026-27'. India, and much of South Asia. */
export const aprilToMarch: FiscalYearRule = createFiscalYearRule({
  id: 'april-march',
  startMonth: 4,
})

/** 1 January to 31 December, labelled '2026'. Most of Europe, and the default elsewhere. */
export const januaryToDecember: FiscalYearRule = createFiscalYearRule({
  id: 'january-december',
  startMonth: 1,
})

/** First day of the fiscal year identified by `startYear`. */
export function fiscalYearStartDate(rule: FiscalYearRule, startYear: number): DateString {
  if (!Number.isInteger(startYear)) {
    throw new TimeError('INVALID_FISCAL_YEAR_RULE', `Not a start year: ${String(startYear)}`)
  }
  return formatDate({ year: startYear, month: rule.startMonth, day: rule.startDay })
}

/**
 * Last day of the fiscal year identified by `startYear`, inclusive.
 *
 * Derived as the day before the next year begins, so leap days and short months are
 * handled by the calendar rather than by a table of month lengths here.
 */
export function fiscalYearEndDate(rule: FiscalYearRule, startYear: number): DateString {
  return addDays(fiscalYearStartDate(rule, startYear + 1), -1)
}

/** The start year of the fiscal year `date` falls in. */
export function fiscalYearStartYearOf(rule: FiscalYearRule, date: DateString): number {
  const { year, month, day } = parseDate(date)
  const beforeStart = month < rule.startMonth || (month === rule.startMonth && day < rule.startDay)
  return beforeStart ? year - 1 : year
}

/** The fiscal year identified by `startYear`, fully resolved. */
export function fiscalYearFor(rule: FiscalYearRule, startYear: number): FiscalYear {
  return {
    ruleId: rule.id,
    startYear,
    label: rule.label(startYear),
    startDate: fiscalYearStartDate(rule, startYear),
    endDate: fiscalYearEndDate(rule, startYear),
  }
}

/** The fiscal year `date` falls in, fully resolved. */
export function fiscalYearOf(rule: FiscalYearRule, date: DateString): FiscalYear {
  return fiscalYearFor(rule, fiscalYearStartYearOf(rule, date))
}

/** The label of the fiscal year `date` falls in. */
export function fiscalYearLabelOf(rule: FiscalYearRule, date: DateString): string {
  return rule.label(fiscalYearStartYearOf(rule, date))
}

/** True when `date` falls within `fiscalYear`, first and last day included. */
export function containsDate(fiscalYear: FiscalYear, date: DateString): boolean {
  return isWithin(date, fiscalYear.startDate, fiscalYear.endDate)
}

function monthsPerPeriod(granularity: PeriodGranularity): number {
  return granularity === 'month' ? 1 : 3
}

function periodLabel(
  granularity: PeriodGranularity,
  index: number,
  startDate: DateString,
  fiscalYearLabel: string,
): string {
  if (granularity === 'quarter') {
    return `Q${String(index)} ${fiscalYearLabel}`
  }
  const { year, month } = parseDate(startDate)
  const abbreviation = MONTH_ABBREVIATIONS[month - 1]
  if (abbreviation === undefined) {
    throw new TimeError('INVALID_DATE', `No month ${String(month)}.`)
  }
  return `${abbreviation} ${String(year)}`
}

/**
 * The periods inside a fiscal year: twelve months, or four quarters.
 *
 * Periods are contiguous and non-overlapping, the first starts on the year's first day,
 * and the last ends on its last day — for every rule, including one that starts on a day
 * other than the 1st. Each period ends the day before the next begins, which is what
 * makes February 2028 end on the 29th without anything here mentioning leap years.
 */
export function periodsOf(
  rule: FiscalYearRule,
  startYear: number,
  granularity: PeriodGranularity,
): FiscalPeriod[] {
  const step = monthsPerPeriod(granularity)
  const count = 12 / step
  const yearStart = fiscalYearStartDate(rule, startYear)
  const fiscalYearLabel = rule.label(startYear)

  const periods: FiscalPeriod[] = []
  for (let position = 0; position < count; position += 1) {
    const startDate = addMonths(yearStart, position * step)
    const endDate = addDays(addMonths(yearStart, (position + 1) * step), -1)
    const index = position + 1
    periods.push({
      index,
      granularity,
      fiscalYearLabel,
      label: periodLabel(granularity, index, startDate, fiscalYearLabel),
      startDate,
      endDate,
    })
  }
  return periods
}

/** The period of the given granularity that `date` falls in. */
export function periodOf(
  rule: FiscalYearRule,
  date: DateString,
  granularity: PeriodGranularity,
): FiscalPeriod {
  const startYear = fiscalYearStartYearOf(rule, date)
  const period = periodsOf(rule, startYear, granularity).find(
    (candidate) =>
      compareDates(date, candidate.startDate) >= 0 && compareDates(date, candidate.endDate) <= 0,
  )
  if (period === undefined) {
    /* Unreachable: the periods tile the fiscal year the date was resolved against. */
    throw new TimeError(
      'INVALID_DATE',
      `${date} falls in no ${granularity} of ${String(startYear)}.`,
    )
  }
  return period
}
