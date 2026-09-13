/*
 * The declarative bit: source column -> target field.
 *
 * A bank's headings are not Coffer's field names, and no two banks agree with each
 * other. So a mapping is DATA — a record of target field names against a small
 * description of where the value comes from and how to read it — and this file is the
 * one interpreter of that data. Phase 6.2's bank import and Phase 7.1's Zoho importer
 * write a mapping each; neither writes a parser.
 *
 * FOUR DECISIONS, AND EACH ONE IS A FAILURE MODE SOMEBODY HAS HAD:
 *
 * 1. A MISSING REQUIRED COLUMN STOPS THE MAPPING BEFORE ANY ROW IS READ, and the error
 *    NAMES THE COLUMN. The alternative is what every naive importer does: run all eight
 *    hundred rows, fail on every one of them for want of a value, and present a wall of
 *    "row 1: date is missing / row 2: date is missing / ...". The user's actual problem
 *    is one sentence — "this file has no column called Value Date" — and it is invisible
 *    inside eight hundred copies of its symptom.
 *
 * 2. MATCHING IS CASE- AND WHITESPACE-INSENSITIVE. "Value Date", "value date" and
 *    " VALUE DATE " are one column. So is a heading that arrived with a non-breaking
 *    space or a zero-width character in it, which is what happens when a statement is
 *    copied out of a bank's web page (see text.ts).
 *
 * 3. NOTHING IS EVER CHOSEN BY POSITION IN A LIST. A field may name several headings —
 *    one mapping then covers a bank that renamed a column between 2023 and 2025 — but if
 *    MORE THAN ONE of them is actually in the file, that is reported as ambiguous and the
 *    mapping stops. Taking the first would make the list's ORDER the rule while looking
 *    like a set of synonyms, which is CONVENTIONS §9's `.find` trap exactly: it silently
 *    implements "whichever is listed first" and no assertion downstream can see it. The
 *    same applies to two columns in the file sharing one heading.
 *
 * 4. EVERY ROW ERROR IS COLLECTED, WITH ITS ROW AND COLUMN. Somebody importing eight
 *    hundred rows needs the eleven that failed, in one list, so they can fix the file
 *    once. A row that fails contributes NO record — a half-filled record is worse than
 *    none, because it looks like data.
 *
 * The mapper is pure: it takes a table (which took a string) and returns values.
 */

import type { ScaleName } from '@main/domain/money'
import type { DateString, DecimalString } from '@shared/scalars'

import {
  parseDebitCredit,
  parseImportDecimal,
  type AmountOptions,
  type DebitCreditSign,
  type SignedAmount,
} from './amounts'
import { parseImportDate, type DateFormat } from './dates'
import {
  CsvError,
  requirePositiveInteger,
  type ImportIssue,
  type ImportIssueCode,
  type ImportIssueSeverity,
} from './errors'
import { cellAt, findColumn, type CsvColumn, type CsvRow, type CsvTable } from './table'
import { isBlank } from './text'

/** A plain text field. */
export interface TextFieldSpec {
  readonly kind: 'text'
  /** Headings this field may appear under. At most one of them may be in the file. */
  readonly columns: readonly string[]
  readonly required: boolean
  /** Longer than this is refused rather than truncated. Truncating loses a cheque number. */
  readonly maxLength?: number
}

/** A date field, read in a format the caller states. There is no detection here — see dates.ts. */
export interface DateFieldSpec {
  readonly kind: 'date'
  readonly columns: readonly string[]
  readonly required: boolean
  readonly format: DateFormat
}

/** A single signed amount column. */
export interface DecimalFieldSpec {
  readonly kind: 'decimal'
  readonly columns: readonly string[]
  readonly required: boolean
  /** Defaults to `money` (2dp). Use `rate` or `quantity` for a column that is neither. */
  readonly scale?: ScaleName
  readonly amount?: AmountOptions
}

/** A pair of Debit and Credit columns read as one signed amount. `sign` has no default. */
export interface DebitCreditFieldSpec {
  readonly kind: 'debit-credit'
  readonly debitColumns: readonly string[]
  readonly creditColumns: readonly string[]
  readonly required: boolean
  readonly sign: DebitCreditSign
  readonly scale?: ScaleName
  readonly amount?: AmountOptions
}

export type FieldSpec = TextFieldSpec | DateFieldSpec | DecimalFieldSpec | DebitCreditFieldSpec

