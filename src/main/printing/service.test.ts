/*
 * The printing service, against a real company with a real issued invoice.
 *
 * THE CHROMIUM IS THE ONLY THING FAKED. `PagePrinter` is the seam (see ./page-printer.ts),
 * so the fake here records the HTML it was handed and everything above it — which document,
 * which copies, what goes on them, what is refused — runs for real: real vault, real
 * SQLCipher, real regime, the real mapper and the real template.
 *
 * What that buys is that the assertions are about the page a user would get. A test that
 * stubbed the template as well would assert that this module calls the functions it calls.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { aprilToMarch } from '@main/domain/time'
import type { PrintDocumentInput, PrintInclude } from '@shared/dto'

import { CompanyProfileService } from '../company-profile/service'
import { CompanyService } from '../companies/service'
import { createQueryBuilder } from '../db/kysely'
import { createSeries } from '../db/repos/numbering'
import { generateFiscalYear } from '../db/repos/periods'
import { DocumentsService } from '../documents/service'
import { PartiesService } from '../parties/service'
import { type Argon2Params, MIN_MEMORY_COST } from '../security'
import type { PagePrinter } from './page-printer'
import { PrintingService, fileNameFor, requireCopies } from './service'

const FAST: Argon2Params = {
  algorithm: 'argon2id',
  memoryCost: MIN_MEMORY_COST,
  timeCost: 1,
  parallelism: 1,
}

const PASSPHRASE = 'a quiet ledger keeps its own counsel'
const TAMIL_NADU_GSTIN = '33AABCC1234D1ZI'
const DATE = '2026-04-15'

const EVERYTHING: PrintInclude = { amountInWords: true, hsnSummary: true }

const directories: string[] = []
const services: CompanyService[] = []

/** A printer that renders nothing and remembers everything it was asked to render. */
interface FakePrinter extends PagePrinter {
  readonly seen: string[]
  savedAs: string | null
}

function fakePrinter(over: Partial<PagePrinter> = {}): FakePrinter {
  const seen: string[] = []
  const printer: FakePrinter = {
    seen,
    savedAs: null,
    preview: vi.fn(async (html: string) => {
      seen.push(html)
      return { imageDataUri: 'data:image/png;base64,iVBORw0KGgo=', widthPx: 794, heightPx: 1123 }
    }),
    savePdf: vi.fn(async (html: string, fileName: string) => {
      seen.push(html)
      printer.savedAs = fileName
      return `/tmp/${fileName}`
    }),
    print: vi.fn(async (html: string) => {
      seen.push(html)
    }),
    headingFont: vi.fn(async () => null),
    ...over,
  }
  return printer
}

interface Fixture {
  companies: CompanyService
  documents: DocumentsService
  printing: PrintingService
  printer: FakePrinter
  partyId: string
}

/** A company in Tamil Nadu, one customer, periods and a series — enough to issue. */
async function fixture(options: { printer?: FakePrinter } = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'coffer-printing-registry-'))
  const companyDirectory = await mkdtemp(join(tmpdir(), 'coffer-printing-books-'))
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

  await new CompanyProfileService(companies).save({
    legalName: 'Acme Traders Private Limited',
    countryCode: 'in',
    registrationNumber: TAMIL_NADU_GSTIN,
  })

  const parties = new PartiesService(companies)
  const party = await parties.create({
    name: 'Bharat Steel',
    countryCode: 'in',
    isCustomer: true,
    jurisdictionCode: '33',
  })

  const db = createQueryBuilder(companies.currentDatabase()!)
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

  const printer = options.printer ?? fakePrinter()
  return {
    companies,
    documents: new DocumentsService(companies),
    printing: new PrintingService(companies, printer),
    printer,
    partyId: party.id,
  } satisfies Fixture
}

