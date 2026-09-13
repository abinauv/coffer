/*
 * The documents service, against a real company created by the real company service.
 *
 * THE SUBJECT IS THE TAX. Everything else on this service is a pass to a repository that
 * is tested against a real database already; what only exists here is the seam — the
 * screen sends what the user typed, this asks the regime, and the repository stores the
 * answer. So the assertions are about which components came back and how much of each,
 * for supplies whose answer differs.
 *
 * Tamil Nadu selling to Tamil Nadu is CGST + SGST. Tamil Nadu selling to Karnataka is
 * IGST. Nothing about the two documents differs except the customer, and a service that
 * quietly stopped asking the regime would produce the same figures for both — which is
 * why every tax test here names the components rather than only the total.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { aprilToMarch } from '@main/domain/time'
import type { CreateDocumentInput, DocumentLineInput } from '@shared/dto'

import { CompanyService } from '../companies/service'
import { CompanyError } from '../companies/errors'
import { CompanyProfileService } from '../company-profile/service'
import { PartiesService } from '../parties/service'
import { createQueryBuilder } from '../db/kysely'
import { generateFiscalYear } from '../db/repos/periods'
import { createSeries } from '../db/repos/numbering'
import { getEntry } from '../db/repos/journal'
import { D } from '@main/domain/money'
import { type Argon2Params, MIN_MEMORY_COST } from '../security'
import { DocumentsService } from './service'

const FAST: Argon2Params = {
  algorithm: 'argon2id',
  memoryCost: MIN_MEMORY_COST,
  timeCost: 1,
  parallelism: 1,
}

const PASSPHRASE = 'a quiet ledger keeps its own counsel'

/* Tamil Nadu is 33, Karnataka 29. The company sits in Tamil Nadu throughout. */
const TAMIL_NADU_GSTIN = '33AABCC1234D1ZI'
const KARNATAKA_GSTIN = '29AAAAA0000A1ZY'

/** Inside 2026-27 under the April-to-March rule the fixture generates. */
const DATE = '2026-04-15'

const directories: string[] = []
const services: CompanyService[] = []

interface Fixture {
  companies: CompanyService
  documents: DocumentsService
  profile: CompanyProfileService
  parties: PartiesService
  local: string
  interstate: string
}

/**
 * A company in Tamil Nadu with two customers: one at home and one in Karnataka.
 *
 * The chart is seeded by `companies.create`, which asks the regime for its components —
 * so the accounts an invoice posts to exist without this file naming a tax.
 */
async function fixture(options: { withProfile?: boolean } = {}): Promise<Fixture> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'coffer-documents-registry-'))
  const companyDirectory = await mkdtemp(join(tmpdir(), 'coffer-documents-books-'))
  directories.push(dataDirectory, companyDirectory)

  const companies = new CompanyService({
    dataDirectory,
    kdf: { passphrase: FAST, recovery: FAST },
  })
  services.push(companies)

  await companies.create({
    displayName: 'Acme Traders',
    directoryPath: companyDirectory,
    passphrase: PASSPHRASE,
  })

  const profile = new CompanyProfileService(companies)
  if (options.withProfile !== false) {
    await profile.save({
      legalName: 'Acme Traders Private Limited',
      countryCode: 'in',
      registrationNumber: TAMIL_NADU_GSTIN,
    })
  }

  const parties = new PartiesService(companies)
  /* Unregistered and local — below the threshold, which is ordinary, and still has a
   * state. The state is what decides the split, not the registration. */
  const local = (
    await parties.create({
      name: 'Bharat Steel',
      countryCode: 'in',
      isCustomer: true,
      jurisdictionCode: '33',
    })
  ).id
  const interstate = (
    await parties.create({
      name: 'Mysore Metals',
      countryCode: 'in',
      isCustomer: true,
      registrationNumber: KARNATAKA_GSTIN,
    })
  ).id

  return {
    companies,
    documents: new DocumentsService(companies),
    profile,
    parties,
    local,
    interstate,
  }
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.close().catch(() => undefined)
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
  }
})

/**
 * The refusal itself, not only its code.
 *
 * Where a rule lives in one layer only, `details` is what proves that layer answered —
 * and where it lives in two, it is the one thing that can tell them apart, because both
 * report the same code by design (CONVENTIONS §6).
 */
async function failureOf(
  run: () => Promise<unknown>,
): Promise<{ code: string; message: string; details: Record<string, unknown> }> {
  try {
    await run()
  } catch (error) {
    const thrown = error as { code?: unknown; message?: unknown; details?: unknown }
    return {
      code: typeof thrown.code === 'string' ? thrown.code : `unexpected: ${String(error)}`,
      message: typeof thrown.message === 'string' ? thrown.message : '',
      details: (thrown.details ?? {}) as Record<string, unknown>,
    }
  }
  throw new Error('Expected the action to fail, and it did not.')
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof CompanyError) return error.code
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : `unexpected: ${String(error)}`
  }
  return 'no error thrown'
}

