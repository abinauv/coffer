/*
 * Putting a registration number to the regime, and reconciling it with a jurisdiction.
 *
 * WHY THIS IS NOT IN A REPOSITORY. What a valid GSTIN looks like is the regime's
 * business, `db/` may not import a concrete regime (CONVENTIONS §1.6), and threading a
 * validator down through every repository call would put the seam in the wrong place. So
 * it happens above them, on the way in.
 *
 * WHY IT IS NOT IN ONE SERVICE. Two things carry a registration number and both matter to
 * the same arithmetic: a party, and the company itself. `TaxRegime.computeTax` takes a
 * supplier and a customer and decides CGST+SGST against IGST from whether their
 * jurisdictions match, so the rule below is the same rule on both sides of a supply — and
 * two copies of it would be two chances to fix one and not the other.
 *
 * ---------------------------------------------------------------------------
 * WHY THE NUMBER DECIDES THE JURISDICTION
 *
 * A GSTIN's first two digits are the state code, and the state decides the place of
 * supply, which decides the tax. A number and a state that disagree therefore change the
 * money on every invoice raised. This refuses the pair rather than picking one, because
 * picking one silently is wrong half the time and invisible either way.
 *
 * Where the caller supplies no jurisdiction and the number encodes one, it is filled in.
 * That is not a guess; it is what the number says.
 *
 * The caller keeps its own error codes, because `PARTY_REGISTRATION_INVALID` and
 * `COMPANY_REGISTRATION_INVALID` are different sentences to different screens — the first
 * is about a customer somebody is entering, the second about the business whose books
 * these are. Shared logic, separate vocabulary.
 */

import { RepoError, type RepoErrorCode } from '../db/repos/errors'
import type { TaxRegime } from '../regimes'

/**
 * The two fields this reconciles, on the way in and on the way out.
 *
 * Both optional, and the result carries only the fields it has an opinion about — so
 * spreading it over an update cannot revive a field the caller left absent.
 */
export interface Registration {
  registrationNumber?: string | null
  jurisdictionCode?: string | null
}

/** What the caller calls its own failures. */
export interface RegistrationVocabulary {
  /** Raised when the regime does not recognise the number. */
  invalidCode: RepoErrorCode
  /** Raised when the number encodes a jurisdiction and the caller supplied another. */
  mismatchCode: RepoErrorCode
  /** What the mismatch sentence calls the registrant: 'party', 'business'. */
  subject: string
}

export function checkRegistration(
  regime: TaxRegime,
  input: Registration,
  vocabulary: RegistrationVocabulary,
): Registration {
  const number = input.registrationNumber
  /* Blank is not a number to check, it is the absence of one. A form with an empty GSTIN
   * box sends `''`, and putting that to the regime would answer "not a valid registration
   * number" to somebody who correctly said they have none. */
  if (number === undefined || number === null || number.trim() === '') {
    return {}
  }

  const result = regime.validateRegistrationNumber(number)
  if (!result.isValid) {
    throw new RepoError(
      vocabulary.invalidCode,
      result.message ?? `${number.trim()} is not a registration number these books recognise.`,
      { registrationNumber: number.trim() },
    )
  }

  /*
   * The regime's spelling, not the caller's. GSTIN validation upper-cases and strips
   * whitespace before it looks at anything, so a pasted ` 33aabcc1234d1zi ` is accepted —
   * and storing what arrived would put it on a tax invoice like that. A valid result
   * always carries a normalised value; the fallback is for a regime that has not been
   * written yet rather than for this one.
   */
  const canonical = result.normalisedValue ?? number.trim()

  const derived = result.derivedJurisdictionCode
  if (derived === undefined || derived === null) {
    return { registrationNumber: canonical }
  }

  const supplied = input.jurisdictionCode
  if (supplied !== undefined && supplied !== null && supplied.trim() !== '') {
    if (supplied.trim() !== derived) {
      const name = regime.jurisdictionName(derived)
      throw new RepoError(
        vocabulary.mismatchCode,
        `${canonical} is registered in ${name ?? derived}, which is not the place given. ` +
          `The registration number decides where a ${vocabulary.subject} is, and that ` +
          'decides the tax.',
        { registrationNumber: canonical, derived, supplied: supplied.trim() },
      )
    }
  }

  return { registrationNumber: canonical, jurisdictionCode: derived }
}
