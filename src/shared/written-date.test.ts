import { describe, expect, it } from 'vitest'
import { writtenDate, writtenDateParts, writtenDayOf, writtenTimeOf } from './written-date'

describe('writtenDate', () => {
  it('writes a calendar date the way the design does', () => {
    expect(writtenDate('2026-09-13')).toBe('13 Sep 2026')
    expect(writtenDate('2027-03-31')).toBe('31 Mar 2027')
    expect(writtenDate('2026-01-01')).toBe('1 Jan 2026')
  })

  /* Read off the string: handed to `Date`, this is 31 Mar in every zone west of UTC. */
  it('never moves a calendar date across midnight', () => {
    expect(writtenDate('2026-04-01')).toBe('1 Apr 2026')
  })

  it('writes anything that is not an ISO date as it came', () => {
    expect(writtenDate('yesterday')).toBe('yesterday')
    expect(writtenDate('2026-13-01')).toBe('2026-13-01')
    expect(writtenDate('2026-02-00')).toBe('2026-02-00')
    expect(writtenDateParts('2026-9-1')).toBeNull()
  })
})

describe('an instant, where the reader is', () => {
  /* Local constructors, so the assertion holds in whatever zone the suite runs in. */
  it('writes the day as 17 Sep 2026, whatever the machine locale', () => {
    expect(writtenDayOf(new Date(2026, 8, 17, 23, 59))).toBe('17 Sep 2026')
    expect(writtenDayOf(new Date(2026, 0, 5))).toBe('5 Jan 2026')
  })

  it('writes the time on a twelve-hour clock in lower case', () => {
    expect(writtenTimeOf(new Date(2026, 8, 17, 21, 40))).toBe('9:40 pm')
    expect(writtenTimeOf(new Date(2026, 8, 17, 9, 5))).toBe('9:05 am')
  })

  it('calls midnight 12 am and noon 12 pm', () => {
    expect(writtenTimeOf(new Date(2026, 8, 17, 0, 0))).toBe('12:00 am')
    expect(writtenTimeOf(new Date(2026, 8, 17, 12, 30))).toBe('12:30 pm')
  })
})