const line = (over: Partial<DocumentLineInput> = {}): DocumentLineInput => ({
  description: 'Ball bearing 6203',
  quantity: '2.000',
  unitPrice: '500.00',
  ratePct: '18',
  ...over,
})

const draft = (over: Partial<CreateDocumentInput> = {}): CreateDocumentInput => ({
  kind: 'sales-invoice',
  date: DATE,
  partyId: 'set by the caller',
  lines: [line()],
  ...over,
})

/** Component codes and amounts, which is what makes intra and inter distinguishable. */
const componentsOf = (document: { lines: readonly { taxes: readonly unknown[] }[] }) =>
  (document.lines[0]?.taxes ?? []).map((tax) => tax as { code: string; amount: string })

describe('which company is open', () => {
  it('refuses every method when none is', async () => {
    const documents = new DocumentsService({ currentDatabase: () => null })

    expect(await codeOf(() => documents.list())).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => documents.get('d1'))).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => documents.create(draft()))).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => documents.delete('d1'))).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => documents.settlement('d1'))).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => documents.openForOffset('d1'))).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => documents.offset({ refundDocumentId: 'd1', offsets: [] }))).toBe(
      'NO_COMPANY_OPEN',
    )
  })
})

describe('what the tax depends on', () => {
  /*
   * The company's own state against the customer's, which is the entire question. Both
   * documents carry the same line at the same rate on the same day.
   */
  it('splits a supply inside the state into CGST and SGST', async () => {
    const { documents, local } = await fixture()

    const document = await documents.create(draft({ partyId: local }))

    expect(componentsOf(document).map((tax) => tax.code)).toEqual(['CGST', 'SGST'])
    expect(componentsOf(document).map((tax) => tax.amount)).toEqual(['90.00', '90.00'])
    expect(document.totals.totalTax).toBe('180.00')
  })

  it('charges IGST on a supply that leaves the state', async () => {
    const { documents, interstate } = await fixture()

    const document = await documents.create(draft({ partyId: interstate }))

    expect(componentsOf(document).map((tax) => tax.code)).toEqual(['IGST'])
    expect(componentsOf(document).map((tax) => tax.amount)).toEqual(['180.00'])
    expect(document.totals.totalTax).toBe('180.00')
  })

  /* The place of supply is recorded, not just used — it is what a return is filed on. */
  it('records where the regime decided the supply happened', async () => {
    const { documents, local, interstate } = await fixture()

    expect((await documents.create(draft({ partyId: local }))).placeOfSupplyJurisdiction).toBe('33')
    expect((await documents.create(draft({ partyId: interstate }))).placeOfSupplyJurisdiction).toBe(
      '29',
    )
  })

  /*
   * An override moves where the supply happened; it does not decide what that means. A
   * Tamil Nadu customer with the place of supply set to Karnataka is an inter-state
   * supply, and the regime is what says so — this service never assembles the answer.
   */
  it('takes a place of supply the caller states, and re-asks the regime about it', async () => {
    const { documents, local } = await fixture()

    const document = await documents.create(
      draft({ partyId: local, placeOfSupplyJurisdiction: '29' }),
    )

    expect(document.placeOfSupplyJurisdiction).toBe('29')
    expect(componentsOf(document).map((tax) => tax.code)).toEqual(['IGST'])
  })

  /*
   * EACH LINE GETS ITS OWN ANSWER. Three lines at three rates on one document, and the
   * regime returns a result per line — so the mapping back has to be by line and not by
   * position-of-the-first. A service that put the first line's components on all three
   * would total 54.00 here and look entirely plausible.
   */
  it('gives every line the tax computed for that line', async () => {
    const { documents, local } = await fixture()

    const document = await documents.create(
      draft({
        partyId: local,
        lines: [
          line({ quantity: '1.000', unitPrice: '100.00', ratePct: '18' }),
          line({ quantity: '1.000', unitPrice: '100.00', ratePct: '5' }),
          line({ quantity: '1.000', unitPrice: '100.00', ratePct: '0' }),
        ],
      }),
    )

    const amounts = document.lines.map((row) => row.taxes.map((tax) => tax.amount))
    expect(amounts).toEqual([['9.00', '9.00'], ['2.50', '2.50'], []])
    expect(document.totals.totalTax).toBe('23.00')
  })

  /* Nil-rated is a rate, not a missing one. It produces a line with no components. */
  it('taxes a line at zero when no rate is given', async () => {
    const { documents, local } = await fixture()

    const document = await documents.create(
      draft({ partyId: local, lines: [line({ ratePct: undefined })] }),
    )

    expect(componentsOf(document)).toEqual([])
    expect(document.totals.totalTax).toBe('0.00')
  })
})

