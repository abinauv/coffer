/*
 * Reading a CSV somebody exported from their bank or their old accounting system.
 * Import from here, not from the individual files.
 *
 * THIS IS THE FIRST THING IN `services/` (ARCHITECTURE §5). It is built once, ahead of
 * both the callers that need it, because the alternative was Phase 6.2's bank-statement
 * import and Phase 7.1's Zoho importer each growing their own CSV reader — and two CSV
 * readers means two answers to "is `""` empty or absent", two two-digit-year rules, and
 * two places for a paisa to go missing.
 *
 * THE WHOLE MODULE IS PURE. Nothing here opens a file. A caller supplies the text, which
 * keeps every part of it testable against a string fixture and leaves the I/O decision —
 * and with it the question of which paths a user may be persuaded to read from — with
 * the caller, where the answer can be enforced once.
 *
 * The pipeline, and what each step refuses to decide for you:
 *
 *   parseCsv        text  -> a faithful grid. Knows nothing about headers, pads nothing.
 *   readCsvTable    text  -> a header and rows. Ragged rows are reported, not repaired.
 *   mapCsvRows      table -> typed records + every error, with row and column numbers.
 *   surveyDateFormats     -> which date formats this column is consistent with, so the
 *                            caller can ask the user when the file is genuinely
 *                            ambiguous and not ask when it is not.
 *   rowFingerprint        -> a stable content hash, so re-importing a statement can be
 *                            detected rather than doubled.
 */

export { CSV_DEFAULTS, parseCsv } from './parse'
export type { CsvGrid, CsvParseOptions, CsvProblem, CsvProblemCode, CsvRecord } from './parse'

export { cellAt, duplicateHeadings, findColumn, readCsvTable, tableOf } from './table'
export type { ColumnLookup, CsvColumn, CsvRow, CsvTable, RaggedRow } from './table'

export { DATE_FORMATS, isDateFormat, parseImportDate, surveyDateFormats } from './dates'
export { TWO_DIGIT_YEAR_CENTURY } from './dates'
export type { DateFormat, DateFormatSurvey, RuledOutFormat } from './dates'

export {
  DEFAULT_CURRENCY_TOKENS,
  parseDebitCredit,
  parseImportAmount,
  parseImportDecimal,
} from './amounts'
export type { AmountOptions, DebitCreditOptions, DebitCreditSign, SignedAmount } from './amounts'

export { DEFAULT_MAX_ISSUES, mapCsvRows, resolveColumns } from './mapping'
export type {
  ColumnMap,
  ColumnResolution,
  DateFieldSpec,
  DebitCreditFieldSpec,
  DecimalFieldSpec,
  FieldSpec,
  MappedRecord,
  MappedRow,
  MappingOptions,
  MappingResult,
  ResolvedColumn,
  TextFieldSpec,
} from './mapping'

export {
  FINGERPRINT_VERSION,
  groupByFingerprint,
  repeatedRows,
  rowFingerprint,
} from './fingerprint'
export type { RowFingerprintInput } from './fingerprint'

export { CsvError, isCsvError } from './errors'
export type {
  CsvErrorCode,
  FieldParse,
  ImportIssue,
  ImportIssueCode,
  ImportIssueSeverity,
} from './errors'

export { BYTE_ORDER_MARK, foldText, isBlank, normaliseHeading, stripByteOrderMark } from './text'
