/*
 * What can go wrong on the way from a document to a printable model.
 *
 * There is one kind of failure here and it is a REFUSAL, not a report: unlike the CSV
 * importer — which reads eight hundred rows somebody exported and has to hand back the
 * eleven that failed — a document either has everything a page needs or it has none of
 * it, and half an invoice is not a useful artefact. So this throws, and the IPC handler
 * that will eventually call the mapper turns the code into a `Result` (CONVENTIONS §5).
 *
 * Every message is written for the person who pressed Print, and says what to do.
 */

export type PrintErrorCode =
  /** A document kind this build does not know. The file was written by a newer Coffer. */
  | 'DOCUMENT_KIND_UNKNOWN'
  /** No company profile. There is no supplier to print, so there is no invoice. */
  | 'COMPANY_PROFILE_MISSING'
  /** The document's party was not supplied. A caller bug — it is a foreign key. */
  | 'PARTY_MISSING'

/** A refusal from the print service. Carries a stable, machine-readable code. */
export class PrintError extends Error {
  readonly code: PrintErrorCode

  constructor(code: PrintErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PrintError'
    this.code = code
  }
}

/** True when `value` is a `PrintError`. */
export function isPrintError(value: unknown): value is PrintError {
  return value instanceof PrintError
}