describe('the amount a line comes to', () => {
  /* The renderer never computes money. The extension is this layer's arithmetic. */
  it('extends the line itself rather than taking the caller word for it', async () => {
    const { documents, local } = await fixture()

    const document = await documents.create(
      draft({
        partyId: local,
        lines: [line({ quantity: '3.000', unitPrice: '250.00', discount: '50.00' })],
      }),
    )

    expect(document.lines[0]?.taxableAmount).toBe('700.00')
    expect(document.totals.taxableValue).toBe('700.00')
  })

  /*
   * `lineAmount` is a defined rounding point, so a line sold by weight rounds to the
   * paisa. Before this service existed the repository compared against the unrounded
   * product and refused the document; measured, and fixed there.
   */
  it('rounds a line whose figures do not multiply out to whole paise', async () => {
    const { documents, local } = await fixture()

    const document = await documents.create(
      draft({ partyId: local, lines: [line({ quantity: '0.333', unitPrice: '10.01' })] }),
    )

    expect(document.lines[0]?.taxableAmount).toBe('3.33')
  })
})

describe('without a company profile', () => {
  /*
   * `computeTax` takes both sides of the supply. With no profile there is no supplier —
   * not even a country — so there is nothing to compute from, and a guess would put a
   * jurisdiction of this layer's choosing on every invoice in the books.
   */
  it('refuses to draft anything, with a sentence a user can act on', async () => {
    const { documents, local } = await fixture({ withProfile: false })

    expect(await codeOf(() => documents.create(draft({ partyId: local })))).toBe(
      'COMPANY_PROFILE_MISSING',
    )
  })

  it('still lists and reads, because neither needs a supplier', async () => {
    const { documents } = await fixture({ withProfile: false })

    expect(await documents.list()).toEqual([])
    expect(await documents.get('nothing')).toBeNull()
  })
})

