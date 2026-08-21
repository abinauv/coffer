/*
 * The parties service — one method per method in the `parties` group of src/shared/ipc.ts.
 *
 * Mostly a thin pass to db/repos/parties, and deliberately so. What it adds is the one
 * thing the repository is forbidden to know: whether a registration number is a real one.
 * GSTIN validation belongs to the regime, `db/` may not import a concrete regime
 * (CONVENTIONS §1), and threading a validator down through every repository call would
 * put the seam in the wrong place. So it happens above the repository, on the way in.
 *
 * THE RULE ITSELF MOVED TO ../books/registration.ts when the company profile arrived,
 * because a company carries a registration number for exactly the same reason a party
 * does: `computeTax` takes a supplier and a customer and compares their jurisdictions.
 * Two copies of one rule would be two chances to fix one of them. What stays here is the
 * vocabulary — `PARTY_REGISTRATION_INVALID` is a sentence about a customer somebody is
 * entering, and the company's equivalent is a sentence about the business itself.
 *
 * WHAT IS NOT HERE. No party balance. That is a sum over `journal_lines.party_id` and
 * belongs with the other reports, alongside the aged analysis it will be grouped by —
 * putting a figure on this service would invite it to be cached on the record, which is
 * the one thing invariant 4 forbids.
 */

import type {
  ArchivePartyInput,
  CreatePartyInput,
  ListPartiesInput,
  Party,
  PartySummary,
  UpdatePartyInput,
} from '@shared/dto'

import { OpenBooks, type OpenCompanyHandle } from '../books/open-books'
import { checkRegistration, type Registration } from '../books/registration'
import {
  archiveParty,
  createParty,
  deleteParty,
  getParty,
  listParties,
  updateParty,
} from '../db/repos/parties'

/** How a party's registration failures are named. See ../books/registration.ts. */
const PARTY_REGISTRATION = {
  invalidCode: 'PARTY_REGISTRATION_INVALID',
  mismatchCode: 'PARTY_JURISDICTION_MISMATCH',
  subject: 'party',
} as const

export class PartiesService {
  private readonly books: OpenBooks

  constructor(companies: OpenCompanyHandle) {
    this.books = new OpenBooks(companies)
  }

  async list(input: ListPartiesInput = {}): Promise<PartySummary[]> {
    return listParties(this.books.db(), input)
  }

  async get(id: string): Promise<Party | null> {
    return getParty(this.books.db(), id)
  }

  async create(input: CreatePartyInput): Promise<Party> {
    return createParty(this.books.db(), { ...input, ...this.checkRegistration(input) })
  }

  /**
   * A change to a party.
   *
   * The same check as `create`, and deliberately with no `'registrationNumber' in input`
   * guard in front of it. That guard was written, and a mutation deleting it changed
   * nothing: `checkRegistration` already answers `{}` for a number that is absent, null
   * or blank, so the guard could only ever agree with it. Two conditions that cannot
   * disagree are one condition and a place for them to drift apart later.
   */
  async update(input: UpdatePartyInput): Promise<Party> {
    return updateParty(this.books.db(), { ...input, ...this.checkRegistration(input) })
  }

  async archive(input: ArchivePartyInput): Promise<Party> {
    return archiveParty(this.books.db(), input.id, input.archived)
  }

  /** Only ever a mistyped party nothing has been posted to — see the repository. */
  async delete(id: string): Promise<void> {
    return deleteParty(this.books.db(), id)
  }

  /**
   * Put the registration number to the regime the BOOKS were created under.
   *
   * `this.books.regime()` rather than the build's default, which is the point of the
   * service existing at all: what counts as a valid number is a property of the file,
   * and the periods on disk were generated from the same regime's calendar.
   */
  private checkRegistration(input: Registration): Registration {
    return checkRegistration(this.books.regime(), input, PARTY_REGISTRATION)
  }
}

export function createPartiesService(companies: OpenCompanyHandle): PartiesService {
  return new PartiesService(companies)
}
