/*
 * Reading a date out of somebody's bank statement. This is where bank imports actually
 * break, and it breaks silently, so the reasoning is written down at length.
 *
 * THE PROBLEM. `01/02/2026` is the first of February in India and the second of January
 * in the United States. NOTHING IN THE FILE SAYS WHICH. Not a header, not a locale tag,
 * not an encoding — CSV carries no metadata at all. A column of such values is
 * self-consistent under both readings for as long as every day of the month is twelve or
 * less, which for a month of statements is most of the time and for a quarter is common.
 *
 * WHY GUESSING IS THE WORST OPTION AVAILABLE. If the importer picks a reading and is
 * wrong, it does not fail. It produces a full year of transactions, every one of them
 * misdated, every total correct, and every reconciliation tying at the foot — because
 * the amounts were never in question. Nothing downstream can detect it: the trial
 * balance balances, the ledger balances, the bank balance matches. What is wrong is
 * WHICH MONTH each transaction is in, which surfaces months later as a GST return filed
 * against the wrong period. The error is invisible precisely where it is largest.
 *
 * SO THE FORMAT IS AN ARGUMENT, NEVER AN INFERENCE. `parseImportDate` takes the format
 * it is to read and refuses everything else. There is no "smart" mode, and adding one
 * would be a regression, not a feature.
 *
 * AND THE CALLER IS GIVEN A WAY TO KNOW WHETHER IT MAY DECIDE FOR ITSELF.
 * `surveyDateFormats` reads a whole column and reports which formats are consistent with
 * ALL of it, plus, for each format it eliminated, the value that eliminated it. Three
 * verdicts:
 *
 *   'unambiguous'  exactly one format reads every value. The file has told you. A
 *                  13 or a 31 in the first position rules out MM/DD; a 13 in the
 *                  second rules out DD/MM. One such value in eight hundred is enough.
 *   'ambiguous'    several formats survive. ASK THE USER. Do not pick. Check
 *                  `agreeOnEveryValue` first: when the survivors produce identical dates
 *                  for every value in this file, there is nothing to ask about.
 *   'none'         no format reads all of it — a mixed or malformed column, or a column
 *                  with nothing in it at all. An EMPTY column is deliberately 'none'
 *                  rather than "everything is consistent": every format is vacuously
 *                  consistent with no values, and reporting that as agreement would hand
 *                  a caller a licence to pick one.
 *
 * TWO-DIGIT YEARS ARE 20YY, FIXED, NEVER A SLIDING WINDOW. A window that moves with the
 * clock ("within fifty years of today") makes the SAME FILE import as different dates
 * depending on when it is imported. An import must be reproducible, and a bank CSV is
 * not from 1926. A file that needs another century needs a four-digit year.
 *
 * A TIME COMPONENT IS ACCEPTED AND DISCARDED; AN EXPLICIT TIME ZONE IS REFUSED. Several
 * Indian banks write `01/02/2027 00:00:00` in the date column, and the time is padding.
 * A zone is not padding: `2027-11-04T22:30:00Z` is the fifth of November in India, and
 * dropping the offset is the same class of mistake as `toISOString().slice(0, 10)`,
 * which converts to UTC first and therefore returns yesterday for anyone in India before
 * 05:30. So a zoned value is rejected by name rather than quietly truncated.
 */

import { formatDate, TimeError, type DateString } from '@main/domain/time'

import { unparsed, parsed, type FieldParse } from './errors'
import { foldText } from './text'

/**
 * Every date layout this module can read.
 *
 * Deliberately a closed list. Each entry is a real shape seen on an Indian bank or
 * accounting export; adding one is a visible change with a test beside it.
 */
export const DATE_FORMATS = [
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'DD-MM-YYYY',
  'MM-DD-YYYY',
  'DD.MM.YYYY',
  'MM.DD.YYYY',
  'DD/MM/YY',
  'MM/DD/YY',
  'DD-MM-YY',
  'MM-DD-YY',
  'DD-MMM-YYYY',
  'DD-MMM-YY',
  'DD MMM YYYY',
  'MMM DD, YYYY',
] as const

export type DateFormat = (typeof DATE_FORMATS)[number]

/** True when `value` names a format this module reads. */
export function isDateFormat(value: unknown): value is DateFormat {
  return typeof value === 'string' && (DATE_FORMATS as readonly string[]).includes(value)
}

/** The century a two-digit year lands in. Fixed, not derived from the clock — see the header. */
export const TWO_DIGIT_YEAR_CENTURY = 2000

