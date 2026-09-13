/*
 * What can go wrong while reading somebody's XML, split into the same two kinds
 * `csv/errors.ts` splits them into — and the split falls in a different place here, for a
 * reason worth understanding before adding anything.
 *
 * An `XmlError` is a REFUSAL. It throws.
 * An `XmlIssue` is a REPORT. It is handed to `onIssue` and never thrown.
 *
 * IN CSV, MOST TROUBLE IS A REPORT: a file of eight hundred rows with eleven bad dates
 * still yields seven hundred and eighty-nine transactions, and a parser that threw on the
 * first one would make the user fix and re-run eleven times. XML is the opposite, and it
 * is not a matter of taste: A MALFORMED XML DOCUMENT HAS NO ROWS. There is no "rest of the
 * file" to salvage, because an unclosed `<VOUCHER>` does not corrupt one voucher — it
 * makes every subsequent close tag belong to the wrong element, so the file still parses
 * into a tree, and that tree is confidently wrong. Recovery here would mean guessing, and
 * a guess that silently reassigns a ledger entry to a different voucher is worse than a
 * refusal at a line number. So structure is refused, and only two things are reported:
 * the encoding declaration and the presence of replacement characters, both of which are
 * observations ABOUT a document that parsed perfectly well.
 *
 * EVERY REFUSAL ABOUT THE DOCUMENT CARRIES A LINE AND A COLUMN, and says them in the
 * message too, so the sentence stands alone in a dialog. `XML_LIMIT_INVALID` is the one
 * code with no position, because it is about an argument the caller passed and not about
 * anything in the file; a position there would be a fiction. `xmlErrorsCarryPositions` in
 * the tests pins that split rather than leaving it to good intentions.
 */

import { type XmlPosition } from './text'

export type XmlErrorCode =
  /** A `<!DOCTYPE`. Refused outright — see the security note in `scan.ts`. */
  | 'XML_DOCTYPE_FORBIDDEN'
  /** A `<!` construct that is not a comment or a CDATA section: `<!ENTITY`, `<!ATTLIST`. */
  | 'XML_INVALID_MARKUP'
  /** A character XML forbids at all — a NUL, a lone surrogate. Usually a decoding mistake. */
  | 'XML_INVALID_CHARACTER'
  /** A `<` that does not begin a tag, or a name that is not a Name. */
  | 'XML_INVALID_NAME'
  /** An element opened and the document ended before it closed. */
  | 'XML_UNCLOSED_ELEMENT'
  /** A close tag with nothing open. */
  | 'XML_UNEXPECTED_CLOSE_TAG'
  /** A close tag naming an element other than the innermost open one. */
  | 'XML_MISMATCHED_TAG'
  /** A tag that the document ended in the middle of. A truncated file lands here. */
  | 'XML_UNTERMINATED_TAG'
  /** A comment with no `-->`. */
  | 'XML_UNTERMINATED_COMMENT'
  /** A CDATA section with no `]]>`. */
  | 'XML_UNTERMINATED_CDATA'
  /** A processing instruction with no `?>`. */
  | 'XML_UNTERMINATED_PI'
  /** An attribute value with no quotation marks around it. */
  | 'XML_ATTRIBUTE_UNQUOTED'
  /** An attribute with no `=`, no separating space, or a `<` inside its value. */
  | 'XML_ATTRIBUTE_MALFORMED'
  /** The same attribute name twice on one element. */
  | 'XML_DUPLICATE_ATTRIBUTE'
  /** `&something;` where `something` is not one of the five XML defines. */
  | 'XML_UNKNOWN_ENTITY'
  /** An `&` that is not a reference at all, or a reference with no `;`. */
  | 'XML_INVALID_REFERENCE'
  /** `&#0;`, `&#xD800;`, `&#x110000;` — a number that is not a character XML allows. */
  | 'XML_INVALID_CHARACTER_REFERENCE'
  /** An `<?xml` that is not at the very start of the document. */
  | 'XML_DECLARATION_MISPLACED'
  /** `<?XML` or `<?Xml` — the target is reserved and the declaration is spelled lower case. */
  | 'XML_RESERVED_TARGET'
  /** Text or a CDATA section outside the root element. */
  | 'XML_CONTENT_OUTSIDE_ROOT'
  /** A second top-level element. */
  | 'XML_MULTIPLE_ROOTS'
  /** A document with no element in it at all. */
  | 'XML_NO_ROOT'
  /** Nesting deeper than the configured limit. */
  | 'XML_TOO_DEEP'
  /** More elements than the configured limit. */
  | 'XML_TOO_MANY_ELEMENTS'
  /** A run of text longer than the configured limit. */
  | 'XML_TEXT_TOO_LONG'
  /** More attributes on one element than the configured limit. */
  | 'XML_TOO_MANY_ATTRIBUTES'
  /** A cap that is not a positive whole number. The one code with no position. */
  | 'XML_LIMIT_INVALID'