describe('changing a draft', () => {
  /*
   * THE CASE THAT IS EASY TO GET WRONG. Not one line was edited, and every line's tax
   * changed — because the customer moved from Tamil Nadu to Karnataka. A service that
   * only re-taxed the lines it was sent would leave CGST+SGST on an inter-state invoice.
   */
  it('re-taxes every line when the party changes, with no line touched', async () => {
    const { documents, local, interstate } = await fixture()
    const document = await documents.create(draft({ partyId: local }))
    expect(componentsOf(document).map((tax) => tax.code)).toEqual(['CGST', 'SGST'])

    const moved = await documents.update({ id: document.id, partyId: interstate })

    expect(componentsOf(moved).map((tax) => tax.code)).toEqual(['IGST'])
    expect(moved.placeOfSupplyJurisdiction).toBe('29')
    expect(moved.totals.totalTax).toBe('180.00')
  })

  it('re-taxes when the place of supply changes on its own', async () => {
    const { documents, local } = await fixture()
    const document = await documents.create(draft({ partyId: local }))

    const moved = await documents.update({
      id: document.id,
      placeOfSupplyJurisdiction: '29',
    })

    expect(componentsOf(moved).map((tax) => tax.code)).toEqual(['IGST'])
  })

  it('taxes the lines it is given, against the party the document already has', async () => {
    const { documents, interstate } = await fixture()
    const document = await documents.create(draft({ partyId: interstate }))

    const changed = await documents.update({
      id: document.id,
      lines: [line({ quantity: '1.000', unitPrice: '100.00' })],
    })

    expect(changed.lines).toHaveLength(1)
    expect(changed.lines[0]?.taxableAmount).toBe('100.00')
    expect(componentsOf(changed).map((tax) => tax.code)).toEqual(['IGST'])
    expect(componentsOf(changed).map((tax) => tax.amount)).toEqual(['18.00'])
  })

  /*
   * And a change that cannot move the tax does not disturb it.
   *
   * THE COMPANY MOVES BETWEEN THE TWO CALLS, which is what makes this assertion mean
   * anything. Re-asking the regime after a narration edit would give the right answer for
   * a business in Karnataka and the wrong one for the invoice, which was raised in Tamil
   * Nadu — and without the profile moving, a service that re-asked on every edit would
   * produce identical figures and this test would pass against it.
   */
  it('leaves the tax alone when only the narration changes', async () => {
    const { documents, profile, local } = await fixture()
    const document = await documents.create(draft({ partyId: local }))
    expect(componentsOf(document).map((tax) => tax.code)).toEqual(['CGST', 'SGST'])

    await profile.save({
      legalName: 'Acme Traders Private Limited',
      countryCode: 'in',
      registrationNumber: KARNATAKA_GSTIN,
    })
    const narrated = await documents.update({ id: document.id, narration: 'Against PO 4471' })

    expect(narrated.narration).toBe('Against PO 4471')
    expect(componentsOf(narrated).map((tax) => tax.code)).toEqual(['CGST', 'SGST'])
    expect(narrated.lines).toHaveLength(1)
  })

  /* And when something DOES move the tax, the company's new state is what it moves to. */
  it('uses the company as it is now when a change does re-ask', async () => {
    const { documents, profile, local } = await fixture()
    const document = await documents.create(draft({ partyId: local }))

    await profile.save({
      legalName: 'Acme Traders Private Limited',
      countryCode: 'in',
      registrationNumber: KARNATAKA_GSTIN,
    })
    const changed = await documents.update({ id: document.id, lines: [line()] })

    expect(componentsOf(changed).map((tax) => tax.code)).toEqual(['IGST'])
  })

  /* A stated place of supply is a decision, and it survives an edit that never mentions
   * it. Falling back to the party's own state would silently undo it. */
  it('keeps a place of supply the caller stated when something else changes', async () => {
    const { documents, local } = await fixture()
    const document = await documents.create(
      draft({ partyId: local, placeOfSupplyJurisdiction: '29' }),
    )

    const changed = await documents.update({ id: document.id, lines: [line()] })

    expect(changed.placeOfSupplyJurisdiction).toBe('29')
    expect(componentsOf(changed).map((tax) => tax.code)).toEqual(['IGST'])
  })

  /*
   * And it is dropped when the party changes, because the customer it was decided for is
   * gone. Nothing records whether the stored place was stated or derived, so the choice
   * is between re-asking and keeping a place that belongs to somebody else's invoice.
   */
  it('drops a stated place of supply when the party moves', async () => {
    const { documents, local, interstate } = await fixture()
    const document = await documents.create(
      draft({ partyId: local, placeOfSupplyJurisdiction: '29' }),
    )

    const moved = await documents.update({ id: document.id, partyId: interstate })

    expect(moved.placeOfSupplyJurisdiction).toBe('29')
    expect(componentsOf(moved).map((tax) => tax.code)).toEqual(['IGST'])

    const home = await documents.update({ id: moved.id, partyId: local })
    expect(home.placeOfSupplyJurisdiction).toBe('33')
    expect(componentsOf(home).map((tax) => tax.code)).toEqual(['CGST', 'SGST'])
  })

  it('says so when the document is not there', async () => {
    const { documents, local } = await fixture()

    expect(await codeOf(() => documents.update({ id: 'nothing', partyId: local }))).toBe(
      'DOCUMENT_NOT_FOUND',
    )
  })
})

describe('issuing, through the service', () => {
  /**
   * The books need periods and a series before anything can be issued. Neither is the
   * service's business, and both are seeded here the way the app will.
   */
  async function ready(): Promise<Fixture> {
    const parts = await fixture()
    const connection = parts.companies.currentDatabase()!
    const db = createQueryBuilder(connection)
    /* `companies.create` already generated the years around today; this only covers the
     * fixed date the documents are dated to, when the wall clock has moved past it. */
    await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2026 }).catch(() => undefined)
    await createSeries(db, {
      kind: 'sales-invoice',
      label: 'Domestic',
      prefix: 'INV',
      separator: '/',
      includeFiscalYear: true,
      width: 4,
      resetOn: 'fiscal-year',
    })
    return parts
  }

  it('numbers the document and posts what it computed', async () => {
    const { documents, local } = await ready()
    const draftDocument = await documents.create(draft({ partyId: local }))

    const issued = await documents.issue({ id: draftDocument.id })

    expect(issued.number).toBe('INV/2026-27/0001')
    expect(issued.status).toBe('issued')
    expect(issued.entryId).not.toBeNull()
    expect(issued.totals.grandTotal).toBe('1180.00')
  })

  it('cancels one, keeping the number and reversing the entry', async () => {
    const { documents, local } = await ready()
    const issued = await documents.issue({
      id: (await documents.create(draft({ partyId: local }))).id,
    })

    const cancelled = await documents.cancel({ id: issued.id })

    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.number).toBe('INV/2026-27/0001')
  })

  it('deletes a draft, and refuses to delete what has been issued', async () => {
    const { documents, local } = await ready()
    const spare = await documents.create(draft({ partyId: local }))
    await documents.delete(spare.id)
    expect(await documents.get(spare.id)).toBeNull()

    const issued = await documents.issue({
      id: (await documents.create(draft({ partyId: local }))).id,
    })
    expect(await codeOf(() => documents.delete(issued.id))).toBe('DOCUMENT_NOT_DRAFT')
  })

  it('lists what it has drafted', async () => {
    const { documents, local, interstate } = await ready()
    await documents.create(draft({ partyId: local }))
    await documents.create(draft({ partyId: interstate }))

    expect(await documents.list()).toHaveLength(2)
    expect(await documents.list({ partyId: interstate })).toHaveLength(1)
  })
})

