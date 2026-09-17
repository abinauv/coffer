/*
 * What can go wrong while building a return, split into the two kinds it comes in.
 *
 * The split is the one `services/importers/csv/errors.ts` already makes, and for the
 * same reason: a caller needs the whole list of what is doubtful about a period, not the
 * first doubt and a stack trace.
 *
 * A `ReturnError` is a REFUSAL. The caller handed this module something a return cannot
 * be made from — a document dated outside the period it is filing, a purchase bill in an
 * outward return, a tax component whose code this module has no box for. It throws,
 * because there is no per-row answer: any of these produces a return that is wrong in a
 * way no reader could see. Dropping the row instead would be the failure this project has
 * already shipped once — a filter that silently removed data while every total still tied.
 *
 * A `ReturnIssue` is a REPORT. The return was produced, and something about it rests on
 * an assumption or is missing a field the portal will want. These are collected onto the
 * artefact and never thrown.
 *
 * ── SEVERITY MEANS SOMETHING DIFFERENT HERE THAN IT DOES IN THE CSV IMPORTER, and the
 * difference is worth stating rather than leaving to inference. There, `error` meant a
 * row produced no data. Here every row produced data — the figures came off documents
 * that were already computed and already invoiced. So:
 *
 *   error    the artefact cannot be FILED as it stands. A figure is right and a field
 *            the portal requires is absent, or a value rests on a guess that a human
 *            has to confirm before it goes anywhere.
 *   warning  it can be filed, and something in it was assumed rather than read.
 *
 * A UI can therefore block "upload" on an error and show a confirmation on a warning,
 * which is the decision severity exists to support.
 */

import { RegimeRefusal } from '../../errors'

/** A refusal. Carries a stable, machine-readable code. */
export type ReturnErrorCode =
  /** `from` is after `to`, or either is not a date. There is no period to file. */
  | 'RETURN_PERIOD_INVALID'
  /** A document dated outside the period. Never dropped — see the header. */
  | 'RETURN_DOCUMENT_OUT_OF_PERIOD'
  /** A purchase-side document handed to an outward return, or the reverse. */
  | 'RETURN_DOCUMENT_WRONG_SIDE'
  /** A document kind that makes no supply — a quotation — handed to a return. */
  | 'RETURN_DOCUMENT_MAKES_NO_SUPPLY'
  /** A document with no number. A draft is not filed and has no number to file under. */
  | 'RETURN_DOCUMENT_UNNUMBERED'
  /** A correction naming a kind it may not correct, or a charge naming an original. */
  | 'RETURN_CORRECTION_MISMATCH'
  /** A tax component whose code has no column in the return. Never silently dropped. */
  | 'RETURN_COMPONENT_UNKNOWN'
  /** A threshold, or another pack value, that is not a usable decimal. */
  | 'RETURN_PACK_VALUE_INVALID'
  /** Two documents in one period sharing a kind and a number. */
  | 'RETURN_DOCUMENT_NUMBER_REPEATED'
  /** A form this regime does not prepare. Asked for by id, from outside the regime. */
  | 'RETURN_FORM_UNKNOWN'

/**
 * A refusal from the return builders.
 *
 * A `RegimeRefusal`, so the IPC boundary maps its code without importing this module:
 * nothing above `regimes/` may name the country a refusal came from (CONVENTIONS §1.6).
 */
export class ReturnError extends RegimeRefusal {
  declare readonly code: ReturnErrorCode

  constructor(code: ReturnErrorCode, message: string, options?: ErrorOptions) {
    super(code, message, options)
    this.name = 'ReturnError'
  }
}

/** True when `value` is a `ReturnError`. */
export function isReturnError(value: unknown): value is ReturnError {
  return value instanceof ReturnError
}

export type ReturnIssueCode =
  /**
   * Carried by EVERY return this module produces, always, and it is the point of the
   * module's whole header: the section shapes below were written from the published
   * description of the returns and have never been checked against GSTN's JSON schema or
   * put through a filing cycle. See `PROVISIONAL_NOTICE`.
   */
  | 'SCHEMA_UNVERIFIED'
  /** An export whose flavour was read off whether it carries IGST. See `resolveExport`. */
  | 'EXPORT_TAX_PAYMENT_INFERRED'
  /** An export carrying no tax and no rate, where the inference cannot separate them. */
  | 'EXPORT_TAX_PAYMENT_ASSUMED'
  /** An export with no shipping bill. The portal wants one; the model has no column. */
  | 'EXPORT_SHIPPING_BILL_MISSING'
  /** A unit with no `units_of_measure.regime_code`. The HSN row has no UQC to file. */
  | 'UQC_NOT_MAPPED'
  /** A line with no HSN or SAC. The HSN summary has nothing to key that value under. */
  | 'CLASSIFICATION_CODE_MISSING'
  /** A credit or debit note that names no original document. Legal, and worth saying. */
  | 'CORRECTED_DOCUMENT_UNNAMED'
  /** Reverse charge is not a column in the data model; a default was used. */
  | 'REVERSE_CHARGE_NOT_RECORDED'
  /** ITC eligibility is not a column in the data model; a default was used. */
  | 'ITC_ELIGIBILITY_NOT_RECORDED'
  /** Exempt or nil-rated outward supplies with no rule 42/43 reversal declared. */
  | 'EXEMPT_SUPPLIES_WITHOUT_REVERSAL'
  /** A figure the model cannot derive was taken as zero because nobody supplied one. */
  | 'FIGURE_NOT_DERIVABLE'

export type ReturnIssueSeverity = 'error' | 'warning'

/**
 * One thing worth saying about a return, located precisely enough to go and fix.
 *
 * `documentNumber` rather than only `documentId`, because the person reading this is
 * holding the invoice and an id means nothing to them.
 */
export interface ReturnIssue {
  readonly code: ReturnIssueCode
  readonly severity: ReturnIssueSeverity
  /** Written for the person filing: what is assumed or missing, and what settles it. */
  readonly message: string
  /** The document it is about, where it is about one. */
  readonly documentId?: string
  readonly documentNumber?: string
  /** The section of the return it affects, e.g. 'EXP', 'HSN'. */
  readonly section?: string
  /** The offending value, where naming it saves opening the file. */
  readonly value?: string
}

/** Build an issue. Present so every construction site reads the same way. */
export function issue(
  code: ReturnIssueCode,
  severity: ReturnIssueSeverity,
  message: string,
  about: Omit<ReturnIssue, 'code' | 'severity' | 'message'> = {},
): ReturnIssue {
  return { code, severity, message, ...about }
}

/** How many of the collected issues would stop a filing. */
export function blockingCount(issues: readonly ReturnIssue[]): number {
  return issues.filter((each) => each.severity === 'error').length
}