/** An issued sales invoice with two lines at different rates, so the fold has work to do. */
async function issuedInvoice(parts: Fixture): Promise<string> {
  const draft = await parts.documents.create({
    kind: 'sales-invoice',
    partyId: parts.partyId,
    date: DATE,
    lines: [
      { description: 'Ball bearing 6203', quantity: '2.000', unitPrice: '500.00', ratePct: '18' },
      { description: 'Grease cartridge', quantity: '1.000', unitPrice: '240.00', ratePct: '12' },
    ],
  })
  return (await parts.documents.issue({ id: draft.id })).id
}

afterEach(async () => {
  for (const service of services.splice(0)) await service.close().catch(() => undefined)
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
  }
})

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : `unexpected: ${String(error)}`
  }
  return 'no error thrown'
}

const request = (id: string, over: Partial<PrintDocumentInput> = {}): PrintDocumentInput => ({
  id,
  copies: ['original'],
  include: EVERYTHING,
  ...over,
})

describe('the page it builds', () => {
  it('renders the invoice a user would recognise', async () => {
    const parts = await fixture()
    const id = await issuedInvoice(parts)

    const preview = await parts.printing.renderPrint(request(id))

    expect(preview.imageDataUri).toMatch(/^data:image\/png;base64,/)
    expect(preview.copyCount).toBe(1)

    const page = parts.printer.seen[0] ?? ''
    expect(page).toContain('INV/2026-27/0001')
    expect(page).toContain('Acme Traders Private Limited')
    expect(page).toContain('Bharat Steel')
    expect(page).toContain('Ball bearing 6203')
    expect(page).toContain('ORIGINAL FOR RECIPIENT')
  })

  /*
   * ONE DOCUMENT, NOT THREE. Three would be three print jobs and three files to save.
   * This is the assertion that holds the decision — see `renderInvoiceRun`.
   */
  it('puts all three copies in one document', async () => {
    const parts = await fixture()
    const id = await issuedInvoice(parts)

    const preview = await parts.printing.renderPrint(
      request(id, { copies: ['original', 'duplicate', 'triplicate'] }),
    )

    expect(preview.copyCount).toBe(3)
    expect(parts.printer.seen).toHaveLength(1)
    const page = parts.printer.seen[0] ?? ''
    expect(page.match(/<!doctype html>/gi)).toHaveLength(1)
    expect(page).toContain('DUPLICATE FOR TRANSPORTER')
    expect(page).toContain('TRIPLICATE FOR SUPPLIER')
  })

  it('leaves off the blocks the user declined', async () => {
    const parts = await fixture()
    const id = await issuedInvoice(parts)

    await parts.printing.renderPrint(
      request(id, { include: { amountInWords: false, hsnSummary: false } }),
    )

    const page = parts.printer.seen[0] ?? ''
    expect(page).not.toContain('Amount in words')
    /* Still an invoice: the figures are not optional. */
    expect(page).toContain('Ball bearing 6203')
    expect(page).toContain('Grand total')
  })

  it('asks for the heading font once, however many times it prints', async () => {
    const parts = await fixture()
    const id = await issuedInvoice(parts)

    await parts.printing.renderPrint(request(id))
    await parts.printing.renderPrint(request(id))
    await parts.printing.print(request(id))

    expect(parts.printer.headingFont).toHaveBeenCalledTimes(1)
  })
})

describe('saving and printing', () => {
  it('names the file after the document number', async () => {
    const parts = await fixture()
    const id = await issuedInvoice(parts)

    const saved = await parts.printing.savePdf(request(id))

    expect(parts.printer.savedAs).toBe('INV-2026-27-0001.pdf')
    expect(saved.path).toBe('/tmp/INV-2026-27-0001.pdf')
  })

  /* A user who closed the save dialog has not hit an error, and nothing was written. */
  it('reports a cancelled save as a cancellation rather than a failure', async () => {
    const printer = fakePrinter({ savePdf: vi.fn(async () => null) })
    const parts = await fixture({ printer })
    const id = await issuedInvoice(parts)

    await expect(parts.printing.savePdf(request(id))).resolves.toEqual({ path: null })
  })

  it('hands the same document to the printer that it previewed', async () => {
    const parts = await fixture()
    const id = await issuedInvoice(parts)

    await parts.printing.renderPrint(request(id))
    await parts.printing.print(request(id))

    expect(parts.printer.seen[1]).toBe(parts.printer.seen[0])
  })
})