/**
 * Read one date cell in a named format.
 *
 * Failure carries a reason, because "does not look like a DD/MM/YYYY date" and "31
 * February is not a real date" send the user to different fixes.
 */
export function parseImportDate(text: string, format: DateFormat): FieldParse<DateString> {
  const value = foldText(text)
  if (value === '') {
    return unparsed('is empty')
  }
  if (ZONED.test(value)) {
    return unparsed(
      'carries a time zone, so the day it names depends on where it is read — ' +
        'export the statement with a plain date column',
    )
  }

  const compiled = COMPILED[format]
  const match = compiled.pattern.exec(value)
  if (match === null) {
    return unparsed(`does not look like a ${format} date`)
  }

  let year: number | null = null
  let month: number | null = null
  let day: number | null = null

  for (const [position, part] of compiled.parts.entries()) {
    const captured = match[position + 1] ?? ''
    if (part === 'year4') {
      year = Number(captured)
    } else if (part === 'year2') {
      year = TWO_DIGIT_YEAR_CENTURY + Number(captured)
    } else if (part === 'month') {
      month = Number(captured)
    } else if (part === 'monthName') {
      const named = MONTH_NAMES[captured.toLowerCase()]
      if (named === undefined) {
        return unparsed(`has a month name Coffer does not know: ${JSON.stringify(captured)}`)
      }
      month = named
    } else {
      day = Number(captured)
    }
  }

  if (year === null || month === null || day === null) {
    /* Unreachable while every format in DATE_FORMATS names all three parts, and checked
     * anyway: the compiler cannot know that, and a format added without a day would
     * otherwise produce a date built from a silent NaN. */
    return unparsed(`does not carry a full date under ${format}`)
  }

  try {
    /* `formatDate` round-trips through the calendar, so 31/02 and 31/04 are refused
     * here rather than rolled over into the next month by a Date constructor. */
    return parsed(formatDate({ year, month, day }))
  } catch (error) {
    if (error instanceof TimeError) {
      return unparsed(`is not a real calendar date when read as ${format}`)
    }
    throw error
  }
}

/** One format that was eliminated, and the value that eliminated it. */
export interface RuledOutFormat {
  readonly format: DateFormat
  /** 0-based position in the values array that was passed in. */
  readonly index: number
  readonly value: string
  readonly why: string
}

export interface DateFormatSurvey {
  readonly considered: readonly DateFormat[]
  /** Formats that read every non-blank value. In `DATE_FORMATS` order. */
  readonly consistent: readonly DateFormat[]
  readonly ruledOut: readonly RuledOutFormat[]
  /** Non-blank values the survey actually looked at. */
  readonly valuesConsidered: number
  readonly blankValues: number
  readonly verdict: 'unambiguous' | 'ambiguous' | 'none'
  /**
   * True when every surviving format produces the SAME date for every value in this
   * column — so an 'ambiguous' verdict has nothing to ask the user about. A two-row file
   * of `05/05/2027, 06/06/2027` reads identically as DD/MM and as MM/DD.
   *
   * False when nothing survived: no formats cannot agree.
   */
  readonly agreeOnEveryValue: boolean
}

/**
 * Report which formats are consistent with a whole column of values.
 *
 * Blank cells are skipped and counted, not treated as failures — an optional date column
 * with gaps is ordinary.
 */
export function surveyDateFormats(
  values: readonly string[],
  candidates: readonly DateFormat[] = DATE_FORMATS,
): DateFormatSurvey {
  const nonBlank: { index: number; value: string }[] = []
  let blankValues = 0
  for (const [index, raw] of values.entries()) {
    const value = foldText(raw)
    if (value === '') {
      blankValues += 1
      continue
    }
    nonBlank.push({ index, value })
  }

  const consistent: DateFormat[] = []
  const ruledOut: RuledOutFormat[] = []
  const datesByFormat = new Map<DateFormat, string[]>()

  for (const format of candidates) {
    const dates: string[] = []
    let survived = true
    for (const { index, value } of nonBlank) {
      const attempt = parseImportDate(value, format)
      if (!attempt.ok) {
        ruledOut.push({ format, index, value, why: attempt.message })
        survived = false
        break
      }
      dates.push(attempt.value)
    }
    if (survived) {
      consistent.push(format)
      datesByFormat.set(format, dates)
    }
  }

  /* Vacuous consistency is not consistency. With no values to read, every candidate
   * survives the loop above, and calling that 'unambiguous' would tell a caller it may
   * pick a format on the strength of an empty column. See the module header. */
  if (nonBlank.length === 0) {
    return {
      considered: [...candidates],
      consistent: [],
      ruledOut: [],
      valuesConsidered: 0,
      blankValues,
      verdict: 'none',
      agreeOnEveryValue: false,
    }
  }

  const verdict =
    consistent.length === 0 ? 'none' : consistent.length === 1 ? 'unambiguous' : 'ambiguous'

  return {
    considered: [...candidates],
    consistent,
    ruledOut,
    valuesConsidered: nonBlank.length,
    blankValues,
    verdict,
    agreeOnEveryValue: allFormatsAgree(consistent, datesByFormat),
  }
}

