/*
 * The company profile service — one method per method in the `companyProfile` group.
 *
 * Two methods, and one of them is a pass. What it adds is the thing db/repos may not do:
 * put the registration number to the regime the BOOKS were created under, and refuse a
 * number and a jurisdiction that disagree. That rule lives in ../books/registration.ts
 * and is shared with parties, because a company and a customer carry a registration
 * number for exactly the same reason — `computeTax` takes both and compares them.
 *
 * IT IS NOT PART OF `companies`. That module is the registry: which company files exist,
 * where they are, how they are keyed, how they are opened and backed up. This is business
 * data inside one of them, and it needs an open company to read at all. Putting a legal
 * name next to a passphrase would put the one screen a user edits their address on into
 * the module that holds the key vault.
 *
 * WHY THE COMPANY'S OWN REGISTRATION MATTERS MORE THAN A PARTY'S. A customer with the
 * wrong state code changes the tax on that customer's invoices. The company with the
 * wrong state code changes the tax on EVERY invoice, in both directions — every sale
 * becomes inter-state or every sale becomes intra-state — and nothing about the documents
 * would look wrong. So the same check runs here, and the sentence it fails with is about
 * the business rather than about somebody's customer.
 */

import type { CompanyProfile, SaveCompanyProfileInput } from '@shared/dto'

import { OpenBooks, type OpenCompanyHandle } from '../books/open-books'
import { checkRegistration } from '../books/registration'
import { getCompanyProfile, saveCompanyProfile } from '../db/repos/company-profile'

/** How the company's own registration failures are named. See ../books/registration.ts. */
const COMPANY_REGISTRATION = {
  invalidCode: 'COMPANY_REGISTRATION_INVALID',
  mismatchCode: 'COMPANY_JURISDICTION_MISMATCH',
  subject: 'business',
} as const

export class CompanyProfileService {
  private readonly books: OpenBooks

  constructor(companies: OpenCompanyHandle) {
    this.books = new OpenBooks(companies)
  }

  /** Null until somebody has entered one — see migration 0011 for why that is allowed. */
  async get(): Promise<CompanyProfile | null> {
    return getCompanyProfile(this.books.db())
  }

  /**
   * Write the whole profile.
   *
   * A REPLACE, not a patch, and the spread is what makes the check safe with it: the
   * result of `checkRegistration` carries only the fields it has an opinion about, so a
   * profile saved with no registration number keeps the jurisdiction the caller sent
   * rather than having it cleared by a check that had nothing to say.
   */
  async save(input: SaveCompanyProfileInput): Promise<CompanyProfile> {
    const registration = checkRegistration(this.books.regime(), input, COMPANY_REGISTRATION)
    return saveCompanyProfile(this.books.db(), { ...input, ...registration })
  }
}

export function createCompanyProfileService(companies: OpenCompanyHandle): CompanyProfileService {
  return new CompanyProfileService(companies)
}
