/*
 * Time primitives. Import from here, not from the individual files.
 *
 * Dates are 'YYYY-MM-DD' text, instants are ISO-8601 UTC text, and the fiscal year is a
 * rule that arrives from the tax regime rather than a constant anything assumes.
 * See docs/CONVENTIONS.md §3 and docs/ARCHITECTURE.md §6.2.
 */

export {
  DATE_PATTERN,
  TimeError,
  addDays,
  addMonths,
  compareDates,
  daysBetween,
  daysInMonth,
  endOfMonth,
  formatDate,
  isDateString,
  isLeapYear,
  isWithin,
  parseDate,
  startOfMonth,
  type CalendarDate,
  type DateString,
  type TimeErrorCode,
} from './calendar-date'

export {
  TIMESTAMP_PATTERN,
  dateOfTimestamp,
  endOfDay,
  fixedClock,
  isTimestamp,
  now,
  parseTimestamp,
  startOfDay,
  systemClock,
  timestampFromEpochMs,
  today,
  type Clock,
  type Timestamp,
} from './instant'

export {
  aprilToMarch,
  containsDate,
  createFiscalYearRule,
  fiscalYearEndDate,
  fiscalYearFor,
  fiscalYearLabelOf,
  fiscalYearOf,
  fiscalYearStartDate,
  fiscalYearStartYearOf,
  januaryToDecember,
  periodOf,
  periodsOf,
  type FiscalPeriod,
  type FiscalYear,
  type FiscalYearRule,
  type FiscalYearRuleSpec,
  type PeriodGranularity,
} from './fiscal-year'
