/*
 * Receipts and allocations, against a real encrypted database.
 *
 * Two things are being tested and they are worth telling apart.
 *
 * THE ARITHMETIC. What a receipt does to the ledger, and what is left outstanding
 * afterwards. The assertions that matter are not about columns — there are no columns for
 * any of it — they are about the identity rule 3 promises:
 *
 *   party control balance  =  SUM(document outstanding)  -  SUM(receipt unallocated)
 *
 * There is a test that states it directly, and it is the one to keep working.
 *
 * THE RULES. 0012's five triggers and the repository checks in front of them. Each
 * trigger gets a test that goes STRAIGHT AT THE TABLE with raw SQL, because the
 * repository refuses the same thing first and a test that only goes through the
 * repository passes against a database that has stopped checking — the defence-in-depth
 * blindness this codebase has now been caught by in five separate batches.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { aprilToMarch } from '@main/domain/time'
import { NUMBERED_KINDS } from '@main/domain/documents'
import type { CreateReceiptInput, CreateTaxedDocumentInput, TaxedLineInput } from '@shared/dto'

import { DATABASE_KEY_BYTES, closeDatabase, openDatabase, type SqliteDatabase } from '../connection'
import { createQueryBuilder, type CofferDb } from '../kysely'
import { runMigrations } from '../migrate'
import { MIGRATIONS } from '../migrations'
import { setAccountRole, updateAccount } from './accounts'
import { accountBalance } from './balances'
import { setUpBooks } from './bootstrap'
import { createDocument } from './documents'
import { isRepoError, type RepoError, type RepoErrorCode } from './errors'
import { cancelDocument, issueDocument } from './issuing'
import { getEntry, postManualEntry } from './journal'
import { createSeries } from './numbering'
import {
  allocatedFromReceipt,
  documentMovement,
  openDocumentsFor,
  outstandingForDocument,
} from './outstanding'
import { createParty } from './parties'
import { closePeriod, listPeriods, reopenPeriod } from './periods'
import { taxAccountsFor } from './tax-accounts'
import {
  MAX_RECEIPT_PAGE,
  allocateReceipt,
  cancelReceipt,
  createReceipt,
  getReceipt,
  listReceipts,
} from './receipts'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x71)
const NOW = '2026-04-20T09:00:00.000Z'
const LATER = '2026-04-21T09:00:00.000Z'

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase
let db: CofferDb
let customer: string
let vendor: string
let bank: string
let cash: string
let receivable: string

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-receipts-'))
  directories.push(dir)
  connection = openDatabase({ filePath: join(dir, 'company.coffer'), key: KEY })
  handles.push(connection)
  runMigrations(connection, MIGRATIONS)
  db = createQueryBuilder(connection)

  /*
   * `setUpBooks` rather than `seedChart` alone, because the numbering series it now seeds
   * are half of what these tests need — and because a receipt is the first thing in this
   * codebase that a company can do without a settings screen having been visited.
   */
  await setUpBooks(db, {
    rule: aprilToMarch,
    /* The two components an intra-state Indian supply carries, seeded as accounts rather
     * than asked of a regime: `db/` may not name one. Same fixture as issuing.test.ts. */
    extraAccounts: taxAccountsFor([
      { code: 'CGST', label: 'Central GST', levy: 'both' },
      { code: 'SGST', label: 'State GST', levy: 'both' },
    ]),
  })

  customer = (await createParty(db, { name: 'Bharat Steel', countryCode: 'in', isCustomer: true }))
    .id
  vendor = (await createParty(db, { name: 'Coastal Freight', countryCode: 'in', isVendor: true }))
    .id

  const accounts = await db.selectFrom('accounts').select(['id', 'code']).execute()
  const byCode = new Map(accounts.map((account) => [account.code, account.id]))
  bank = byCode.get('1210')!
  cash = byCode.get('1100')!

  const roles = await db.selectFrom('account_roles').select(['role', 'account_id']).execute()
  receivable = roles.find((role) => role.role === 'accounts-receivable')!.account_id
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

async function failureOf(action: () => Promise<unknown>): Promise<RepoError> {
  try {
    await action()
  } catch (error) {
    if (isRepoError(error)) return error
    throw error
  }
  throw new Error('Expected the action to fail, and it did not.')
}

async function codeOf(action: () => Promise<unknown>): Promise<RepoErrorCode | string> {
  try {
    await action()
  } catch (error) {
    return isRepoError(error) ? error.code : `not a RepoError: ${String(error)}`
  }
  return 'no error thrown'
}

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

/** An issued invoice for 1,180.00 unless told otherwise. */
async function invoice(over: Partial<CreateTaxedDocumentInput> = {}) {
  const document = await createDocument(db, draft(over), NOW)
  return issueDocument(db, { id: document.id }, NOW)
}

const receiptInput = (over: Partial<CreateReceiptInput> = {}): CreateReceiptInput => ({
  kind: 'receipt',
  date: '2026-04-20',
  partyId: customer,
  amount: '1180.00',
  accountId: bank,
  ...over,
})

/** The document row shape `outstanding.ts` reads, fetched for an assertion. */
async function control(documentId: string) {
  const row = await db
    .selectFrom('documents')
    .select(['id', 'kind', 'party_id', 'entry_id'])
    .where('id', '=', documentId)
    .executeTakeFirstOrThrow()
  return { id: row.id, kind: row.kind, partyId: row.party_id, entryId: row.entry_id }
}

