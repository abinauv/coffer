/*
 * What can go wrong while reading somebody's CSV, split into the two kinds it actually
 * comes in.
 *
 * A `CsvError` is a REFUSAL: the caller asked for something this module will not do, or
 * the file is so far outside what a statement can be that continuing would only produce
 * nonsense at scale. An empty delimiter, a negative row limit, ten million columns on
 * one line. It throws, because there is no per-row answer to give.
 *
 * An `ImportIssue` is a REPORT: one row, or one column, that could not be read, while
 * the rest of the file was fine. These are collected and returned, never thrown. The
 * reason is the whole point of the module — somebody importing eight hundred rows needs
 * the list of the eleven that failed, with row and column numbers, not the first one and
 * a stack trace. A parser that throws on the first bad date makes the user fix and
 * re-run eleven times.
 *
 * SEVERITY IS NOT DECORATION. An `error` means a row (or the whole mapping) produced no
 * data; a `warning` means something was noticed and the data still came through. A UI
 * can offer "import anyway" for warnings and must not for errors.
 *
 * ONE RULE INHERITED FROM companies/errors.ts: every message is written for the person
 * holding the statement. It names the column heading they can see in their file, and the
 * row number their spreadsheet shows, not an array index.
 */

export type CsvErrorCode =
  /** A delimiter or quote character that cannot work — empty, multi-character, or a newline. */
  | 'CSV_DELIMITER_INVALID'
  /** A size limit that is not a positive whole number. See the note in parse.ts. */
  | 'CSV_LIMIT_INVALID'
  /** More rows than the configured limit. */
  | 'CSV_TOO_MANY_ROWS'
  /** More fields on one line than the configured limit. */
  | 'CSV_TOO_MANY_COLUMNS'
  /** A single field longer than the configured limit — usually an unterminated quote. */
  | 'CSV_FIELD_TOO_LONG'
  /** A column mapping that does not describe anything: no candidate headings, say. */
  | 'CSV_SPEC_INVALID'

/** A refusal from the CSV importer. Carries a stable, machine-readable code. */
export class CsvError extends Error {
  readonly code: CsvErrorCode

  constructor(code: CsvErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CsvError'
    this.code = code
  }
}

/** True when `value` is a `CsvError`. */
export function isCsvError(value: unknown): value is CsvError {
  return value instanceof CsvError
}

export type ImportIssueCode =
  /** A required target field has no column in this file. The mapping cannot run. */
  | 'MISSING_COLUMN'
  /** Two columns could serve one target field, or two headings share a name. */
  | 'AMBIGUOUS_COLUMN'
  /** A heading cell is empty, so that column can never be matched by name. */
  | 'UNNAMED_COLUMN'
  /** A column in the file that no target field claims. Informational. */
  | 'UNMAPPED_COLUMN'
  /** Two target fields resolved to the same source column. Probably a mapping mistake. */
  | 'COLUMN_USED_TWICE'
  /** A row has more or fewer fields than the header. Never padded — see table.ts. */
  | 'RAGGED_ROW'
  /** A required field was blank on this row. */
  | 'MISSING_VALUE'
  /** A date cell did not read as the format the caller named. */
  | 'INVALID_DATE'
  /** An amount cell did not read as a number, or a debit/credit pair did not resolve. */
  | 'INVALID_AMOUNT'
  /** A text cell was longer than the field allows. */
  | 'VALUE_TOO_LONG'
  /** A quote opened and the file ended before it closed — it swallowed the rest. */
  | 'UNTERMINATED_QUOTE'
  /** Characters after a closing quote, which no well-formed CSV produces. */
  | 'TEXT_AFTER_CLOSING_QUOTE'
  /** More issues than the caller asked to be listed. The counts are still complete. */
  | 'ISSUE_LIMIT_REACHED'

export type ImportIssueSeverity = 'error' | 'warning'

/**
 * One thing that went wrong, located precisely enough for a user to go and look at it.
 *
 * `line` is the 1-based line of the ORIGINAL FILE, which is what a text editor shows and
 * is NOT the row number once a quoted field has contained a newline. `rowNumber` is the
 * 1-based position among data rows, header excluded, which is what a spreadsheet user
 * counts. Both are carried because the two disagree exactly in the files that are
 * hardest to debug, and a message with only one of them sends the user to the wrong
 * place in precisely those files.
 */
export interface ImportIssue {
  readonly code: ImportIssueCode
  readonly severity: ImportIssueSeverity
  /** Written for the user: what is wrong and, where possible, what to do. */
  readonly message: string
  /** 1-based line in the file as a text editor counts them. */
  readonly line?: number
  /** 1-based position among data rows, header excluded. */
  readonly rowNumber?: number
  /** 1-based column position in the row. */
  readonly columnNumber?: number
  /** The heading as it is written in the file. */
  readonly heading?: string
  /** The target field the issue is about, where there is one. */
  readonly field?: string
  /** The offending cell, so the message can be read without opening the file. */
  readonly value?: string
}

/**
 * The result of reading one cell.
 *
 * Deliberately not an exception and deliberately not `T | null`. A caller assembling a
 * row needs the REASON to put in the issue list — "31 February is not a real date" and
 * "does not look like a DD/MM/YYYY date" send the user to different fixes, and `null`
 * says neither.
 */
export type FieldParse<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

/** Build a successful field parse. */
export function parsed<T>(value: T): FieldParse<T> {
  return { ok: true, value }
}

/** Build a failed field parse. `message` completes the sentence "<column> <message>". */
export function unparsed<T>(message: string): FieldParse<T> {
  return { ok: false, message }
}

/*
 * Positive, whole, and NOT zero.
 *
 * Zero is refused rather than read as "no limit", because a limit whose disabled value
 * looks like an ordinary small number is how a cap silently stops existing. This project
 * has already paid for the general version of that mistake: `slice(0, -0)` is `''`, so a
 * zero group size was harmless and a NEGATIVE one hung the render — the guess about
 * which malformed input was dangerous was exactly backwards. A limit here says what it
 * means or it is rejected at the door.
 */
export function requirePositiveInteger(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CsvError(
      'CSV_LIMIT_INVALID',
      `${what} must be a whole number of at least 1, not ${String(value)}.`,
    )
  }
  return value
}
