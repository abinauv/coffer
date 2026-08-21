/*
 * The documents service — where the regime is finally asked for the tax.
 *
 * This is the seam the whole design has been built around. `db/` may not name a regime
 * (CONVENTIONS §1.6) and the renderer may not compute money (§1.7), so there is exactly
 * one layer that can ask "what tax does this line carry", and this is it. The screen
 * collects what the user typed, this asks the regime, and the repository stores what it
 * answered. The reference project called `computeGst()` straight from its screens; the
 * two DTO families in shared/dto.ts — `CreateDocumentInput` against
 * `CreateTaxedDocumentInput` — exist to make that impossible to do here by accident.
 *
 * ---------------------------------------------------------------------------
 * A DOCUMENT IS TAXED AS A WHOLE, SO ANY CHANGE THAT MATTERS RE-ASKS
 *
 * `update` recomputes every line when the lines change — and also when the PARTY, the
 * DATE or the PLACE OF SUPPLY changes, which is the part that is easy to miss. Moving an
 * invoice from a Tamil Nadu customer to a Karnataka one turns CGST+SGST into IGST on
 * every line, without a single line being edited. Recomputing only the lines that arrived
 * would leave a document whose tax was right for a customer it no longer has.
 *
 * A change to the narration or the party reference re-asks nothing, because nothing about
 * the tax depends on them.
 *
 * ---------------------------------------------------------------------------
 * THE PLACE OF SUPPLY: THE REGIME DECIDES, THE USER MAY RELOCATE
 *
 * Absent, the place of supply is what `regime.placeOfSupply(supplier, customer)` says.
 * Supplied, it is used — but it is used by BUILDING A CUSTOMER THAT SITS THERE and asking
 * the regime again, never by assembling a `PlaceOfSupply` here. An override says where the
 * supply happened; what that means for the tax stays the regime's answer, and a
 * hand-assembled `isIntraJurisdiction` would be this layer deciding CGST+SGST against
 * IGST with its own arithmetic.
 *
 * ---------------------------------------------------------------------------
 * WITHOUT A COMPANY PROFILE THERE IS NO SUPPLIER, AND NO TAX
 *
 * `computeTax` takes both sides of the supply. With no profile there is no supplier — not
 * even a country — so there is nothing to compute from, and inventing one would put a
 * jurisdiction of this layer's choosing on every invoice in the books. It refuses with
 * `COMPANY_PROFILE_MISSING`, which is a sentence a user can act on, once.
 *
 * Reading, issuing and cancelling need none of that and do not ask for it: the tax on an
 * issued document was decided when it was drafted and is stored on it.
 */

import { D, roundAt, toMoneyString } from '@main/domain/money'
import type {
  CancelDocumentInput,
  CreateDocumentInput,
  DateString,
  Document,
  DocumentLineInput,
  DocumentLineTaxDto,
  DocumentSummary,
  IssueDocumentInput,
  ListDocumentsInput,
  TaxedLineInput,
  UpdateDocumentInput,
} from '@shared/dto'

import { OpenBooks, type OpenCompanyHandle } from '../books/open-books'
import { getCompanyProfile } from '../db/repos/company-profile'
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
} from '../db/repos/documents'
import { RepoError } from '../db/repos/errors'
import { cancelDocument, issueDocument } from '../db/repos/issuing'
import { getParty } from '../db/repos/parties'
import type { CofferDb } from '../db/kysely'
import type { TaxParty, TaxableLine } from '../regimes/types'

/** Where a supply happened, as a document stores it. */
interface StoredPlaceOfSupply {
  jurisdictionCode: string | null
  countryCode: string
}

/** What the caller may say about where the supply happened. Absent means "ask". */
interface PlaceOverride {
  placeOfSupplyJurisdiction?: string | null
  placeOfSupplyCountry?: string
}

export class DocumentsService {
  private readonly books: OpenBooks

  constructor(companies: OpenCompanyHandle) {
    this.books = new OpenBooks(companies)
  }

  async list(input: ListDocumentsInput = {}): Promise<DocumentSummary[]> {
    return listDocuments(this.books.db(), input)
  }

  async get(id: string): Promise<Document | null> {
    return getDocument(this.books.db(), id)
  }

  async create(input: CreateDocumentInput): Promise<Document> {
    const db = this.books.db()
    const taxed = await this.tax(db, input.date, input.partyId, input, input.lines ?? [])

    return createDocument(
      db,
      {
        ...input,
        placeOfSupplyJurisdiction: taxed.placeOfSupply.jurisdictionCode,
        placeOfSupplyCountry: taxed.placeOfSupply.countryCode,
        lines: taxed.lines,
      },
      new Date().toISOString(),
    )
  }

