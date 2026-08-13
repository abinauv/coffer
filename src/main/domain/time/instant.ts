/*
 * Instants as ISO-8601 UTC text: '2026-08-13T09:30:00.000Z'.
 *
 * docs/CONVENTIONS.md §3: never a local-time timestamp, never a stored `Date`. One
 * canonical form, always UTC, always with milliseconds and a trailing `Z`, so stored
 * timestamps sort as text in the same order they happened and mean the same thing when
 * the database is copied to a machine in another zone.
 *
 * Reading the clock is the one thing in `domain/` that could not be a pure function, so
 * it is not one: every helper here takes a `Clock`. That keeps the domain deterministic
 * under test — a fiscal-period boundary test that depends on when it is run is worse
 * than no test — and leaves `systemClock` as the single, explicit place the real clock
 * is read.
 */

import { formatDate, parseDate, TimeError, type DateString } from './calendar-date'

/** An ISO-8601 UTC timestamp with milliseconds, e.g. '2026-08-13T09:30:00.000Z'. */
export type Timestamp = string

/** Shape only. A string matching this may still be an impossible instant. */
export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** A source of the current time. Injected so that domain logic stays deterministic. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  nowMs(): number
}

/** The real clock. The only place in `domain/` that reads it. */
export const systemClock: Clock = {
  nowMs: () => Date.now(),
}

/** A clock frozen at a given instant. For tests and for one-instant-per-transaction work. */
export function fixedClock(at: Timestamp): Clock {
  const ms = parseTimestamp(at)
  return { nowMs: () => ms }
}

/**
 * Parse an ISO-8601 UTC timestamp, returning epoch milliseconds.
 *
 * Strict in both directions: the text must match the canonical form and must survive a
 * round-trip through `Date`, so '2026-02-30T00:00:00.000Z' and '2026-01-01T25:00:00.000Z'
 * are rejected rather than silently rolled over into the next day.
 */
export function parseTimestamp(text: string, what = 'timestamp'): number {
  if (!TIMESTAMP_PATTERN.test(text)) {
    throw new TimeError(
      'INVALID_TIMESTAMP',
      `${what} is not an ISO-8601 UTC timestamp: ${JSON.stringify(text)}`,
    )
  }
  const ms = Date.parse(text)
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== text) {
    throw new TimeError('INVALID_TIMESTAMP', `${what} is not a real instant: ${text}`)
  }
  return ms
}

/** True when `value` is a canonical ISO-8601 UTC timestamp. */
export function isTimestamp(value: unknown): value is Timestamp {
  if (typeof value !== 'string') {
    return false
  }
  try {
    parseTimestamp(value)
    return true
  } catch {
    return false
  }
}

/** The largest magnitude a JavaScript Date can represent, in milliseconds. */
const MAX_EPOCH_MS = 8_640_000_000_000_000

/** Render epoch milliseconds as a canonical timestamp. */
export function timestampFromEpochMs(ms: number): Timestamp {
  if (!Number.isSafeInteger(ms) || Math.abs(ms) > MAX_EPOCH_MS) {
    throw new TimeError('INVALID_TIMESTAMP', `Not an epoch-millisecond value: ${String(ms)}`)
  }
  const text = new Date(ms).toISOString()
  if (!TIMESTAMP_PATTERN.test(text)) {
    throw new TimeError('INVALID_TIMESTAMP', `Epoch value is out of range: ${String(ms)}`)
  }
  return text
}

/** The current instant, as a canonical timestamp. */
export function now(clock: Clock): Timestamp {
  return timestampFromEpochMs(clock.nowMs())
}

/** The UTC calendar date an instant falls on. */
export function dateOfTimestamp(timestamp: Timestamp): DateString {
  const moment = new Date(parseTimestamp(timestamp))
  return formatDate({
    year: moment.getUTCFullYear(),
    month: moment.getUTCMonth() + 1,
    day: moment.getUTCDate(),
  })
}

/**
 * Today's UTC date.
 *
 * UTC, not the user's local day — the alternative is a document dated differently
 * depending on where it was entered from, and a period that closes at a different
 * moment for each user. Where a screen needs the user's local day it converts for
 * display; the stored value stays UTC.
 */
export function today(clock: Clock): DateString {
  return dateOfTimestamp(now(clock))
}

/** The instant at the very start of a UTC calendar date. */
export function startOfDay(date: DateString): Timestamp {
  parseDate(date)
  return `${date}T00:00:00.000Z`
}

/** The last representable instant within a UTC calendar date. */
export function endOfDay(date: DateString): Timestamp {
  parseDate(date)
  return `${date}T23:59:59.999Z`
}