/*
 * WHAT HAS SETTLED A DOCUMENT, THROUGH THE SERVICE (0016).
 *
 * `settlement` and `offset` answer the same DTO through one mapper, and a mutation pass
 * is why these exist: emptying the `offsets` list and reporting `offset` as nought both
 * survived the whole suite. Everything below the service was covered by
 * db/repos/offsets.test.ts, and nothing had ever looked at what crossed the boundary.
 *
 * The figures are decimal strings and there is no `Decimal` anywhere in the answer, which
 * is §1.7 at the seam it applies to.
 */
describe('offsets, through the service', () => {
  /** Books that can issue an invoice AND a credit note, which needs two series. */
  async function ready(): Promise<Fixture> {
    const parts = await fixture()
    const db = createQueryBuilder(parts.companies.currentDatabase()!)
    await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2026 }).catch(() => undefined)
    for (const [kind, prefix] of [
      ['sales-invoice', 'INV'],
      ['credit-note', 'CRN'],
    ] as const) {
      await createSeries(db, {
        kind,
        label: 'Domestic',
        prefix,
        separator: '/',
        includeFiscalYear: true,
        width: 4,
        resetOn: 'fiscal-year',
      })
    }
    return parts
  }

  async function issuedPair(parts: Fixture) {
    const invoice = await parts.documents.issue({
      id: (await parts.documents.create(draft({ partyId: parts.local }))).id,
    })
    const note = await parts.documents.issue({
      id: (await parts.documents.create(draft({ partyId: parts.local, kind: 'credit-note' }))).id,
    })
    return { invoice, note }
  }

  it('is the whole document before anything settles it', async () => {
    const parts = await ready()
    const { invoice } = await issuedPair(parts)

    expect(await parts.documents.settlement(invoice.id)).toEqual({
      documentId: invoice.id,
      movement: '1180.00',
      allocated: '0.00',
      offset: '0.00',
      outstanding: '1180.00',
      receipts: [],
      offsets: [],
    })
  })

  it('hands back the offset and the document at the other end', async () => {
    const parts = await ready()
    const { invoice, note } = await issuedPair(parts)

    const saved = await parts.documents.offset({
      refundDocumentId: note.id,
      offsets: [{ chargeDocumentId: invoice.id, amount: '400.00' }],
    })

    /* The answer is the NOTE's settlement, because that is the panel that saved. */
    expect(saved.documentId).toBe(note.id)
    expect(saved.offset).toBe('400.00')
    expect(saved.outstanding).toBe('780.00')
    expect(saved.offsets).toEqual([
      {
        offsetId: expect.any(String),
        documentId: invoice.id,
        documentKind: 'sales-invoice',
        documentNumber: 'INV/2026-27/0001',
        documentDate: DATE,
        amount: '400.00',
      },
    ])

    /* And the same row read from the invoice, naming the note instead. */
    const onInvoice = await parts.documents.settlement(invoice.id)
    expect(onInvoice.offset).toBe('400.00')
    expect(onInvoice.outstanding).toBe('780.00')
    expect(onInvoice.offsets.map((row) => row.documentNumber)).toEqual(['CRN/2026-27/0001'])
  })

  it('clears the set when it is sent an empty list', async () => {
    const parts = await ready()
    const { invoice, note } = await issuedPair(parts)
    await parts.documents.offset({
      refundDocumentId: note.id,
      offsets: [{ chargeDocumentId: invoice.id, amount: '400.00' }],
    })

    const cleared = await parts.documents.offset({ refundDocumentId: note.id, offsets: [] })

    expect(cleared.offset).toBe('0.00')
    expect(cleared.offsets).toEqual([])
    expect((await parts.documents.settlement(invoice.id)).outstanding).toBe('1180.00')
  })

  it('offers the invoices a note may be set against, and refuses the reverse', async () => {
    const parts = await ready()
    const { invoice, note } = await issuedPair(parts)

    const open = await parts.documents.openForOffset(note.id)
    expect(open).toEqual([
      {
        id: invoice.id,
        kind: 'sales-invoice',
        number: 'INV/2026-27/0001',
        date: DATE,
        grandTotal: '1180.00',
        outstanding: '1180.00',
      },
    ])

    expect(await codeOf(() => parts.documents.openForOffset(invoice.id))).toBe(
      'OFFSET_KIND_MISMATCH',
    )
  })

  it('refuses a document these books do not have', async () => {
    const parts = await ready()
    expect(await codeOf(() => parts.documents.settlement('nobody'))).toBe('DOCUMENT_NOT_FOUND')
  })
})

