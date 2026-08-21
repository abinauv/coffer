/*
 * The `companyProfile` group.
 *
 * Same contract as ./parties.ts: the boundary, not the behaviour. Validate the shape of
 * what the renderer sent, call a `CompanyProfileService`, wrap the answer in a `Result`.
 *
 * VALIDATION IS SHAPE ONLY, and the registration number is the case that shows why.
 * Whether `33AABCC1234D1ZI` is a real GSTIN is the regime's question, its answer carries
 * a sentence written for the user, and its code is `COMPANY_REGISTRATION_INVALID`.
 * Collapsing that into `INVALID_ARGUMENT` here would tell somebody who mistyped one
 * character that their input was malformed.
 *
 * `save` TAKES THE WHOLE PROFILE, and the parse reflects that. There is no `'field' in
 * input` dance as there is in ./parties.ts, because absent and null mean the same thing
 * here: a save is a replace, so a field the screen did not send is a field the screen is
 * clearing. The two fields with no null are `legalName` and `countryCode` — a business
 * with no name is not one this can record.
 */

import type { CompanyProfile, SaveCompanyProfileInput } from '../../../shared/dto'
import type { GroupHandlers } from '../registry'
import { ok } from '../surface'
import { expectBoundedString, expectNonEmptyString, expectRecord } from '../validate'

/**
 * What the IPC layer needs from src/main/company-profile.
 *
 * One method per contract method, same names, same DTOs, no envelope.
 */
export interface CompanyProfileService {
  get(): Promise<CompanyProfile | null>
  save(input: SaveCompanyProfileInput): Promise<CompanyProfile>
}

/** Long enough for a legal name with a full address in it, short enough to bound. */
const MAX_TEXT = 500

const text = (value: unknown, field: string): string => expectBoundedString(value, field, MAX_TEXT)

/**
 * An optional field on a replace: absent and null are the same answer, which is "clear
 * it". A blank string is too, and the repository is what turns it into a null — there is
 * one way to store the absence of a value (0011).
 */
function optionalText(input: Record<string, unknown>, field: string): string | null {
  const value = input[field]
  if (value === undefined || value === null) return null
  return text(value, field)
}

function parseSave(value: unknown): SaveCompanyProfileInput {
  const input = expectRecord(value, 'input')
  return {
    legalName: text(expectNonEmptyString(input['legalName'], 'legalName'), 'legalName'),
    countryCode: expectNonEmptyString(input['countryCode'], 'countryCode'),
    tradeName: optionalText(input, 'tradeName'),
    registrationNumber: optionalText(input, 'registrationNumber'),
    jurisdictionCode: optionalText(input, 'jurisdictionCode'),
    addressLine1: optionalText(input, 'addressLine1'),
    addressLine2: optionalText(input, 'addressLine2'),
    city: optionalText(input, 'city'),
    postalCode: optionalText(input, 'postalCode'),
    email: optionalText(input, 'email'),
    phone: optionalText(input, 'phone'),
  }
}

export function createCompanyProfileHandlers(
  service: CompanyProfileService,
): GroupHandlers<'companyProfile'> {
  return {
    get: {
      parseArgs: (): [] => [],
      handle: async () => ok(await service.get()),
    },

    save: {
      parseArgs: (raw): [SaveCompanyProfileInput] => [parseSave(raw[0])],
      handle: async (input) => ok(await service.save(input)),
    },
  }
}
