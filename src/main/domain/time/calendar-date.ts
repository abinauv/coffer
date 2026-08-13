/*
 * Calendar dates as 'YYYY-MM-DD' text.
 *
 * docs/CONVENTIONS.md §3: a date is a `YYYY-MM-DD` string, in TypeScript and in SQLite
 * alike. Never a `Date` object, never a local-time value. A `Date` carries a time and a
 * zone whether or not you wanted them, and the day an invoice was issued is not a
 * moment — it is a day, the same day in every zone the books are ever opened in.
 *
 * The arithmetic here uses a UTC `Date` internally as a calendar calculator and throws
 * it away immediately. UTC only: no local-time construction, no `getFullYear`, so no
 * function in this file can return a different answer on a machine in another zone.
 *
 * Comparison is deliberately absent as an operation on a parsed value: fixed-width
 * zero-padded 'YYYY-MM-DD' sorts correctly as plain text, so `a < b` on the strings is
 * already right and `compareDates` exists only to validate its operands first.
 */

export type TimeErrorCode = 'INVALID_DATE' | 'INVALID_TIMESTAMP' | 'INVALID_FISCAL_YEAR_RULE'

/**
 * A malformed date, timestamp or fiscal-year rule. A programmer or data-integrity
 * error, not something the user can act on, so it throws — docs/CONVENTIONS.md §5.
 */
export class TimeError extends Error {
  readonly code: TimeErrorCode

  constructor(code: TimeErrorCode, message: string) {
    super(message)
    this.name = 'TimeError'
    this.code = code
  }
}

/** A calendar date, 'YYYY-MM-DD'. No time, no zone. */
export type DateString = string

/** The parts of a calendar date. `month` is 1-12; `day` is 1-31. */
export interface CalendarDate {
  year: number
  month: number
  day: number
}

/** Shape only. A string matching this may still be an impossible date, e.g. 2026-02-30. */
export const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

const MIN_YEAR = 1000
const MAX_YEAR = 9999

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/** Format date parts as 'YYYY-MM-DD'. Validates that the date exists. */
export function formatDate(date: CalendarDate): DateString {
  const text = `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`
  /* Round-trip through the parser so an impossible date cannot be formatted into
   * existence and then stored. */
  parseDate(text, 'formatted date')
  return text
}

/**
 * Parse 'YYYY-MM-DD' into its parts.
 *
 * Rejects anything that is not exactly ten characters of zero-padded digits, and
 * anything that is not a real calendar date: 2026-02-29 fails because 2026 is not a
 * leap year, while 2028-02-29 succeeds.
 */
export function parseDate(text: string, what = 'date'): CalendarDate {
  const match = DATE_PATTERN.exec(text)
  if (match === null) {
    throw new TimeError(
      'INVALID_DATE',
      `${what} is not a 'YYYY-MM-DD' date: ${JSON.stringify(text)}`,
    )
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])

  if (year < MIN_YEAR || year > MAX_YEAR) {
    throw new TimeError('INVALID_DATE', `${what} has an out-of-range year: ${text}`)
  }
  if (month < 1 || month > 12) {
    throw new TimeError('INVALID_DATE', `${what} has no month ${String(month)}: ${text}`)
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new TimeError('INVALID_DATE', `${what} is not a real calendar date: ${text}`)
  }

  return { year, month, day }
}

/** True when `value` is a real calendar date in 'YYYY-MM-DD' form. */
export function isDateString(value: unknown): value is DateString {
  if (typeof value !== 'string') {
    return false
  }
  try {
    parseDate(value)
    return true
  } catch {
    return false
  }
}

/** Proleptic Gregorian leap year: divisible by 4, except centuries not divisible by 400. */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** Days in a given month. February is 29 in a leap year. */
export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) {
    throw new TimeError('INVALID_DATE', `No month ${String(month)}.`)
  }
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

/** Days since the epoch, using UTC purely as a calendar calculator. */
function toEpochDay(date: DateString): number {
  const { year, month, day } = parseDate(date)
  return Date.UTC(year, month - 1, day) / 86_400_000
}

function fromEpochDay(epochDay: number): DateString {
  const moment = new Date(epochDay * 86_400_000)
  return formatDate({
    year: moment.getUTCFullYear(),
    month: moment.getUTCMonth() + 1,
    day: moment.getUTCDate(),
  })
}

/** Add calendar days. Negative values subtract. Crosses month, year and leap boundaries. */
export function addDays(date: DateString, days: number): DateString {
  if (!Number.isSafeInteger(days)) {
    throw new TimeError('INVALID_DATE', `Cannot add ${String(days)} days.`)
  }
  return fromEpochDay(toEpochDay(date) + days)
}

/**
 * Add calendar months, clamping the day to the end of the target month.
 *
 * 31 January plus one month is 28 February, or 29 February in a leap year. This is the
 * conventional answer and the one that keeps monthly periods contiguous, but it is not
 * reversible — subtracting a month from the result does not return 31 January. Where
 * that matters, work from the period start rather than stepping back and forth.
 */
export function addMonths(date: DateString, months: number): DateString {
  if (!Number.isSafeInteger(months)) {
    throw new TimeError('INVALID_DATE', `Cannot add ${String(months)} months.`)
  }
  const { year, month, day } = parseDate(date)
  const zeroBased = year * 12 + (month - 1) + months
  const targetYear = Math.floor(zeroBased / 12)
  const targetMonth = (zeroBased % 12) + 1
  return formatDate({
    year: targetYear,
    month: targetMonth,
    day: Math.min(day, daysInMonth(targetYear, targetMonth)),
  })
}

/** Whole days from `from` to `to`. Negative when `to` is earlier. */
export function daysBetween(from: DateString, to: DateString): number {
  return toEpochDay(to) - toEpochDay(from)
}

/** -1, 0 or 1. Validates both operands, which comparing the raw strings does not. */
export function compareDates(a: DateString, b: DateString): -1 | 0 | 1 {
  parseDate(a, 'left date')
  parseDate(b, 'right date')
  if (a < b) {
    return -1
  }
  return a > b ? 1 : 0
}

/** True when `date` falls within `[start, end]`, both ends included. */
export function isWithin(date: DateString, start: DateString, end: DateString): boolean {
  return compareDates(date, start) >= 0 && compareDates(date, end) <= 0
}

/** The first day of the month `date` falls in. */
export function startOfMonth(date: DateString): DateString {
  const { year, month } = parseDate(date)
  return formatDate({ year, month, day: 1 })
}

/** The last day of the month `date` falls in. */
export function endOfMonth(date: DateString): DateString {
  const { year, month } = parseDate(date)
  return formatDate({ year, month, day: daysInMonth(year, month) })
}