/** Target field name -> where its value comes from. */
export type ColumnMap = Readonly<Record<string, FieldSpec>>

/** What each field kind produces. All three string kinds are boundary representations. */
interface ValueOfKind {
  readonly text: string
  readonly date: DateString
  readonly decimal: DecimalString
  readonly 'debit-credit': SignedAmount
}

/**
 * The shape one mapped row has, derived from the mapping itself.
 *
 * An optional field is `| undefined` — that is the ONE place absence exists in this
 * module, and it means "the cell was blank", never "the file quoted an empty string".
 * See decision 1 in parse.ts.
 *
 * A spec whose `required` is a plain `boolean` rather than a literal `true` widens to the
 * optional form, which is the safe direction: the caller is asked to handle a value that
 * might not be there.
 */
export type MappedRow<M extends ColumnMap> = {
  readonly [K in keyof M]: M[K]['required'] extends true
    ? ValueOfKind[M[K]['kind']]
    : ValueOfKind[M[K]['kind']] | undefined
}

/** One successfully mapped row, still carrying where it came from. */
export interface MappedRecord<M extends ColumnMap> {
  /** 1-based line in the file, as a text editor counts them. */
  readonly line: number
  /** 1-based position among data rows. */
  readonly rowNumber: number
  readonly values: MappedRow<M>
}

/** Where one target field's value is read from, for a mapping screen to show. */
export interface ResolvedColumn {
  readonly field: string
  readonly kind: FieldSpec['kind']
  /** One column, or two for a debit/credit pair, in the order the spec names them. */
  readonly columns: readonly CsvColumn[]
}

export interface ColumnResolution {
  readonly columns: readonly ResolvedColumn[]
  readonly issues: readonly ImportIssue[]
  /** False when a required column is missing or ambiguous. No row is read in that case. */
  readonly ok: boolean
}

export interface MappingOptions {
  /**
   * How many issues to LIST. The counts stay complete either way — a file where every
   * row fails should not build a two-hundred-thousand-element array to say so. Must be
   * at least 1; see `requirePositiveInteger`.
   */
  readonly maxIssues?: number
  /** Report columns no field claims, as warnings. On by default; useful to a mapping screen. */
  readonly reportUnmappedColumns?: boolean
}

export interface MappingResult<M extends ColumnMap> {
  readonly records: readonly MappedRecord<M>[]
  /** Column issues first, then the file's structural problems, then row issues in row order. */
  readonly issues: readonly ImportIssue[]
  /** Every error in the file, including any beyond `maxIssues`. */
  readonly errorCount: number
  readonly warningCount: number
  readonly issuesTruncated: boolean
  readonly resolution: ColumnResolution
}

export const DEFAULT_MAX_ISSUES = 500

/**
 * Work out which column each target field reads, without reading any rows.
 *
 * Exported on its own so a mapping screen can tell the user "this file has no Value Date
 * column" while they are still choosing the file, rather than after a long import.
 *
 * @throws CsvError when the mapping itself is malformed — a field naming no columns.
 */
export function resolveColumns(header: readonly CsvColumn[], map: ColumnMap): ColumnResolution {
  return build(header, map).resolution
}

/**
 * Map a table's rows through a column mapping.
 *
 * @throws CsvError when the mapping is malformed or `maxIssues` is not a positive whole
 *   number. Everything about the DATA is reported, never thrown.
 */
