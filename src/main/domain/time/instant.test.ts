import { describe, expect, it } from 'vitest'
import { TimeError } from './calendar-date'
import {
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
} from './instant'

describe('parseTimestamp', () => {
  it('accepts the canonical form', () => {
    expect(parseTimestamp('1970-01-01T00:00:00.000Z')).toBe(0)
    expect(parseTimestamp('2026-08-13T09:30:00.000Z')).toBe(Date.UTC(2026, 7, 13, 9, 30, 0, 0))
  })

  it('rejects anything that is not exactly the canonical form', () => {
    const rejected = [
      '2026-08-13T09:30:00Z',
      '2026-08-13T09:30:00.000+05:30',
      '2026-08-13T09:30:00.000',
      '2026-08-13 09:30:00.000Z',
      '2026-08-13',
      '2026-08-13T09:30:00.00Z',
      '',
      'now',
    ]
    for (const text of rejected) {
      expect(() => parseTimestamp(text), text).toThrow(TimeError)
      expect(isTimestamp(text), text).toBe(false)
    }
  })

  it('rejects a well-formed string that is not a real instant', () => {
    /* Date would roll these over silently; the round-trip check catches them. */
    expect(() => parseTimestamp('2026-02-30T00:00:00.000Z')).toThrow(TimeError)
    expect(() => parseTimestamp('2026-01-01T25:00:00.000Z')).toThrow(TimeError)
    expect(() => parseTimestamp('2026-13-01T00:00:00.000Z')).toThrow(TimeError)
  })

  it('accepts the leap second-free leap day', () => {
    expect(isTimestamp('2028-02-29T23:59:59.999Z')).toBe(true)
    expect(isTimestamp('2026-02-29T00:00:00.000Z')).toBe(false)
  })

  it('rejects a non-string', () => {
    expect(isTimestamp(0)).toBe(false)
    expect(isTimestamp(new Date())).toBe(false)
  })
})

describe('timestampFromEpochMs', () => {
  it('round-trips', () => {
    const ms = Date.UTC(2026, 7, 13, 9, 30, 0, 0)
    expect(parseTimestamp(timestampFromEpochMs(ms))).toBe(ms)
  })

  it('always includes milliseconds and the Z', () => {
    expect(timestampFromEpochMs(0)).toBe('1970-01-01T00:00:00.000Z')
  })

  it('rejects a value that is not epoch milliseconds', () => {
    expect(() => timestampFromEpochMs(1.5)).toThrow(TimeError)
    expect(() => timestampFromEpochMs(Number.NaN)).toThrow(TimeError)
    expect(() => timestampFromEpochMs(8.64e15 + 1)).toThrow(TimeError)
  })
})

describe('clocks', () => {
  it('a fixed clock does not move', () => {
    const clock = fixedClock('2026-08-13T09:30:00.000Z')
    expect(now(clock)).toBe('2026-08-13T09:30:00.000Z')
    expect(now(clock)).toBe('2026-08-13T09:30:00.000Z')
    expect(today(clock)).toBe('2026-08-13')
  })

  it('the system clock produces a valid timestamp', () => {
    expect(isTimestamp(now(systemClock))).toBe(true)
  })

  it('a fixed clock rejects a malformed instant', () => {
    expect(() => fixedClock('2026-08-13')).toThrow(TimeError)
  })
})

describe('dateOfTimestamp and today', () => {
  it('takes the UTC calendar date, not the local one', () => {
    /* In IST (UTC+5:30) this instant is already 14 August locally. The stored date
     * must not depend on where the machine is. */
    expect(dateOfTimestamp('2026-08-13T23:30:00.000Z')).toBe('2026-08-13')
    expect(dateOfTimestamp('2026-08-13T00:00:00.000Z')).toBe('2026-08-13')
    expect(dateOfTimestamp('2026-08-13T23:59:59.999Z')).toBe('2026-08-13')
  })

  it('crosses the year at midnight UTC', () => {
    expect(dateOfTimestamp('2026-12-31T23:59:59.999Z')).toBe('2026-12-31')
    expect(dateOfTimestamp('2027-01-01T00:00:00.000Z')).toBe('2027-01-01')
  })

  it('today is the UTC date of now', () => {
    const clock = fixedClock('2027-03-31T18:30:00.000Z')
    expect(today(clock)).toBe('2027-03-31')
  })
})

describe('day bounds', () => {
  it('span the whole UTC day', () => {
    expect(startOfDay('2028-02-29')).toBe('2028-02-29T00:00:00.000Z')
    expect(endOfDay('2028-02-29')).toBe('2028-02-29T23:59:59.999Z')
    expect(parseTimestamp(endOfDay('2028-02-29')) - parseTimestamp(startOfDay('2028-02-29'))).toBe(
      86_399_999,
    )
  })

  it('reject a date that does not exist', () => {
    expect(() => startOfDay('2026-02-29')).toThrow(TimeError)
    expect(() => endOfDay('2026-02-29')).toThrow(TimeError)
  })
})
