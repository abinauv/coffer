/*
 * Offsets, against a real encrypted database.
 *
 * The same two things receipts.test.ts tells apart, and the same reason for telling them
 * apart.
 *
 * THE ARITHMETIC. An offset moves no money and posts no entry, so the only way to see it
 * is in what two documents have left — and the property that has to hold is that a row
 * subtracted at both ends CANCELS out of the control account. The identity is the one
 * rule 3 promises, unchanged by this table having been added underneath it:
 *
 *   party control balance  =  SUM(document outstanding)  -  SUM(receipt unallocated)
 *
 * THE RULES. 0016's five triggers, and the repository checks in front of them. Each
 * trigger gets a test that goes STRAIGHT AT THE TABLE with raw SQL, because the
 * repository refuses the same thing first and a test that only went through `setOffsets`
 * would pass against a database that had stopped checking — the defence-in-depth
 * blindness this codebase has been caught by in five separate batches.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { D } from '@main/domain/money'
import { aprilToMarch } from '@main/domain/time'
import {
  DOCUMENT_KINDS,
  correctionMap,
  definitionOf,
  type DocumentKind,
} from '@main/domain/documents'
import type { CreateReceiptInput, CreateTaxedDocumentInput, TaxedLineInput } from '@shared/dto'

import { DATABASE_KEY_BYTES, closeDatabase, openDatabase, type SqliteDatabase } from '../connection'
import { createQueryBuilder, type CofferDb } from '../kysely'
import { runMigrations } from '../migrate'
import { MIGRATIONS } from '../migrations'
import { accountBalance } from './balances'
import { setUpBooks } from './bootstrap'
import { createDocument } from './documents'
import { isRepoError, type RepoError, type RepoErrorCode } from './errors'
import { cancelDocument, issueDocument } from './issuing'
import { setOffsets } from './offsets'
import {
  allocatedFromReceipt,
  offsetToDocument,
  openChargesFor,
  openDocumentsFor,
  outstandingForDocument,
  settlementFor,
} from './outstanding'
import { createParty } from './parties'
import { createReceipt } from './receipts'
import { taxAccountsFor } from './tax-accounts'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x2e)
const NOW = '2026-04-20T09:00:00.000Z'

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase
let db: CofferDb
let customer: string
let other: string
let vendor: string
let bank: string
let receivable: string

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-offsets-'))
  directories.push(dir)
  connection = openDatabase({ filePath: join(dir, 'company.coffer'), key: KEY })
  handles.push(connection)
  runMigrations(connection, MIGRATIONS)
  db = createQueryBuilder(connection)

  await setUpBooks(db, {
    rule: aprilToMarch,
    extraAccounts: taxAccountsFor([
      { code: 'CGST', label: 'Central GST', levy: 'both' },
      { code: 'SGST', label: 'State GST', levy: 'both' },
    ]),
  })

  customer = (await createParty(db, { name: 'Bharat Steel', countryCode: 'in', isCustomer: true }))
    .id
  other = (await createParty(db, { name: 'Nilgiri Works', countryCode: 'in', isCustomer: true })).id
  vendor = (await createParty(db, { name: 'Coastal Freight', countryCode: 'in', isVendor: true }))
    .id

  const accounts = await db.selectFrom('accounts').select(['id', 'code']).execute()
  bank = new Map(accounts.map((account) => [account.code, account.id])).get('1210')!

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

/** An issued document for 1,180.00 unless told otherwise. */
async function issued(over: Partial<CreateTaxedDocumentInput> = {}) {
  const document = await createDocument(db, draft(over), NOW)
  return issueDocument(db, { id: document.id }, NOW)
}

const invoice = (over: Partial<CreateTaxedDocumentInput> = {}) => issued(over)
const note = (over: Partial<CreateTaxedDocumentInput> = {}) =>
  issued({ kind: 'credit-note', ...over })

/** The document row shape `outstanding.ts` reads, fetched for an assertion. */
async function control(documentId: string) {
  const row = await db
    .selectFrom('documents')
    .select(['id', 'kind', 'party_id', 'entry_id'])
    .where('id', '=', documentId)
    .executeTakeFirstOrThrow()
  return { id: row.id, kind: row.kind, partyId: row.party_id, entryId: row.entry_id }
}

async function left(documentId: string): Promise<string> {
  return (await outstandingForDocument(db, await control(documentId))).toString()
}