export function mapCsvRows<M extends ColumnMap>(
  table: CsvTable,
  map: M,
  options: MappingOptions = {},
): MappingResult<M> {
  const maxIssues = requirePositiveInteger(options.maxIssues ?? DEFAULT_MAX_ISSUES, 'maxIssues')
  const log = new IssueLog(maxIssues)

  const { resolution, readers } = build(table.header, map)
  for (const issue of resolution.issues) {
    log.add(issue)
  }

  if (options.reportUnmappedColumns !== false) {
    const claimed = new Set(
      resolution.columns.flatMap((resolved) => resolved.columns.map((column) => column.index)),
    )
    for (const column of table.header) {
      if (!claimed.has(column.index) && column.key !== '') {
        log.add({
          code: 'UNMAPPED_COLUMN',
          severity: 'warning',
          message: `The column ${JSON.stringify(column.heading)} is not used by this import.`,
          columnNumber: column.index + 1,
          heading: column.heading,
        })
      }
    }
  }

  for (const problem of table.problems) {
    log.add({
      code: problem.code,
      /* An unterminated quote has already eaten rows; text after a closing quote has
       * corrupted one field. The first is an error, the second a warning. */
      severity: problem.code === 'UNTERMINATED_QUOTE' ? 'error' : 'warning',
      message: problem.message,
      line: problem.line,
      columnNumber: problem.columnNumber,
    })
  }

  if (!resolution.ok) {
    /* Decision 1: no row work at all. The user gets the column sentence, not its
     * symptom repeated once per row. */
    return {
      records: [],
      issues: log.issues(),
      errorCount: log.errorCount,
      warningCount: log.warningCount,
      issuesTruncated: log.truncated,
      resolution,
    }
  }

  const raggedByNumber = new Map(table.ragged.map((row) => [row.number, row]))
  const records: MappedRecord<M>[] = []

  for (const row of table.rows) {
    const ragged = raggedByNumber.get(row.number)
    if (ragged !== undefined) {
      log.add({
        code: 'RAGGED_ROW',
        severity: 'error',
        message:
          `Row ${String(ragged.number)} (line ${String(ragged.line)}) has ${String(ragged.found)} values ` +
          `where the heading row has ${String(ragged.expected)}. Coffer will not guess which ones are missing.`,
        line: ragged.line,
        rowNumber: ragged.number,
      })
      continue
    }

    /* Every field name, not only the ones with a reader: an OPTIONAL field whose column
     * is absent from the file still exists on the record, as `undefined`. A record whose
     * keys depend on which columns the bank happened to include is a record a caller has
     * to feature-detect. */
    const draft: Record<string, ValueOfKind[keyof ValueOfKind] | undefined> = {}
    for (const field of Object.keys(map)) {
      draft[field] = undefined
    }
    let rowFailed = false

    for (const [field, read] of readers) {
      const reading = read(row)
      if (reading.failure !== undefined) {
        rowFailed = true
        log.add({
          code: reading.failure.code,
          severity: 'error',
          message:
            `Row ${String(row.number)} (line ${String(row.line)}), column ` +
            `${JSON.stringify(reading.failure.column.heading)}: ${reading.failure.message}.`,
          line: row.line,
          rowNumber: row.number,
          columnNumber: reading.failure.column.index + 1,
          heading: reading.failure.column.heading,
          field,
          value: reading.failure.value,
        })
        continue
      }
      /* Set even when blank, so every mapped record has the same keys and a caller can
       * destructure without asking whether the property exists. */
      draft[field] = reading.value
    }

    if (!rowFailed) {
      records.push({
        line: row.line,
        rowNumber: row.number,
        values: draft as unknown as MappedRow<M>,
      })
    }
  }

  return {
    records,
    issues: log.issues(),
    errorCount: log.errorCount,
    warningCount: log.warningCount,
    issuesTruncated: log.truncated,
    resolution,
  }
}

// ---- Internals ------------------------------------------------------------

/** What reading one field off one row produced. Neither set means "the cell was blank". */
interface FieldReading {
  readonly value?: ValueOfKind[keyof ValueOfKind]
  readonly failure?: {
    readonly code: ImportIssueCode
    readonly message: string
    readonly column: CsvColumn
    readonly value: string
  }
}

type FieldReader = (row: CsvRow) => FieldReading

/**
 * Resolve every field to its columns and build a reader for each.
 *
 * The reader is a closure over the spec AND its resolved columns, built in the same
 * place. That is deliberate: a resolution table stored separately from the specs can go
 * out of step with them — a two-column pair recorded against a one-column field — and
 * the check for that would be a branch no test could ever reach. Built together, the
 * mismatch is not representable.
 */