/**
 * A refusal from the XML reader. Carries a stable code and, for everything about the
 * document itself, the line and column to send the user to.
 */
export class XmlError extends Error {
  readonly code: XmlErrorCode
  /** 1-based line, as a text editor counts them. Absent only on `XML_LIMIT_INVALID`. */
  readonly line: number | undefined
  /** 1-based column in UTF-16 units. Absent only on `XML_LIMIT_INVALID`. */
  readonly column: number | undefined

  constructor(code: XmlErrorCode, message: string, position?: XmlPosition, options?: ErrorOptions) {
    super(message, options)
    this.name = 'XmlError'
    this.code = code
    this.line = position?.line
    this.column = position?.column
  }
}

/** True when `value` is an `XmlError`. */
export function isXmlError(value: unknown): value is XmlError {
  return value instanceof XmlError
}

/**
 * Build a refusal whose message begins with the place it happened.
 *
 * One helper rather than a convention, because "the message must repeat the numbers" is
 * exactly the sort of rule that holds for the first fifteen call sites and not the
 * sixteenth, and the sixteenth is the one a user meets.
 */
export function xmlErrorAt(code: XmlErrorCode, position: XmlPosition, sentence: string): XmlError {
  return new XmlError(
    code,
    `Line ${String(position.line)}, column ${String(position.column)}: ${sentence}`,
    position,
  )
}

export type XmlIssueCode =
  /**
   * The document declares an encoding this module cannot vouch for.
   *
   * Reported and not refused. The reasoning is in the header of `scan.ts` and it is the
   * one decision in this batch that was settled by measurement.
   */
  | 'ENCODING_UNVERIFIED'
  /** U+FFFD in the text: the bytes were not what the decoder was told they were. */
  | 'REPLACEMENT_CHARACTER'

export type XmlIssueSeverity = 'error' | 'warning'

/**
 * Something noticed about a document that nonetheless parsed.
 *
 * The severity contract is `csv/errors.ts`'s, unchanged: an `error` means data did not
 * come through, a `warning` means it did and something is worth saying. Both issues this
 * module can raise are warnings by construction — a document that produced no data was
 * refused, not reported.
 *
 * A SEPARATE TYPE FROM `ImportIssue`, DELIBERATELY. Its code union is closed and does not
 * contain these two codes, and widening it is a change to a file this batch does not own.
 * Noted for the integration step: the natural home is a shared `importers/issues.ts` that
 * both readers contribute codes to.
 */
export interface XmlIssue {
  readonly code: XmlIssueCode
  readonly severity: XmlIssueSeverity
  /** Written for the person holding the file: what was noticed and what to do about it. */
  readonly message: string
  readonly line?: number
  readonly column?: number
  /** The offending value, where quoting it helps — the encoding label, say. */
  readonly value?: string
}

/**
 * Positive, whole, and NOT zero.
 *
 * Inherited from `csv/errors.ts`, with its reasoning intact and one addition. There, zero
 * was refused for a size cap and ACCEPTED for `maxDecimalPlaces`, and the difference is
 * not arbitrary: THE TEST IS WHETHER ZERO DESCRIBES SOMETHING THAT CAN EXIST. Zero
 * decimal places describes whole rupees, which exist and are common. Zero elements
 * describes a document with no elements, zero depth a document whose root is too deep to
 * open, and zero characters of text a document nothing can say — none of which is a file,
 * so none of them is a limit. Read as "unlimited" they would be a cap that quietly stopped
 * existing, which is how this project already lost a render to `slice(0, -0)`.
 */
export function requirePositiveInteger(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new XmlError(
      'XML_LIMIT_INVALID',
      `${what} must be a whole number of at least 1, not ${String(value)}.`,
    )
  }
  return value
}