// ---- The one fact about a supply the regime cannot work out -----------------

/**
 * A company in Tamil Nadu with a customer outside India, and a vendor at home.
 *
 * The overseas customer is what makes a supply an export, which is the REGIME's answer
 * (`placeOfSupply().isExport`) and not this file's — an export treatment is refused on
 * everything else, and the refusal is the only rule in this service with no floor under
 * it.
 */
async function tradingAbroad() {
  const base = await fixture()
  const overseas = (
    await base.parties.create({
      name: 'Gulf Bearings FZE',
      countryCode: 'ae',
      isCustomer: true,
    })
  ).id
  const vendor = (
    await base.parties.create({
      name: 'Coimbatore Forgings',
      countryCode: 'in',
      isVendor: true,
      jurisdictionCode: '33',
    })
  ).id
  return { ...base, overseas, vendor }
}

describe('an export, with tax paid and under an undertaking', () => {
  /*
   * THE SAME SUPPLY TWICE. Same goods, same customer, same day, same rate — the treatment
   * is the only difference, which is what a test comparing two answers needs.
   */
  it('charges integrated tax when the tax is paid on the export', async () => {
    const { documents, overseas } = await tradingAbroad()

    const document = await documents.create(
      draft({ partyId: overseas, exportTaxPayment: 'with-payment' }),
    )

    expect(componentsOf(document).map((tax) => [tax.code, tax.amount])).toEqual([
      ['IGST', '180.00'],
    ])
    expect(document.totals.totalTax).toBe('180.00')
    expect(document.exportTaxPayment).toBe('with-payment')
  })

  /*
   * THE RATE SURVIVES AND THE TAX DOES NOT. Before this column an LUT export could not be
   * represented at all: the only way to a nil figure was a rate of zero, which is a
   * NIL-RATED supply — inside the tax, with its input credit reversed rather than
   * refunded. The line below still says 18%.
   */
  it('charges nothing under an undertaking, and keeps the rate on the line', async () => {
    const { documents, overseas } = await tradingAbroad()

    const document = await documents.create(
      draft({ partyId: overseas, exportTaxPayment: 'without-payment' }),
    )

    expect(componentsOf(document).map((tax) => [tax.code, tax.amount])).toEqual([['IGST', '0.00']])
    expect(document.totals.totalTax).toBe('0.00')
    expect(document.lines[0]?.ratePct).toBe('18.000')
    expect(document.exportTaxPayment).toBe('without-payment')
  })

  /*
   * SWITCHING THE TREATMENT RE-ASKS THE REGIME, and it is the least obvious of the five
   * things that do: no line, party, date or place has changed, and the tax on every line
   * moves. Left out, an exporter who gave an undertaking after drafting would keep an
   * invoice carrying tax nobody ever charged.
   */
  it('re-taxes the whole document when the treatment changes on a draft', async () => {
    const { documents, overseas } = await tradingAbroad()

    const drafted = await documents.create(
      draft({ partyId: overseas, exportTaxPayment: 'with-payment' }),
    )
    expect(drafted.totals.totalTax).toBe('180.00')

    const changed = await documents.update({
      id: drafted.id,
      exportTaxPayment: 'without-payment',
    })

    expect(changed.totals.totalTax).toBe('0.00')
    expect(changed.lines[0]?.ratePct).toBe('18.000')
  })

  it('keeps the treatment when something else on the draft changes', async () => {
    const { documents, overseas } = await tradingAbroad()

    const drafted = await documents.create(
      draft({ partyId: overseas, exportTaxPayment: 'without-payment' }),
    )
    const edited = await documents.update({
      id: drafted.id,
      lines: [line({ unitPrice: '750.00' })],
    })

    expect(edited.exportTaxPayment).toBe('without-payment')
    expect(edited.totals.taxableValue).toBe('1500.00')
    expect(edited.totals.totalTax).toBe('0.00')
  })

  /*
   * REFUSED ON A DOMESTIC SUPPLY RATHER THAN CLEARED. A value dropped in silence is a
   * decision lost without anybody being told it was made — and it is the only thing this
   * service refuses that no trigger can, because which supplies leave the country is the
   * regime's answer and `db/` may not ask a regime.
   */
  it('refuses an export treatment on a supply that does not leave the country', async () => {
    const { documents, local, interstate } = await tradingAbroad()

    expect(
      await codeOf(() =>
        documents.create(draft({ partyId: local, exportTaxPayment: 'without-payment' })),
      ),
    ).toBe('EXPORT_TAX_PAYMENT_INVALID')
    expect(
      await codeOf(() =>
        documents.create(draft({ partyId: interstate, exportTaxPayment: 'with-payment' })),
      ),
    ).toBe('EXPORT_TAX_PAYMENT_INVALID')
  })

  /*
   * AND NOT THE OTHER DIRECTION. An export that says nothing is ordinary — a business that
   * has not been asked the question yet must still be able to raise the invoice — and the
   * RETURN is what says the flavour had to be inferred, rather than the editor blocking.
   */
  it('does not insist that an export say which it was', async () => {
    const { documents, overseas } = await tradingAbroad()

    const document = await documents.create(draft({ partyId: overseas }))

    expect(document.exportTaxPayment).toBeNull()
    expect(document.totals.totalTax).toBe('180.00')
  })

  it('refuses it on a document that moves to a domestic customer', async () => {
    const { documents, overseas, local } = await tradingAbroad()

    const drafted = await documents.create(
      draft({ partyId: overseas, exportTaxPayment: 'without-payment' }),
    )

    expect(await codeOf(() => documents.update({ id: drafted.id, partyId: local }))).toBe(
      'EXPORT_TAX_PAYMENT_INVALID',
    )
  })
})