/** Write an offset straight into the table, past every repository check. */
function writeOffset(chargeId: string, refundId: string, amount = '100.00'): void {
  connection
    .prepare(
      `INSERT INTO document_offsets
         (id, charge_document_id, refund_document_id, amount, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), chargeId, refundId, amount, NOW)
}

const receiptInput = (over: Partial<CreateReceiptInput> = {}): CreateReceiptInput => ({
  kind: 'receipt',
  date: '2026-04-20',
  partyId: customer,
  amount: '500.00',
  accountId: bank,
  ...over,
})

// ---- What an offset does ---------------------------------------------------

describe('setting a credit note against an invoice', () => {
  it('takes the same amount off both ends', async () => {
    const charge = await invoice()
    const refund = await note()

    await setOffsets(
      db,
      { refundDocumentId: refund.id, offsets: [{ chargeDocumentId: charge.id, amount: '400.00' }] },
      NOW,
    )

    expect(await left(charge.id)).toBe('780')
    expect(await left(refund.id)).toBe('780')
  })

  /*
   * THE PROPERTY THE WHOLE TABLE RESTS ON. An offset moves no money — so whatever it does
   * to the two documents, the control account must be exactly where it was. Both figures
   * are asserted rather than only their difference, because a pair of errors that cancel
   * is precisely how the aged report was wrong before this batch.
   */
  it('leaves the control account untouched', async () => {
    const charge = await invoice()
    const refund = await note()
    const before = (await accountBalance(db, receivable)).balance

    await setOffsets(
      db,
      { refundDocumentId: refund.id, offsets: [{ chargeDocumentId: charge.id, amount: '400.00' }] },
      NOW,
    )

    expect((await accountBalance(db, receivable)).balance).toBe(before)
    /* And it is not zero by accident of nothing having been posted: the invoice and the
     * note are both on the account and cancel each other, which is what makes the
     * assertion above about the OFFSET rather than about an empty ledger. */
    expect(before).toBe('0.00')
    expect((await accountBalance(db, receivable)).debit).toBe('1180.00')
  })

  it('settles both in full when the two are the same size', async () => {
    const charge = await invoice()
    const refund = await note()

    await setOffsets(
      db,
      {
        refundDocumentId: refund.id,
        offsets: [{ chargeDocumentId: charge.id, amount: '1180.00' }],
      },
      NOW,
    )

    expect(await left(charge.id)).toBe('0')
    expect(await left(refund.id)).toBe('0')
  })

  it('spreads one note across several invoices', async () => {
    const first = await invoice()
    const second = await invoice({ date: '2026-04-16' })
    const refund = await note()

    await setOffsets(
      db,
      {
        refundDocumentId: refund.id,
        offsets: [
          { chargeDocumentId: first.id, amount: '700.00' },
          { chargeDocumentId: second.id, amount: '480.00' },
        ],
      },
      NOW,
    )

    expect(await left(first.id)).toBe('480')
    expect(await left(second.id)).toBe('700')
    expect(await left(refund.id)).toBe('0')
  })

  it('takes credit from two notes against one invoice', async () => {
    const charge = await invoice()
    const first = await note()
    const second = await note({ date: '2026-04-16' })

    for (const refund of [first, second]) {
      await setOffsets(
        db,
        {
          refundDocumentId: refund.id,
          offsets: [{ chargeDocumentId: charge.id, amount: '400.00' }],
        },
        NOW,
      )
    }

    expect(await left(charge.id)).toBe('380')
    expect(await offsetToDocument(db, charge.id)).toBeTruthy()
    expect((await offsetToDocument(db, charge.id)).toString()).toBe('800')
  })

  /*
   * REPLACED WHOLESALE, NEVER ADDED TO. The second call is the whole statement, so the
   * first call's row is gone rather than joined — and a test that only ever saved once
   * would pass against an implementation that appended, right up until a user changed
   * their mind.
   */
  it('replaces the whole set rather than adding to it', async () => {
    const charge = await invoice()
    const refund = await note()
    const set = (amount: string) =>
      setOffsets(
        db,
        { refundDocumentId: refund.id, offsets: [{ chargeDocumentId: charge.id, amount }] },
        NOW,
      )

    await set('400.00')
    await set('900.00')

    expect(await left(charge.id)).toBe('280')
    expect(await left(refund.id)).toBe('280')
  })

  it('puts both back on account when the set is emptied', async () => {
    const charge = await invoice()
    const refund = await note()
    await setOffsets(
      db,
      { refundDocumentId: refund.id, offsets: [{ chargeDocumentId: charge.id, amount: '400.00' }] },
      NOW,
    )

    await setOffsets(db, { refundDocumentId: refund.id, offsets: [] }, NOW)

    expect(await left(charge.id)).toBe('1180')
    expect(await left(refund.id)).toBe('1180')
  })

  /* Re-saving an unchanged set is a no-op and not a refusal. It is the commonest thing a
   * panel does — open, change nothing, press save — and it only works because the delete
   * happens before the caps are read. */
  it('accepts the same set saved twice over', async () => {
    const charge = await invoice()
    const refund = await note()
    const save = () =>
      setOffsets(
        db,
        {
          refundDocumentId: refund.id,
          offsets: [{ chargeDocumentId: charge.id, amount: '1180.00' }],
        },
        NOW,
      )

    await save()
    await save()

    expect(await left(charge.id)).toBe('0')
  })

  it('works the same way on the purchase side', async () => {
    const bill = await issued({ kind: 'purchase-bill', partyId: vendor })
    const debit = await issued({ kind: 'debit-note', partyId: vendor })

    await setOffsets(
      db,
      { refundDocumentId: debit.id, offsets: [{ chargeDocumentId: bill.id, amount: '300.00' }] },
      NOW,
    )

    expect(await left(bill.id)).toBe('880')
    expect(await left(debit.id)).toBe('880')
  })
})

// ---- Beside money ----------------------------------------------------------

describe('an offset and a receipt against one invoice', () => {
  it('both come off, and the invoice can be settled by the two together', async () => {
    const charge = await invoice()
    const refund = await note()

    await setOffsets(
      db,
      { refundDocumentId: refund.id, offsets: [{ chargeDocumentId: charge.id, amount: '680.00' }] },
      NOW,
    )
    await createReceipt(
      db,
      receiptInput({ allocations: [{ documentId: charge.id, amount: '500.00' }] }),
      NOW,
    )

    expect(await left(charge.id)).toBe('0')
  })

  /*
   * THE CAP READS BOTH SOURCES, which is the thing that would be wrong if `outstanding`
   * had grown a second function instead of one more subtraction. The invoice has 500 left
   * after the offset, so a receipt for 600 against it is refused — and the message says
   * 500, not 1,180.
   */
  it('refuses a receipt for more than is left after the offset', async () => {
    const charge = await invoice()
    const refund = await note()
    await setOffsets(
      db,
      { refundDocumentId: refund.id, offsets: [{ chargeDocumentId: charge.id, amount: '680.00' }] },
      NOW,
    )

    const failure = await failureOf(() =>
      createReceipt(
        db,
        receiptInput({
          amount: '600.00',
          allocations: [{ documentId: charge.id, amount: '600.00' }],
        }),
        NOW,
      ),
    )

    expect(failure.code).toBe('ALLOCATION_EXCEEDS_DOCUMENT')
    expect(failure.details['outstanding']).toBe('500.00')
  })

  /* And the mirror: a refund voucher may not take more than the note has left once part
   * of it has been offset. Same figure, read from the other kind of document. */
  it('refuses a refund for more than the note has left after the offset', async () => {
    const charge = await invoice()
    const refund = await note()
    await setOffsets(
      db,
      {
        refundDocumentId: refund.id,
        offsets: [{ chargeDocumentId: charge.id, amount: '1000.00' }],
      },
      NOW,
    )

    expect(
      await codeOf(() =>
        createReceipt(
          db,
          receiptInput({
            kind: 'refund',
            amount: '300.00',
            allocations: [{ documentId: refund.id, amount: '300.00' }],
          }),
          NOW,
        ),
      ),
    ).toBe('ALLOCATION_EXCEEDS_DOCUMENT')
  })

  /*
   * THE IDENTITY, WITH BOTH KINDS OF MATCH IN PLAY. Rule 3 of the receipt contract, and
   * the reason an aged report cannot disagree with the balance sheet: every matching row
   * is subtracted at two ends that face opposite ways, so it contributes nothing at all
   * to the account.
   */
  it('keeps the control account equal to what is open, offsets and all', async () => {
    const charge = await invoice()
    const refund = await note()
    await setOffsets(
      db,
      { refundDocumentId: refund.id, offsets: [{ chargeDocumentId: charge.id, amount: '400.00' }] },
      NOW,
    )
    const receipt = await createReceipt(
      db,
      receiptInput({ allocations: [{ documentId: charge.id, amount: '500.00' }] }),
      NOW,
    )

    const balance = D((await accountBalance(db, receivable)).balance)
    const chargeOpen = await outstandingForDocument(db, await control(charge.id))
    const refundOpen = await outstandingForDocument(db, await control(refund.id))
    const unallocated = D(receipt.amount).minus(await allocatedFromReceipt(db, receipt.id))

    /* A refund document's outstanding stands to the party's CREDIT, so it comes off the
     * charges rather than adding to them — the same sign the account gives it. */
    expect(balance.toString()).toBe(chargeOpen.minus(refundOpen).minus(unallocated).toString())

    /* And the figures themselves, so the identity is not satisfied by three zeros. */
    expect(chargeOpen.toString()).toBe('280')
    expect(refundOpen.toString()).toBe('780')
    expect(unallocated.toString()).toBe('0')
    expect(balance.toString()).toBe('-500')
  })
})

// ---- What the repository refuses -------------------------------------------

describe('what the repository refuses, with the figures in it', () => {
  it('refuses more than the note has left, naming what is left', async () => {
    const charge = await invoice()
    const refund = await note()

    const failure = await failureOf(() =>
      setOffsets(
        db,
        {
          refundDocumentId: refund.id,
          offsets: [{ chargeDocumentId: charge.id, amount: '1500.00' }],
        },
        NOW,
      ),
    )

    expect(failure.code).toBe('OFFSET_EXCEEDS_DOCUMENT')
    expect(failure.details['outstanding']).toBe('1180.00')
    /* Ungrouped, because `toMoneyString` is the storage shape and the Indian grouping is
     * the renderer's job (2.2e-2). A message asserting '1,180.00' would be asserting that
     * main had started formatting money for a screen. */
    expect(failure.message).toContain('1180.00')
    expect(failure.message).toContain('1500.00')
  })

  /*
   * THE OWN END WITH EVERY FAR END INSIDE ITS OWN CAP, which is the only shape that can
   * see this rule at all. A mutation pass found both of the assertions above passing
   * against a repository with NO refund-end check: 1,500 against a single 1,180 invoice
   * trips the FAR end, which answers the same code with the same figure, so the test
   * could not tell the two apart. Two invoices of 1,180 and offsets of 700 and 600 are
   * each within their own invoice and 1,300 together, so only the note can refuse them.
   *
   * IT ALSO PINS THAT THE CAP READS THE TOTAL. Taking the first line alone — 700, which
   * fits — is a mutation this is the only test to kill.
   */
  it('refuses a set that fits every invoice but not the note', async () => {
    const first = await invoice()
    const second = await invoice({ date: '2026-04-16' })
    const refund = await note()

    const failure = await failureOf(() =>
      setOffsets(
        db,
        {
          refundDocumentId: refund.id,
          offsets: [
            { chargeDocumentId: first.id, amount: '700.00' },
            { chargeDocumentId: second.id, amount: '600.00' },
          ],
        },
        NOW,
      ),
    )

    expect(failure.code).toBe('OFFSET_EXCEEDS_DOCUMENT')
    expect(failure.details['documentId']).toBe(refund.id)
    expect(failure.details['requested']).toBe('1300.00')
    expect(failure.message).toContain(refund.number ?? '')
    expect(failure.message).toContain('left to set against anything')

    /* And nothing was written: the refusal happens before the first insert. */
    expect((await offsetToDocument(db, first.id)).toString()).toBe('0')
  })

  /* The far end, which is a different sentence because it is a different mistake: the
   * note has plenty left and this particular invoice does not. */
  it('refuses more than the invoice has outstanding', async () => {
    /* 200.00 of goods and the fixture's 180.00 of tax: 380.00 on the account, which is
     * the figure the refusal has to name rather than the note's own 1,180.00. */
    const charge = await invoice({
      lines: [line({ unitPrice: '100.00', taxableAmount: '200.00' })],
    })
    const refund = await note()

    const failure = await failureOf(() =>
      setOffsets(
        db,
        {
          refundDocumentId: refund.id,
          offsets: [{ chargeDocumentId: charge.id, amount: '500.00' }],
        },
        NOW,
      ),
    )

    expect(failure.code).toBe('OFFSET_EXCEEDS_DOCUMENT')
    expect(failure.details['outstanding']).toBe('380.00')
    expect(failure.message).toContain('outstanding')
  })

  it('refuses the same invoice twice in one set', async () => {
    const charge = await invoice()
    const refund = await note()

    expect(
      await codeOf(() =>
        setOffsets(
          db,
          {
            refundDocumentId: refund.id,
            offsets: [
              { chargeDocumentId: charge.id, amount: '100.00' },
              { chargeDocumentId: charge.id, amount: '100.00' },
            ],
          },
          NOW,
        ),
      ),
    ).toBe('OFFSET_EXCEEDS_DOCUMENT')
  })

  it('refuses an offset of nothing, and one that is not money', async () => {
    const charge = await invoice()
    const refund = await note()
    const set = (amount: string) =>
      setOffsets(
        db,
        { refundDocumentId: refund.id, offsets: [{ chargeDocumentId: charge.id, amount }] },
        NOW,
      )

    expect(await codeOf(() => set('0.00'))).toBe('OFFSET_AMOUNT_INVALID')
    expect(await codeOf(() => set('-100.00'))).toBe('OFFSET_AMOUNT_INVALID')
    expect(await codeOf(() => set('a hundred'))).toBe('OFFSET_AMOUNT_INVALID')
  })

  it("refuses another party's invoice", async () => {
    const charge = await invoice({ partyId: other })
    const refund = await note()

    const failure = await failureOf(() =>
      setOffsets(
        db,
        {
          refundDocumentId: refund.id,
          offsets: [{ chargeDocumentId: charge.id, amount: '100.00' }],
        },
        NOW,
      ),
    )

    expect(failure.code).toBe('OFFSET_PARTY_MISMATCH')
    expect(failure.message).toContain('different party')
  })

  it('refuses a draft at either end', async () => {
    const charge = await invoice()
    const refund = await note()
    const draftInvoice = await createDocument(db, draft(), NOW)
    const draftNote = await createDocument(db, draft({ kind: 'credit-note' }), NOW)

    expect(
      await codeOf(() =>
        setOffsets(
          db,
          {
            refundDocumentId: refund.id,
            offsets: [{ chargeDocumentId: draftInvoice.id, amount: '100.00' }],
          },
          NOW,
        ),
      ),
    ).toBe('DOCUMENT_NOT_ISSUED')

    expect(
      await codeOf(() =>
        setOffsets(
          db,
          {
            refundDocumentId: draftNote.id,
            offsets: [{ chargeDocumentId: charge.id, amount: '100.00' }],
          },
          NOW,
        ),
      ),
    ).toBe('DOCUMENT_NOT_ISSUED')
  })

  it('refuses a cancelled invoice, which owes nothing', async () => {
    const charge = await invoice()
    const refund = await note()
    await cancelDocument(db, { id: charge.id }, NOW)

    const failure = await failureOf(() =>
      setOffsets(
        db,
        {
          refundDocumentId: refund.id,
          offsets: [{ chargeDocumentId: charge.id, amount: '100.00' }],
        },
        NOW,
      ),
    )

    expect(failure.code).toBe('DOCUMENT_NOT_ISSUED')
    expect(failure.message).toContain('cancelled')
  })

  /*
   * A CREDIT NOTE AGAINST A CREDIT NOTE. Two documents, one party, both issued, both
   * posting — every question 0012's rules would ask answers yes. What is wrong is that
   * they face the same way, so the pair takes both figures FURTHER from zero while the
   * control account is unmoved. It is 0015's argument about a refund voucher, one table
   * across.
   */
  it('refuses a document facing the same way as the one settling it', async () => {
    const first = await note()
    const second = await note({ date: '2026-04-16' })

    const failure = await failureOf(() =>
      setOffsets(
        db,
        {
          refundDocumentId: first.id,
          offsets: [{ chargeDocumentId: second.id, amount: '100.00' }],
        },
        NOW,
      ),
    )

    expect(failure.code).toBe('OFFSET_KIND_MISMATCH')
    expect(failure.message).toContain('sales invoices')
    expect(failure.message).toContain('credit note')
  })

  it('refuses a purchase bill set against a sales credit note', async () => {
    const bill = await issued({ kind: 'purchase-bill', partyId: vendor })
    const refund = await note({ partyId: vendor })

    /* The party is the same, so this is the SIDE being wrong and nothing else — the one
     * case a same-party check could never see. */
    expect(
      await codeOf(() =>
        setOffsets(
          db,
          {
            refundDocumentId: refund.id,
            offsets: [{ chargeDocumentId: bill.id, amount: '100.00' }],
          },
          NOW,
        ),
      ),
    ).toBe('OFFSET_KIND_MISMATCH')
  })

  /* Set FROM an invoice, which is the panel being opened on the wrong document rather
   * than a user error — so the sentence says which document to open instead. */
  it('refuses a set owned by a document that settles nothing', async () => {
    const charge = await invoice()
    const second = await invoice({ date: '2026-04-16' })

    const failure = await failureOf(() =>
      setOffsets(
        db,
        {
          refundDocumentId: charge.id,
          offsets: [{ chargeDocumentId: second.id, amount: '10.00' }],
        },
        NOW,
      ),
    )

    expect(failure.code).toBe('OFFSET_KIND_MISMATCH')
    expect(failure.message).toContain('settles nothing')
  })

  it('refuses a quotation, which posts nothing at all', async () => {
    const quotation = await issued({ kind: 'quotation' })
    const refund = await note()

    expect(
      await codeOf(() =>
        setOffsets(
          db,
          {
            refundDocumentId: refund.id,
            offsets: [{ chargeDocumentId: quotation.id, amount: '10.00' }],
          },
          NOW,
        ),
      ),
    ).toBe('OFFSET_KIND_MISMATCH')
  })

  it('refuses a document these books do not have, at either end', async () => {
    const refund = await note()

    expect(
      await codeOf(() =>
        setOffsets(
          db,
          {
            refundDocumentId: refund.id,
            offsets: [{ chargeDocumentId: 'nobody', amount: '1.00' }],
          },
          NOW,
        ),
      ),
    ).toBe('DOCUMENT_NOT_FOUND')
    expect(
      await codeOf(() => setOffsets(db, { refundDocumentId: 'nobody', offsets: [] }, NOW)),
    ).toBe('DOCUMENT_NOT_FOUND')
  })

  /*
   * ONE TRANSACTION, AND THE PROOF IS THE SET THAT SURVIVES. The delete runs first, so a
   * set refused on its second line would otherwise leave the user with NOTHING — the
   * offsets they had, gone, and the ones they asked for, not written.
   */
  it('leaves the previous set alone when a save is refused half way through', async () => {
    const first = await invoice()
    const second = await invoice({ date: '2026-04-16' })
    const refund = await note()
    await setOffsets(
      db,
      { refundDocumentId: refund.id, offsets: [{ chargeDocumentId: first.id, amount: '400.00' }] },
      NOW,
    )

    await expect(
      setOffsets(
        db,
        {
          refundDocumentId: refund.id,
          offsets: [
            { chargeDocumentId: first.id, amount: '100.00' },
            { chargeDocumentId: second.id, amount: '9000.00' },
          ],
        },
        NOW,
      ),
    ).rejects.toThrow()

    expect(await left(first.id)).toBe('780')
    expect(await left(refund.id)).toBe('780')
  })
})

// ---- Cancelling either end -------------------------------------------------

describe('cancelling a document something is set against', () => {
  it('is refused from either end, with the figure named', async () => {
    const charge = await invoice()
    const refund = await note()
    await setOffsets(
      db,
      { refundDocumentId: refund.id, offsets: [{ chargeDocumentId: charge.id, amount: '400.00' }] },
      NOW,
    )

    const failure = await failureOf(() => cancelDocument(db, { id: charge.id }, NOW))
    expect(failure.code).toBe('DOCUMENT_OFFSET')
    expect(failure.message).toContain('400.00')

    expect(await codeOf(() => cancelDocument(db, { id: refund.id }, NOW))).toBe('DOCUMENT_OFFSET')
  })

  it('is allowed again once the offset is taken off', async () => {
    const charge = await invoice()
    const refund = await note()
    await setOffsets(
      db,
      { refundDocumentId: refund.id, offsets: [{ chargeDocumentId: charge.id, amount: '400.00' }] },
      NOW,
    )

    await setOffsets(db, { refundDocumentId: refund.id, offsets: [] }, NOW)

    expect((await cancelDocument(db, { id: charge.id }, NOW)).status).toBe('cancelled')
  })
})

// ---- The pickers and the panel ---------------------------------------------

describe('what the offset panel is handed', () => {
  it('offers the party open invoices, oldest first', async () => {
    const first = await invoice()
    const second = await invoice({ date: '2026-04-16' })
    await invoice({ partyId: other })
    const refund = await note()

    const open = await openChargesFor(db, await control(refund.id))

    expect(open.map((row) => row.id)).toEqual([first.id, second.id])
    expect(open[0]?.outstanding.toString()).toBe('1180')
  })

  /*
   * ITS OWN OFFSETS, BACK ON THE TABLE IT IS DRAWING. Without the exclusion the panel
   * would list every invoice EXCEPT the ones it is showing lines for — so a user could
   * not reduce an offset they had made, and the invoice on screen would be missing from
   * the list beside it. Not an equivalent mutant: this picker is called live.
   */
  it('shows an invoice it has already settled in full, with the credit back on it', async () => {
    const charge = await invoice()
    const refund = await note()
    await setOffsets(
      db,
      {
        refundDocumentId: refund.id,
        offsets: [{ chargeDocumentId: charge.id, amount: '1180.00' }],
      },
      NOW,
    )

    const open = await openChargesFor(db, await control(refund.id))

    expect(open.map((row) => row.id)).toEqual([charge.id])
    expect(open[0]?.outstanding.toString()).toBe('1180')
  })

  /* Another note's offset is NOT put back, because the panel does not own it. */
  it('leaves out what a different note has already settled', async () => {
    const charge = await invoice()
    const first = await note()
    const second = await note({ date: '2026-04-16' })
    await setOffsets(
      db,
      { refundDocumentId: first.id, offsets: [{ chargeDocumentId: charge.id, amount: '1180.00' }] },
      NOW,
    )

    expect(await openChargesFor(db, await control(second.id))).toEqual([])
  })

  it('refuses to fill a picker for a document that settles nothing', async () => {
    const charge = await control((await invoice()).id)
    expect(await codeOf(() => openChargesFor(db, charge))).toBe('OFFSET_KIND_MISMATCH')
  })

  /* The voucher picker reads the same figure. A note settled in full by an offset has
   * nothing left to refund in cash either, so it stops being offered. */
  it('drops a fully offset note from the refund picker', async () => {
    const charge = await invoice()
    const refund = await note()
    expect(await openDocumentsFor(db, { partyId: customer, kind: 'refund' })).toHaveLength(1)

    await setOffsets(
      db,
      {
        refundDocumentId: refund.id,
        offsets: [{ chargeDocumentId: charge.id, amount: '1180.00' }],
      },
      NOW,
    )

    expect(await openDocumentsFor(db, { partyId: customer, kind: 'refund' })).toEqual([])
  })

  it('lists the offset from both ends, described by the other document', async () => {
    const charge = await invoice()
    const refund = await note()
    await setOffsets(
      db,
      { refundDocumentId: refund.id, offsets: [{ chargeDocumentId: charge.id, amount: '400.00' }] },
      NOW,
    )

    const onInvoice = await settlementFor(db, await control(charge.id))
    const onNote = await settlementFor(db, await control(refund.id))

    expect(onInvoice.offset.toString()).toBe('400')
    expect(onInvoice.offsets.map((row) => row.number)).toEqual([refund.number])
    expect(onInvoice.offsets[0]?.kind).toBe('credit-note')
    expect(onNote.offset.toString()).toBe('400')
    expect(onNote.offsets.map((row) => row.number)).toEqual([charge.number])
    expect(onNote.offsets[0]?.kind).toBe('sales-invoice')
    expect(onNote.outstanding.toString()).toBe('780')
  })
})

// ---- 0016's triggers, straight at the table --------------------------------

describe('the rules the database holds', () => {
  it('refuses two ends belonging to different parties', async () => {
    const charge = await invoice({ partyId: other })
    const refund = await note()

    expect(() => writeOffset(charge.id, refund.id)).toThrow(/OFFSET_PARTY_MISMATCH/)
  })

  it('refuses a draft or a cancelled document at either end', async () => {
    const charge = await invoice()
    const refund = await note()
    const draftInvoice = await createDocument(db, draft(), NOW)
    const draftNote = await createDocument(db, draft({ kind: 'credit-note' }), NOW)
    const cancelled = await invoice({ date: '2026-04-17' })
    await cancelDocument(db, { id: cancelled.id }, NOW)

    expect(() => writeOffset(draftInvoice.id, refund.id)).toThrow(/DOCUMENT_NOT_ISSUED/)
    expect(() => writeOffset(charge.id, draftNote.id)).toThrow(/DOCUMENT_NOT_ISSUED/)
    expect(() => writeOffset(cancelled.id, refund.id)).toThrow(/DOCUMENT_NOT_ISSUED/)
  })

  /*
   * THE AGREEMENT TEST 0016'S HEADER PROMISES. `OFFSETS` is a CASE written in SQL because
   * a trigger cannot import a union, and `correctionMap` is the same fact in TypeScript.
   * This asks the database about EVERY kind the domain knows and requires the two to
   * agree in both directions — so a sixth kind cannot be added to `DOCUMENT_KINDS`
   * without something going red here.
   */
  it('accepts exactly the pairings the domain calls charge-and-refund', async () => {
    const corrects = correctionMap(DOCUMENT_KINDS)
    const documents = new Map<DocumentKind, string>()
    for (const definition of DOCUMENT_KINDS) {
      const party = definition.side === 'sales' ? customer : vendor
      documents.set(definition.kind, (await issued({ kind: definition.kind, partyId: party })).id)
    }

    for (const refundKind of DOCUMENT_KINDS) {
      for (const chargeKind of DOCUMENT_KINDS) {
        const charge = documents.get(chargeKind.kind)!
        const refund = documents.get(refundKind.kind)!
        if (charge === refund) continue

        const write = () => writeOffset(charge, refund, '1.00')
        const label = `${chargeKind.kind} settled by ${refundKind.kind}`

        if (corrects.get(refundKind.kind) === chargeKind.kind) {
          expect(write, `${label} must be accepted`).not.toThrow()
        } else {
          expect(write, `${label} must be refused`).toThrow(/OFFSET_KIND_MISMATCH/)
        }
      }
    }
  })

  /*
   * `IS NOT` RATHER THAN `<>`, AND HERE IT IS LOAD-BEARING. The CASE answers NULL for any
   * CHARGE kind at the refund end — a real document, not a missing one — so `<>` would
   * evaluate to NULL, the `WHEN` would not fire, and an invoice set against an invoice
   * would be written in silence. That is the row this table exists to refuse.
   */
  it('refuses a charge document standing at the refund end', async () => {
    const first = await invoice()
    const second = await invoice({ date: '2026-04-16' })

    expect(() => writeOffset(first.id, second.id)).toThrow(/OFFSET_KIND_MISMATCH/)
  })

  it('refuses a document set against itself', async () => {
    const refund = await note()
    expect(() => writeOffset(refund.id, refund.id)).toThrow(/OFFSET_KIND_MISMATCH/)
  })

  it('refuses one pair twice over', async () => {
    const charge = await invoice()
    const refund = await note()
    writeOffset(charge.id, refund.id)

    expect(() => writeOffset(charge.id, refund.id)).toThrow(/UNIQUE/i)
  })

  it('refuses an amount that is not unsigned money at two places', async () => {
    const charge = await invoice()
    const refund = await note()

    expect(() => writeOffset(charge.id, refund.id, '100')).toThrow(/CHECK/i)
    expect(() => writeOffset(charge.id, refund.id, '100.000')).toThrow(/CHECK/i)
    expect(() => writeOffset(charge.id, refund.id, '-100.00')).toThrow(/CHECK/i)
    expect(() => writeOffset(charge.id, refund.id, '0.00')).toThrow(/CHECK/i)
  })

  it('refuses an edit, so the rules only have to hold on insert', async () => {
    const charge = await invoice()
    const refund = await note()
    writeOffset(charge.id, refund.id)

    expect(() => connection.prepare(`UPDATE document_offsets SET amount = '1.00'`).run()).toThrow(
      /OFFSET_IMMUTABLE/,
    )
  })

  it('refuses a cancel at either end, from the table', async () => {
    const charge = await invoice()
    const refund = await note()
    writeOffset(charge.id, refund.id)

    const cancel = (id: string) =>
      connection
        .prepare(`UPDATE documents SET status = 'cancelled', cancelled_at = ? WHERE id = ?`)
        .run(NOW, id)

    expect(() => cancel(charge.id)).toThrow(/DOCUMENT_OFFSET/)
    expect(() => cancel(refund.id)).toThrow(/DOCUMENT_OFFSET/)
  })

  /*
   * A DOCUMENT WITH AN OFFSET CANNOT BE DELETED, AND THE FOREIGN KEY IS NOT WHAT SAYS SO.
   * MEASURED: the `RESTRICT` never gets a chance, because 0009's freeze trigger refuses
   * to touch a row that has left draft and answers `DOCUMENT_NOT_DRAFT` first. That is
   * exactly what 0016's header claims about both of its keys — floors under a path
   * nothing currently takes — and this is the assertion that keeps the claim honest: the
   * delete is refused, whichever rule gets there.
   */
  it('will not let a document with an offset be deleted out from under it', async () => {
    const charge = await invoice()
    const refund = await note()
    writeOffset(charge.id, refund.id)

    expect(() => connection.prepare(`DELETE FROM documents WHERE id = ?`).run(charge.id)).toThrow()
    expect(() => connection.prepare(`DELETE FROM documents WHERE id = ?`).run(refund.id)).toThrow()
  })
})

// ---- The label the sentences are built from --------------------------------

describe('the words a refusal uses', () => {
  /* The message names what the refund kind DOES settle, because "a credit note does not
   * settle that" is only useful to somebody who is told what it does. */
  it('names both kinds, in the words the rest of the app uses', async () => {
    const first = await note()
    const second = await note({ date: '2026-04-16' })

    const failure = await failureOf(() =>
      setOffsets(
        db,
        { refundDocumentId: first.id, offsets: [{ chargeDocumentId: second.id, amount: '1.00' }] },
        NOW,
      ),
    )

    expect(failure.message).toContain(definitionOf('credit-note').pluralLabel)
    expect(failure.message).toContain(definitionOf('sales-invoice').pluralLabel.toLowerCase())
  })
})
