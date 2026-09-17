/*
 * Dates as Coffer writes them in a sentence: `31 Mar 2026`, and a time as `9:40 pm`.
 *
 * SHARED, because both processes write sentences. The renderer draws dates on every screen,
 * and main writes the messages a refusal carries — "These books have no period covering
 * 1 Apr 2027" — which reach the screen unchanged. One table of month names keeps the two
 * from disagreeing.
 *
 * NEVER `toLocaleDateString`. The voice rule (docs/design.md) fixes the form, and the
 * locale Electron reports is the operating system's: on a machine set up in American
 * English it wrote "Sep 17, 2026" beside a register that says "17 Sep 2026".
 *
 * Pure, no DOM, no Node.
 */

const MONTHS = [
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

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export interface WrittenDateParts {
  day: number
  month: string
  year: string
}

/*
 * A calendar date is read off the string, not handed to `Date`. `2026-04-01` is the first of
 * April wherever the reader sits, and `new Date('2026-04-01')` is UTC midnight — the thirty-
 * first of March in every zone west of Greenwich.
 */
export function writtenDateParts(iso: string): WrittenDateParts | null {
  const match = ISO_DATE.exec(iso)
  if (match === null) return null
  const month = MONTHS[Number(match[2]) - 1]
  const day = Number(match[3])
  if (month === undefined || day < 1 || day > 31) return null
  return { day, month, year: match[1] ?? '' }
}

/** `2026-09-13` as `13 Sep 2026`. Anything that is not an ISO date is written as it came. */
export function writtenDate(iso: string): string {
  const parts = writtenDateParts(iso)
  return parts === null ? iso : `${String(parts.day)} ${parts.month} ${parts.year}`
}

/** The day an instant falls on where the reader is, as `17 Sep 2026`. */
export function writtenDayOf(at: Date): string {
  return `${String(at.getDate())} ${MONTHS[at.getMonth()] ?? ''} ${String(at.getFullYear())}`
}

/** The time of an instant where the reader is, as `9:40 pm`. Twelve-hour, lower case. */
export function writtenTimeOf(at: Date): string {
  const hours = at.getHours()
  const hour = hours % 12 === 0 ? 12 : hours % 12
  const minutes = String(at.getMinutes()).padStart(2, '0')
  return `${String(hour)}:${minutes} ${hours < 12 ? 'am' : 'pm'}`
}
