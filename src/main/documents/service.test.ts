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
