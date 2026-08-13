import { describe, expect, it } from 'vitest'
import {
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
  TimeError,
} from './calendar-date'
import fixture from './__fixtures__/calendar.json'

interface CalendarFixture {
  leapYears: { year: number; isLeap: boolean; why?: string }[]
  daysInMonth: { year: number; month: number; days: number }[]
  addDays: { date: string; days: number; expected: string; why?: string }[]
  addMonths: { date: string; months: number; expected: string; why?: string }[]
  daysBetween: { from: string; to: string; expected: number; why?: string }[]
  monthBounds: { date: string; start: string; end: string }[]
  invalidDates: { text: string; why: string }[]
  validDates: string[]
}

const golden = fixture as unknown as CalendarFixture

describe('isLeapYear — golden cases', () => {
  for (const entry of golden.leapYears) {
    it(`${String(entry.year)} ${entry.isLeap ? 'is' : 'is not'} a leap year`, () => {
      expect(isLeapYear(entry.year)).toBe(entry.isLeap)
    })
  }
})

describe('daysInMonth — golden cases', () => {
  for (const entry of golden.daysInMonth) {
    it(`${String(entry.year)}-${String(entry.month)} has ${String(entry.days)} days`, () => {
      expect(daysInMonth(entry.year, entry.month)).toBe(entry.days)
    })
  }

  it('rejects a month that does not exist', () => {
    expect(() => daysInMonth(2026, 0)).toThrow(TimeError)
    expect(() => daysInMonth(2026, 13)).toThrow(TimeError)
  })
})

describe('parseDate', () => {
  for (const text of golden.validDates) {
    it(`accepts ${text}`, () => {
      expect(formatDate(parseDate(text))).toBe(text)
      expect(isDateString(text)).toBe(true)
    })
  }

  for (const { text, why } of golden.invalidDates) {
    it(`rejects ${JSON.stringify(text)} — ${why}`, () => {
      expect(() => parseDate(text)).toThrow(TimeError)
      expect(isDateString(text)).toBe(false)
    })
  }

  it('names the field it was reading', () => {
    expect(() => parseDate('nope', 'journal_entries.date')).toThrowError(/journal_entries\.date/)
  })

  it('returns 1-based month and day', () => {
    expect(parseDate('2026-08-13')).toEqual({ year: 2026, month: 8, day: 13 })
  })

  it('rejects a non-string', () => {
    expect(isDateString(20260813)).toBe(false)
    expect(isDateString(null)).toBe(false)
  })
})

describe('formatDate', () => {
  it('zero-pads so dates sort as text', () => {
    expect(formatDate({ year: 2026, month: 1, day: 2 })).toBe('2026-01-02')
  })

  it('refuses to format a date that does not exist', () => {
    expect(() => formatDate({ year: 2026, month: 2, day: 29 })).toThrow(TimeError)
    expect(() => formatDate({ year: 2026, month: 13, day: 1 })).toThrow(TimeError)
  })
})

describe('addDays — golden cases', () => {
  for (const entry of golden.addDays) {
    it(`${entry.date} + ${String(entry.days)} days is ${entry.expected}`, () => {
      expect(addDays(entry.date, entry.days)).toBe(entry.expected)
    })
  }

  it('is reversible', () => {
    for (const entry of golden.addDays) {
      expect(addDays(entry.expected, -entry.days)).toBe(entry.date)
    }
  })

  it('does not shift with the host time zone', () => {
    /* Every value here is derived from UTC arithmetic on strings; a local-time
     * implementation would move by a day either side of midnight in some zones. */
    expect(addDays('2026-01-01', 0)).toBe('2026-01-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('rejects a fractional day count', () => {
    expect(() => addDays('2026-01-01', 1.5)).toThrow(TimeError)
  })
})

describe('addMonths — golden cases', () => {
  for (const entry of golden.addMonths) {
    it(`${entry.date} + ${String(entry.months)} months is ${entry.expected}`, () => {
      expect(addMonths(entry.date, entry.months)).toBe(entry.expected)
    })
  }

  it('rejects a fractional month count', () => {
    expect(() => addMonths('2026-01-01', 0.5)).toThrow(TimeError)
  })
})

describe('daysBetween — golden cases', () => {
  for (const entry of golden.daysBetween) {
    it(`${entry.from} to ${entry.to} is ${String(entry.expected)} days`, () => {
      expect(daysBetween(entry.from, entry.to)).toBe(entry.expected)
    })
  }

  it('is antisymmetric', () => {
    for (const entry of golden.daysBetween) {
      expect(daysBetween(entry.to, entry.from)).toBe(0 - entry.expected)
    }
  })

  it('agrees with addDays', () => {
    for (const entry of golden.daysBetween) {
      expect(addDays(entry.from, entry.expected)).toBe(entry.to)
    }
  })
})

describe('month bounds — golden cases', () => {
  for (const entry of golden.monthBounds) {
    it(`${entry.date} sits in ${entry.start}..${entry.end}`, () => {
      expect(startOfMonth(entry.date)).toBe(entry.start)
      expect(endOfMonth(entry.date)).toBe(entry.end)
      expect(addDays(entry.end, 1)).toBe(addMonths(entry.start, 1))
    })
  }
})

describe('compareDates and isWithin', () => {
  it('orders dates', () => {
    expect(compareDates('2026-01-01', '2026-01-02')).toBe(-1)
    expect(compareDates('2026-01-02', '2026-01-01')).toBe(1)
    expect(compareDates('2026-01-01', '2026-01-01')).toBe(0)
  })

  it('validates both operands rather than comparing nonsense', () => {
    expect(() => compareDates('2026-13-01', '2026-01-01')).toThrowError(/left date/)
    expect(() => compareDates('2026-01-01', '2026-02-30')).toThrowError(/right date/)
  })

  it('includes both ends of the range', () => {
    expect(isWithin('2026-04-01', '2026-04-01', '2027-03-31')).toBe(true)
    expect(isWithin('2027-03-31', '2026-04-01', '2027-03-31')).toBe(true)
    expect(isWithin('2026-03-31', '2026-04-01', '2027-03-31')).toBe(false)
    expect(isWithin('2027-04-01', '2026-04-01', '2027-03-31')).toBe(false)
  })
})
