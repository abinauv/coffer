/*
 * The receipts service, against a real company created by the real company service.
 *
 * THE SUBJECT IS WHAT THIS LAYER ADDS, and it is deliberately little: the repository is
 * tested against a real database already, so what is asserted here is the seam. Which
 * company is open. What crosses as a DTO rather than as a `Decimal`. And the two reads
 * that exist only for a screen — `settlement` and `open` — which have no equivalent in
 * the repository's own tests because nothing below this layer needed them.
 *
 * `open` IS THE ONE TO READ. It answers "which of this party's documents still have
 * something on them", and every subtlety in it is about a screen: oldest first, because
 * money without instructions settles the oldest invoice; and `exceptReceiptId`, because
 * an editor opening an existing receipt has to see the invoices that receipt is already
 * settling, with that money back on them.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { CreateReceiptInput } from '@shared/dto'

import { CompanyService } from '../companies/service'
import { CompanyError } from '../companies/errors'
import { CompanyProfileService } from '../company-profile/service'
import { DocumentsService } from '../documents/service'
import { PartiesService } from '../parties/service'
import { type Argon2Params, MIN_MEMORY_COST } from '../security'
import { ReceiptsService } from './service'

const FAST: Argon2Params = {
  algorithm: 'argon2id',
  memoryCost: MIN_MEMORY_COST,
  timeCost: 1,
  parallelism: 1,
}

const PASSPHRASE = 'a quiet ledger keeps its own counsel'
const TAMIL_NADU_GSTIN = '33AABCC1234D1ZI'

/** Inside 2026-27 under the April-to-March rule the company is created with. */
const DATE = '2026-04-15'
const PAID = '2026-04-20'

const directories: string[] = []
const services: CompanyService[] = []

interface Fixture {
  companies: CompanyService
  receipts: ReceiptsService
  documents: DocumentsService
  customer: string
  vendor: string
  bank: string
}

async function fixture(): Promise<Fixture> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'coffer-receipts-registry-'))
  const companyDirectory = await mkdtemp(join(tmpdir(), 'coffer-receipts-books-'))
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
  const customer = (
    await parties.create({
      name: 'Bharat Steel',
      countryCode: 'in',
      isCustomer: true,
      jurisdictionCode: '33',
    })
  ).id
  const vendor = (
    await parties.create({
      name: 'Coastal Freight',
      countryCode: 'in',
      isVendor: true,
      jurisdictionCode: '33',
    })
  ).id

  /* The bank account the shipped chart gives every company. Named by code rather than by
   * role, because the rule under test is that the receipt takes the account it was GIVEN
   * — see the posting rule's header on why a role would be the wrong answer. */
  const handle = companies.currentDatabase()
  if (handle === null) throw new Error('the fixture failed to open its company')
  const { createQueryBuilder } = await import('../db/kysely')
  const db = createQueryBuilder(handle)
  const bank = (
    await db
      .selectFrom('accounts')
      .select('id')
      .where('code', '=', '1210')
      .executeTakeFirstOrThrow()
  ).id

  return {
    companies,
    receipts: new ReceiptsService(companies),
    documents: new DocumentsService(companies),
    customer,
    vendor,
    bank,
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

/** An issued invoice for 1,180.00. */
async function invoice(fx: Fixture, date = DATE) {
  const document = await fx.documents.create({
    kind: 'sales-invoice',
    date,
    partyId: fx.customer,
    lines: [
      { description: 'Ball bearing 6203', quantity: '2.000', unitPrice: '500.00', ratePct: '18' },
    ],
  })
  return fx.documents.issue({ id: document.id })
}

const money = (fx: Fixture, over: Partial<CreateReceiptInput> = {}): CreateReceiptInput => ({
  kind: 'receipt',
  date: PAID,
  partyId: fx.customer,
  amount: '1180.00',
  accountId: fx.bank,
  ...over,
})

describe('which company is open', () => {
  it('refuses every method when none is', async () => {
    const receipts = new ReceiptsService({ currentDatabase: () => null })

    expect(await codeOf(() => receipts.list())).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => receipts.get('r1'))).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => receipts.cancel({ id: 'r1' }))).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => receipts.open({ partyId: 'p1', kind: 'receipt' }))).toBe(
      'NO_COMPANY_OPEN',
    )
  })
})