/** Write an allocation straight into the table, past every repository check. */
function writeAllocation(receiptId: string, documentId: string, amount: string): void {
  connection
    .prepare(
      `INSERT INTO receipt_allocations (id, receipt_id, document_id, amount, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), receiptId, documentId, amount, NOW)
}

// ---- Recording money -------------------------------------------------------

describe('recording a receipt', () => {
  it('numbers it, posts it and stores it, all at once', async () => {
    const receipt = await createReceipt(db, receiptInput(), NOW)

    expect(receipt.number).toBe('RCT/2026-27/0001')
    expect(receipt.status).toBe('posted')
    expect(receipt.entryId).not.toBeNull()
    expect(receipt.amount).toBe('1180.00')
    expect(receipt.partyName).toBe('Bharat Steel')
    expect(receipt.accountName).toBe('Bank Account')
  })

  /* Rule 1 as a column, not as a convention: the table cannot hold a receipt without a
   * number or without an entry, so there is no "recorded but not posted" to close. */
  it('leaves no state in which it exists without having posted', () => {
    const columns = connection
      .prepare<[], { name: string; notnull: number }>(`PRAGMA table_info(receipts)`)
      .all()

    for (const required of ['number', 'entry_id']) {
      expect(columns.find((column) => column.name === required)?.notnull).toBe(1)
    }
  })

  it('debits the bank and credits receivables, carrying the customer', async () => {
    const receipt = await createReceipt(db, receiptInput(), NOW)
    const entry = await getEntry(db, receipt.entryId)

    expect(entry?.lines).toHaveLength(2)
    expect(entry?.lines[0]).toMatchObject({ accountId: bank, debit: '1180.00', credit: '0.00' })
    expect(entry?.lines[1]).toMatchObject({
      accountId: receivable,
      debit: '0.00',
      credit: '1180.00',
      partyId: customer,
    })
  })

  it('records itself as the source, so the entry drills back', async () => {
    const receipt = await createReceipt(db, receiptInput(), NOW)
    const entry = await getEntry(db, receipt.entryId)

    expect(entry).toMatchObject({
      sourceType: 'receipt',
      sourceId: receipt.id,
      sourceNumber: receipt.number,
    })
  })

  it('takes the money into whichever account was named', async () => {
    const receipt = await createReceipt(db, receiptInput({ accountId: cash }), NOW)
    expect((await accountBalance(db, cash)).balance).toBe('1180.00')
    expect(receipt.accountName).toBe('Cash in Hand')
  })

  it('keeps the reference and the narration as typed', async () => {
    const receipt = await createReceipt(
      db,
      receiptInput({ reference: '  UTR9911  ', narration: '  Part payment  ' }),
      NOW,
    )
    expect(receipt.reference).toBe('UTR9911')
    expect(receipt.narration).toBe('Part payment')
  })

  it('numbers a payment from its own series', async () => {
    const payment = await createReceipt(
      db,
      receiptInput({ kind: 'payment', partyId: vendor, amount: '500.00' }),
      NOW,
    )
    expect(payment.number).toBe('PAY/2026-27/0001')
  })

  it('debits payables and credits the bank for a payment', async () => {
    const payment = await createReceipt(
      db,
      receiptInput({ kind: 'payment', partyId: vendor, amount: '500.00' }),
      NOW,
    )
    const entry = await getEntry(db, payment.entryId)

    expect(entry?.lines[0]).toMatchObject({ debit: '500.00', partyId: vendor })
    expect(entry?.lines[1]).toMatchObject({ accountId: bank, credit: '500.00' })
  })
})

describe('what recording refuses', () => {
  it('refuses a receipt for nothing', async () => {
    const failure = await failureOf(() => createReceipt(db, receiptInput({ amount: '0.00' }), NOW))
    expect(failure.code).toBe('RECEIPT_AMOUNT_INVALID')
    expect(failure.message).toMatch(/money that moved/)
  })

  /* Not merely refused — refused with the sentence that says what to do instead. The
   * direction is the kind, and a negative receipt is a payment. */
  it('refuses a negative one and says it is a payment', async () => {
    const failure = await failureOf(() =>
      createReceipt(db, receiptInput({ amount: '-500.00' }), NOW),
    )
    expect(failure.code).toBe('RECEIPT_AMOUNT_INVALID')
    expect(failure.message).toMatch(/money out is a payment/)
  })

  it('refuses an amount that is not money', async () => {
    expect(await codeOf(() => createReceipt(db, receiptInput({ amount: 'lots' }), NOW))).toBe(
      'RECEIPT_AMOUNT_INVALID',
    )
  })

  it('refuses a group account', async () => {
    const group = await db
      .selectFrom('accounts')
      .select('id')
      .where('code', '=', '1200')
      .executeTakeFirstOrThrow()

    const failure = await failureOf(() =>
      createReceipt(db, receiptInput({ accountId: group.id }), NOW),
    )
    expect(failure.code).toBe('RECEIPT_ACCOUNT_INVALID')
    expect(failure.message).toMatch(/is a group/)
  })

  /*
   * The one worth its own test. Posting a receipt into the receivables control account
   * balances perfectly and settles nothing — the customer's account is debited and
   * credited by the same figure — so no report would look wrong and the invoice would
   * still say it was unpaid.
   */
  it('refuses the control account it is settling against', async () => {
    const failure = await failureOf(() =>
      createReceipt(db, receiptInput({ accountId: receivable }), NOW),
    )
    expect(failure.code).toBe('RECEIPT_ACCOUNT_INVALID')
    expect(failure.message).toMatch(/settles against/)
  })

  it('refuses an archived account', async () => {
    await updateAccount(db, { id: cash, isArchived: true })
    const failure = await failureOf(() => createReceipt(db, receiptInput({ accountId: cash }), NOW))
    expect(failure.code).toBe('RECEIPT_ACCOUNT_INVALID')
    expect(failure.message).toMatch(/archived/)
  })

  it('refuses an account that is not in these books', async () => {
    expect(await codeOf(() => createReceipt(db, receiptInput({ accountId: 'gone' }), NOW))).toBe(
      'ACCOUNT_NOT_FOUND',
    )
  })

  it('refuses a date the books do not reach', async () => {
    expect(await codeOf(() => createReceipt(db, receiptInput({ date: '2019-04-01' }), NOW))).toBe(
      'NO_PERIOD',
    )
  })

  it('refuses a closed month, and spends no number doing it', async () => {
    const period = (await listPeriods(db, {})).find((row) => row.startDate === '2026-04-01')!
    await closePeriod(db, period.id)

    expect(await codeOf(() => createReceipt(db, receiptInput(), NOW))).toBe('PERIOD_CLOSED')

    /* The rollback, which is the point: a refused posting takes the counter back with it,
     * so the next receipt that succeeds is still number one. Without the transaction this
     * would be 0002 and a series would have a hole in it. */
    await reopenPeriod(db, period.id)
    expect((await createReceipt(db, receiptInput(), NOW)).number).toBe('RCT/2026-27/0001')
  })

  it('refuses a party these books do not have', async () => {
    expect(await codeOf(() => createReceipt(db, receiptInput({ partyId: 'nobody' }), NOW))).toBe(
      'PARTY_NOT_FOUND',
    )
  })
})

// ---- Allocation ------------------------------------------------------------

describe('allocating a receipt', () => {
  it('settles an invoice, and the invoice says so', async () => {
    const document = await invoice()
    const receipt = await createReceipt(
      db,
      receiptInput({ allocations: [{ documentId: document.id, amount: '1180.00' }] }),
      NOW,
    )

    expect(receipt.allocated).toBe('1180.00')
    expect(receipt.unallocated).toBe('0.00')
    expect((await outstandingForDocument(db, await control(document.id))).toString()).toBe('0')
  })

  it('carries the document number and date for the screen that lists it', async () => {
    const document = await invoice()
    const receipt = await createReceipt(
      db,
      receiptInput({ allocations: [{ documentId: document.id, amount: '180.00' }] }),
      NOW,
    )

    expect(receipt.allocations).toEqual([
      {
        id: expect.any(String),
        documentId: document.id,
        documentKind: 'sales-invoice',
        documentNumber: document.number,
        documentDate: '2026-04-15',
        amount: '180.00',
      },
    ])
  })

  /*
   * Money on account. Not an unfinished job and not an error — a customer paying on the
   * first of the month against invoices nobody has matched yet is the ordinary case, and
   * the figure has to be visible or the aged report cannot tie.
   */
  it('leaves a receipt nobody has matched as money on account', async () => {
    const receipt = await createReceipt(db, receiptInput(), NOW)
    expect(receipt.allocated).toBe('0.00')
    expect(receipt.unallocated).toBe('1180.00')
  })

  it('spreads one receipt across several invoices', async () => {
    const first = await invoice()
    const second = await invoice({ date: '2026-04-16' })

    const receipt = await createReceipt(
      db,
      receiptInput({
        amount: '2360.00',
        allocations: [
          { documentId: first.id, amount: '1180.00' },
          { documentId: second.id, amount: '1180.00' },
        ],
      }),
      NOW,
    )

    expect(receipt.allocated).toBe('2360.00')
    expect((await outstandingForDocument(db, await control(first.id))).toString()).toBe('0')
    expect((await outstandingForDocument(db, await control(second.id))).toString()).toBe('0')
  })

  it('replaces the whole set rather than adding to it', async () => {
    const first = await invoice()
    const second = await invoice({ date: '2026-04-16' })
    const receipt = await createReceipt(
      db,
      receiptInput({ allocations: [{ documentId: first.id, amount: '1180.00' }] }),
      NOW,
    )

    const moved = await allocateReceipt(
      db,
      { id: receipt.id, allocations: [{ documentId: second.id, amount: '1180.00' }] },
      LATER,
    )

    expect(moved.allocations.map((allocation) => allocation.documentId)).toEqual([second.id])
    expect((await outstandingForDocument(db, await control(first.id))).toString()).toBe('1180')
  })

  it('un-allocates everything when given an empty list', async () => {
    const document = await invoice()
    const receipt = await createReceipt(
      db,
      receiptInput({ allocations: [{ documentId: document.id, amount: '1180.00' }] }),
      NOW,
    )

    const cleared = await allocateReceipt(db, { id: receipt.id, allocations: [] }, LATER)

    expect(cleared.allocations).toEqual([])
    expect(cleared.unallocated).toBe('1180.00')
    expect((await outstandingForDocument(db, await control(document.id))).toString()).toBe('1180')
  })

  /*
   * Rule 2: allocating moves no money. If it ever posted anything, the control account
   * would move twice for one payment and every party balance would be wrong by the
   * amount that had been matched.
   */
  it('writes no journal entry and changes no balance', async () => {
    const document = await invoice()
    const receipt = await createReceipt(db, receiptInput(), NOW)

    const before = (await accountBalance(db, receivable)).balance
    const entriesBefore = await db.selectFrom('journal_entries').select('id').execute()

    await allocateReceipt(
      db,
      { id: receipt.id, allocations: [{ documentId: document.id, amount: '1180.00' }] },
      LATER,
    )

    expect((await accountBalance(db, receivable)).balance).toBe(before)
    expect(await db.selectFrom('journal_entries').select('id').execute()).toHaveLength(
      entriesBefore.length,
    )
  })
})

describe('what allocation refuses', () => {
  it('refuses more than the receipt holds', async () => {
    const first = await invoice()
    const second = await invoice({ date: '2026-04-16' })

    const failure = await failureOf(() =>
      createReceipt(
        db,
        receiptInput({
          amount: '1180.00',
          allocations: [
            { documentId: first.id, amount: '1180.00' },
            { documentId: second.id, amount: '1180.00' },
          ],
        }),
        NOW,
      ),
    )
    expect(failure.code).toBe('ALLOCATION_EXCEEDS_RECEIPT')

    /*
     * The SENTENCE, not only the code — and this assertion is the whole reason the check
     * runs before the inserts rather than after them. 0012's trigger raises the same code
     * and `repoErrorFrom` maps it back, so a test asserting the code alone passes against
     * a repository that has stopped checking. The figures only the repository knows are
     * what tells the two apart.
     */
    expect(failure.message).toMatch(/2360\.00 was allocated out of a receipt for 1180\.00/)
  })

  it('refuses more than the document has outstanding, and names both figures', async () => {
    const document = await invoice()

    const failure = await failureOf(() =>
      createReceipt(
        db,
        receiptInput({
          amount: '5000.00',
          allocations: [{ documentId: document.id, amount: '2000.00' }],
        }),
        NOW,
      ),
    )
    expect(failure.code).toBe('ALLOCATION_EXCEEDS_DOCUMENT')
    expect(failure.message).toContain('1180.00')
    expect(failure.message).toContain('2000.00')
  })

  it('counts what other receipts already took', async () => {
    const document = await invoice()
    await createReceipt(
      db,
      receiptInput({
        amount: '1000.00',
        allocations: [{ documentId: document.id, amount: '1000.00' }],
      }),
      NOW,
    )

    const failure = await failureOf(() =>
      createReceipt(
        db,
        receiptInput({
          amount: '1000.00',
          allocations: [{ documentId: document.id, amount: '1000.00' }],
        }),
        LATER,
      ),
    )
    expect(failure.code).toBe('ALLOCATION_EXCEEDS_DOCUMENT')
    expect(failure.message).toContain('180.00')
  })

  /*
   * The cap must not count a receipt against itself. Re-saving the same allocation is
   * something a user does every time they open a receipt and press save, and a cap that
   * read its own rows would refuse them their own money the second time.
   */
  it('does not count a receipt against itself when it is re-saved', async () => {
    const document = await invoice()
    const receipt = await createReceipt(
      db,
      receiptInput({ allocations: [{ documentId: document.id, amount: '1180.00' }] }),
      NOW,
    )

    const again = await allocateReceipt(
      db,
      { id: receipt.id, allocations: [{ documentId: document.id, amount: '1180.00' }] },
      LATER,
    )
    expect(again.allocated).toBe('1180.00')
  })

  it("refuses another party's invoice", async () => {
    const document = await invoice()
    const other = await createParty(db, {
      name: 'Nilgiri Tools',
      countryCode: 'in',
      isCustomer: true,
    })

    const failure = await failureOf(() =>
      createReceipt(
        db,
        receiptInput({
          partyId: other.id,
          allocations: [{ documentId: document.id, amount: '1180.00' }],
        }),
        NOW,
      ),
    )
    expect(failure.code).toBe('ALLOCATION_PARTY_MISMATCH')
    expect(failure.message).toMatch(/different party/)
  })

  it('refuses a draft, because a draft has posted nothing', async () => {
    const document = await createDocument(db, draft(), NOW)

    const failure = await failureOf(() =>
      createReceipt(
        db,
        receiptInput({ allocations: [{ documentId: document.id, amount: '100.00' }] }),
        NOW,
      ),
    )
    expect(failure.code).toBe('DOCUMENT_NOT_ISSUED')
    expect(failure.message).toMatch(/Issue it first/)
  })

  it('refuses a cancelled document, because it owes nothing', async () => {
    const document = await invoice()
    await cancelDocument(db, { id: document.id }, LATER)

    expect(
      await codeOf(() =>
        createReceipt(
          db,
          receiptInput({ allocations: [{ documentId: document.id, amount: '100.00' }] }),
          LATER,
        ),
      ),
    ).toBe('DOCUMENT_NOT_ISSUED')
  })

  it('refuses a payment against a sales invoice', async () => {
    const document = await invoice()
    const failure = await failureOf(() =>
      createReceipt(
        db,
        receiptInput({
          kind: 'payment',
          allocations: [{ documentId: document.id, amount: '100.00' }],
        }),
        NOW,
      ),
    )
    expect(failure.code).toBe('ALLOCATION_SIDE_MISMATCH')
  })

  it('refuses the same document twice in one receipt', async () => {
    const document = await invoice()
    expect(
      await codeOf(() =>
        createReceipt(
          db,
          receiptInput({
            allocations: [
              { documentId: document.id, amount: '100.00' },
              { documentId: document.id, amount: '100.00' },
            ],
          }),
          NOW,
        ),
      ),
    ).toBe('ALLOCATION_EXCEEDS_DOCUMENT')
  })

  it('refuses an allocation of nothing', async () => {
    const document = await invoice()
    expect(
      await codeOf(() =>
        createReceipt(
          db,
          receiptInput({ allocations: [{ documentId: document.id, amount: '0.00' }] }),
          NOW,
        ),
      ),
    ).toBe('RECEIPT_AMOUNT_INVALID')
  })

  /* The whole receipt rolls back, allocations included. Half a receipt is not a thing. */
  it('records nothing at all when one allocation is refused', async () => {
    const document = await invoice()
    await codeOf(() =>
      createReceipt(
        db,
        receiptInput({ allocations: [{ documentId: document.id, amount: '99999.00' }] }),
        NOW,
      ),
    )

    expect(await listReceipts(db)).toEqual([])
    expect(await db.selectFrom('receipt_allocations').select('id').execute()).toEqual([])
  })

  it('refuses an allocation against a cancelled receipt', async () => {
    const document = await invoice()
    const receipt = await createReceipt(db, receiptInput(), NOW)
    await cancelReceipt(db, { id: receipt.id }, LATER)

    const failure = await failureOf(() =>
      allocateReceipt(
        db,
        { id: receipt.id, allocations: [{ documentId: document.id, amount: '100.00' }] },
        LATER,
      ),
    )
    expect(failure.code).toBe('RECEIPT_CANCELLED')
    /* 0012's trigger raises the same code, so the code alone cannot tell whether the
     * repository still checks. Its own sentence can. */
    expect(failure.message).toMatch(/settles nothing/)
  })
})

// ---- Cancelling ------------------------------------------------------------

describe('cancelling a receipt', () => {
  it('reverses the entry and keeps the number', async () => {
    const receipt = await createReceipt(db, receiptInput(), NOW)
    const cancelled = await cancelReceipt(db, { id: receipt.id }, LATER)

    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.number).toBe(receipt.number)
    expect(cancelled.cancelledAt).toBe(LATER)
    expect((await getEntry(db, receipt.entryId))?.reversedByEntryId).not.toBeNull()
  })

  it('takes the money back off the bank', async () => {
    const receipt = await createReceipt(db, receiptInput(), NOW)
    await cancelReceipt(db, { id: receipt.id }, LATER)
    expect((await accountBalance(db, bank)).balance).toBe('0.00')
  })

  /*
   * The allocations GO, rather than being left for every reader to filter out. Ledger
   * invariant 2's reasoning in a second table: a filter someone forgets to write is how a
   * cancelled receipt keeps an invoice looking paid.
   */
  it('drops what it settled, so the invoice is owed again', async () => {
    const document = await invoice()
    const receipt = await createReceipt(
      db,
      receiptInput({ allocations: [{ documentId: document.id, amount: '1180.00' }] }),
      NOW,
    )

    await cancelReceipt(db, { id: receipt.id }, LATER)

    expect((await getReceipt(db, receipt.id))?.allocations).toEqual([])
    expect((await outstandingForDocument(db, await control(document.id))).toString()).toBe('1180')
  })

  it('posts the reversal as of the receipt date unless told otherwise', async () => {
    const receipt = await createReceipt(db, receiptInput(), NOW)
    await cancelReceipt(db, { id: receipt.id }, LATER)

    const reversal = await db
      .selectFrom('journal_entries')
      .select(['entry_date', 'narration'])
      .where('reverses_entry_id', '=', receipt.entryId)
      .executeTakeFirstOrThrow()

    expect(reversal.entry_date).toBe('2026-04-20')
    expect(reversal.narration).toBe('Cancellation of receipt RCT/2026-27/0001')
  })

  it('takes the date and the narration it is given', async () => {
    const receipt = await createReceipt(db, receiptInput(), NOW)
    await cancelReceipt(
      db,
      { id: receipt.id, date: '2026-04-25', narration: 'Cheque bounced' },
      LATER,
    )

    const reversal = await db
      .selectFrom('journal_entries')
      .select(['entry_date', 'narration'])
      .where('reverses_entry_id', '=', receipt.entryId)
      .executeTakeFirstOrThrow()

    expect(reversal).toEqual({ entry_date: '2026-04-25', narration: 'Cheque bounced' })
  })

  it('refuses to cancel one twice', async () => {
    const receipt = await createReceipt(db, receiptInput(), NOW)
    await cancelReceipt(db, { id: receipt.id }, LATER)
    expect(await codeOf(() => cancelReceipt(db, { id: receipt.id }, LATER))).toBe(
      'RECEIPT_CANCELLED',
    )
  })

  it('refuses one that is not in these books', async () => {
    expect(await codeOf(() => cancelReceipt(db, { id: 'nobody' }, LATER))).toBe('RECEIPT_NOT_FOUND')
  })

  /* There is no delete, and this is the assertion that says so. A number handed out is
   * never released (rule 1), so cancelling is the only way out. */
  it('has no delete beside it', async () => {
    const module: Record<string, unknown> = await import('./receipts')
    expect(Object.keys(module)).not.toContain('deleteReceipt')
  })
})

describe('cancelling a document that has been receipted', () => {
  /*
   * Refused rather than detached, and the asymmetry with cancelling a RECEIPT is the
   * point. The money still exists and still belongs to the party; silently un-matching it
   * would create on-account money nobody decided to create.
   */
  it('is refused, with the figure named', async () => {
    const document = await invoice()
    await createReceipt(
      db,
      receiptInput({ allocations: [{ documentId: document.id, amount: '500.00' }] }),
      NOW,
    )

    const failure = await failureOf(() => cancelDocument(db, { id: document.id }, LATER))
    expect(failure.code).toBe('DOCUMENT_ALLOCATED')
    expect(failure.message).toContain('500.00')
  })

  it('goes through once the receipt lets go of it', async () => {
    const document = await invoice()
    const receipt = await createReceipt(
      db,
      receiptInput({ allocations: [{ documentId: document.id, amount: '500.00' }] }),
      NOW,
    )

    await allocateReceipt(db, { id: receipt.id, allocations: [] }, LATER)
    expect((await cancelDocument(db, { id: document.id }, LATER)).status).toBe('cancelled')
  })
})

// ---- What is outstanding ---------------------------------------------------

describe('what a document has outstanding', () => {
  it('is what it put on the account, less what has been allocated', async () => {
    const document = await invoice()
    expect((await documentMovement(db, await control(document.id))).toString()).toBe('1180')

    await createReceipt(
      db,
      receiptInput({
        amount: '500.00',
        allocations: [{ documentId: document.id, amount: '500.00' }],
      }),
      NOW,
    )
    expect((await outstandingForDocument(db, await control(document.id))).toString()).toBe('680')
  })

  it('is nothing for a draft, which has posted nothing', async () => {
    const document = await createDocument(db, draft(), NOW)
    expect((await documentMovement(db, await control(document.id))).toString()).toBe('0')
  })

  /*
   * The one the document contract promised would need no code: "a cancelled invoice's
   * outstanding goes to zero without anybody writing code to make it". The reversal is a
   * second entry and the query takes both, so the two net. Nothing filters on status.
   */
  it('is nothing for a cancelled one, because the reversal nets it out', async () => {
    const document = await invoice()
    await cancelDocument(db, { id: document.id }, LATER)
    expect((await documentMovement(db, await control(document.id))).toString()).toBe('0')
  })

  /*
   * THE IDENTITY. Everything in this file exists to keep it true, and an aged report and
   * the balance sheet cannot disagree while it holds — they are the same sum grouped two
   * ways. Two invoices, one part-allocated receipt, and money left on account.
   */
  it('ties to the control account, with the unallocated money counted', async () => {
    const first = await invoice()
    const second = await invoice({ date: '2026-04-16' })

    const receipt = await createReceipt(
      db,
      receiptInput({
        amount: '1500.00',
        allocations: [{ documentId: first.id, amount: '1180.00' }],
      }),
      NOW,
    )

    const outstanding = (await outstandingForDocument(db, await control(first.id))).plus(
      await outstandingForDocument(db, await control(second.id)),
    )
    const unallocated = (await getReceipt(db, receipt.id))!.unallocated

    /* 2360 invoiced, 1500 received: the customer owes 860. */
    expect(outstanding.minus(unallocated).toString()).toBe('860')
    expect((await accountBalance(db, receivable)).balance).toBe('860.00')
  })

  it('reads the movement off the party lines, not off whichever account holds the role', async () => {
    const document = await invoice()

    /* Repointing the role is an ordinary thing to do while tidying a chart. An
     * implementation that looked the account up by role would report this invoice as
     * outstanding nothing from here on. */
    await setAccountRole(db, 'accounts-receivable', cash)

    expect((await documentMovement(db, await control(document.id))).toString()).toBe('1180')
  })

  /*
   * THE SIGN, THE ONLY WAY IT CAN BE TESTED TODAY. A purchase bill's control line is a
   * CREDIT, so a raw `debit - credit` reports what a vendor is owed as a negative and
   * every payables report would come out upside down. No purchase bill can be issued yet
   * — there is no posting rule — so the state is built directly: a manual entry that
   * credits payables in that vendor's name, and a document row pointing at it.
   *
   * Worth the surgery rather than waiting. The branch is written now, it is wrong in a
   * way that looks like an accounting mistake rather than a bug, and the day purchase
   * bills post is the day nobody would be looking at this line.
   */
  it('reports a purchase bill as a positive amount owed, not a negative one', async () => {
    const payable = (
      await db
        .selectFrom('account_roles')
        .select('account_id')
        .where('role', '=', 'accounts-payable')
        .executeTakeFirstOrThrow()
    ).account_id
    const expense = (
      await db
        .selectFrom('accounts')
        .select('id')
        .where('code', '=', '6700')
        .executeTakeFirstOrThrow()
    ).id

    const posted = await postManualEntry(db, {
      date: '2026-04-15',
      narration: 'Freight bill',
      lines: [
        { accountId: expense, debit: '5000.00', credit: '0.00' },
        { accountId: payable, debit: '0.00', credit: '5000.00', partyId: vendor },
      ],
    })

    const documentId = randomUUID()
    connection
      .prepare(
        `INSERT INTO documents (id, kind, status, number, document_date, party_id,
           place_of_supply_country, rounding_policy, narration, entry_id, created_at,
           updated_at, issued_at)
         VALUES (?, 'purchase-bill', 'issued', 'BILL/1', '2026-04-15', ?, 'in', 'none', '',
           ?, ?, ?, ?)`,
      )
      .run(documentId, vendor, posted.entryId, NOW, NOW, NOW)

    expect((await documentMovement(db, await control(documentId))).toString()).toBe('5000')
  })

  /*
   * A DRAFT CARRYING AN ENTRY, which is the one state the picker's `status = 'issued'`
   * filter catches that the arithmetic does not. 0008's CHECKs constrain the number and
   * the stamps and say nothing about `entry_id` on a draft, so the row below is legal —
   * and it has a real movement, so without the filter it would be offered for settlement
   * as though somebody could pay an invoice that has not been raised.
   *
   * Built directly because nothing in the app can produce it. That is the point: a rule
   * whose only job is to hold a state the code above it never creates can only be tested
   * by creating that state.
   */
  it('does not offer a draft that somehow carries an entry', async () => {
    const document = await invoice()

    /* Its own entry, because `documents.entry_id` is UNIQUE — a real posting that debits
     * the customer, so the draft has a movement the picker would otherwise offer. */
    const posted = await postManualEntry(db, {
      date: '2026-04-15',
      narration: 'Not a document anybody issued',
      lines: [
        { accountId: receivable, debit: '900.00', credit: '0.00', partyId: customer },
        { accountId: bank, debit: '0.00', credit: '900.00' },
      ],
    })

    connection
      .prepare(
        `INSERT INTO documents (id, kind, status, number, document_date, party_id,
           place_of_supply_country, rounding_policy, narration, entry_id, created_at,
           updated_at)
         VALUES (?, 'sales-invoice', 'draft', NULL, '2026-04-15', ?, 'in', 'none', '',
           ?, ?, ?)`,
      )
      .run(randomUUID(), customer, posted.entryId, NOW, NOW)

    const open = await openDocumentsFor(db, { partyId: customer, side: 'sales' })
    expect(open.map((row) => row.id)).toEqual([document.id])
  })

  /*
   * The picker, on the purchase side. The single-document `documentMovement` goes through
   * the same batch since a mutation pass showed what two implementations cost — so this
   * and the test above it now break together rather than one covering for the other.
   */
  it('offers a purchase bill as a positive amount owed', async () => {
    const payable = (
      await db
        .selectFrom('account_roles')
        .select('account_id')
        .where('role', '=', 'accounts-payable')
        .executeTakeFirstOrThrow()
    ).account_id
    const expense = (
      await db
        .selectFrom('accounts')
        .select('id')
        .where('code', '=', '6700')
        .executeTakeFirstOrThrow()
    ).id

    const posted = await postManualEntry(db, {
      date: '2026-04-15',
      narration: 'Freight bill',
      lines: [
        { accountId: expense, debit: '5000.00', credit: '0.00' },
        { accountId: payable, debit: '0.00', credit: '5000.00', partyId: vendor },
      ],
    })

    connection
      .prepare(
        `INSERT INTO documents (id, kind, status, number, document_date, party_id,
           place_of_supply_country, rounding_policy, narration, entry_id, created_at,
           updated_at, issued_at)
         VALUES (?, 'purchase-bill', 'issued', 'BILL/9', '2026-04-15', ?, 'in', 'none', '',
           ?, ?, ?, ?)`,
      )
      .run(randomUUID(), vendor, posted.entryId, NOW, NOW, NOW)

    const open = await openDocumentsFor(db, { partyId: vendor, side: 'purchase' })
    expect(open).toHaveLength(1)
    expect(open[0]?.outstanding.toString()).toBe('5000')
  })

  /*
   * A CREDIT NOTE IS NOT SOMETHING A RECEIPT SETTLES, and it looks like one to every
   * filter that came before this. It is a sales-side document, it posts, it is issued,
   * and it has a real movement on the customer's control account — so the only thing
   * telling it apart from an invoice is its DIRECTION. Without that test the picker
   * offers a refund as something incoming money can pay off, which reads to the ledger
   * as a customer paying us for a return we gave them.
   *
   * NOTHING COULD HAVE CAUGHT THIS BEFORE 0013, because a credit note could not be
   * issued: `sales-invoice` was the only kind with a posting rule, so the side filter and
   * the direction filter agreed on every row that existed.
   */
  it('does not offer a credit note as something a receipt settles', async () => {
    const receivable = (
      await db
        .selectFrom('account_roles')
        .select('account_id')
        .where('role', '=', 'accounts-receivable')
        .executeTakeFirstOrThrow()
    ).account_id
    const returns = (
      await db
        .selectFrom('accounts')
        .select('id')
        .where('code', '=', '4200')
        .executeTakeFirstOrThrow()
    ).id

    const posted = await postManualEntry(db, {
      date: '2026-04-15',
      narration: 'Goods returned',
      lines: [
        { accountId: returns, debit: '400.00', credit: '0.00' },
        { accountId: receivable, debit: '0.00', credit: '400.00', partyId: customer },
      ],
    })

    connection
      .prepare(
        `INSERT INTO documents (id, kind, status, number, document_date, party_id,
           place_of_supply_country, rounding_policy, narration, entry_id, created_at,
           updated_at, issued_at)
         VALUES (?, 'credit-note', 'issued', 'CRN/9', '2026-04-15', ?, 'in', 'none', '',
           ?, ?, ?, ?)`,
      )
      .run(randomUUID(), customer, posted.entryId, NOW, NOW, NOW)

    expect(await openDocumentsFor(db, { partyId: customer, side: 'sales' })).toEqual([])
  })

  /* And the same on the other side: a debit note reduces what we owe a vendor, so it is
   * not something a payment settles either. One rule, both sides. */
  it('does not offer a debit note as something a payment settles', async () => {
    const payable = (
      await db
        .selectFrom('account_roles')
        .select('account_id')
        .where('role', '=', 'accounts-payable')
        .executeTakeFirstOrThrow()
    ).account_id
    const returns = (
      await db
        .selectFrom('accounts')
        .select('id')
        .where('code', '=', '5200')
        .executeTakeFirstOrThrow()
    ).id

    const posted = await postManualEntry(db, {
      date: '2026-04-15',
      narration: 'Goods sent back',
      lines: [
        { accountId: payable, debit: '400.00', credit: '0.00', partyId: vendor },
        { accountId: returns, debit: '0.00', credit: '400.00' },
      ],
    })

    connection
      .prepare(
        `INSERT INTO documents (id, kind, status, number, document_date, party_id,
           place_of_supply_country, rounding_policy, narration, entry_id, created_at,
           updated_at, issued_at)
         VALUES (?, 'debit-note', 'issued', 'DBN/9', '2026-04-15', ?, 'in', 'none', '',
           ?, ?, ?, ?)`,
      )
      .run(randomUUID(), vendor, posted.entryId, NOW, NOW, NOW)

    expect(await openDocumentsFor(db, { partyId: vendor, side: 'purchase' })).toEqual([])
  })

  /*
   * THE SIDE FILTER AND THE PARTY FILTER WERE MASKING EACH OTHER. Every other test in
   * this file has a customer and a vendor who are different people, so dropping
   * `side = options.side` entirely changed nothing: the party filter had already excluded
   * the other side's documents. A mutation removing it survived the whole suite.
   *
   * One firm you both buy from and sell to is ordinary — job work, a distributor who
   * supplies you as well — and for them the two filters stop agreeing. Without the side
   * test, recording a customer receipt would offer their purchase bills as things it
   * could settle, and paying one would credit the wrong control account.
   */
  it('keeps the two sides apart for a party who is both customer and vendor', async () => {
    const both = (
      await createParty(db, {
        name: 'Coromandel Forge',
        countryCode: 'in',
        isCustomer: true,
        isVendor: true,
      })
    ).id
    const receivable = (
      await db
        .selectFrom('account_roles')
        .select('account_id')
        .where('role', '=', 'accounts-receivable')
        .executeTakeFirstOrThrow()
    ).account_id
    const payable = (
      await db
        .selectFrom('account_roles')
        .select('account_id')
        .where('role', '=', 'accounts-payable')
        .executeTakeFirstOrThrow()
    ).account_id
    const expense = (
      await db
        .selectFrom('accounts')
        .select('id')
        .where('code', '=', '6700')
        .executeTakeFirstOrThrow()
    ).id

    const sale = await postManualEntry(db, {
      date: '2026-04-15',
      narration: 'Sold to them',
      lines: [
        { accountId: receivable, debit: '700.00', credit: '0.00', partyId: both },
        { accountId: expense, debit: '0.00', credit: '700.00' },
      ],
    })
    const bill = await postManualEntry(db, {
      date: '2026-04-15',
      narration: 'Bought from them',
      lines: [
        { accountId: expense, debit: '300.00', credit: '0.00' },
        { accountId: payable, debit: '0.00', credit: '300.00', partyId: both },
      ],
    })

    const insert = connection.prepare(
      `INSERT INTO documents (id, kind, status, number, document_date, party_id,
         place_of_supply_country, rounding_policy, narration, entry_id, created_at,
         updated_at, issued_at)
       VALUES (?, ?, 'issued', ?, '2026-04-15', ?, 'in', 'none', '', ?, ?, ?, ?)`,
    )
    insert.run(randomUUID(), 'sales-invoice', 'INV/77', both, sale.entryId, NOW, NOW, NOW)
    insert.run(randomUUID(), 'purchase-bill', 'BILL/77', both, bill.entryId, NOW, NOW, NOW)

    const sales = await openDocumentsFor(db, { partyId: both, side: 'sales' })
    const purchases = await openDocumentsFor(db, { partyId: both, side: 'purchase' })

    expect(sales.map((row) => row.number)).toEqual(['INV/77'])
    expect(purchases.map((row) => row.number)).toEqual(['BILL/77'])
  })

  it('counts what one receipt let go of', async () => {
    const document = await invoice()
    const receipt = await createReceipt(
      db,
      receiptInput({ allocations: [{ documentId: document.id, amount: '1180.00' }] }),
      NOW,
    )
    expect((await allocatedFromReceipt(db, receipt.id)).toString()).toBe('1180')
  })
})

// ---- Listing ---------------------------------------------------------------

describe('the register', () => {
  it('lists newest first, with what each has left', async () => {
    await createReceipt(db, receiptInput({ date: '2026-04-18', amount: '100.00' }), NOW)
    await createReceipt(db, receiptInput({ date: '2026-04-22', amount: '200.00' }), NOW)

    const rows = await listReceipts(db)
    expect(rows.map((row) => row.date)).toEqual(['2026-04-22', '2026-04-18'])
    expect(rows[0]?.unallocated).toBe('200.00')
  })

  it('filters by kind, status and party', async () => {
    const receipt = await createReceipt(db, receiptInput(), NOW)
    await createReceipt(
      db,
      receiptInput({ kind: 'payment', partyId: vendor, amount: '50.00' }),
      NOW,
    )
    await cancelReceipt(db, { id: receipt.id }, LATER)

    expect(await listReceipts(db, { kind: 'payment' })).toHaveLength(1)
    expect(await listReceipts(db, { status: 'cancelled' })).toHaveLength(1)
    expect(await listReceipts(db, { partyId: vendor })).toHaveLength(1)
  })

  it('searches the number, the party, the reference and the narration', async () => {
    await createReceipt(db, receiptInput({ reference: 'UTR8842', narration: 'advance' }), NOW)

    expect(await listReceipts(db, { search: 'utr88' })).toHaveLength(1)
    expect(await listReceipts(db, { search: 'ADVANCE' })).toHaveLength(1)
    expect(await listReceipts(db, { search: 'bharat' })).toHaveLength(1)
    expect(await listReceipts(db, { search: 'RCT/2026-27' })).toHaveLength(1)
    expect(await listReceipts(db, { search: 'nothing like it' })).toHaveLength(0)
  })

  it('bounds a page however large a limit it is asked for', async () => {
    /*
     * A CEILING CAN ONLY BE TESTED BY EXCEEDING IT — the 2.2b finding, and the first
     * version of this test made the same mistake it warns about: it asked for more than
     * the cap out of one row, which passes whether the clamp exists or not.
     *
     * The rows go in with the foreign keys off and an invented entry id, because what is
     * being tested is a `LIMIT` and building five hundred real ledger entries would be
     * the slow way to learn nothing more. Everything else about them is a legal row.
     */
    const seed = await createReceipt(db, receiptInput(), NOW)
    connection.pragma('foreign_keys = OFF')
    try {
      const insert = connection.prepare(
        `INSERT INTO receipts (id, kind, status, number, series_id, receipt_date, party_id,
           amount, account_id, reference, narration, entry_id, created_at, updated_at)
         VALUES (?, 'receipt', 'posted', ?, ?, '2026-04-20', ?, '1.00', ?, '', '', ?, ?, ?)`,
      )
      const series = (await getReceipt(db, seed.id))!.seriesId
      for (let index = 0; index < MAX_RECEIPT_PAGE; index += 1) {
        insert.run(randomUUID(), `BULK/${index}`, series, customer, bank, randomUUID(), NOW, NOW)
      }
    } finally {
      connection.pragma('foreign_keys = ON')
    }

    expect(await listReceipts(db, { limit: MAX_RECEIPT_PAGE + 500 })).toHaveLength(MAX_RECEIPT_PAGE)
  })

  it('answers null for a receipt that is not there', async () => {
    expect(await getReceipt(db, 'nobody')).toBeNull()
  })
})

// ---- Migration 0012 --------------------------------------------------------

describe('migration 0012', () => {
  /*
   * Every test below goes STRAIGHT AT THE TABLE. The repository refuses the same things
   * first, so a test that went through it would pass against a database whose triggers
   * had all been deleted — which is the blindness this codebase has now been caught by
   * five times.
   */

  async function postedReceipt(): Promise<string> {
    return (await createReceipt(db, receiptInput(), NOW)).id
  }

  it('refuses an allocation between two different parties', async () => {
    const document = await invoice()
    const other = await createParty(db, {
      name: 'Nilgiri Tools',
      countryCode: 'in',
      isCustomer: true,
    })
    const receipt = (await createReceipt(db, receiptInput({ partyId: other.id }), NOW)).id

    expect(() => writeAllocation(receipt, document.id, '100.00')).toThrow(
      /ALLOCATION_PARTY_MISMATCH/,
    )
  })

  /*
   * NULL IS REFUSED RATHER THAN SWALLOWED, which is the 2.2c finding stated as a test:
   * `<>` against a NULL is NULL, a `WHEN` that evaluates to NULL does not fire, and a
   * trigger that does not fire is a rule that is not there.
   *
   * WHICH of the three rules speaks is deliberately not asserted, and the reason is in
   * 0012's header: they overlap on exactly this case, so all three would have to be
   * spelt `<>` before a row got through. Pinning the code here would pin the order
   * SQLite happens to fire them in, which is not a rule anybody wrote.
   */
  it('refuses a row naming a receipt or a document that does not exist', async () => {
    const document = await invoice()
    const receipt = await postedReceipt()

    expect(() => writeAllocation(randomUUID(), document.id, '100.00')).toThrow(
      /ALLOCATION_|RECEIPT_/,
    )
    expect(() => writeAllocation(receipt, randomUUID(), '100.00')).toThrow(/ALLOCATION_|DOCUMENT_/)
  })

  it('refuses an allocation against a draft', async () => {
    const document = await createDocument(db, draft(), NOW)
    const receipt = await postedReceipt()
    expect(() => writeAllocation(receipt, document.id, '100.00')).toThrow(/DOCUMENT_NOT_ISSUED/)
  })

  it('refuses an allocation against a cancelled document', async () => {
    const document = await invoice()
    const receipt = await postedReceipt()
    await cancelDocument(db, { id: document.id }, LATER)

    expect(() => writeAllocation(receipt, document.id, '100.00')).toThrow(/DOCUMENT_NOT_ISSUED/)
  })

  it('refuses an allocation against a cancelled receipt', async () => {
    const document = await invoice()
    const receipt = await postedReceipt()
    await cancelReceipt(db, { id: receipt }, LATER)

    expect(() => writeAllocation(receipt, document.id, '100.00')).toThrow(/RECEIPT_CANCELLED/)
  })

  it('refuses allocations adding up to more than the receipt holds', async () => {
    const first = await invoice()
    const second = await invoice({ date: '2026-04-16' })
    const receipt = (await createReceipt(db, receiptInput({ amount: '1500.00' }), NOW)).id

    writeAllocation(receipt, first.id, '1180.00')
    expect(() => writeAllocation(receipt, second.id, '400.00')).toThrow(
      /ALLOCATION_EXCEEDS_RECEIPT/,
    )
  })

  it('allows allocations adding up to exactly what the receipt holds', async () => {
    const first = await invoice()
    const second = await invoice({ date: '2026-04-16' })
    const receipt = (await createReceipt(db, receiptInput({ amount: '1500.00' }), NOW)).id

    writeAllocation(receipt, first.id, '1180.00')
    expect(() => writeAllocation(receipt, second.id, '320.00')).not.toThrow()
  })

  it('refuses to edit an allocation at all', async () => {
    const document = await invoice()
    const receipt = await postedReceipt()
    writeAllocation(receipt, document.id, '100.00')

    expect(() =>
      connection.prepare(`UPDATE receipt_allocations SET amount = '200.00'`).run(),
    ).toThrow(/ALLOCATION_IMMUTABLE/)
  })

  it('refuses to cancel a document that money is allocated against', async () => {
    const document = await invoice()
    const receipt = await postedReceipt()
    writeAllocation(receipt, document.id, '100.00')

    expect(() =>
      connection
        .prepare(`UPDATE documents SET status = 'cancelled', cancelled_at = ? WHERE id = ?`)
        .run(LATER, document.id),
    ).toThrow(/DOCUMENT_ALLOCATED/)
  })

  it('refuses two allocation rows for one receipt and one document', async () => {
    const document = await invoice()
    const receipt = await postedReceipt()
    writeAllocation(receipt, document.id, '100.00')

    expect(() => writeAllocation(receipt, document.id, '100.00')).toThrow(/UNIQUE/)
  })

  it('refuses a receipt for nothing, or for a negative, at the column', async () => {
    const insert = (amount: string) =>
      connection
        .prepare(
          `INSERT INTO receipts (id, kind, status, number, series_id, receipt_date, party_id,
             amount, account_id, reference, narration, entry_id, created_at, updated_at)
           SELECT ?, 'receipt', 'posted', ?, series_id, '2026-04-20', ?, ?, ?, '', '', entry_id,
             ?, ? FROM receipts LIMIT 1`,
        )
        .run(randomUUID(), `X-${amount}`, customer, amount, bank, NOW, NOW)

    await postedReceipt()
    expect(() => insert('0.00')).toThrow(/CHECK constraint failed/)
    expect(() => insert('-5.00')).toThrow(/CHECK constraint failed/)
  })

  it('refuses two receipts of one kind carrying the same number', async () => {
    const first = await postedReceipt()
    expect(() =>
      connection
        .prepare(
          `INSERT INTO receipts (id, kind, status, number, series_id, receipt_date, party_id,
             amount, account_id, reference, narration, entry_id, created_at, updated_at)
           SELECT ?, kind, status, number, series_id, receipt_date, party_id, amount, account_id,
             reference, narration, ?, created_at, updated_at FROM receipts WHERE id = ?`,
        )
        .run(randomUUID(), randomUUID(), first),
    ).toThrow(/UNIQUE/)
  })

  it('holds no figure that could disagree with the ledger', () => {
    const columns = connection
      .prepare<[], { name: string }>(`PRAGMA table_info(receipts)`)
      .all()
      .map((row) => row.name)

    for (const forbidden of ['allocated', 'unallocated', 'is_settled', 'outstanding']) {
      expect(columns).not.toContain(forbidden)
    }
  })

  /*
   * The CHECK is a list of strings and `NUMBERED_KINDS` is a TypeScript table, so nothing
   * makes them agree except this. A kind added to one and not the other produces a series
   * that no picker offers and no document can use, or one the database refuses with a
   * constraint name.
   */
  it('lets a series be created for every kind the domain knows, and no other', async () => {
    for (const definition of NUMBERED_KINDS) {
      const series = await createSeries(db, {
        kind: definition.kind,
        label: `Check ${definition.kind}`,
      })
      expect(series.kind).toBe(definition.kind)
    }

    expect(() =>
      connection
        .prepare(
          `INSERT INTO numbering_series (id, kind, label, created_at, updated_at)
           VALUES (?, 'delivery-note', 'Nope', ?, ?)`,
        )
        .run(randomUUID(), NOW, NOW),
    ).toThrow(/CHECK constraint failed/)
  })

  /* The rebuild has to put 0007's rules back. A series that has issued something still
   * cannot change shape — if the trigger were lost, nothing else would notice. */
  it('keeps the frozen-shape trigger the rebuild had to recreate', async () => {
    await postedReceipt()
    const series = await db
      .selectFrom('numbering_series')
      .select('id')
      .where('kind', '=', 'receipt')
      .executeTakeFirstOrThrow()

    expect(() =>
      connection.prepare(`UPDATE numbering_series SET prefix = 'RC' WHERE id = ?`).run(series.id),
    ).toThrow(/SERIES_IN_USE/)
  })

  it('keeps the one-default-per-kind index the rebuild had to recreate', async () => {
    expect(() =>
      connection
        .prepare(
          `INSERT INTO numbering_series (id, kind, label, is_default, created_at, updated_at)
           VALUES (?, 'receipt', 'Second', 1, ?, ?)`,
        )
        .run(randomUUID(), NOW, NOW),
    ).toThrow(/UNIQUE/)
  })
})
