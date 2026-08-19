/*
 * The parties service — one method per method in the `parties` group of src/shared/ipc.ts.
 *
 * Mostly a thin pass to db/repos/parties, and deliberately so. What it adds is the one
 * thing the repository is forbidden to know: whether a registration number is a real one.
 * GSTIN validation belongs to the regime, `db/` may not import a concrete regime
 * (CONVENTIONS §1), and threading a validator down through every repository call would
 * put the seam in the wrong place. So it happens here, once, on the way in.
 *
 * WHY THE NUMBER DECIDES THE JURISDICTION. A GSTIN's first two digits are the state code,
 * and a party's state decides the place of supply — which decides whether an invoice
 * carries CGST+SGST or IGST. A number and a state that disagree therefore change the tax
 * on every invoice raised for that party. This service refuses the pair rather than
 * picking one, because picking one silently is wrong half the time and invisible either
 * way. Where the caller supplies no jurisdiction and the number encodes one, it is
 * filled in — that is not a guess, it is what the number says.
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
import {
  archiveParty,
  createParty,
  deleteParty,
  getParty,
  listParties,
  updateParty,
} from '../db/repos/parties'
import { RepoError } from '../db/repos/errors'

/** What a registration number resolves to once the regime has had a look at it. */
interface Registration {
  registrationNumber?: string | null
  jurisdictionCode?: string | null
}

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
   * Put the registration number to the regime, and reconcile it with the jurisdiction.
   *
   * Returns only the fields it has an opinion about, so that spreading the result over
   * an update cannot revive a field the caller left absent.
   */
  private checkRegistration(input: Registration): Registration {
    const number = input.registrationNumber
    /* Blank is not a number to check, it is the absence of one. A form with an empty
     * GSTIN box sends `''`, and putting that to the regime would answer "not a valid
     * registration number" to somebody who correctly said they have none. */
    if (number === undefined || number === null || number.trim() === '') {
      return {}
    }

    const result = this.books.regime().validateRegistrationNumber(number)
    if (!result.isValid) {
      throw new RepoError(
        'PARTY_REGISTRATION_INVALID',
        result.message ?? `${number.trim()} is not a registration number these books recognise.`,
        { registrationNumber: number.trim() },
      )
    }

    /*
     * The regime's spelling, not the caller's. GSTIN validation upper-cases and strips
     * whitespace before it looks at anything, so a pasted ` 33aabcc1234d1zi ` is
     * accepted — and storing what arrived would put it on a tax invoice like that. A
     * valid result always carries a normalised value; the fallback is for a regime that
     * has not been written yet rather than for this one.
     */
    const canonical = result.normalisedValue ?? number.trim()

    const derived = result.derivedJurisdictionCode
    if (derived === undefined || derived === null) {
      return { registrationNumber: canonical }
    }

    const supplied = input.jurisdictionCode
    if (supplied !== undefined && supplied !== null && supplied.trim() !== '') {
      if (supplied.trim() !== derived) {
        const name = this.books.regime().jurisdictionName(derived)
        throw new RepoError(
          'PARTY_JURISDICTION_MISMATCH',
          `${canonical} is registered in ${name ?? derived}, which is not the place given. ` +
            'The registration number decides where a party is, and that decides the tax.',
          { registrationNumber: canonical, derived, supplied: supplied.trim() },
        )
      }
    }

    return { registrationNumber: canonical, jurisdictionCode: derived }
  }
}

export function createPartiesService(companies: OpenCompanyHandle): PartiesService {
  return new PartiesService(companies)
}