describe('whether credit may be taken, on the line', () => {
  it('stores it on a purchase bill, line by line', async () => {
    const { documents, vendor } = await tradingAbroad()

    const bill = await documents.create(
      draft({
        kind: 'purchase-bill',
        partyId: vendor,
        lines: [
          line({ description: 'Laptop', itcEligibility: 'eligible' }),
          line({ description: 'Staff car', itcEligibility: 'ineligible-17-5' }),
        ],
      }),
    )

    expect(bill.lines.map((each) => [each.description, each.itcEligibility])).toEqual([
      ['Laptop', 'eligible'],
      ['Staff car', 'ineligible-17-5'],
    ])
  })

  /* Absent stays absent: a return resolves it to eligible and COUNTS the resolution, which
   * it cannot do if the repository has already decided on the user's behalf. */
  it('leaves a line that says nothing saying nothing', async () => {
    const { documents, vendor } = await tradingAbroad()

    const bill = await documents.create(draft({ kind: 'purchase-bill', partyId: vendor }))

    expect(bill.lines[0]?.itcEligibility).toBeNull()
  })

  /*
   * ASSERTED ON `details` AS WELL AS ON THE CODE. The database does not hold this rule at
   * all — 0021's header argues why: it needs the list of purchase-side kinds, which lives
   * in `@shared/documents` and which a migration cannot import — so the repository is the
   * only layer that speaks, and what it says is the useful half. A user who pasted an
   * eligibility onto every line is told it is on every line rather than sent back to line
   * one six times.
   */
  it('refuses it on a sale, which gives no credit to reclaim, and says which lines', async () => {
    const { documents, local } = await tradingAbroad()

    const failure = await failureOf(() =>
      documents.create(
        draft({
          partyId: local,
          lines: [
            line({ description: 'A thing' }),
            line({ description: 'Another', itcEligibility: 'ineligible-other' }),
            line({ description: 'A third', itcEligibility: 'eligible' }),
          ],
        }),
      ),
    )

    expect(failure.code).toBe('ITC_ELIGIBILITY_NOT_INWARD')
    expect(failure.details).toMatchObject({ lineNumber: 2, lines: 2 })
    expect(failure.message).toContain('2 line(s)')
  })

  /* Carried through an edit that re-asks the regime. `update` replaces the whole set, so a
   * mapper that dropped the field would silently un-block every line on a party change. */
  it('survives an edit that re-taxes the document', async () => {
    const { documents, vendor } = await tradingAbroad()

    const bill = await documents.create(
      draft({
        kind: 'purchase-bill',
        partyId: vendor,
        lines: [line({ itcEligibility: 'ineligible-17-5' })],
      }),
    )
    const edited = await documents.update({ id: bill.id, date: '2026-04-20' })

    expect(edited.lines[0]?.itcEligibility).toBe('ineligible-17-5')
  })
})

describe('whether the buyer discharges the tax', () => {
  it('records it, and leaves it off by default', async () => {
    const { documents, vendor } = await tradingAbroad()

    const ordinary = await documents.create(draft({ kind: 'purchase-bill', partyId: vendor }))
    const reverse = await documents.create(
      draft({ kind: 'purchase-bill', partyId: vendor, isReverseCharge: true }),
    )

    expect(ordinary.isReverseCharge).toBe(false)
    expect(reverse.isReverseCharge).toBe(true)
  })

  /*
   * IT DOES NOT MOVE THE TAX ON THE DOCUMENT. What the supply attracts is unchanged; who
   * owes it is a posting question, and the entry is where the two legs appear. A service
   * that re-asked the regime on this flag would be answering a question the regime was
   * never asked.
   */
  it('changes nothing about what the document says the tax is', async () => {
    const { documents, vendor } = await tradingAbroad()

    const ordinary = await documents.create(draft({ kind: 'purchase-bill', partyId: vendor }))
    const reverse = await documents.create(
      draft({ kind: 'purchase-bill', partyId: vendor, isReverseCharge: true }),
    )

    expect(reverse.totals.totalTax).toBe(ordinary.totals.totalTax)
    expect(componentsOf(reverse)).toEqual(componentsOf(ordinary))
  })
})