  /**
   * Change a draft, and re-ask the regime when the change could move the tax.
   *
   * The existing document supplies whatever the caller left out — its date, its party,
   * its lines — because the regime has to be asked about the document as it will be, not
   * about the fragment that arrived.
   */
  async update(input: UpdateDocumentInput): Promise<Document> {
    const db = this.books.db()
    const now = new Date().toISOString()

    if (!changesTheTax(input)) {
      /* Nothing here can move the tax, so nothing is re-asked. `lines` is spelled out as
       * absent rather than spread through: `changesTheTax` is false only when no line
       * arrived, and saying so keeps the two shapes from meeting. */
      return updateDocument(db, { ...input, lines: undefined }, now)
    }

    const existing = await this.require(db, input.id)
    const lines = input.lines ?? existing.lines.map(asPricedLine)
    const partyId = input.partyId ?? existing.partyId
    const taxed = await this.tax(
      db,
      input.date ?? existing.date,
      partyId,
      placeAsked(input, existing, partyId !== existing.partyId),
      lines,
    )

    return updateDocument(
      db,
      {
        ...input,
        placeOfSupplyJurisdiction: taxed.placeOfSupply.jurisdictionCode,
        placeOfSupplyCountry: taxed.placeOfSupply.countryCode,
        lines: taxed.lines,
      },
      now,
    )
  }

  /** Only ever a draft — an issued document is cancelled, never removed. */
  async delete(id: string): Promise<void> {
    return deleteDocument(this.books.db(), id)
  }

  async issue(input: IssueDocumentInput): Promise<Document> {
    return issueDocument(this.books.db(), input, new Date().toISOString())
  }

  async cancel(input: CancelDocumentInput): Promise<Document> {
    return cancelDocument(this.books.db(), input, new Date().toISOString())
  }

  // ---- The seam ------------------------------------------------------------

  /**
   * Price the lines, settle where the supply happened, and put both to the regime.
   *
   * The extension — `quantity x price - discount` — is computed here rather than sent by
   * the screen, and rounded at `lineAmount`, which is the defined point for it. The
   * repository checks the same arithmetic when it stores the line, so a bug here is
   * caught rather than written to the books.
   */
  private async tax(
    db: CofferDb,
    date: DateString,
    partyId: string,
    place: PlaceOverride,
    lines: readonly DocumentLineInput[],
  ): Promise<{ placeOfSupply: StoredPlaceOfSupply; lines: TaxedLineInput[] }> {
    const regime = this.books.regime()
    const supplier = await this.supplier(db)
    const customer = await this.customer(db, partyId)
    const placeOfSupply = regime.placeOfSupply(supplier, relocated(customer, place))

    const priced = lines.map((line, index) => ({
      line,
      lineId: String(index + 1),
      taxableAmount: extensionOf(line),
    }))

    const taxable: TaxableLine[] = priced.map((entry) => ({
      lineId: entry.lineId,
      taxableAmount: entry.taxableAmount,
      ratePct: entry.line.ratePct ?? '0',
      classificationCode: entry.line.classificationCode ?? null,
      ...(entry.line.isCharge === undefined ? {} : { isCharge: entry.line.isCharge }),
    }))

    /*
     * Asked once for the whole document, not once per line. Which components a supply
     * attracts is a property of the supply, and a regime that had to answer line by line
     * could not tell an intra-state document from an inter-state one.
     *
     * `date` IS THE DOCUMENT'S OWN, AND IS A DELIBERATE MUTATION SURVIVOR. A document is
     * taxed as of its own date because rates change, and `TaxComputationInput` carries it
     * for that reason. `in-gst` checks that it is a date and does not yet vary by it, so
     * no test can tell this apart from passing any other valid date — measured, and the
     * mutation survives. It stays as the document's own because the day a regime does
     * vary by date, every invoice edited after a rate change would silently be re-taxed
     * at the new rate, and nothing in the books would say so.
     */
    const computed = regime.computeTax({
      supplier,
      customer,
      placeOfSupply,
      lines: taxable,
      date,
    })

    const byLine = new Map(computed.lines.map((result) => [result.lineId, result]))

    return {
      placeOfSupply: {
        jurisdictionCode: placeOfSupply.jurisdictionCode,
        countryCode: placeOfSupply.countryCode,
      },
      lines: priced.map((entry) => ({
        ...entry.line,
        taxableAmount: entry.taxableAmount,
        taxes: taxesOf(byLine.get(entry.lineId)?.components ?? []),
      })),
    }
  }

  /** The business these books belong to, as the regime sees it. */
  private async supplier(db: CofferDb): Promise<TaxParty> {
    const profile = await getCompanyProfile(db)
    if (profile === null) {
      throw new RepoError(
        'COMPANY_PROFILE_MISSING',
        'These books do not say who they are for yet. Fill in the company profile — the ' +
          'tax on a sale depends on where the business is as much as on where the customer is.',
      )
    }
    return {
      registrationNumber: profile.registrationNumber,
      jurisdictionCode: profile.jurisdictionCode,
      countryCode: profile.countryCode,
    }
  }

