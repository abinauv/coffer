import { describe, expect, it } from 'vitest'
import {
  dayDistance,
  describeCreated,
  describeFileSize,
  describeLastOpened,
  formatDate,
  formatDayRange,
} from './dates'

/* Local times throughout: these lines are read by the person at the machine, and the
 * boundary that matters to them is their own midnight, not UTC's. */
const NOW = new Date(2026, 7, 14, 15, 30)

describe('dayDistance', () => {
  it('separates today, yesterday and everything older', () => {
    expect(dayDistance(new Date(2026, 7, 14, 8, 0).toISOString(), NOW)).toBe('today')
    expect(dayDistance(new Date(2026, 7, 13, 23, 59).toISOString(), NOW)).toBe('yesterday')
    expect(dayDistance(new Date(2026, 7, 1).toISOString(), NOW)).toBe('earlier')
  })

  it('notices a timestamp from the future rather than showing a negative age', () => {
    expect(dayDistance(new Date(2027, 0, 1).toISOString(), NOW)).toBe('future')
  })

  it('says so when a timestamp cannot be read', () => {
    expect(dayDistance('not a date', NOW)).toBe('unreadable')
  })
})

describe('describeLastOpened', () => {
  it('distinguishes never opened from opened long ago', () => {
    expect(describeLastOpened(null, NOW)).toBe('Not opened yet')
    expect(describeLastOpened(new Date(2026, 0, 4).toISOString(), NOW)).toContain('Opened ')
    expect(describeLastOpened(new Date(2026, 0, 4).toISOString(), NOW)).toContain('2026')
  })

  it('uses the day name for the last two days', () => {
    expect(describeLastOpened(new Date(2026, 7, 14, 9, 15).toISOString(), NOW)).toContain(
      'Opened today at',
    )
    expect(describeLastOpened(new Date(2026, 7, 13, 9, 15).toISOString(), NOW)).toContain(
      'Opened yesterday at',
    )
  })

  it('does not print "Invalid Date" at anyone', () => {
    expect(describeLastOpened('nonsense', NOW)).toBe('Opened at an unknown time')
  })
})

describe('describeCreated', () => {
  it('reads as a date', () => {
    expect(describeCreated(new Date(2026, 0, 4).toISOString())).toContain('Created ')
  })

  it('admits when it cannot read one', () => {
    expect(describeCreated('nonsense')).toBe('Created at an unknown time')
  })
})

describe('describeFileSize', () => {
  it('scales to the unit a person would use', () => {
    expect(describeFileSize(512)).toBe('512 bytes')
    expect(describeFileSize(2048)).toBe('2 KB')
    expect(describeFileSize(1024 * 1024 * 3.5)).toBe('3.5 MB')
    expect(describeFileSize(1024 * 1024 * 1024 * 12)).toBe('12 GB')
  })

  it('does not invent a size it does not have', () => {
    expect(describeFileSize(Number.NaN)).toBe('an unknown size')
    expect(describeFileSize(-1)).toBe('an unknown size')
  })
})

describe('formatDate', () => {
  it('writes a calendar date the way the design does', () => {
    expect(formatDate('2026-09-13')).toBe('13 Sep 2026')
    expect(formatDate('2027-03-31')).toBe('31 Mar 2027')
    expect(formatDate('2026-01-01')).toBe('1 Jan 2026')
  })

  /* Read off the string, never through `Date`: UTC midnight on the first of April is the
   * thirty-first of March west of Greenwich, and a document date has no zone at all. */
  it('does not move a date across midnight in any zone', () => {
    expect(formatDate('2026-04-01')).toBe('1 Apr 2026')
  })

  it('shows what it was given when that is not an ISO date', () => {
    expect(formatDate('13/09/2026')).toBe('13/09/2026')
    expect(formatDate('2026-13-01')).toBe('2026-13-01')
  })
})

describe('formatDayRange', () => {
  it('says the month once inside one month', () => {
    expect(formatDayRange('2026-09-01', '2026-09-15')).toBe('1–15 Sep')
    expect(formatDayRange('2026-09-01', '2026-09-01')).toBe('1 Sep')
  })

  it('names both months across two, and both years across two', () => {
    expect(formatDayRange('2026-08-28', '2026-09-03')).toBe('28 Aug – 3 Sep')
    expect(formatDayRange('2026-12-28', '2027-01-03')).toBe('28 Dec 2026 – 3 Jan 2027')
  })
})