// ---- Internals ------------------------------------------------------------

function allFormatsAgree(
  consistent: readonly DateFormat[],
  datesByFormat: ReadonlyMap<DateFormat, readonly string[]>,
): boolean {
  const first = consistent[0]
  if (first === undefined) {
    return false
  }
  const reference = datesByFormat.get(first) ?? []
  return consistent.every((format) => {
    const dates = datesByFormat.get(format) ?? []
    return dates.length === reference.length && dates.every((date, at) => date === reference[at])
  })
}

/**
 * A time followed by an explicit offset or `Z`. Anchored on the time so that the hyphens
 * inside `2027-11-04` cannot be mistaken for a negative offset.
 */
const ZONED = /\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:Z|[+-]\d{2}:?\d{2})\s*$/

/**
 * A trailing clock time, which is accepted and thrown away. Optional seconds, optional
 * fractional seconds, optional am/pm. Preceded by whitespace or a `T`.
 */
const TIME_SUFFIX = String.raw`(?:[\sT]+\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s*[AaPp]\.?[Mm]\.?)?)?`

type DatePart = 'year4' | 'year2' | 'month' | 'monthName' | 'day'

interface CompiledFormat {
  readonly pattern: RegExp
  /** The parts in capture-group order. */
  readonly parts: readonly DatePart[]
}

/*
 * Longest token first. `YYYY` has to be tried before `YY` and `MMM` before `MM`, or the
 * scanner consumes the prefix and leaves a stray `YY` to be treated as two literal Y
 * characters — a pattern that then matches nothing, silently, for one format only.
 */
const TOKENS: readonly { token: string; part: DatePart; source: string }[] = [
  { token: 'YYYY', part: 'year4', source: String.raw`(\d{4})` },
  { token: 'MMM', part: 'monthName', source: String.raw`([A-Za-z]{3,9})` },
  { token: 'MM', part: 'month', source: String.raw`(\d{1,2})` },
  { token: 'DD', part: 'day', source: String.raw`(\d{1,2})` },
  { token: 'YY', part: 'year2', source: String.raw`(\d{2})` },
]

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compileFormat(format: DateFormat): CompiledFormat {
  const parts: DatePart[] = []
  let source = '^'
  let at = 0

  while (at < format.length) {
    const token = TOKENS.find((candidate) => format.startsWith(candidate.token, at))
    if (token !== undefined) {
      source += token.source
      parts.push(token.part)
      at += token.token.length
      continue
    }

    const character = format.charAt(at)
    if (character === ' ') {
      /* One or more of any whitespace: `foldText` has already collapsed runs, but a
       * caller may hand a raw value straight to `parseImportDate`. */
      source += String.raw`\s+`
      at += 1
      continue
    }
    if (character === ',') {
      /* `Nov 04,2027` and `Nov 04, 2027` are the same date. Absorb the space that
       * follows a comma in the format so it does not become a second, required, `\s+`. */
      source += String.raw`,\s*`
      at += format.startsWith(', ', at) ? 2 : 1
      continue
    }
    source += escapeRegExp(character)
    at += 1
  }

  return { pattern: new RegExp(`${source}${TIME_SUFFIX}$`), parts }
}

/*
 * Compiled once. Built from DATE_FORMATS itself, so the record is total by construction:
 * a format cannot be added to the union without an entry appearing here.
 */
const COMPILED = Object.fromEntries(
  DATE_FORMATS.map((format) => [format, compileFormat(format)]),
) as Readonly<Record<DateFormat, CompiledFormat>>

/**
 * Month names, abbreviated and in full, lower case. `sept` is here because it is
 * four letters and real; a three-letter-only table drops it and the row fails with
 * "unknown month name" for one bank in twenty.
 */
const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
}
