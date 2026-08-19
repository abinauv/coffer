/*
 * What India lets an invoice number look like.
 *
 * Rule 46(b) of the CGST Rules is unusually specific about this, and unusually easy to
 * break by accident. A tax invoice carries "a consecutive serial number not exceeding
 * sixteen characters, in one or multiple series, containing alphabets or numerals or
 * special characters hyphen or dash and slash symbolised as '-' and '/' respectively,
 * and any combination thereof, unique for a financial year".
 *
 * Read carefully, that is four separate rules, and three of them are about the string:
 *
 *   - at most sixteen characters
 *   - letters, digits, '-' and '/' only — no space, no '#', no '.'
 *   - not empty
 *
 * The fourth, uniqueness within a financial year, is not something a string can be asked
 * about. It is the numbering counter's job and the unique index behind it, and saying so
 * here rather than pretending to check it is the point of this comment.
 *
 * WHY SIXTEEN MATTERS. It is the width of the field in the GSTR-1 schema and on the
 * e-invoice payload. A seventeen-character number does not fail at the accountant's desk
 * — it fails at the portal, weeks later, on a return that will not upload, and by then
 * every invoice in the month carries it. `INV/2026-27/0001` is exactly sixteen, which is
 * why the default series is shaped the way it is and has no room to spare.
 */

import type { ValidationResult } from '@main/regimes/types'

/** Rule 46(b). Sixteen, not "about sixteen". */
export const MAX_DOCUMENT_NUMBER_LENGTH = 16

/** Letters, digits, hyphen and slash. Nothing else, deliberately. */
const ALLOWED = /^[A-Za-z0-9/-]+$/

export function validateDocumentNumber(value: string): ValidationResult {
  if (value === '') {
    return {
      isValid: false,
      message: 'A document number is required.',
      derivedJurisdictionCode: null,
      normalisedValue: null,
    }
  }

  if (value.length > MAX_DOCUMENT_NUMBER_LENGTH) {
    return {
      isValid: false,
      message: `A document number may be at most ${String(MAX_DOCUMENT_NUMBER_LENGTH)} characters. This one is ${String(value.length)}.`,
      derivedJurisdictionCode: null,
      normalisedValue: null,
    }
  }

  if (!ALLOWED.test(value)) {
    return {
      isValid: false,
      message: 'A document number may contain only letters, digits, hyphens and slashes.',
      derivedJurisdictionCode: null,
      normalisedValue: null,
    }
  }

  /* Kept exactly as typed. A document number is a label the business chose and the
   * regime constrains only its shape — `inv/2026-27/0001` is a number somebody meant to
   * write that way, not a mis-spelling of anything. */
  return { isValid: true, message: null, derivedJurisdictionCode: null, normalisedValue: value }
}
