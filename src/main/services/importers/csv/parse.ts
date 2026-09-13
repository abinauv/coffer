/*
 * An RFC 4180 CSV reader.
 *
 * NO DEPENDENCY, ON PURPOSE. Adding a package is a decision this project takes one at a
 * time, and the whole of CSV that a bank statement uses is a two-hundred-line state
 * machine. The same trade `companies/archive.ts` made for ZIP: no supply chain, and the
 * failure modes are ours to name.
 *
 * A CSV SOMEBODY DOWNLOADED FROM THEIR BANK IS UNTRUSTED INPUT, in exactly the sense
 * `archive.ts` means it. It is not a path-traversal surface — this module never touches
 * the filesystem, and the caller supplies the text — but it is an ALLOCATION surface. A
 * single line of ten million commas is a ten-million-element array; one unclosed quote
 * turns a hundred-megabyte file into one field. So there are three caps, they are on by
 * default, and exceeding one is a refusal with a line number rather than a slow death.
 *
 * WHAT "FAITHFUL" MEANS HERE. This module returns the grid as written, including blank
 * lines and rows whose length disagrees with their neighbours. It does not know which
 * row is the header and it does not pad anything. Interpretation is table.ts's job. The
 * split exists so that "the file has a ragged row" is a fact you can look at rather than
 * a decision already taken for you.
 *
 * THREE DECISIONS WORTH READING BEFORE YOU CHANGE ANYTHING:
 *
 * 1. `""` IS AN EMPTY STRING, NOT AN ABSENT VALUE, and it is indistinguishable from a
 *    bare empty field. The answer is forced by one observation: QUOTING IS TRANSPORT,
 *    NOT MEANING. Excel quotes a field if and only if it contains a delimiter, a quote
 *    or a newline; several bank portals quote every field unconditionally; a third group
 *    quotes none. The same statement, exported twice, differs in which fields carry
 *    quotes and in nothing else. If `""` meant "present and empty" while an empty field
 *    meant "absent", the meaning of a file would depend on which tool wrote it, and a
 *    downstream rule such as "skip rows with no narration" would fire on one export and
 *    not on the other.
 *
 *    So: every field is a `string`, and absence is expressed where it can be expressed
 *    honestly — a SHORT ROW is missing fields (reported, never padded, table.ts), and an
 *    OPTIONAL target field whose cell is blank maps to `undefined` (mapping.ts). Both of
 *    those are properties of the data. Quoting is not.
 *
 * 2. A NEWLINE INSIDE QUOTES IS DATA, and CRLF and lone CR inside quotes are normalised
 *    to LF. The first half is RFC 4180 and is the case naive splitters get wrong; it is
 *    common in address columns and in narrations pasted out of a portal. The second half
 *    is the same argument as (1): a line ending is transport. The same address exported
 *    on Windows and on Linux must produce the same string, or the duplicate fingerprint
 *    in fingerprint.ts reports every row of a re-download as new.
 *
 * 3. A BARE QUOTE INSIDE AN UNQUOTED FIELD IS DATA AND IS NOT REPORTED. `5" pipe` and
 *    `12"` are ordinary content in a description column, and a warning on each would
 *    bury the real ones. A quote after a field's CLOSING quote is a different thing —
 *    nothing well-formed produces it, it usually means a quote inside a quoted field was
 *    not doubled, and it IS reported.
 */

import { CsvError, requirePositiveInteger } from './errors'
import { stripByteOrderMark } from './text'

/** Defaults for every cap and character. Exported so a caller can see what it is opting out of. */
export const CSV_DEFAULTS = {
  delimiter: ',',
  quote: '"',
  /** Comfortably more rows than a decade of one account's statements. */
  maxRows: 200_000,
  /** A statement with 512 columns is not a statement. */
  maxFieldsPerRow: 512,
  /** One megabyte in a single cell is an unterminated quote, not a narration. */
  maxFieldCharacters: 1_000_000,
} as const