function build(
  header: readonly CsvColumn[],
  map: ColumnMap,
): { resolution: ColumnResolution; readers: ReadonlyMap<string, FieldReader> } {
  const issues: ImportIssue[] = []
  const columns: ResolvedColumn[] = []
  const readers = new Map<string, FieldReader>()
  let ok = true

  for (const column of header) {
    if (column.key === '') {
      issues.push({
        code: 'UNNAMED_COLUMN',
        severity: 'warning',
        message:
          `Column ${String(column.index + 1)} of the heading row has no name, so nothing can be ` +
          'matched to it.',
        columnNumber: column.index + 1,
      })
    }
  }

  for (const [field, spec] of Object.entries(map)) {
    if (spec.kind === 'debit-credit') {
      const debit = resolveOne(header, field, spec.debitColumns, spec.required, issues, 'debit')
      const credit = resolveOne(header, field, spec.creditColumns, spec.required, issues, 'credit')
      if (debit === null || credit === null) {
        ok = ok && !spec.required
        continue
      }
      columns.push({ field, kind: spec.kind, columns: [debit, credit] })
      readers.set(field, (row) => readDebitCredit(spec, row, debit, credit))
      continue
    }

    const column = resolveOne(header, field, spec.columns, spec.required, issues, null)
    if (column === null) {
      ok = ok && !spec.required
      continue
    }
    columns.push({ field, kind: spec.kind, columns: [column] })
    readers.set(field, readerFor(spec, column))
  }

  const used = new Map<number, string[]>()
  for (const resolved of columns) {
    for (const column of resolved.columns) {
      used.set(column.index, [...(used.get(column.index) ?? []), resolved.field])
    }
  }
  for (const [index, fields] of used) {
    if (fields.length > 1) {
      issues.push({
        code: 'COLUMN_USED_TWICE',
        severity: 'warning',
        message: `Column ${String(index + 1)} is read by more than one field: ${fields.join(', ')}.`,
        columnNumber: index + 1,
      })
    }
  }

  return { resolution: { columns, issues, ok }, readers }
}

function readerFor(
  spec: TextFieldSpec | DateFieldSpec | DecimalFieldSpec,
  column: CsvColumn,
): FieldReader {
  /* A switch, exhaustively checked: `assertNever` below stops this compiling the moment
   * a fifth field kind is added, which is the property CONVENTIONS §9 asks a total record
   * for. The union is discriminated, so each branch also gets the narrowed spec. */
  switch (spec.kind) {
    case 'text':
      return (row) => readText(spec, row, column)
    case 'date':
      return (row) => readDate(spec, row, column)
    case 'decimal':
      return (row) => readDecimal(spec, row, column)
    default:
      return assertNever(spec)
  }
}

function readText(spec: TextFieldSpec, row: CsvRow, column: CsvColumn): FieldReading {
  const raw = cellAt(row, column.index)
  if (isBlank(raw)) {
    return spec.required
      ? { failure: { code: 'MISSING_VALUE', message: 'is empty', column, value: raw } }
      : {}
  }
  /* Trimmed, not folded. The ends are noise; the middle is what the user will read on a
   * screen, and collapsing runs of spaces inside a narration changes it. */
  const value = raw.trim()
  if (spec.maxLength !== undefined && value.length > spec.maxLength) {
    return {
      failure: {
        code: 'VALUE_TOO_LONG',
        message: `is ${String(value.length)} characters, and at most ${String(spec.maxLength)} are allowed`,
        column,
        value,
      },
    }
  }
  return { value }
}

function readDate(spec: DateFieldSpec, row: CsvRow, column: CsvColumn): FieldReading {
  const raw = cellAt(row, column.index)
  if (isBlank(raw)) {
    return spec.required
      ? { failure: { code: 'MISSING_VALUE', message: 'is empty', column, value: raw } }
      : {}
  }
  const attempt = parseImportDate(raw, spec.format)
  return attempt.ok
    ? { value: attempt.value }
    : { failure: { code: 'INVALID_DATE', message: attempt.message, column, value: raw.trim() } }
}

function readDecimal(spec: DecimalFieldSpec, row: CsvRow, column: CsvColumn): FieldReading {
  const raw = cellAt(row, column.index)
  if (isBlank(raw)) {
    return spec.required
      ? { failure: { code: 'MISSING_VALUE', message: 'is empty', column, value: raw } }
      : {}
  }
  const attempt = parseImportDecimal(raw, spec.scale ?? 'money', spec.amount)
  return attempt.ok
    ? { value: attempt.value }
    : { failure: { code: 'INVALID_AMOUNT', message: attempt.message, column, value: raw.trim() } }
}

