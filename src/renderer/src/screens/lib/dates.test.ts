import { describe, expect, it } from 'vitest'
import { dayDistance, describeCreated, describeFileSize, describeLastOpened } from './dates'

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