export interface CsvParseOptions {
  /** One character. Defaults to a comma; a semicolon and a tab are the other two that occur. */
  readonly delimiter?: string
  /** One character. Defaults to a double quote. */
  readonly quote?: string
  readonly maxRows?: number
  readonly maxFieldsPerRow?: number
  readonly maxFieldCharacters?: number
}

export type CsvProblemCode = 'UNTERMINATED_QUOTE' | 'TEXT_AFTER_CLOSING_QUOTE'

/** A structural anomaly in the text. Reported, never thrown — the rest of the file still reads. */
export interface CsvProblem {
  readonly code: CsvProblemCode
  /** 1-based line where the offending field began. */
  readonly line: number
  /** 1-based field position within its record. */
  readonly columnNumber: number
  readonly message: string
}

/** One record of the grid. `line` is where the record STARTS, which matters once a field wraps. */
export interface CsvRecord {
  readonly line: number
  readonly fields: readonly string[]
}

export interface CsvGrid {
  readonly records: readonly CsvRecord[]
  /** True when the text began with U+FEFF. Worth surfacing: it explains a first-column mismatch. */
  readonly hadByteOrderMark: boolean
  readonly problems: readonly CsvProblem[]
}

/**
 * Parse CSV text into a grid of records.
 *
 * Handles quoted fields containing the delimiter, doubled quotes, newlines inside
 * quotes, CRLF / LF / lone CR line endings, a trailing newline or its absence, and a
 * leading byte order mark.
 *
 * @throws CsvError when an option is unusable or a cap is exceeded.
 */
