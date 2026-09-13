/*
 * The aged report, against a real encrypted database.
 *
 * THE ONE ASSERTION THE FILE EXISTS FOR is that the foot of the report equals the control
 * account on the balance sheet at the same date. Every other test here is a way for that
 * to be false: an unallocated receipt left off, an allocation counted at one end and not
 * the other, an opening balance nobody attributed, a document cancelled after the date.
 * `ties` is asserted alongside a figure every time, because a report that ties at nought
 * ties.
 *
 * AND THE SECOND IS THAT "AS AT" MEANS THE LEDGER. The tests that matter most run the
 * same books through the report twice at two dates and watch the answer change — a report
 * that read today's rows and printed last month's heading would give the same number both
 * times, and every one of these fixtures would pass against it if only one date were ever
 * asked for.
 *
 * The dates are all inside a fiscal year fixed by a clock rather than by the real one:
 * `setUpBooks` generates the year it is opened in, and a suite whose fixtures depend on
 * when it is run is a suite that starts failing on the first of an April.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { controlRoleFor } from '@main/domain/documents'
import { RECEIPT_KINDS, receiptTreatmentOf, settles } from '@main/domain/receipts'
import { AGE_BUCKETS } from '@main/domain/reports'
import { aprilToMarch, fixedClock } from '@main/domain/time'
import { postingKindOn, TRADE_SIDES } from '@shared/documents'
import type {
  AgedReport,
  AgedPartyRow,
  CreateReceiptInput,
  CreateTaxedDocumentInput,
  TaxedLineInput,
} from '@shared/dto'

import { DATABASE_KEY_BYTES, closeDatabase, openDatabase, type SqliteDatabase } from '../connection'
import { createQueryBuilder, type CofferDb } from '../kysely'
import { runMigrations } from '../migrate'
import { MIGRATIONS } from '../migrations'
import { clearAccountRole, setAccountRole } from './accounts'
import { agedReport } from './ageing'
import { accountBalance } from './balances'
import { setUpBooks } from './bootstrap'
import { createDocument } from './documents'
import { isRepoError, type RepoErrorCode } from './errors'
import { cancelDocument, issueDocument } from './issuing'
import { postManualEntry } from './journal'
import { postOpeningBalances } from './opening-balances'
import { createParty } from './parties'
import { setOffsets } from './offsets'
import { createReceipt, cancelReceipt } from './receipts'
import { taxAccountsFor } from './tax-accounts'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x5a)
const NOW = '2026-04-20T09:00:00.000Z'
const LATER = '2026-07-02T09:00:00.000Z'

/** Mid-year, so `setUpBooks` lays down 2026-27 and 2027-28 whenever this is run. */
const CLOCK = fixedClock('2026-06-15T00:00:00.000Z')

/** The day every report below is drawn as at, unless it is testing what the date does. */
const AS_AT = '2026-06-30'

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase
let db: CofferDb
let customer: string
let vendor: string
let bank: string
let receivable: string
let payable: string

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-ageing-'))
  directories.push(dir)
  connection = openDatabase({ filePath: join(dir, 'company.coffer'), key: KEY })
  handles.push(connection)
  runMigrations(connection, MIGRATIONS)
  db = createQueryBuilder(connection)

  await setUpBooks(db, {
    rule: aprilToMarch,
    clock: CLOCK,
    extraAccounts: taxAccountsFor([
      { code: 'CGST', label: 'Central GST', levy: 'both' },
      { code: 'SGST', label: 'State GST', levy: 'both' },
    ]),
  })

  /* Thirty days, so an invoice's due date is a date nothing else in the fixture is — the
   * document date would answer the same as the due date on nought-day terms, and a report
   * bucketing by the wrong one of the two would then be invisible. */
  customer = (
    await createParty(db, {
      name: 'Bharat Steel',
      countryCode: 'in',
      isCustomer: true,
      paymentTermsDays: 30,
    })
  ).id
  vendor = (
    await createParty(db, {
      name: 'Coastal Freight',
      countryCode: 'in',
      isVendor: true,
      paymentTermsDays: 15,
    })
  ).id

  const accounts = await db.selectFrom('accounts').select(['id', 'code']).execute()
  const byCode = new Map(accounts.map((account) => [account.code, account.id]))
  bank = byCode.get('1210')!

  const roles = await db.selectFrom('account_roles').select(['role', 'account_id']).execute()
  receivable = roles.find((role) => role.role === 'accounts-receivable')!.account_id
  payable = roles.find((role) => role.role === 'accounts-payable')!.account_id
})

