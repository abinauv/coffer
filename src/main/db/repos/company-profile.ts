/*
 * The company profile repository — who these books belong to.
 *
 * Read migration 0011 first. The two decisions that shape this file are that there is at
 * most one profile, pinned by a CHECK rather than by convention, and that the table may
 * legitimately be empty: a migration cannot invent a legal name, so a profile exists once
 * somebody has entered one and every read answers null until then.
 *
 * WHAT THIS FILE DOES NOT DO. It does not validate a registration number, for the reason
 * the parties repository does not: GSTIN is the regime's business
 * (`TaxRegime.validateRegistrationNumber`), `db/` may not import a concrete regime
 * (CONVENTIONS §1.6), and a company's number and its jurisdiction can disagree in exactly
 * the way a party's can. The service layer checks both before calling — the same
 * `checkRegistration` shape the parties service already has — and what is enforced here
 * is only what storage can answer for: that a legal name and a country are present, that
 * a blank is stored as nothing, and that there is one row.
 *
 * SAVING IS A REPLACE, NOT A PATCH. `updateParty` writes only the fields it was given;
 * this writes all of them, and a field left out is cleared. The difference is deliberate
 * and lives in the DTO comment: one profile, one screen that owns every field of it, so a
 * patch would give two ways to say "no e-mail address" and make the stored row depend on
 * which one the caller picked.
 */

import type { CompanyProfile, SaveCompanyProfileInput } from '@shared/dto'

import type { CofferDb } from '../kysely'
import { COMPANY_PROFILE_ID } from '../migrations/0011_company_profile'
import type { CompanyProfileTable } from '../schema'
import { RepoError, type RepoErrorCode } from './errors'

type CompanyProfileRow = {
  [K in keyof CompanyProfileTable]: CompanyProfileTable[K]
}

// ---- Reading ---------------------------------------------------------------

/**
 * The profile, or null when nobody has entered one.
 *
 * The `where` is not a rule and a mutation deleting it survives on purpose: 0011's CHECK
 * means there is at most one row, so `executeTakeFirst` would return the same one without
 * it. It says which row is meant, which is the part a reader needs.
 */
export async function getCompanyProfile(db: CofferDb): Promise<CompanyProfile | null> {
  const row = await db
    .selectFrom('company_profile')
    .selectAll()
    .where('id', '=', COMPANY_PROFILE_ID)
    .executeTakeFirst()
  return row === undefined ? null : toProfile(row)
}

/**
 * The company's own jurisdiction, for `PostingContext.homeJurisdictionCode`.
 *
 * One column rather than the whole profile, and that is the point of it existing: issuing
 * a document has no business knowing the company's address or its e-mail, and a function
 * that handed it the whole row would be an invitation for a posting rule to start
 * branching on one of them. Null covers three different situations that a posting rule
 * treats identically — no profile yet, a country with no sub-national jurisdictions, and
 * a profile whose jurisdiction has not been filled in.
 */
export async function homeJurisdictionCode(db: CofferDb): Promise<string | null> {
  const row = await db
    .selectFrom('company_profile')
    .select('jurisdiction_code')
    .where('id', '=', COMPANY_PROFILE_ID)
    .executeTakeFirst()
  return row?.jurisdiction_code ?? null
}

// ---- Writing ---------------------------------------------------------------

/**
 * Write the profile, creating it the first time and replacing it afterwards.
 *
 * One statement, so there is no window where the profile is half-written and no
 * transaction needed to close one. `created_at` is left out of the update, so it keeps
 * saying when the profile was first entered — which is not when the company file was
 * made, and the two are worth being able to tell apart.
 */
export async function saveCompanyProfile(
  db: CofferDb,
  input: SaveCompanyProfileInput,
): Promise<CompanyProfile> {
  const legalName = requireText(
    input.legalName,
    'COMPANY_LEGAL_NAME_REQUIRED',
    'These books need the name the business is registered under. It is what prints on a tax invoice.',
  )
  const countryCode = requireText(
    input.countryCode,
    'COMPANY_COUNTRY_REQUIRED',
    'These books need to know which country the business is in.',
  ).toLowerCase()

  const now = new Date().toISOString()
  const fields = {
    legal_name: legalName,
    trade_name: trimmedOrNull(input.tradeName),
    registration_number: trimmedOrNull(input.registrationNumber),
    jurisdiction_code: trimmedOrNull(input.jurisdictionCode),
    country_code: countryCode,
    address_line1: trimmedOrNull(input.addressLine1),
    address_line2: trimmedOrNull(input.addressLine2),
    city: trimmedOrNull(input.city),
    postal_code: trimmedOrNull(input.postalCode),
    email: trimmedOrNull(input.email),
    phone: trimmedOrNull(input.phone),
    updated_at: now,
  }

  await db
    .insertInto('company_profile')
    .values({ id: COMPANY_PROFILE_ID, created_at: now, ...fields })
    .onConflict((oc) => oc.column('id').doUpdateSet(fields))
    .execute()

  const saved = await getCompanyProfile(db)
  if (saved === null) {
    /*
     * A plain Error, not a `RepoError`. The insert above either wrote the row or threw,
     * so there is no state of the books in which this happens and no sentence a user
     * could act on if it did (CONVENTIONS §5). It is here rather than a `!` so that a
     * corrupted file says what went wrong instead of returning a profile made of
     * undefined.
     */
    throw new Error('The company profile was written and could not be read back.')
  }
  return saved
}

// ---- Checks ----------------------------------------------------------------

/**
 * Trim, and refuse what is left if there is nothing in it.
 *
 * A blank legal name is a form somebody tabbed through, not a business with no name, and
 * 0011 refuses it either way — this is what turns that constraint into a sentence. The
 * codes are separate per field because the message has to say which box is empty.
 */
function requireText(value: string, code: RepoErrorCode, message: string): string {
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new RepoError(code, message)
  }
  return trimmed
}

/** A blank is the absence of a value, and there is one way to store that. */
function trimmedOrNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null
  }
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

// ---- Conversion ------------------------------------------------------------

function toProfile(row: CompanyProfileRow): CompanyProfile {
  return {
    legalName: row.legal_name,
    tradeName: row.trade_name,
    registrationNumber: row.registration_number,
    jurisdictionCode: row.jurisdiction_code,
    countryCode: row.country_code,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    postalCode: row.postal_code,
    email: row.email,
    phone: row.phone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
