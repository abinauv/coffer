/*
 * HSN and SAC — how India says what a thing is.
 *
 * HSN ("Harmonized System of Nomenclature") classifies goods, at 4, 6 or 8 digits: the
 * chapter and heading, then the subheading, then the tariff item. Five and seven digits
 * are not shorter codes, they are truncated ones, and GSTR-1 rejects them. How many
 * digits a taxpayer must quote depends on turnover, so all three lengths are valid input
 * and none of them is "the" length.
 *
 * SAC ("Services Accounting Code") classifies services. It is chapter 99 of the same
 * system, always six digits, always starting 99. That one fact is what lets a single
 * field accept both and still tell them apart — which matters, because a four- or
 * eight-digit code beginning 99 is not a shorter or longer service code, it is a typo.
 *
 * The `ClassificationScheme` contract carries one `code`, so this regime presents the
 * pair as one scheme (`HSN`, labelled 'HSN / SAC') and distinguishes them with
 * `classificationKindOf`. The alternative — two schemes — would push the choice of which
 * field to validate against out into every screen.
 *
 * The codes themselves are seed data in the compliance pack, not here: what a code means
 * and what it is usually taxed at is a schedule, and schedules change without an
 * amendment to the Act.
 */

import type { ClassificationScheme, ValidationResult } from '@main/regimes/types'
import type { DecimalString } from '@shared/scalars'
import {
  BUNDLED_COMPLIANCE_PACK,
  type ClassificationEntry,
  type ClassificationKind,
  type IndiaCompliancePack,
} from './compliance-pack'

/** Digit counts an HSN code may have. A SAC is always 6, which is already in this set. */
export const HSN_LENGTHS: readonly number[] = [4, 6, 8]

/** A SAC is exactly six digits. */
export const SAC_LENGTH = 6

/** Chapter 99 of the harmonised system is services. */
const SAC_PREFIX = '99'

const DIGITS = /^[0-9]+$/

/** Trim and drop the spaces and dots people put in a code when reading it aloud. */
export function normaliseClassificationCode(code: string): string {
  return code.replace(/[\s.]/g, '')
}

/**
 * Whether a code is a goods code or a service code, or null when it is neither.
 *
 * Six digits starting 99 is a SAC; any other valid length is HSN.
 */
export function classificationKindOf(code: string): ClassificationKind | null {
  const value = normaliseClassificationCode(code)
  if (!validateClassificationCode(value).isValid) {
    return null
  }
  return value.length === SAC_LENGTH && value.startsWith(SAC_PREFIX) ? 'SAC' : 'HSN'
}

/** Validate a code against both schemes, with a message naming what is wrong. */
export function validateClassificationCode(code: string): ValidationResult {
  const value = normaliseClassificationCode(code)

  if (value === '') {
    return { isValid: false, message: 'Enter an HSN or SAC code.' }
  }

  if (!DIGITS.test(value)) {
    return {
      isValid: false,
      message: `An HSN or SAC code is digits only. This one is '${value}'.`,
    }
  }

  if (value.startsWith(SAC_PREFIX) && value.length !== SAC_LENGTH) {
    return {
      isValid: false,
      message: `A code starting 99 is a service code, which is always ${String(SAC_LENGTH)} digits. This one has ${String(value.length)}.`,
    }
  }

  if (!HSN_LENGTHS.includes(value.length)) {
    return {
      isValid: false,
      message: `An HSN code is 4, 6 or 8 digits and a service code is ${String(SAC_LENGTH)}. This one has ${String(value.length)}.`,
    }
  }

  return { isValid: true, message: null }
}

/** The bundled entry for a code, or null. Exact match on the normalised code. */
export function findClassification(
  code: string,
  pack: IndiaCompliancePack = BUNDLED_COMPLIANCE_PACK,
): ClassificationEntry | null {
  const value = normaliseClassificationCode(code)
  return pack.classificationCodes.find((entry) => entry.code === value) ?? null
}

/**
 * The rate the pack suggests for a code, or null when the pack does not carry it.
 *
 * A suggestion the user may override, never a rate applied behind their back — which is
 * why `computeTax` takes the rate off the line rather than looking it up from here.
 */
export function defaultRateFor(
  code: string,
  pack: IndiaCompliancePack = BUNDLED_COMPLIANCE_PACK,
): DecimalString | null {
  return findClassification(code, pack)?.defaultRatePct ?? null
}

/**
 * Codes whose number or description contains `term`, for a picker's type-ahead.
 *
 * Case-insensitive, and matched against both the code and the description so that
 * typing '8471' and typing 'computer' both land somewhere useful.
 */
export function searchClassification(
  term: string,
  pack: IndiaCompliancePack = BUNDLED_COMPLIANCE_PACK,
): readonly ClassificationEntry[] {
  const needle = term.trim().toLowerCase()
  if (needle === '') {
    return pack.classificationCodes
  }
  return pack.classificationCodes.filter(
    (entry) => entry.code.startsWith(needle) || entry.description.toLowerCase().includes(needle),
  )
}

/** The rates a picker offers, from the pack. */
export function rateSlabs(
  pack: IndiaCompliancePack = BUNDLED_COMPLIANCE_PACK,
): readonly DecimalString[] {
  return pack.rateSlabs.map((slab) => slab.ratePct)
}

/** The `ClassificationScheme` the regime exposes. */
export const indiaClassification: ClassificationScheme = {
  code: 'HSN',
  label: 'HSN / SAC',
  /* Copied, not shared: the contract's array is mutable and a caller must not be able
   * to reach through it and edit the regime's own list. */
  validLengths: [...HSN_LENGTHS],
  validate: validateClassificationCode,
}