/*
 * ===========================================================================
 * THE FIELD REACHES THE ENTRY, NOT ONLY THE ROW
 * ===========================================================================
 *
 * Every test above reads what was STORED. This one reads what was POSTED, and it exists
 * because a mutation showed the difference: `toDomainLine` mapping `itcEligibility` to
 * null unconditionally left every assertion above passing, because the DTO comes off the
 * table and the domain shape is built separately. The column, the DTO and the posting rule
 * were each tested and the JOIN between the last two was not.
 */
describe('a blocked line, from the screen to the journal entry', () => {
  async function readyToBuy(): Promise<Fixture & { vendor: string }> {
    const parts = await tradingAbroad()
    const connection = parts.companies.currentDatabase()!
    const db = createQueryBuilder(connection)
    await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2026 }).catch(() => undefined)
    await createSeries(db, {
      kind: 'purchase-bill',
      label: 'Purchases',
      prefix: 'BILL',
      separator: '/',
      includeFiscalYear: true,
      width: 4,
      resetOn: 'fiscal-year',
    })
    return parts
  }

  /** The signed movement on one account code, read out of the posted entry. */
  async function postedOn(parts: Fixture, entryId: string, code: string): Promise<string> {
    const db = createQueryBuilder(parts.companies.currentDatabase()!)
    const entry = await getEntry(db, entryId)
    expect(entry, 'the document said it posted and the entry is not there').not.toBeNull()
    return entry!.lines
      .filter((line) => line.accountCode === code)
      .reduce((running, line) => running.plus(D(line.debit)).minus(D(line.credit)), D('0'))
      .toString()
  }

  it('costs a blocked line’s tax into the expense and claims the eligible one', async () => {
    const parts = await readyToBuy()
    const bill = await parts.documents.create(
      draft({
        kind: 'purchase-bill',
        partyId: parts.vendor,
        lines: [
          line({ description: 'Laptop', itcEligibility: 'eligible' }),
          line({ description: 'Staff car', itcEligibility: 'ineligible-17-5' }),
        ],
      }),
    )
    const issued = await parts.documents.issue({ id: bill.id })
    expect(issued.entryId).not.toBeNull()

    /* Two lines of 1,000 at 18% intra-state: 90 of CGST each. One is reclaimable and one
     * is not, so 90 reaches the input tax asset and 90 is carried in Purchases beside the
     * goods — 1,000 + 1,000 + 90 + 90. */
    expect(await postedOn(parts, issued.entryId!, '1510')).toBe('90')
    expect(await postedOn(parts, issued.entryId!, '1520')).toBe('90')
    expect(await postedOn(parts, issued.entryId!, '5100')).toBe('2180')
    expect(await postedOn(parts, issued.entryId!, '2100')).toBe('-2360')
  })

  it('claims both when neither line says anything, which is what the books already assert', async () => {
    const parts = await readyToBuy()
    const bill = await parts.documents.create(
      draft({
        kind: 'purchase-bill',
        partyId: parts.vendor,
        lines: [line({ description: 'Laptop' }), line({ description: 'Bearings' })],
      }),
    )
    const issued = await parts.documents.issue({ id: bill.id })

    expect(await postedOn(parts, issued.entryId!, '1510')).toBe('180')
    expect(await postedOn(parts, issued.entryId!, '5100')).toBe('2000')
  })

  /* And the other half of 0020, posted rather than stored: the supplier is credited with
   * the net, the tax is owed AND claimed, and the two tax legs net to nothing. */
  it('owes and claims the tax on a reverse-charge bill, and pays the supplier the net', async () => {
    const parts = await readyToBuy()
    const bill = await parts.documents.create(
      draft({ kind: 'purchase-bill', partyId: parts.vendor, isReverseCharge: true }),
    )
    const issued = await parts.documents.issue({ id: bill.id })

    expect(await postedOn(parts, issued.entryId!, '1510')).toBe('90')
    expect(await postedOn(parts, issued.entryId!, '2210')).toBe('-90')
    expect(await postedOn(parts, issued.entryId!, '5100')).toBe('1000')
    expect(await postedOn(parts, issued.entryId!, '2100')).toBe('-1000')
  })
})