  private async customer(db: CofferDb, partyId: string): Promise<TaxParty> {
    const party = await getParty(db, partyId)
    if (party === null) {
      throw new RepoError('PARTY_NOT_FOUND', 'That party is not in these books.', { partyId })
    }
    return {
      registrationNumber: party.registrationNumber,
      jurisdictionCode: party.jurisdictionCode,
      countryCode: party.countryCode,
    }
  }

  private async require(db: CofferDb, id: string): Promise<Document> {
    const document = await getDocument(db, id)
    if (document === null) {
      throw new RepoError('DOCUMENT_NOT_FOUND', 'That document is not in these books.', { id })
    }
    return document
  }
}

export function createDocumentsService(companies: OpenCompanyHandle): DocumentsService {
  return new DocumentsService(companies)
}

// ---- What moves the tax ----------------------------------------------------

/**
 * Whether a change could move the tax, and therefore has to re-ask the regime.
 *
 * Four fields, and only one of them is obvious. The lines are; the party, the date and
 * the place of supply are the three that change every line's tax without any line being
 * touched — a different customer changes the split, a different date changes the rates in
 * force, and a different place of supply is the whole question.
 */
function changesTheTax(input: UpdateDocumentInput): boolean {
  return (
    input.lines !== undefined ||
    input.partyId !== undefined ||
    input.date !== undefined ||
    input.placeOfSupplyJurisdiction !== undefined ||
    input.placeOfSupplyCountry !== undefined
  )
}

/**
 * Where the supply happened, for a document being changed. Three answers, in order.
 *
 * WHAT THE CALLER SAYS WINS. Stating a place is a decision only a person can make.
 *
 * OTHERWISE, IF THE PARTY CHANGED, THE REGIME IS ASKED AGAIN — `undefined` is what means
 * that. Nothing on the document records whether its stored place was derived or stated,
 * so keeping it would keep a Tamil Nadu place of supply on an invoice that now belongs to
 * a customer in Karnataka, and the whole document would stay CGST+SGST when it is IGST.
 * Measured: the test for this failed against the first version of this function, which
 * kept the stored place unconditionally.
 *
 * OTHERWISE THE DOCUMENT KEEPS THE PLACE IT HAS. An edit to the lines is not a statement
 * about geography, and re-deriving on one would silently undo an override the user set.
 *
 * What this costs is that an override IS dropped when the party changes — the customer it
 * was decided for is gone, and re-stating it is a field the editor already shows.
 */
function placeAsked(
  input: UpdateDocumentInput,
  existing: Document,
  partyChanged: boolean,
): PlaceOverride {
  if (partyChanged) {
    return {
      placeOfSupplyJurisdiction: input.placeOfSupplyJurisdiction,
      placeOfSupplyCountry: input.placeOfSupplyCountry,
    }
  }
  return {
    placeOfSupplyJurisdiction:
      input.placeOfSupplyJurisdiction === undefined
        ? existing.placeOfSupplyJurisdiction
        : input.placeOfSupplyJurisdiction,
    placeOfSupplyCountry: input.placeOfSupplyCountry ?? existing.placeOfSupplyCountry,
  }
}

/**
 * The customer as the place of supply says they are, for the regime to judge.
 *
 * An override moves where the supply happened; it does not decide what that means. The
 * regime still answers whether it is intra-jurisdiction and whether it is an export, from
 * a customer standing in the place the caller named.
 */
function relocated(customer: TaxParty, place: PlaceOverride): TaxParty {
  return {
    registrationNumber: customer.registrationNumber,
    jurisdictionCode:
      place.placeOfSupplyJurisdiction === undefined
        ? customer.jurisdictionCode
        : place.placeOfSupplyJurisdiction,
    countryCode: place.placeOfSupplyCountry ?? customer.countryCode,
  }
}

/** `quantity x price - discount`, rounded at the point defined for a line. */
function extensionOf(line: DocumentLineInput): string {
  const extended = D(line.quantity)
    .times(D(line.unitPrice))
    .minus(D(line.discount ?? '0'))
  return toMoneyString(roundAt('lineAmount', extended))
}

function taxesOf(components: readonly DocumentLineTaxDto[]): DocumentLineTaxDto[] {
  return components.map((component) => ({
    code: component.code,
    label: component.label,
    ratePct: component.ratePct,
    amount: component.amount,
  }))
}

/** A stored line, back in the shape a screen would have sent it. */
function asPricedLine(line: Document['lines'][number]): DocumentLineInput {
  return {
    itemId: line.itemId,
    description: line.description,
    quantity: line.quantity,
    unitCode: line.unitCode,
    unitPrice: line.unitPrice,
    discount: line.discount,
    ratePct: line.ratePct,
    classificationCode: line.classificationCode,
    isCharge: line.isCharge,
    accountId: line.accountId,
  }
}
