/*
 * Dates, for the two places these screens show one: when a company was last opened, and
 * when it was created.
 *
 * Timestamps cross IPC as ISO-8601 UTC strings (docs/CONVENTIONS.md §3). They are shown
 * in the user's own time zone, because the only reader is the person sitting in front of
 * the machine — but in the form the voice rule fixes, `17 Sep 2026` and `9:40 pm`, and not
 * in the operating system's locale. `toLocaleDateString` wrote "Sep 17, 2026" on a machine
 * set up in American English, beside registers that say "17 Sep 2026".
 */

import { writtenDate, writtenDateParts, writtenDayOf, writtenTimeOf } from '@shared/written-date'

/** A timestamp that could not be read at all. Better than printing 'Invalid Date'. */
const UNREADABLE = 'at an unknown time'

export type DayDistance = 'today' | 'yesterday' | 'earlier' | 'future' | 'unreadable'

/** How far back a timestamp is, in whole local days. */
export function dayDistance(timestamp: string, now: Date): DayDistance {
  const at = new Date(timestamp)
  if (Number.isNaN(at.getTime())) return 'unreadable'

  const startOfDay = (date: Date): number =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)
  if (days < 0) return 'future'
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  return 'earlier'
}

function formatDay(timestamp: string): string {
  const at = new Date(timestamp)
  if (Number.isNaN(at.getTime())) return UNREADABLE
  return writtenDayOf(at)
}

function formatTime(timestamp: string): string {
  const at = new Date(timestamp)
  if (Number.isNaN(at.getTime())) return UNREADABLE
  return writtenTimeOf(at)
}

/**
 * The line under a company's name in the picker.
 *
 * `null` is a real state and gets its own sentence: a company that has been added or
 * restored but never unlocked is not the same as one opened long ago.
 */
export function describeLastOpened(timestamp: string | null, now: Date = new Date()): string {
  if (timestamp === null) return 'Not opened yet'
  switch (dayDistance(timestamp, now)) {
    case 'today':
      return `Opened today at ${formatTime(timestamp)}`
    case 'yesterday':
      return `Opened yesterday at ${formatTime(timestamp)}`
    case 'future':
    case 'earlier':
      return `Opened ${formatDay(timestamp)}`
    case 'unreadable':
      return 'Opened at an unknown time'
  }
}

/** The same treatment for a creation date, which is never null. */
export function describeCreated(timestamp: string): string {
  const day = formatDay(timestamp)
  return day === UNREADABLE ? 'Created at an unknown time' : `Created ${day}`
}

// ---- Calendar dates, as the app writes them ---------------------------------

/*
 * `31 Mar 2026`, the voice rule in docs/design.md, for a date the app WRITES. A date typed
 * into a field keeps the platform's own picker. The table and the reading of the string are
 * in `@shared/written-date`, because main writes dates into its messages too.
 */
const dateParts = writtenDateParts

/** `2026-09-13` as `13 Sep 2026`. Anything that is not an ISO date is shown as it came. */
export function formatDate(iso: string): string {
  return writtenDate(iso)
}

/**
 * A span of days, as short as it can honestly be: `1–15 Sep` inside one month,
 * `28 Aug – 3 Sep` across two, with the year only where the two ends are in different ones.
 */
export function formatDayRange(from: string, to: string): string {
  const start = dateParts(from)
  const end = dateParts(to)
  if (start === null || end === null) return `${from} – ${to}`
  if (start.year !== end.year) return `${formatDate(from)} – ${formatDate(to)}`
  if (start.month !== end.month) {
    return `${String(start.day)} ${start.month} – ${String(end.day)} ${end.month}`
  }
  return start.day === end.day
    ? `${String(start.day)} ${start.month}`
    : `${String(start.day)}–${String(end.day)} ${end.month}`
}

/** A file size a person can read. Used for the archive a backup just wrote. */
export function describeFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'an unknown size'
  if (bytes < 1024) return `${Math.round(bytes)} bytes`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${units[unit] ?? 'KB'}`
}
