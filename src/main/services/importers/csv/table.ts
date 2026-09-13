/*
 * The step that turns a faithful grid into "a header and some rows".
 *
 * parse.ts deliberately knows nothing about headers. This file makes the three
 * interpretive decisions that a header implies, and each one is here rather than in the
 * parser so that it can be argued with:
 *
 * 1. THE HEADER IS THE FIRST NON-BLANK LINE. Bank exports routinely begin with a blank
 *    line, or with a `,,,,` separator row left over from a spreadsheet. Taking line 1
 *    unconditionally gives a header of empty strings, after which every column is
 *    "missing" and the message sends the user hunting for a mapping bug.
 *
 * 2. A BLANK LINE IS SKIPPED, ANYWHERE, and counted. Statements put one before a footer
 *    ("Statement generated on ...") and between sections. A blank line is a row of
 *    nothing, and a row of nothing is not a transaction. `,,,` counts as blank for the
 *    same reason — it is a spreadsheet's idea of an empty row.
 *
 * 3. A RAGGED ROW IS REPORTED AND NEVER PADDED. Short rows are the tempting one: it
 *    looks harmless to treat the missing trailing cells as empty, and it is not. A row
 *    is short either because a trailing empty column was omitted (harmless) or because a
 *    delimiter inside an unquoted value ate a column boundary (catastrophic — every
 *    field after it is shifted one place left, so the narration lands in the amount
 *    column and the amount in the balance column). Those two are indistinguishable from
 *    the row alone. Padding silently picks the harmless reading for both. So the row is
 *    handed back with its real length and listed in `ragged`, and mapping.ts refuses it.
 *
 * COLUMN LOOKUP IS BY NORMALISED HEADING AND REFUSES TO GUESS. `findColumn` returns
 * `missing`, `found`, or `ambiguous` — it never returns "the first one that matched".
 * CONVENTIONS §1.9 is explicit about why: a `.find` over a list silently implements
 * "whichever is listed first" while looking like a rule, and a statement with two
 * columns both called "Amount" is not hypothetical. The caller is told there are two and
 * which positions they are in.
 */

import { parseCsv, type CsvGrid, type CsvParseOptions, type CsvProblem } from './parse'
import { isBlank, normaliseHeading } from './text'

/** One column of the header. `heading` is as written; `key` is what matching compares. */
export interface CsvColumn {
  /** 0-based position in the row. */
  readonly index: number
  /** The heading exactly as the file spells it — this is what a message shows the user. */
  readonly heading: string
  /** `heading` normalised: NFC, no invisibles, single spaces, trimmed, lower case. */
  readonly key: string
}

/** One data row. */
export interface CsvRow {
  /** 1-based line in the file, as a text editor counts them. */
  readonly line: number
  /** 1-based position among data rows, header and blank lines excluded. */
  readonly number: number
  readonly fields: readonly string[]
}

/** A row whose field count disagrees with the header. Reported, never padded. */
export interface RaggedRow {
  readonly line: number
  readonly number: number
  readonly expected: number
  readonly found: number
}

export interface CsvTable {
  readonly header: readonly CsvColumn[]
  /** Every data row in file order, ragged ones included. */
  readonly rows: readonly CsvRow[]
  readonly ragged: readonly RaggedRow[]
  /** 1-based line numbers that held nothing. */
  readonly blankLines: readonly number[]
  readonly hadByteOrderMark: boolean
  readonly problems: readonly CsvProblem[]
}

export type ColumnLookup =
  | { readonly kind: 'found'; readonly column: CsvColumn }
  | { readonly kind: 'missing' }
  | { readonly kind: 'ambiguous'; readonly columns: readonly CsvColumn[] }

/**
 * Read CSV text as a header and rows.
 *
 * @throws CsvError when an option is unusable or a size cap is exceeded (see parse.ts).
 */
export function readCsvTable(text: string, options: CsvParseOptions = {}): CsvTable {
  return tableOf(parseCsv(text, options))
}

/** The same interpretation applied to a grid that has already been parsed. */
export function tableOf(grid: CsvGrid): CsvTable {
  const blankLines: number[] = []
  const rows: CsvRow[] = []
  const ragged: RaggedRow[] = []
  let header: CsvColumn[] | null = null

  for (const record of grid.records) {
    if (record.fields.every(isBlank)) {
      blankLines.push(record.line)
      continue
    }

    if (header === null) {
      header = record.fields.map((heading, index) => ({
        index,
        heading,
        key: normaliseHeading(heading),
      }))
      continue
    }

    const row: CsvRow = { line: record.line, number: rows.length + 1, fields: record.fields }
    rows.push(row)
    if (record.fields.length !== header.length) {
      ragged.push({
        line: row.line,
        number: row.number,
        expected: header.length,
        found: record.fields.length,
      })
    }
  }

  return {
    header: header ?? [],
    rows,
    ragged,
    blankLines,
    hadByteOrderMark: grid.hadByteOrderMark,
    problems: grid.problems,
  }
}

/**
 * Find the column with a given heading, case- and whitespace-insensitively.
 *
 * Returns `ambiguous` rather than choosing when two columns normalise to the same key.
 * See the module header, and CONVENTIONS §1.9.
 */
export function findColumn(header: readonly CsvColumn[], heading: string): ColumnLookup {
  const key = normaliseHeading(heading)
  /* `filter` and a count, not `find`. The difference is the whole rule: `find` cannot
   * tell "the one column called Amount" from "the first of the two called Amount". */
  const matches = header.filter((column) => column.key === key)
  const first = matches[0]
  if (first === undefined) {
    return { kind: 'missing' }
  }
  return matches.length === 1
    ? { kind: 'found', column: first }
    : { kind: 'ambiguous', columns: matches }
}

/**
 * Headings that appear more than once, as normalised keys.
 *
 * Worth reporting even when no target field wants them: a duplicated heading is usually
 * a sign that two sections of a statement were concatenated into one file.
 */
export function duplicateHeadings(header: readonly CsvColumn[]): readonly string[] {
  const counts = new Map<string, number>()
  for (const column of header) {
    if (column.key === '') {
      continue
    }
    counts.set(column.key, (counts.get(column.key) ?? 0) + 1)
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key)
}

/**
 * Read one cell of a row.
 *
 * Returns `''` for a cell a short row does not have. That is safe ONLY because ragged
 * rows are refused before any cell of theirs is read — see mapping.ts. It exists so that
 * this file has one definition of "the cell at column n" rather than an index expression
 * repeated at four call sites under `noUncheckedIndexedAccess`.
 */
export function cellAt(row: CsvRow, index: number): string {
  return row.fields[index] ?? ''
}