describe('recording money through the service', () => {
  /*
   * A COMPANY THE APP MADE, with no test creating a numbering series first. That is the
   * whole point of the assertion: until 0012-1 nothing seeded one, so this call would
   * have failed with `SERIES_NOT_CONFIGURED` — and every repository test passed anyway,
   * because each of them makes its own series.
   */
  it('numbers a receipt in a company nobody configured', async () => {
    const fx = await fixture()
    const receipt = await fx.receipts.create(money(fx))

    expect(receipt.number).toBe('RCT/2026-27/0001')
    expect(receipt.status).toBe('posted')
  })

  it('hands back decimal strings, never a Decimal', async () => {
    const fx = await fixture()
    const receipt = await fx.receipts.create(money(fx))

    /* §1.7: the renderer never computes money, so every figure crosses already added up
     * and already rendered. A `Decimal` reaching a screen would be an object it could do
     * arithmetic with. */
    expect(receipt.amount).toBe('1180.00')
    expect(receipt.allocated).toBe('0.00')
    expect(receipt.unallocated).toBe('1180.00')
  })

  it('lists what it recorded', async () => {
    const fx = await fixture()
    await fx.receipts.create(money(fx))
    await fx.receipts.create(money(fx, { kind: 'payment', partyId: fx.vendor, amount: '400.00' }))

    expect((await fx.receipts.list()).map((row) => row.kind).sort()).toEqual(['payment', 'receipt'])
    expect(await fx.receipts.list({ kind: 'payment' })).toHaveLength(1)
  })

  it('answers null for a receipt that is not there', async () => {
    const fx = await fixture()
    expect(await fx.receipts.get('nobody')).toBeNull()
  })
})

/*
 * `settlement` IS ON THE DOCUMENTS SERVICE SINCE 0016 and these tests did not follow it,
 * which is deliberate. It answers about a document settled BY MONEY, and this file holds
 * the only fixture that can make money — a company with a bank account, a numbering
 * series and a receipts service beside a documents one. The offsets half of the same
 * method is tested in db/repos/offsets.test.ts, where the fixture can make two documents.
 */
describe('what a document has against it', () => {
  it('is the whole invoice before anything is paid', async () => {
    const fx = await fixture()
    const document = await invoice(fx)

    expect(await fx.documents.settlement(document.id)).toEqual({
      documentId: document.id,
      movement: '1180.00',
      allocated: '0.00',
      offset: '0.00',
      outstanding: '1180.00',
      receipts: [],
      offsets: [],
    })
  })

  it('names the receipts that settled it, with what each one put on it', async () => {
    const fx = await fixture()
    const document = await invoice(fx)
    const receipt = await fx.receipts.create(
      money(fx, {
        amount: '500.00',
        allocations: [{ documentId: document.id, amount: '500.00' }],
      }),
    )

    const settlement = await fx.documents.settlement(document.id)
    expect(settlement.allocated).toBe('500.00')
    expect(settlement.outstanding).toBe('680.00')
    expect(settlement.receipts).toEqual([
      { receiptId: receipt.id, number: 'RCT/2026-27/0001', date: PAID, amount: '500.00' },
    ])
  })

  /*
   * A document that is not there and a document with nothing outstanding are different
   * facts. Answering zeros for the first would show a screen a fully-paid invoice that
   * does not exist.
   */
  it('refuses a document these books do not have rather than answering zeros', async () => {
    const fx = await fixture()
    expect(await codeOf(() => fx.documents.settlement('nobody'))).toBe('DOCUMENT_NOT_FOUND')
  })

  it('comes to nothing once the invoice is cancelled, with nothing written to make it', async () => {
    const fx = await fixture()
    const document = await invoice(fx)
    await fx.documents.cancel({ id: document.id })

    expect(await fx.documents.settlement(document.id)).toMatchObject({
      movement: '0.00',
      outstanding: '0.00',
    })
  })
})