function readDebitCredit(
  spec: DebitCreditFieldSpec,
  row: CsvRow,
  debit: CsvColumn,
  credit: CsvColumn,
): FieldReading {
  const debitText = cellAt(row, debit.index)
  const creditText = cellAt(row, credit.index)

  /* Both cells empty is the field being absent. A pair written `0.00` / `0.00` is NOT
   * absent — the bank wrote something — and falls through to `parseDebitCredit`, which
   * refuses it as a movement of nothing. See its doc comment. */
  if (isBlank(debitText) && isBlank(creditText)) {
    return spec.required
      ? {
          failure: {
            code: 'MISSING_VALUE',
            message: `is empty, and so is ${JSON.stringify(credit.heading)}`,
            column: debit,
            value: '',
          },
        }
      : {}
  }

  const attempt = parseDebitCredit(debitText, creditText, {
    sign: spec.sign,
    ...(spec.scale === undefined ? {} : { scale: spec.scale }),
    ...(spec.amount === undefined ? {} : { amount: spec.amount }),
  })
  return attempt.ok
    ? { value: attempt.value }
    : {
        failure: {
          code: 'INVALID_AMOUNT',
          message: attempt.message,
          column: debit,
          value: `${debitText.trim()} / ${creditText.trim()}`,
        },
      }
}

/**
 * Resolve one field's candidate headings to exactly one column, or report why not.
 *
 * `role` names the half of a debit/credit pair, so the message says which of the two is
 * missing rather than naming the field twice.
 */
function resolveOne(
  header: readonly CsvColumn[],
  field: string,
  candidates: readonly string[],
  required: boolean,
  issues: ImportIssue[],
  role: 'debit' | 'credit' | null,
): CsvColumn | null {
  if (candidates.length === 0) {
    throw new CsvError(
      'CSV_SPEC_INVALID',
      `The mapping for ${JSON.stringify(field)} names no columns to read from.`,
    )
  }

  const what =
    role === null ? JSON.stringify(field) : `the ${role} half of ${JSON.stringify(field)}`
  const found: CsvColumn[] = []
  const ambiguous: string[] = []

  for (const candidate of candidates) {
    const lookup = findColumn(header, candidate)
    if (lookup.kind === 'found') {
      found.push(lookup.column)
    } else if (lookup.kind === 'ambiguous') {
      ambiguous.push(
        `${JSON.stringify(candidate)} appears in columns ` +
          lookup.columns.map((column) => String(column.index + 1)).join(' and '),
      )
    }
  }

  if (ambiguous.length > 0) {
    issues.push({
      code: 'AMBIGUOUS_COLUMN',
      severity: severityFor(required),
      message: `This file has more than one column that could be ${what}: ${ambiguous.join('; ')}.`,
      field,
    })
    return null
  }

  const first = found[0]
  if (first === undefined) {
    issues.push({
      code: 'MISSING_COLUMN',
      severity: severityFor(required),
      message:
        `This file has no column for ${what}. Coffer looked for ` +
        `${candidates.map((name) => JSON.stringify(name)).join(', ')}.`,
      field,
    })
    return null
  }

  if (found.length > 1) {
    /* Decision 3: two synonyms both present. Taking `found[0]` would make the order of
     * the spec's list the rule, invisibly. */
    issues.push({
      code: 'AMBIGUOUS_COLUMN',
      severity: severityFor(required),
      message:
        `This file has more than one column that could be ${what}: ` +
        `${found.map((column) => JSON.stringify(column.heading)).join(', ')}. ` +
        'Rename or remove one of them.',
      field,
    })
    return null
  }

  return first
}

function severityFor(required: boolean): ImportIssueSeverity {
  return required ? 'error' : 'warning'
}

function assertNever(value: never): never {
  throw new CsvError('CSV_SPEC_INVALID', `Unhandled field kind: ${JSON.stringify(value)}`)
}

/** Collects issues up to a limit while counting all of them. */
class IssueLog {
  private readonly listed: ImportIssue[] = []
  private readonly limit: number
  errorCount = 0
  warningCount = 0
  truncated = false

  constructor(limit: number) {
    this.limit = limit
  }

  add(issue: ImportIssue): void {
    if (issue.severity === 'error') {
      this.errorCount += 1
    } else {
      this.warningCount += 1
    }
    if (this.listed.length < this.limit) {
      this.listed.push(issue)
      return
    }
    this.truncated = true
  }

  /** The listed issues, with a note appended when there were more. */
  issues(): readonly ImportIssue[] {
    if (!this.truncated) {
      return this.listed
    }
    return [
      ...this.listed,
      {
        code: 'ISSUE_LIMIT_REACHED',
        severity: 'warning',
        /* Deliberately not counted in `warningCount`: the counts describe the FILE, and
         * this line describes the list. */
        message:
          `Only the first ${String(this.limit)} problems are listed. ` +
          `The file has ${String(this.errorCount)} errors and ${String(this.warningCount)} warnings in total.`,
      },
    ]
  }
}