export function parseCsv(text: string, options: CsvParseOptions = {}): CsvGrid {
  const delimiter = requireOneCharacter(options.delimiter ?? CSV_DEFAULTS.delimiter, 'delimiter')
  const quote = requireOneCharacter(options.quote ?? CSV_DEFAULTS.quote, 'quote character')
  if (delimiter === quote) {
    throw new CsvError(
      'CSV_DELIMITER_INVALID',
      'The delimiter and the quote character cannot be the same character.',
    )
  }

  const maxRows = requirePositiveInteger(options.maxRows ?? CSV_DEFAULTS.maxRows, 'maxRows')
  const maxFieldsPerRow = requirePositiveInteger(
    options.maxFieldsPerRow ?? CSV_DEFAULTS.maxFieldsPerRow,
    'maxFieldsPerRow',
  )
  const maxFieldCharacters = requirePositiveInteger(
    options.maxFieldCharacters ?? CSV_DEFAULTS.maxFieldCharacters,
    'maxFieldCharacters',
  )

  const { text: body, hadByteOrderMark } = stripByteOrderMark(text)

  const records: CsvRecord[] = []
  const problems: CsvProblem[] = []

  let fields: string[] = []
  let field = ''
  /** True once anything at all has been consumed for the current field, quotes included. */
  let fieldStarted = false
  /** True when the current field opened with a quote, whether or not it has closed. */
  let fieldWasQuoted = false
  let inQuotes = false
  /** One report per field, so a run of junk after a closing quote is one message. */
  let alreadyReportedAfterQuote = false

  /** 1-based physical line the scanner is on. */
  let line = 1
  /** 1-based physical line the current record began on. */
  let recordLine = 1
  /** 1-based line the current field began on — where an unterminated quote opened. */
  let fieldLine = 1

  function endField(): void {
    if (field.length > maxFieldCharacters) {
      throw new CsvError(
        'CSV_FIELD_TOO_LONG',
        `Line ${String(fieldLine)} of this file has a single value of ${String(field.length)} characters. ` +
          'That is almost always a quotation mark that was opened and never closed.',
      )
    }
    if (fields.length >= maxFieldsPerRow) {
      throw new CsvError(
        'CSV_TOO_MANY_COLUMNS',
        `Line ${String(recordLine)} of this file has more than ${String(maxFieldsPerRow)} columns.`,
      )
    }
    fields.push(field)
    field = ''
    fieldStarted = false
    fieldWasQuoted = false
    alreadyReportedAfterQuote = false
  }

  function endRecord(): void {
    if (records.length >= maxRows) {
      throw new CsvError(
        'CSV_TOO_MANY_ROWS',
        `This file has more than ${String(maxRows)} rows, which is more than Coffer reads at once.`,
      )
    }
    records.push({ line: recordLine, fields })
    fields = []
  }

  const length = body.length
  let index = 0

  while (index < length) {
    const character = body.charAt(index)

    if (inQuotes) {
      if (character === quote) {
        /* A doubled quote is one literal quote. This is the ONLY escape RFC 4180 has —
         * there is no backslash, and treating one as an escape would corrupt every
         * Windows path that ever appears in a narration. */
        if (body.charAt(index + 1) === quote) {
          field += quote
          index += 2
          continue
        }
        inQuotes = false
        index += 1
        continue
      }
      if (character === '\r' || character === '\n') {
        /* Decision 2 in the header: the newline is data, normalised to LF. */
        field += '\n'
        line += 1
        index += character === '\r' && body.charAt(index + 1) === '\n' ? 2 : 1
        continue
      }
      field += character
      index += 1
      continue
    }

    if (character === delimiter) {
      endField()
      index += 1
      continue
    }

    if (character === '\r' || character === '\n') {
      endField()
      endRecord()
      line += 1
      index += character === '\r' && body.charAt(index + 1) === '\n' ? 2 : 1
      recordLine = line
      continue
    }

    if (character === quote && !fieldStarted) {
      fieldStarted = true
      fieldWasQuoted = true
      inQuotes = true
      fieldLine = line
      index += 1
      continue
    }

    if (fieldWasQuoted && !alreadyReportedAfterQuote) {
      /* Decision 3: only AFTER a closing quote. A bare quote in an unquoted field is
       * ordinary content and says nothing. */
      alreadyReportedAfterQuote = true
      problems.push({
        code: 'TEXT_AFTER_CLOSING_QUOTE',
        line,
        columnNumber: fields.length + 1,
        message:
          `Line ${String(line)}, column ${String(fields.length + 1)} has text after a closing quotation mark. ` +
          'A quotation mark inside a quoted value has to be written twice.',
      })
    }
    if (!fieldStarted) {
      fieldStarted = true
      fieldLine = line
    }
    field += character
    index += 1
  }

  if (inQuotes) {
    problems.push({
      code: 'UNTERMINATED_QUOTE',
      line: fieldLine,
      columnNumber: fields.length + 1,
      message:
        `A quotation mark opened on line ${String(fieldLine)}, column ${String(fields.length + 1)} and was never closed, ` +
        'so everything after it was read as one value.',
    })
  }

  /* A trailing newline ended the last record already and leaves nothing pending here. A
   * file with no trailing newline leaves the last record here. Both give the same
   * records — which is the point, and is what the trailing-newline test pins. */
  if (fieldStarted || field !== '' || fields.length > 0) {
    endField()
    endRecord()
  }

  return { records, hadByteOrderMark, problems }
}

// ---- Internals ------------------------------------------------------------

function requireOneCharacter(value: string, what: string): string {
  /* `.length`, not a code-point count: the scanner compares one UTF-16 unit at a time,
   * so a delimiter made of a surrogate pair would half-match inside an emoji. Refusing
   * it is honest; silently mis-splitting is not. An empty string would match nothing and
   * spin the loop, which is the one input that has to be refused rather than tolerated. */
  if (value.length !== 1) {
    throw new CsvError(
      'CSV_DELIMITER_INVALID',
      `The ${what} must be exactly one character, not ${JSON.stringify(value)}.`,
    )
  }
  if (value === '\r' || value === '\n') {
    throw new CsvError('CSV_DELIMITER_INVALID', `The ${what} cannot be a line break.`)
  }
  return value
}