describe('what it refuses', () => {
  /*
   * THE REFUSAL THAT MATTERS MOST. A draft has no number, and a page that looks like an
   * invoice and carries no number cannot be told from a real one once it is on paper.
   */
  it('refuses a draft, and renders nothing at all', async () => {
    const parts = await fixture()
    const draft = await parts.documents.create({
      kind: 'sales-invoice',
      partyId: parts.partyId,
      date: DATE,
      lines: [
        { description: 'Ball bearing 6203', quantity: '1.000', unitPrice: '500.00', ratePct: '18' },
      ],
    })

    expect(await codeOf(() => parts.printing.renderPrint(request(draft.id)))).toBe(
      'DOCUMENT_NOT_ISSUED',
    )
    expect(parts.printer.seen).toEqual([])
  })

  it('refuses a print of no copies rather than guessing at the original', async () => {
    const parts = await fixture()
    const id = await issuedInvoice(parts)

    expect(await codeOf(() => parts.printing.renderPrint(request(id, { copies: [] })))).toBe(
      'NO_COPIES_REQUESTED',
    )
    expect(parts.printer.seen).toEqual([])
  })

  it('refuses a document that is not in these books', async () => {
    const parts = await fixture()

    expect(await codeOf(() => parts.printing.renderPrint(request('no-such-document')))).toBe(
      'DOCUMENT_NOT_FOUND',
    )
  })

  /*
   * NOT TESTED HERE: a company with no profile. `services/pdf` refuses that with
   * COMPANY_PROFILE_MISSING and its own tests hold it, but this service cannot reach the
   * state — a document cannot be created without a profile, because computing its tax
   * needs a supplier. The refusal stays as the mapper's floor rather than being asserted
   * against a company this fixture is unable to build.
   */

  it('refuses when no company is open', async () => {
    const parts = await fixture()
    const id = await issuedInvoice(parts)
    await parts.companies.close()

    expect(await codeOf(() => parts.printing.renderPrint(request(id)))).toBe('NO_COMPANY_OPEN')
  })
})

describe('the copy list', () => {
  /*
   * ORDER IS NOT THE CALLER'S TO CHOOSE. The three copies are a sequence in the rule that
   * names them, and a run that printed the triplicate first would be collated wrong by the
   * person at the printer, who reads the markings and not the order they arrived in.
   */
  it('puts the copies back into the rule order', () => {
    expect(requireCopies(['triplicate', 'original'])).toEqual(['original', 'triplicate'])
    expect(requireCopies(['duplicate', 'triplicate', 'original'])).toEqual([
      'original',
      'duplicate',
      'triplicate',
    ])
  })

  it('folds a copy asked for twice into one', () => {
    expect(requireCopies(['original', 'original'])).toEqual(['original'])
  })

  it('refuses an empty list', () => {
    expect(() => requireCopies([])).toThrow(/at least one copy/)
  })
})

describe('the file name', () => {
  it('uses the document number, made safe for a filesystem', () => {
    expect(fileNameFor('INV/2026-27/0001', 'sales-invoice')).toBe('INV-2026-27-0001.pdf')
    expect(fileNameFor('SALES\\2026 #1', 'sales-invoice')).toBe('SALES-2026-1.pdf')
  })

  it('falls back to the kind when a document somehow has no number', () => {
    expect(fileNameFor(null, 'sales-invoice')).toBe('sales-invoice.pdf')
  })

  it('never produces a name that is only an extension', () => {
    expect(fileNameFor('///', 'sales-invoice')).toBe('document.pdf')
  })
})
