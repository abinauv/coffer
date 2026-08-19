/*
 * GSTIN — the Indian registration number, and what it encodes.
 *
 * Fifteen characters, and every one of them means something:
 *
 *     3 3 A A B C C 1 2 3 4 D 1 Z I
 *     └┬┘ └─────────┬─────────┘ │ │ └ check character, base-36
 *      │            │           │ └── always 'Z'
 *      │            │           └──── which registration this is for that PAN in that
 *      │            │                 state — a second branch gets '2'
 *      │            └──────────────── the holder's PAN, unchanged
 *      └───────────────────────────── GST state code
 *
 * Two consequences the rest of the regime depends on. First, the state code is the
 * jurisdiction: a GSTIN alone is enough to decide CGST+SGST versus IGST, which is why
 * `validateRegistrationNumber` returns it. Second, the last character is a checksum over
 * the first fourteen, so a single mistyped character is detectable — and detecting it at
 * entry is the difference between a rejected return and a corrected keystroke.
 *
 * Messages here are written for the person typing, not for a log. "GSTIN format is
 * wrong" tells someone nothing about which of fifteen characters to look at; naming the
 * position and showing what they typed does.
 */

import type { ValidationResult } from '@main/regimes/types'
import { isKnownJurisdictionCode, jurisdictionName } from './jurisdictions'

export const GSTIN_LENGTH = 15

/** Base-36, digits before letters. Position in this string is the character's value. */
const CHECKSUM_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

const DIGITS = /^[0-9]+$/
const LETTERS = /^[A-Z]+$/
const ALPHANUMERIC = /^[A-Z0-9]$/

/**
 * Upper-case and strip whitespace.
 *
 * Whitespace is stripped anywhere, not just at the ends: a GSTIN copied off a
 * certificate or a PDF arrives as '33 AABCC1234D 1Z I' often enough that treating that
 * as a typo would be a worse answer than accepting it.
 */
export function normaliseGstin(value: string): string {
  return value.toUpperCase().replace(/\s+/g, '')
}

/**
 * The check character for the first fourteen, by the GSTN algorithm: walk right to left
 * with a factor alternating 2, 1, 2, 1…; multiply each character's base-36 value by the
 * factor; add the quotient and remainder of that product over 36; the check character is
 * whatever value brings the running total up to a multiple of 36.
 *
 * Throws on a character outside the alphabet — callers check the structure first.
 */
export function gstinCheckCharacter(firstFourteen: string): string {
  if (firstFourteen.length !== GSTIN_LENGTH - 1) {
    throw new Error(
      `A GSTIN check character is computed over ${String(GSTIN_LENGTH - 1)} characters, got ${String(firstFourteen.length)}.`,
    )
  }

  const base = CHECKSUM_ALPHABET.length
  let factor = 2
  let total = 0

  for (let index = firstFourteen.length - 1; index >= 0; index -= 1) {
    const character = firstFourteen.charAt(index)
    const value = CHECKSUM_ALPHABET.indexOf(character)
    if (value === -1) {
      throw new Error(`Not a GSTIN character: '${character}'.`)
    }
    const product = factor * value
    total += Math.floor(product / base) + (product % base)
    factor = factor === 1 ? 2 : 1
  }

  return CHECKSUM_ALPHABET.charAt((base - (total % base)) % base)
}

/** The state code a GSTIN carries, or null when the value is too short to have one. */
export function gstinJurisdictionCode(value: string): string | null {
  const gstin = normaliseGstin(value)
  if (gstin.length < 2) {
    return null
  }
  const code = gstin.slice(0, 2)
  return isKnownJurisdictionCode(code) ? code : null
}

function invalid(message: string, derivedJurisdictionCode: string | null): ValidationResult {
  return { isValid: false, message, derivedJurisdictionCode, normalisedValue: null }
}

/**
 * Validate a GSTIN and derive its state code.
 *
 * The state code is returned whenever it is recognisable, including on failure — a
 * checksum typo does not make the first two characters less informative, and the caller
 * may want to keep showing 'Tamil Nadu' while the user fixes the rest.
 */
export function validateGstin(value: string): ValidationResult {
  const gstin = normaliseGstin(value)
  const derived = gstinJurisdictionCode(gstin)

  if (gstin === '') {
    return invalid('Enter a GSTIN.', null)
  }

  if (gstin.length !== GSTIN_LENGTH) {
    return invalid(
      `A GSTIN is ${String(GSTIN_LENGTH)} characters long. This one has ${String(gstin.length)}.`,
      derived,
    )
  }

  const stateCode = gstin.slice(0, 2)
  if (!DIGITS.test(stateCode)) {
    return invalid(
      `A GSTIN starts with a two-digit state code, for example 33 for Tamil Nadu. This one starts with '${stateCode}'.`,
      derived,
    )
  }

  const panLetters = gstin.slice(2, 7)
  if (!LETTERS.test(panLetters)) {
    return invalid(
      `Characters 3 to 7 are the five letters that start the PAN, for example ABCDE. This one has '${panLetters}'.`,
      derived,
    )
  }

  const panDigits = gstin.slice(7, 11)
  if (!DIGITS.test(panDigits)) {
    return invalid(
      `Characters 8 to 11 are the four digits of the PAN. This one has '${panDigits}'.`,
      derived,
    )
  }

  const panLastLetter = gstin.charAt(11)
  if (!LETTERS.test(panLastLetter)) {
    return invalid(
      `Character 12 is the last letter of the PAN. This one has '${panLastLetter}'.`,
      derived,
    )
  }

  const registrationNumber = gstin.charAt(12)
  if (!ALPHANUMERIC.test(registrationNumber)) {
    return invalid(
      `Character 13 says which registration this is for the PAN in that state, a letter or a digit. This one has '${registrationNumber}'.`,
      derived,
    )
  }

  const reserved = gstin.charAt(13)
  if (reserved !== 'Z') {
    return invalid(
      `Character 14 of every GSTIN is the letter Z. This one has '${reserved}'.`,
      derived,
    )
  }

  const checkCharacter = gstin.charAt(14)
  if (!ALPHANUMERIC.test(checkCharacter)) {
    return invalid(
      `The last character is a check character, a letter or a digit. This one has '${checkCharacter}'.`,
      derived,
    )
  }

  if (!isKnownJurisdictionCode(stateCode)) {
    return invalid(
      `'${stateCode}' is not an Indian state code. A GSTIN starts with the state code, for example 33 for Tamil Nadu.`,
      null,
    )
  }

  if (checkCharacter !== gstinCheckCharacter(gstin.slice(0, 14))) {
    return invalid(
      'The last character does not match the rest of this GSTIN, so at least one character is mistyped. Check it against the registration certificate.',
      derived,
    )
  }

  /* `gstin` is the normalised form — upper-cased and stripped of whitespace at the top
   * of this function. Handing it back is what stops a pasted lower-case number being
   * stored and printed as it was typed. */
  return {
    isValid: true,
    message: null,
    derivedJurisdictionCode: stateCode,
    normalisedValue: gstin,
  }
}

/** The state name behind a GSTIN, for showing beside the field. Null when unreadable. */
export function gstinJurisdictionName(value: string): string | null {
  const code = gstinJurisdictionCode(value)
  return code === null ? null : jurisdictionName(code)
}