afterEach(() => {
  for (const handle of handles.splice(0)) {
    try {
      closeDatabase(handle)
    } catch {
      /* a test may have closed it already */
    }
  }
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

// ---- Fixtures --------------------------------------------------------------

const line = (over: Partial<TaxedLineInput> = {}): TaxedLineInput => ({
  description: 'Ball bearing 6203',
  quantity: '2.000',
  unitPrice: '500.00',
  taxableAmount: '1000.00',
  ratePct: '18.000',
  taxes: [
    { code: 'CGST', label: 'CGST @ 9%', ratePct: '9.000', amount: '90.00' },
    { code: 'SGST', label: 'SGST @ 9%', ratePct: '9.000', amount: '90.00' },
  ],
  ...over,
})

const draft = (over: Partial<CreateTaxedDocumentInput> = {}): CreateTaxedDocumentInput => ({
  kind: 'sales-invoice',
  date: '2026-04-15',
  partyId: customer,
  placeOfSupplyCountry: 'in',
  placeOfSupplyJurisdiction: '33',
  lines: [line()],
  ...over,
})

/** An issued document for 1,180.00 unless told otherwise. */
async function issued(over: Partial<CreateTaxedDocumentInput> = {}) {
  const document = await createDocument(db, draft(over), NOW)
  return issueDocument(db, { id: document.id }, NOW)
}

const receiptInput = (over: Partial<CreateReceiptInput> = {}): CreateReceiptInput => ({
  kind: 'receipt',
  date: '2026-05-01',
  partyId: customer,
  amount: '1180.00',
  accountId: bank,
  ...over,
})

async function report(asAtDate = AS_AT, side: 'sales' | 'purchase' = 'sales'): Promise<AgedReport> {
  return agedReport(db, { side, asAtDate })
}

function rowFor(aged: AgedReport, partyId: string | null): AgedPartyRow | undefined {
  return aged.parties.find((party) => party.partyId === partyId)
}

/** Every column's figure, as strings, so an assertion can name the whole row at once. */
function columns(party: AgedPartyRow | undefined): string[] {
  return party?.buckets ?? []
}

async function codeOf(action: () => Promise<unknown>): Promise<RepoErrorCode | string> {
  try {
    await action()
  } catch (error) {
    return isRepoError(error) ? error.code : `not a RepoError: ${String(error)}`
  }
  return 'no error thrown'
}

// ---- What is on the report -------------------------------------------------

describe('what the aged report is made of', () => {
  it('has nothing on it, and still ties, when nothing has been posted', async () => {
    const aged = await report()

    expect(aged.parties).toEqual([])
    expect(aged.totals.total).toBe('0.00')
    expect(aged.controlBalance).toBe('0.00')
    expect(aged.ties).toBe(true)
  })

  it('names the control account it is a decomposition of', async () => {
    const aged = await report()

    expect(aged.accountId).toBe(receivable)
    expect(aged.accountCode).toBe('1300')
    expect(aged.side).toBe('sales')
    expect(aged.asAtDate).toBe(AS_AT)
    expect(aged.buckets.map((bucket) => bucket.label)).toEqual(
      AGE_BUCKETS.map((bucket) => bucket.label),
    )
  })

  /*
   * THE DUE DATE, NOT THE DOCUMENT DATE, and the fixture is chosen so the two answer
   * differently. Raised 15 April on thirty-day terms, so it fell due on 15 May and is 46
   * days overdue at the end of June — the third column. Bucketing by the document date
   * would make it 76 days and put it in the fourth, which is the mistake 0014-1 exists to
   * make impossible and this is where it would show.
   */
  it('ages an invoice from the date it fell due', async () => {
    const invoice = await issued()

    const aged = await report()
    const party = rowFor(aged, customer)

    expect(party?.partyName).toBe('Bharat Steel')
    expect(party?.items).toHaveLength(1)
    expect(party?.items[0]).toMatchObject({
      source: 'document',
      sourceId: invoice.id,
      kind: 'sales-invoice',
      number: 'INV/2026-27/0001',
      date: '2026-04-15',
      dueDate: '2026-05-15',
      daysOverdue: 46,
      bucket: 2,
      amount: '1180.00',
    })
    expect(columns(party)).toEqual(['0.00', '0.00', '1180.00', '0.00', '0.00'])
    expect(party?.total).toBe('1180.00')
    expect(aged.ties).toBe(true)
  })

  it('leaves out a draft, which has put nothing on the account', async () => {
    await createDocument(db, draft(), NOW)

    const aged = await report()

    expect(aged.parties).toEqual([])
    expect(aged.ties).toBe(true)
  })

  it('leaves out an invoice that has been paid in full', async () => {
    const invoice = await issued()
    await createReceipt(
      db,
      receiptInput({ allocations: [{ documentId: invoice.id, amount: '1180.00' }] }),
      NOW,
    )

    const aged = await report()

    expect(aged.parties).toEqual([])
    expect(aged.totals.total).toBe('0.00')
    expect(aged.ties).toBe(true)
  })

  it('leaves out an invoice that has been cancelled', async () => {
    const invoice = await issued()
    await cancelDocument(db, { id: invoice.id, date: '2026-06-01' }, LATER)

    const aged = await report()

    expect(aged.parties).toEqual([])
    expect(aged.ties).toBe(true)
  })

  it('shows what is left when part of an invoice has been paid', async () => {
    const invoice = await issued()
    await createReceipt(
      db,
      receiptInput({
        amount: '400.00',
        allocations: [{ documentId: invoice.id, amount: '400.00' }],
      }),
      NOW,
    )

    const aged = await report()
    const party = rowFor(aged, customer)

    expect(party?.items).toHaveLength(1)
    expect(party?.items[0]?.amount).toBe('780.00')
    expect(party?.total).toBe('780.00')
    expect(party?.onAccount).toBe('0.00')
    expect(aged.ties).toBe(true)
  })
})

// ---- As at a date ----------------------------------------------------------

describe('as at a date', () => {
  /* The same books, twice. A report that read today's rows would answer 1,180.00 in both
   * directions and every other test in this file would still pass. */
  it('does not know about an invoice raised after the date', async () => {
    await issued({ date: '2026-06-20' })

    expect((await report('2026-06-01')).totals.total).toBe('0.00')
    expect((await report('2026-06-30')).totals.total).toBe('1180.00')
  })

  it('does not let a receipt dated after the date settle anything', async () => {
    const invoice = await issued()
    await createReceipt(
      db,
      receiptInput({
        date: '2026-06-20',
        allocations: [{ documentId: invoice.id, amount: '1180.00' }],
      }),
      NOW,
    )

    const before = await report('2026-06-01')
    expect(rowFor(before, customer)?.total).toBe('1180.00')
    expect(rowFor(before, customer)?.items).toHaveLength(1)
    expect(before.ties).toBe(true)

    expect((await report('2026-06-30')).totals.total).toBe('0.00')
  })

  /*
   * A CANCELLATION IS A SECOND ENTRY WITH ITS OWN DATE, which is the whole reason the
   * filter is on the ledger rather than on `documents.status`. As at the first of June
   * this invoice was outstanding, and it was: the reversal had not been posted.
   */
  it('still shows a document that was cancelled after the date', async () => {
    const invoice = await issued()
    await cancelDocument(db, { id: invoice.id, date: '2026-06-15' }, LATER)

    const before = await report('2026-06-01')
    expect(rowFor(before, customer)?.total).toBe('1180.00')
    expect(before.ties).toBe(true)

    expect((await report('2026-06-30')).totals.total).toBe('0.00')
  })

  /*
   * THE DAY ITSELF IS IN. "As at 30 June" includes the thirtieth, in all three places the
   * date is applied — the movements, the allocations and the control balance. A `<` in
   * any one of them passes every other test in this file, because no other fixture posts
   * anything on the day it is read.
   *
   * The ITEM is asserted rather than only the total, and that is what catches the
   * allocation half: dropping an allocation from both ends leaves the total exactly where
   * it was and moves 400.00 from a reduced invoice to a receipt standing on account.
   */
  it("counts what was posted on the report's own day", async () => {
    const invoice = await issued({ date: AS_AT })
    await createReceipt(
      db,
      receiptInput({
        date: AS_AT,
        amount: '400.00',
        allocations: [{ documentId: invoice.id, amount: '400.00' }],
      }),
      NOW,
    )

    const aged = await report()
    const party = rowFor(aged, customer)

    expect(party?.items).toHaveLength(1)
    expect(party?.items[0]?.source).toBe('document')
    expect(party?.items[0]?.amount).toBe('780.00')
    expect(party?.total).toBe('780.00')
    expect(aged.ties).toBe(true)
  })

  /*
   * BOTH ENDS OF AN ALLOCATION, and this is the fixture that needs both halves of the
   * rule. The money arrived in May against an invoice raised in June — which a receipt
   * screen permits, because the invoice exists by the time anyone matches it. Read as at
   * the first of June, counting the allocation would show an invoice nobody had yet
   * raised as paid, and the receipt as having nothing spare.
   */
  it('counts an allocation only once both ends are in the books', async () => {
    const invoice = await issued({ date: '2026-06-10' })
    await createReceipt(
      db,
      receiptInput({
        date: '2026-05-20',
        allocations: [{ documentId: invoice.id, amount: '1180.00' }],
      }),
      NOW,
    )

    const before = await report('2026-06-01')
    const party = rowFor(before, customer)

    expect(party?.items).toHaveLength(1)
    expect(party?.items[0]?.source).toBe('receipt')
    expect(party?.onAccount).toBe('1180.00')
    expect(party?.total).toBe('-1180.00')
    expect(before.ties).toBe(true)

    expect((await report('2026-06-30')).totals.total).toBe('0.00')
  })
})

// ---- Money standing to a party's credit ------------------------------------

describe('money on account', () => {
  /*
   * THE HALF A LIST OF UNPAID INVOICES LEAVES OUT. Without this row the page would say
   * the customer owes 1,180.00 while the balance sheet says nought, and somebody would
   * ring them about money they had already sent.
   */
  it('carries a receipt that has been matched against nothing', async () => {
    await createReceipt(db, receiptInput({ amount: '500.00' }), NOW)

    const aged = await report()
    const party = rowFor(aged, customer)

    expect(party?.items[0]).toMatchObject({
      source: 'receipt',
      /* Carried so a screen can open the row. Not inferable from the report's side —
       * a refund to a customer is money out on the sales side. */
      kind: 'receipt',
      number: 'RCT/2026-27/0001',
      date: '2026-05-01',
      bucket: null,
      amount: '-500.00',
    })
    expect(columns(party)).toEqual(['0.00', '0.00', '0.00', '0.00', '0.00'])
    expect(party?.onAccount).toBe('500.00')
    expect(party?.total).toBe('-500.00')
    expect(aged.ties).toBe(true)
  })

  it('carries the spare part of a receipt that only half settles an invoice', async () => {
    const invoice = await issued()
    await createReceipt(
      db,
      receiptInput({
        amount: '2000.00',
        allocations: [{ documentId: invoice.id, amount: '1180.00' }],
      }),
      NOW,
    )

    const aged = await report()
    const party = rowFor(aged, customer)

    /* The invoice has gone; the receipt is here for what is left of it. */
    expect(party?.items).toHaveLength(1)
    expect(party?.items[0]?.source).toBe('receipt')
    expect(party?.onAccount).toBe('820.00')
    expect(party?.total).toBe('-820.00')
    expect(aged.ties).toBe(true)
  })

  /*
   * A CREDIT NOTE IS ON ACCOUNT AND NOT IN A COLUMN. It reduces what the customer owes
   * and 0014 gives it no due date, because what it is waiting for is somebody to say
   * which invoice it offsets — which is 0015's work, not a column heading.
   */
  it('carries a credit note as a credit rather than ageing it', async () => {
    await issued()
    await issued({ kind: 'credit-note', date: '2026-06-05' })

    const aged = await report()
    const party = rowFor(aged, customer)

    const note = party?.items.find((item) => item.kind === 'credit-note')
    expect(note).toMatchObject({ source: 'document', bucket: null, amount: '-1180.00' })
    expect(note?.dueDate).toBe('2026-06-05')
    expect(party?.onAccount).toBe('1180.00')
    expect(party?.total).toBe('0.00')
    expect(aged.ties).toBe(true)
  })

  it('drops a receipt that has been cancelled', async () => {
    const receipt = await createReceipt(db, receiptInput({ amount: '500.00' }), NOW)
    await cancelReceipt(db, { id: receipt.id, date: '2026-06-10' }, LATER)

    const aged = await report()

    expect(aged.parties).toEqual([])
    expect(aged.ties).toBe(true)
  })
})

// ---- Lines with no document behind them -------------------------------------

describe('what reached the control account without a document', () => {
  /*
   * THE CASE THE REPORT WOULD OTHERWISE BE EMPTY FOR. A business adopting Coffer types
   * its opening receivables and nothing else; a report that only understood documents
   * would show it nothing on the day it started, which is the day it most needs to see
   * who owes what.
   */
  it('ages an opening balance from the day it was raised', async () => {
    await postOpeningBalances(db, {
      date: '2026-04-01',
      lines: [{ accountId: receivable, amount: '450000.00', partyId: customer }],
    })

    const aged = await report()
    const party = rowFor(aged, customer)

    expect(party?.items[0]).toMatchObject({
      source: 'journal',
      kind: null,
      date: '2026-04-01',
      dueDate: '2026-04-01',
      daysOverdue: 90,
      bucket: 3,
      amount: '450000.00',
    })
    expect(party?.total).toBe('450000.00')
    expect(aged.ties).toBe(true)
  })

  it('carries a manual credit to the control account as money on account', async () => {
    await postManualEntry(db, {
      date: '2026-05-10',
      narration: 'Advance received, posted by hand',
      lines: [
        { accountId: bank, debit: '3000.00', credit: '0.00' },
        { accountId: receivable, debit: '0.00', credit: '3000.00', partyId: customer },
      ],
    })

    const aged = await report()
    const party = rowFor(aged, customer)

    expect(party?.items[0]?.source).toBe('journal')
    expect(party?.items[0]?.bucket).toBeNull()
    expect(party?.onAccount).toBe('3000.00')
    expect(aged.ties).toBe(true)
  })

  /*
   * A CONTROL LINE NAMING NOBODY, which 0005's trigger refuses — so the fixture builds it
   * the one way a real file can: the role is pointed elsewhere while the entry is posted,
   * and pointed back afterwards. That is not a contrivance. It is what happens when a
   * chart is tidied and a role is moved onto an account that already has history.
   *
   * The report has to carry it or the foot stops equalling the account, and this page is
   * the only one in the product that would ever show it.
   */
  it('carries a control line that names no party, and still ties', async () => {
    await clearAccountRole(db, 'accounts-receivable')
    await postManualEntry(db, {
      date: '2026-05-10',
      narration: 'Posted while the role was pointed elsewhere',
      lines: [
        { accountId: receivable, debit: '250.00', credit: '0.00' },
        { accountId: bank, debit: '0.00', credit: '250.00' },
      ],
    })
    await setAccountRole(db, 'accounts-receivable', receivable)

    const aged = await report()
    const orphan = rowFor(aged, null)

    expect(orphan?.partyName).toBe('Not attributed to a party')
    expect(orphan?.total).toBe('250.00')
    expect(aged.totals.total).toBe('250.00')
    expect(aged.ties).toBe(true)
  })
})

// ---- The identity ----------------------------------------------------------

describe('the foot of the report and the control account', () => {
  /*
   * EVERY SHAPE AT ONCE, against `accountBalance` — the same figure the balance sheet
   * draws from. This is the test to keep working: each of the four fixtures below is a
   * way for the two to disagree, and a report missing any one of them would tie on a file
   * that happened not to contain it.
   */
  it('equals the receivable balance at the same date', async () => {
    const invoice = await issued()
    await issued({ date: '2026-05-02' })
    await issued({ kind: 'credit-note', date: '2026-06-05' })
    await createReceipt(
      db,
      receiptInput({
        amount: '2000.00',
        allocations: [{ documentId: invoice.id, amount: '600.00' }],
      }),
      NOW,
    )
    await postOpeningBalances(db, {
      date: '2026-04-01',
      lines: [{ accountId: receivable, amount: '5000.00', partyId: customer }],
    })

    const aged = await report()
    const balance = await accountBalance(db, receivable, { toDate: AS_AT })

    expect(aged.controlBalance).toBe(balance.balance)
    expect(aged.totals.total).toBe(balance.balance)
    expect(aged.ties).toBe(true)
    /* Not nought, or the assertion above would hold of a report with nothing on it. */
    expect(aged.totals.total).not.toBe('0.00')
  })

  it('equals it at an earlier date too, with different figures on both sides', async () => {
    await issued()
    await issued({ date: '2026-06-20' })

    const earlier = await report('2026-06-01')
    const balance = await accountBalance(db, receivable, { toDate: '2026-06-01' })

    expect(earlier.totals.total).toBe(balance.balance)
    expect(earlier.totals.total).toBe('1180.00')
    expect((await report('2026-06-30')).totals.total).toBe('2360.00')
  })

  it('splits one party across two columns without losing anything', async () => {
    await issued({ date: '2026-04-15' })
    await issued({ date: '2026-06-20' })

    const aged = await report()
    const party = rowFor(aged, customer)

    /* Due 15 May and 20 July: forty-six days late, and ten days early. */
    expect(columns(party)).toEqual(['1180.00', '0.00', '1180.00', '0.00', '0.00'])
    expect(party?.total).toBe('2360.00')
    expect(aged.totals.buckets).toEqual(columns(party))
    expect(aged.ties).toBe(true)
  })

  /*
   * WHAT IS PAST DUE, AND IT IS NEITHER THE TOTAL NOR ANY COLUMN. The dashboard leads
   * with this figure and refused to compute it, correctly — "everything past due" is a
   * sum over columns and a renderer does not add money up (CONVENTIONS §1.7).
   *
   * THE FIXTURE MAKES ALL FOUR FIGURES DIFFERENT, on purpose. One invoice forty-six days
   * late, one not due for another three weeks, and a receipt on account: `overdue` is
   * 1,180, `total` is 1,960, `onAccount` is 400 and no single column is any of them. A
   * fixture with one invoice would let `overdue` be a copy of `total`, of the third
   * column, or of the row, and no assertion could tell which.
   */
  it('carries what is past due, which is neither the total nor a column', async () => {
    await issued({ date: '2026-04-15' })
    await issued({ date: '2026-06-20' })
    await createReceipt(db, receiptInput({ amount: '400.00' }), NOW)

    const aged = await report()

    expect(aged.totals.overdue).toBe('1180.00')
    /* Not the total — that has the not-yet-due invoice in it and the credit taken off. */
    expect(aged.totals.total).toBe('1960.00')
    expect(aged.totals.onAccount).toBe('400.00')
    expect(aged.totals.buckets).toEqual(['1180.00', '0.00', '1180.00', '0.00', '0.00'])
    expect(aged.ties).toBe(true)
  })

  it('keeps two parties apart and totals both', async () => {
    const second = (
      await createParty(db, { name: 'Anand Traders', countryCode: 'in', isCustomer: true })
    ).id
    await issued()
    await issued({ partyId: second, date: '2026-06-20' })

    const aged = await report()

    expect(aged.parties).toHaveLength(2)
    expect(rowFor(aged, customer)?.total).toBe('1180.00')
    expect(rowFor(aged, second)?.total).toBe('1180.00')
    expect(aged.totals.total).toBe('2360.00')
    expect(aged.ties).toBe(true)
  })
})

// ---- The purchase side ------------------------------------------------------

describe('the purchase side', () => {
  async function bill(over: Partial<CreateTaxedDocumentInput> = {}) {
    return issued({
      kind: 'purchase-bill',
      partyId: vendor,
      date: '2026-05-01',
      placeOfSupplyJurisdiction: '33',
      ...over,
    })
  }

  /* Positive means "the party is owed", not "the account is debited". A raw debit less
   * credit would report a bill as a negative and the whole page would read backwards. */
  it('reports what is owed to a vendor as a positive figure', async () => {
    await bill()

    const aged = await report(AS_AT, 'purchase')
    const party = rowFor(aged, vendor)

    expect(aged.accountId).toBe(payable)
    /* Fifteen-day terms from the first of May: due 16 May, 45 days late. */
    expect(party?.items[0]).toMatchObject({
      kind: 'purchase-bill',
      dueDate: '2026-05-16',
      daysOverdue: 45,
      bucket: 2,
      amount: '1180.00',
    })
    expect(party?.total).toBe('1180.00')
    expect(aged.ties).toBe(true)
  })

  it('takes a payment off what is owed', async () => {
    const document = await bill()
    await createReceipt(
      db,
      receiptInput({
        kind: 'payment',
        partyId: vendor,
        amount: '400.00',
        date: '2026-06-01',
        allocations: [{ documentId: document.id, amount: '400.00' }],
      }),
      NOW,
    )

    const aged = await report(AS_AT, 'purchase')

    expect(rowFor(aged, vendor)?.total).toBe('780.00')
    expect(aged.ties).toBe(true)
  })

  it('equals the payable balance at the same date', async () => {
    await bill()
    await createReceipt(
      db,
      receiptInput({ kind: 'payment', partyId: vendor, amount: '2000.00', date: '2026-06-01' }),
      NOW,
    )

    const aged = await report(AS_AT, 'purchase')
    const balance = await accountBalance(db, payable, { toDate: AS_AT })

    expect(aged.totals.total).toBe(balance.balance)
    expect(aged.totals.total).toBe('-820.00')
    expect(aged.ties).toBe(true)
  })

  /* The two sides are two accounts, and a bill on one must not appear on the other. Both
   * fixtures are posted, so a report that ignored its side would show three items. */
  it('does not put a purchase on the sales report', async () => {
    await issued()
    await bill()

    const sales = await report()
    const purchases = await report(AS_AT, 'purchase')

    expect(sales.parties).toHaveLength(1)
    expect(rowFor(sales, customer)?.items[0]?.kind).toBe('sales-invoice')
    expect(purchases.parties).toHaveLength(1)
    expect(rowFor(purchases, vendor)?.items[0]?.kind).toBe('purchase-bill')
  })
})

// ---- Refusals and the tables it stands on -----------------------------------

describe('the report cannot be drawn', () => {
  it('refuses when no account fills the role it would report on', async () => {
    await clearAccountRole(db, 'accounts-receivable')

    expect(await codeOf(() => report())).toBe('ROLE_UNMAPPED')
  })
})

/*
 * THE JOIN THE WHOLE REPORT RESTS ON, and it is between two tables that were written
 * apart on purpose.
 *
 * `controlRoleFor` says which account a side's DOCUMENTS move; `receiptTreatmentOf` says
 * which account a voucher moves, and the header of domain/receipts/types.ts argues — with
 * reason — that the second should be stated rather than derived from the side, because
 * nothing in principle says a sales-side voucher must move receivables.
 *
 * In principle. In this report they must agree, or a receipt lands on an account the aged
 * report is not looking at, and the page shows an invoice as unpaid while the money sits
 * one row down the balance sheet. So the dependency is pinned here, where it exists,
 * rather than by collapsing a distinction another file made deliberately.
 */
describe('the two role tables the report depends on', () => {
  /* EVERY VOUCHER KIND, not just the one that settles a charge. 0015 put a second voucher
   * on each side — a refund moves receivables the other way — and the dependency this
   * pins is that BOTH of a side's vouchers land on the account that side's documents are
   * reported from. A refund on the wrong account would be money leaving the business that
   * the aged report never sees. */
  it.each(RECEIPT_KINDS)('settles a $kind on the account that raised it', (definition) => {
    expect(receiptTreatmentOf(definition.kind).controlRole).toBe(controlRoleFor(definition.side))
  })

  it.each(TRADE_SIDES)('gives the %s side two vouchers on one account', (side) => {
    const onSide = RECEIPT_KINDS.filter((definition) => definition.side === side)

    expect(onSide).toHaveLength(2)
    expect(onSide.map((definition) => settles(definition.kind)).sort()).toEqual(
      [postingKindOn(side, 'charge'), postingKindOn(side, 'refund')].sort(),
    )
  })
})

// ---- When the report does not tie -------------------------------------------

/*
 * `ties` IS NOT DECORATION, and this is the file that proves it by making it false.
 *
 * THE WAY 0014-2 MADE IT FALSE IS GONE, and that is a correction worth recording. It used
 * a RECEIPT settling a PURCHASE BILL — a state the repository refused and the database
 * did not — so the two ends of one allocation sat on two different control accounts.
 * Migration 0015 made that a trigger, because a refund shares a control account with a
 * receipt and the mistake stopped being visible. The fixture that exploited the hole had
 * to go with it.
 *
 * WHAT REPLACES IT NEEDS NO WRITE PAST ANYTHING, which is why it is a better test.
 * `outstanding.ts` has warned since 0012 that repointing a control role is "a perfectly
 * ordinary thing to do while tidying a chart" — and a business that does it between
 * raising an invoice and banking the cheque leaves one end of the allocation on the old
 * account and the other on the new one. Every step below is an operation the app offers.
 *
 * The report then sees the receipt and not the invoice: the receipt's own movement and
 * the allocation put back on it cancel exactly, the page comes to nothing, and the
 * account it claims to equal is five hundred rupees the other way.
 *
 * There is nothing this report can do about that except say so. Refusing to draw would
 * leave a damaged file with no page to diagnose it from, and quietly balancing to the
 * account would hide the one number that shows something is wrong.
 */
describe('a control account repointed between the document and the money', () => {
  /** A leaf that fills no role, standing in for wherever somebody moved the control to. */
  async function movedTo(code: string): Promise<string> {
    const row = await db
      .selectFrom('accounts')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow()
    return row.id
  }

  it('reports that the sales page no longer equals the receivable account', async () => {
    const invoice = await issued({ date: '2026-05-01' })
    await setAccountRole(db, 'accounts-receivable', await movedTo('1600'))
    await createReceipt(
      db,
      receiptInput({
        amount: '500.00',
        date: '2026-05-10',
        allocations: [{ documentId: invoice.id, amount: '500.00' }],
      }),
      NOW,
    )

    const aged = await report()

    expect(aged.ties).toBe(false)
    expect(aged.controlBalance).toBe('-500.00')
    expect(aged.totals.total).toBe('0.00')
  })

  it('reports the same of the purchase page', async () => {
    const bill = await issued({ kind: 'purchase-bill', partyId: vendor, date: '2026-05-01' })
    await setAccountRole(db, 'accounts-payable', await movedTo('2400'))
    await createReceipt(
      db,
      receiptInput({
        kind: 'payment',
        partyId: vendor,
        amount: '500.00',
        date: '2026-05-10',
        allocations: [{ documentId: bill.id, amount: '500.00' }],
      }),
      NOW,
    )

    const aged = await report(AS_AT, 'purchase')

    expect(aged.ties).toBe(false)
    expect(aged.controlBalance).toBe('-500.00')
    expect(aged.totals.total).toBe('0.00')
  })

  /*
   * AND THE PAGE STILL DRAWS THE OTHER PARTIES. The whole argument for reporting `ties`
   * rather than refusing is that the rows are the diagnosis, so a second party whose
   * money never moved has to appear on the same broken page — on the new account, where
   * their receipt landed.
   */
  it('still lists what did land on the account it is reporting from', async () => {
    const invoice = await issued({ date: '2026-05-01' })
    await setAccountRole(db, 'accounts-receivable', await movedTo('1600'))
    await createReceipt(
      db,
      receiptInput({
        amount: '500.00',
        date: '2026-05-10',
        allocations: [{ documentId: invoice.id, amount: '500.00' }],
      }),
      NOW,
    )
    await createReceipt(db, receiptInput({ amount: '200.00', date: '2026-05-11' }), NOW)

    const aged = await report()

    expect(aged.ties).toBe(false)
    expect(aged.totals.total).toBe('-200.00')
    expect(rowFor(aged, customer)?.total).toBe('-200.00')
  })
})

// ---- Straight at the table --------------------------------------------------

/*
 * One test that writes past every repository check, for the reason receipts.test.ts gives:
 * the arithmetic above all arrives through functions that would refuse a state the
 * arithmetic is supposed to survive. An allocation larger than the document it settles is
 * refused twice over — by `replaceAllocations` and by a trigger — so the only way to ask
 * what the report does with one is to put it there.
 */
describe('a file holding something the repository would refuse', () => {
  it('shows an over-allocated document as a credit rather than hiding it', async () => {
    const invoice = await issued()
    const receipt = await createReceipt(db, receiptInput({ amount: '2000.00' }), NOW)

    connection
      .prepare(
        `INSERT INTO receipt_allocations (id, receipt_id, document_id, amount, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), receipt.id, invoice.id, '1500.00', NOW)

    const aged = await report()
    const party = rowFor(aged, customer)
    const document = party?.items.find((item) => item.source === 'document')

    expect(document?.amount).toBe('-320.00')
    expect(document?.bucket).toBeNull()
    /* The receipt's spare has shrunk by the same 1,500, so the foot is unmoved and the
     * account still agrees — which is the property that makes showing it safe. */
    expect(aged.ties).toBe(true)
  })
})

// ---- The two quadrants 0015 opened, and the table 0016 added ----------------

/*
 * A REFUND DOCUMENT AND A REFUND VOUCHER, WHICH THIS REPORT USED TO GET WRONG.
 *
 * The sign of a match was decided by which TABLE the figure came from — off a document,
 * back on a receipt — and that is the right pair of signs only while every document is a
 * charge and every voucher settles one. 0015-1 added the two kinds that break it, and
 * MEASURED against the version before this batch: a refund of 400 against a credit note
 * of 1,180 reported the note at -1,580 and the voucher at +800.
 *
 * `ties` WAS STILL TRUE, which is what makes these tests worth having. The two errors are
 * equal and opposite, so the foot of the report was right while both rows were nonsense —
 * and `ties` alone can never see it. Every test below therefore asserts the ITEMS as well.
 */
describe('a refund, on both sides of the match', () => {
  it('reports a credit note and the refund paid against it, both in their own facing', async () => {
    const credit = await issued({ kind: 'credit-note' })
    await createReceipt(
      db,
      receiptInput({
        kind: 'refund',
        amount: '400.00',
        date: '2026-05-01',
        allocations: [{ documentId: credit.id, amount: '400.00' }],
      }),
      NOW,
    )

    const aged = await report()
    const party = rowFor(aged, customer)

    /* The note, less what has actually been paid back. The voucher is settled in full and
     * so is not an item at all — an aged report lists what is open. */
    expect(party?.items).toHaveLength(1)
    expect(party?.items[0]).toMatchObject({ kind: 'credit-note', amount: '-780.00' })
    expect(party?.onAccount).toBe('780.00')
    expect(party?.total).toBe('-780.00')
    expect(aged.controlBalance).toBe('-780.00')
    expect(aged.ties).toBe(true)
  })

  /* Part paid, so the voucher survives as an item too and both figures are checked. A
   * refund of 400 out of a voucher for 1,000 leaves 600 standing to the customer. */
  it('leaves the unspent part of a refund voucher on the report', async () => {
    const credit = await issued({ kind: 'credit-note' })
    await createReceipt(
      db,
      receiptInput({
        kind: 'refund',
        amount: '1000.00',
        date: '2026-05-01',
        allocations: [{ documentId: credit.id, amount: '400.00' }],
      }),
      NOW,
    )

    const party = rowFor(await report(), customer)
    const items = new Map(party?.items.map((item) => [item.kind, item.amount]))

    expect(items.get('credit-note')).toBe('-780.00')
    /* A refund voucher PUTS money on receivables — it is money going back out — so its
     * unspent part is a debit, and it ages like a debt rather than standing on account. */
    expect(items.get('refund')).toBe('600.00')
    expect(party?.total).toBe('-180.00')
    expect((await report()).ties).toBe(true)
  })

  it('does the same on the purchase side', async () => {
    const debit = await issued({ kind: 'debit-note', partyId: vendor, date: '2026-04-15' })
    await createReceipt(
      db,
      receiptInput({
        kind: 'refund-received',
        partyId: vendor,
        amount: '400.00',
        date: '2026-05-01',
        allocations: [{ documentId: debit.id, amount: '400.00' }],
      }),
      NOW,
    )

    const aged = await report(AS_AT, 'purchase')
    const party = rowFor(aged, vendor)

    expect(party?.items).toHaveLength(1)
    expect(party?.items[0]).toMatchObject({ kind: 'debit-note', amount: '-780.00' })
    expect(aged.ties).toBe(true)
  })
})

describe('an offset between two documents', () => {
  /*
   * THE PAGE THIS BATCH EXISTS FOR. Before it, an invoice sat in an overdue column at its
   * full value with a credit note on account beside it and nothing that could match them
   * — the two figures a user has to net in their head before they can chase anybody.
   */
  it('takes the offset off both documents and still ties', async () => {
    const invoice = await issued()
    const credit = await issued({ kind: 'credit-note' })
    await setOffsets(
      db,
      {
        refundDocumentId: credit.id,
        offsets: [{ chargeDocumentId: invoice.id, amount: '400.00' }],
      },
      NOW,
    )

    const aged = await report()
    const party = rowFor(aged, customer)
    const items = new Map(party?.items.map((item) => [item.kind, item.amount]))

    expect(items.get('sales-invoice')).toBe('780.00')
    expect(items.get('credit-note')).toBe('-780.00')
    expect(columns(party)).toEqual(['0.00', '0.00', '780.00', '0.00', '0.00'])
    expect(party?.onAccount).toBe('780.00')
    expect(party?.total).toBe('0.00')
    expect(aged.controlBalance).toBe('0.00')
    expect(aged.ties).toBe(true)
  })

  /* Settled in full against each other, so neither is an item and the party drops off the
   * report — which is the state a business is trying to reach. */
  it('drops both when they settle each other exactly', async () => {
    const invoice = await issued()
    const credit = await issued({ kind: 'credit-note' })
    await setOffsets(
      db,
      {
        refundDocumentId: credit.id,
        offsets: [{ chargeDocumentId: invoice.id, amount: '1180.00' }],
      },
      NOW,
    )

    const aged = await report()

    expect(aged.parties).toEqual([])
    expect(aged.totals.total).toBe('0.00')
    expect(aged.ties).toBe(true)
  })

  /*
   * AS AT MEANS THE LEDGER, FOR AN OFFSET TOO. Both ends have to be in the books by the
   * date — the same rule an allocation follows, and for the same reason: an April invoice
   * shown as part settled by a July credit note is a June report that knows the future.
   */
  it('ignores an offset whose other end is not in the books yet', async () => {
    const invoice = await issued()
    const credit = await issued({ kind: 'credit-note', date: '2026-07-15' })
    await setOffsets(
      db,
      {
        refundDocumentId: credit.id,
        offsets: [{ chargeDocumentId: invoice.id, amount: '400.00' }],
      },
      NOW,
    )

    const june = await report()
    expect(rowFor(june, customer)?.items[0]).toMatchObject({
      kind: 'sales-invoice',
      amount: '1180.00',
    })
    expect(june.ties).toBe(true)

    const august = await report('2026-08-31')
    const items = new Map(rowFor(august, customer)?.items.map((item) => [item.kind, item.amount]))
    expect(items.get('sales-invoice')).toBe('780.00')
    expect(items.get('credit-note')).toBe('-780.00')
    expect(august.ties).toBe(true)
  })

  /*
   * AN OFFSET AND A RECEIPT AGAINST ONE INVOICE, which is the case where a report that
   * counted one of the two sources would still tie and still be wrong. 1,180 less a 400
   * offset less a 300 receipt leaves 480 on the invoice.
   */
  it('counts both kinds of match against one invoice', async () => {
    const invoice = await issued()
    const credit = await issued({ kind: 'credit-note' })
    await setOffsets(
      db,
      {
        refundDocumentId: credit.id,
        offsets: [{ chargeDocumentId: invoice.id, amount: '400.00' }],
      },
      NOW,
    )
    await createReceipt(
      db,
      receiptInput({
        amount: '300.00',
        date: '2026-05-01',
        allocations: [{ documentId: invoice.id, amount: '300.00' }],
      }),
      NOW,
    )

    const aged = await report()
    const items = new Map(rowFor(aged, customer)?.items.map((item) => [item.kind, item.amount]))

    expect(items.get('sales-invoice')).toBe('480.00')
    expect(items.get('credit-note')).toBe('-780.00')
    expect(items.has('receipt')).toBe(false)
    expect(aged.controlBalance).toBe('-300.00')
    expect(aged.ties).toBe(true)
  })
})