describe('what a party still has open', () => {
  it('lists the invoices with something left on them', async () => {
    const fx = await fixture()
    const first = await invoice(fx)
    const second = await invoice(fx, '2026-04-16')

    const open = await fx.receipts.open({ partyId: fx.customer, kind: 'receipt' })
    expect(open.map((row) => row.id)).toEqual([first.id, second.id])
    expect(open[0]).toMatchObject({ number: first.number, outstanding: '1180.00' })
  })

  /* Oldest first, and it is not cosmetic: money arriving without instructions settles
   * the oldest invoice, and a list in the other order invites the opposite. */
  it('puts the oldest first, which is the order money is applied in', async () => {
    const fx = await fixture()
    const newer = await invoice(fx, '2026-04-20')
    const older = await invoice(fx, '2026-04-02')

    const open = await fx.receipts.open({ partyId: fx.customer, kind: 'receipt' })
    expect(open.map((row) => row.date)).toEqual(['2026-04-02', '2026-04-20'])
    expect(open[0]?.id).toBe(older.id)
    expect(open[1]?.id).toBe(newer.id)
  })

  it('drops an invoice once nothing is left on it', async () => {
    const fx = await fixture()
    const document = await invoice(fx)
    await fx.receipts.create(
      money(fx, { allocations: [{ documentId: document.id, amount: '1180.00' }] }),
    )

    expect(await fx.receipts.open({ partyId: fx.customer, kind: 'receipt' })).toEqual([])
  })

  it('shows what is left when an invoice is part paid', async () => {
    const fx = await fixture()
    const document = await invoice(fx)
    await fx.receipts.create(
      money(fx, { amount: '180.00', allocations: [{ documentId: document.id, amount: '180.00' }] }),
    )

    const open = await fx.receipts.open({ partyId: fx.customer, kind: 'receipt' })
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ grandTotal: '1180.00', outstanding: '1000.00' })
  })

  /*
   * THE ARGUMENT THAT IS EASY TO FORGET. An editor opening a receipt that already settles
   * an invoice IN FULL must see that invoice with the money back on it — otherwise the
   * list it offers does not contain the line the screen is displaying, and the user
   * cannot reduce an allocation they made.
   */
  it('puts a receipt own allocations back when that receipt is the one being edited', async () => {
    const fx = await fixture()
    const document = await invoice(fx)
    const receipt = await fx.receipts.create(
      money(fx, { allocations: [{ documentId: document.id, amount: '1180.00' }] }),
    )

    expect(await fx.receipts.open({ partyId: fx.customer, kind: 'receipt' })).toEqual([])

    const editing = await fx.receipts.open({
      partyId: fx.customer,
      kind: 'receipt',
      exceptReceiptId: receipt.id,
    })
    expect(editing).toHaveLength(1)
    expect(editing[0]).toMatchObject({ id: document.id, outstanding: '1180.00' })
  })

  it('leaves a draft out, because a draft has posted nothing', async () => {
    const fx = await fixture()
    await fx.documents.create({
      kind: 'sales-invoice',
      date: DATE,
      partyId: fx.customer,
      lines: [{ description: 'Not issued', quantity: '1.000', unitPrice: '100.00', ratePct: '18' }],
    })

    expect(await fx.receipts.open({ partyId: fx.customer, kind: 'receipt' })).toEqual([])
  })

  it('leaves a cancelled invoice out, because the reversal nets it to nothing', async () => {
    const fx = await fixture()
    const document = await invoice(fx)
    await fx.documents.cancel({ id: document.id })

    expect(await fx.receipts.open({ partyId: fx.customer, kind: 'receipt' })).toEqual([])
  })

  /* A payment settles purchases. The customer's sales invoices are not its business, and
   * offering them would be offering to settle the wrong side of the trade. */
  it('offers a payment nothing on the sales side', async () => {
    const fx = await fixture()
    await invoice(fx)

    expect(await fx.receipts.open({ partyId: fx.customer, kind: 'payment' })).toEqual([])
  })

  it('refuses a kind this build does not know', async () => {
    const fx = await fixture()
    await expect(fx.receipts.open({ partyId: fx.customer, kind: 'advance' })).rejects.toThrow(
      /newer Coffer/,
    )
  })
})
