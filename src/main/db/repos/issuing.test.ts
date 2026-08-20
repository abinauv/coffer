/*
 * Issuing and cancelling, against a real encrypted database.
 *
 * This is the first test in the codebase where all of Phase 2 is connected: a draft goes
 * in, a numbered document and a balanced journal entry come out, and the two agree. So
 * the assertions worth making are not about columns — they are about the ledger the
 * document produced, and about what is left behind when issuing fails part way through.
 *
 * THE ROLLBACK TESTS ARE THE POINT OF THE FILE. Rule 3 says issuing is one transaction,
 * and the only way to demonstrate that is to break it in the middle — a closed period, an
 * unmapped role — and then show that the counter did not move, no entry exists, and the
 * document is still a draft. A test that only ever issues successfully would pass against
 * an implementation with no transaction at all.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { aprilToMarch } from '@main/domain/time'
import type { CreateDocumentInput, DocumentLineInput } from '@shared/dto'

import { DATABASE_KEY_BYTES, closeDatabase, openDatabase, type SqliteDatabase } from '../connection'
import { createQueryBuilder, type CofferDb } from '../kysely'
import { runMigrations } from '../migrate'
import { MIGRATIONS } from '../migrations'
import { clearAccountRole, listAccounts } from './accounts'
import { accountBalance, trialBalance } from './balances'
import { createDocument, deleteDocument, getDocument, updateDocument } from './documents'
import { isRepoError, type RepoError, type RepoErrorCode } from './errors'
import { cancelDocument, issueDocument } from './issuing'
import { getEntry, listEntries } from './journal'
import { allocateNumber, createSeries, getSeries, previewNumber } from './numbering'
import { createParty } from './parties'
import { closePeriod, generateFiscalYear, listPeriods } from './periods'
import { seedChart } from './seed-chart'
import { taxAccountsFor } from './tax-accounts'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x3c)
const NOW = '2026-04-15T09:00:00.000Z'
const LATER = '2026-04-16T09:00:00.000Z'

/** April to March, so 15 April 2026 falls in 2026-27. Every date below is inside it. */
const YEAR = '2026-27'

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase
let db: CofferDb
let customer: string
let account: Record<string, string>
let series: string

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-issuing-'))
  directories.push(dir)
  connection = openDatabase({ filePath: join(dir, 'company.coffer'), key: KEY })
  handles.push(connection)
  runMigrations(connection, MIGRATIONS)
  db = createQueryBuilder(connection)

  /* The two components an intra-state Indian supply carries. Seeded as accounts rather
   * than asked of a regime: `db/` may not name one, and what the resolver needs is a role
   * called `tax-output-cgst`, which is data. */
  await seedChart(db, {
    extraAccounts: taxAccountsFor([
      { code: 'CGST', label: 'Central GST', levy: 'both' },
      { code: 'SGST', label: 'State GST', levy: 'both' },
    ]),
  })
  await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })

  account = {}
  for (const row of await listAccounts(db)) {
    account[row.code] = row.id
  }

  customer = (await createParty(db, { name: 'Bharat Steel', countryCode: 'in', isCustomer: true }))
    .id

  series = (
    await createSeries(db, {
      kind: 'sales-invoice',
      label: 'Domestic',
      prefix: 'INV',
      separator: '/',
      includeFiscalYear: true,
      width: 4,
      resetOn: 'fiscal-year',
    })
  ).id
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

/** ₹1,000 of goods at 18%, split 9% CGST and 9% SGST. ₹1,180 to the customer. */
function line(over: Partial<DocumentLineInput> = {}): DocumentLineInput {
  return {
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
  }
}

const draft = (over: Partial<CreateDocumentInput> = {}): CreateDocumentInput => ({
  kind: 'sales-invoice',
  date: '2026-04-15',
  partyId: customer,
  placeOfSupplyCountry: 'IN',
  placeOfSupplyJurisdiction: '33',
  lines: [line()],
  ...over,
})

/** A draft ready to issue, returning its id. */
async function drafted(over: Partial<CreateDocumentInput> = {}): Promise<string> {
  return (await createDocument(db, draft(over), NOW)).id
}

/** What the counter would hand out next. The rollback tests all watch this. */
async function nextSequence(): Promise<number> {
  return (await previewNumber(db, series, YEAR)).nextSequence
}

// ---- Issuing ---------------------------------------------------------------

describe('issueDocument', () => {
  it('gives a draft a number, an entry and a status, all at once', async () => {
    const id = await drafted()

    const issued = await issueDocument(db, { id }, NOW)

    expect(issued.status).toBe('issued')
    expect(issued.number).toBe('INV/2026-27/0001')
    expect(issued.seriesId).toBe(series)
    expect(issued.entryId).not.toBeNull()
    expect(issued.issuedAt).toBe(NOW)
    expect(issued.cancelledAt).toBeNull()
  })

  /*
   * The entry, line by line. This is the assertion the whole batch exists for: the
   * document's own arithmetic and the ledger's are the same numbers, arrived at through
   * `documentTotals` on one side and the posting rule on the other.
   */
  it('posts the invoice the sales rule describes', async () => {
    const id = await drafted()
    const issued = await issueDocument(db, { id }, NOW)

    const entry = await getEntry(db, issued.entryId!)
    const byAccount = new Map(entry!.lines.map((row) => [row.accountId, row]))

    expect(entry!.lines).toHaveLength(4)
    /* Dr receivable the grand total, Cr sales the taxable value, Cr each output tax
     * account what that component came to. `2210` and `2220` are output CGST and SGST;
     * the input accounts beside them (`1510`, `1520`) are untouched, which is what makes
     * this a SALE rather than a purchase. */
    expect(byAccount.get(account['1300']!)).toMatchObject({ debit: '1180.00', credit: '0.00' })
    expect(byAccount.get(account['4100']!)).toMatchObject({ debit: '0.00', credit: '1000.00' })
    expect(byAccount.get(account['2210']!)).toMatchObject({ debit: '0.00', credit: '90.00' })
    expect(byAccount.get(account['2220']!)).toMatchObject({ debit: '0.00', credit: '90.00' })
    expect(byAccount.has(account['1510']!)).toBe(false)
    expect(byAccount.has(account['1520']!)).toBe(false)
  })

  /* The party rides on the control line and no other. An aged report is a grouping of
   * these rows, so a receivable naming nobody is a figure no report can attribute. */
  it('names the customer on the receivable line only', async () => {
    const id = await drafted()
    const issued = await issueDocument(db, { id }, NOW)

    const entry = await getEntry(db, issued.entryId!)
    const named = entry!.lines.filter((row) => row.partyId !== null)

    expect(named).toHaveLength(1)
    expect(named[0]!.accountId).toBe(account['1300'])
    expect(named[0]!.partyId).toBe(customer)
  })

  it('leaves the books balanced, with the receivable at the grand total', async () => {
    const id = await drafted()
    await issueDocument(db, { id }, NOW)

    expect((await trialBalance(db)).balanced).toBe(true)
    expect((await accountBalance(db, account['1300']!)).balance).toBe('1180.00')
    expect((await accountBalance(db, account['4100']!)).balance).toBe('1000.00')
  })

  /* The entry finds its way back to the document, by id and by the number a person
   * reads. A day book line that cannot be traced to its paper is the thing every audit
   * asks for and no report can reconstruct afterwards. */
  it('records which document the entry came from', async () => {
    const id = await drafted()
    const issued = await issueDocument(db, { id }, NOW)

    const entry = await getEntry(db, issued.entryId!)

    expect(entry!.sourceType).toBe('sales-invoice')
    expect(entry!.sourceId).toBe(id)
    expect(entry!.sourceNumber).toBe('INV/2026-27/0001')
    expect(entry!.narration).toBe('Sales invoice INV/2026-27/0001')
  })

  it('uses the document narration when it has one', async () => {
    const id = await drafted({ narration: 'Against PO 4471' })
    const issued = await issueDocument(db, { id }, NOW)

    expect((await getEntry(db, issued.entryId!))!.narration).toBe('Against PO 4471')
  })

  it('numbers consecutively from the counter', async () => {
    const first = await issueDocument(db, { id: await drafted() }, NOW)
    const second = await issueDocument(db, { id: await drafted() }, NOW)

    expect([first.number, second.number]).toEqual(['INV/2026-27/0001', 'INV/2026-27/0002'])
    expect(await nextSequence()).toBe(3)
  })

  it('draws from the series it was given rather than the default', async () => {
    const exports_ = await createSeries(db, {
      kind: 'sales-invoice',
      label: 'Export',
      prefix: 'EXP',
      separator: '/',
      includeFiscalYear: false,
      width: 3,
      resetOn: 'never',
      isDefault: false,
    })

    const issued = await issueDocument(db, { id: await drafted(), seriesId: exports_.id }, NOW)

    expect(issued.number).toBe('EXP/001')
    expect(issued.seriesId).toBe(exports_.id)
    /* The default series is untouched, which is the point of naming one. */
    expect(await nextSequence()).toBe(1)
  })

  it('rounds to the rupee when the document says to, and posts the difference', async () => {
    const id = await drafted({
      roundingPolicy: 'whole-unit',
      lines: [
        line({
          quantity: '1.000',
          unitPrice: '1000.40',
          taxableAmount: '1000.40',
          taxes: [{ code: 'CGST', label: 'CGST @ 9%', ratePct: '9.000', amount: '90.04' }],
        }),
      ],
    })

    const issued = await issueDocument(db, { id }, NOW)

    expect(issued.totals.netTotal).toBe('1090.44')
    expect(issued.totals.grandTotal).toBe('1090.00')
    expect(issued.totals.roundOff).toBe('-0.44')

    const entry = await getEntry(db, issued.entryId!)
    const roundOff = entry!.lines.find((row) => row.accountId === account['6990'])
    expect(roundOff).toMatchObject({ debit: '0.44', credit: '0.00' })
    expect((await trialBalance(db)).balanced).toBe(true)
  })

  /* Once issued it is not a draft, and every route that edits one has to say so. The
   * triggers are tested in documents.test.ts; what is tested here is that the repository
   * refuses first, with a sentence rather than a constraint name. */
  it('closes the document to editing and deleting', async () => {
    const id = await drafted()
    await issueDocument(db, { id }, NOW)

    expect(await codeOf(() => updateDocument(db, { id, narration: 'x' }, LATER))).toBe(
      'DOCUMENT_NOT_DRAFT',
    )
    expect(await codeOf(() => deleteDocument(db, id))).toBe('DOCUMENT_NOT_DRAFT')
  })

  /*
   * THE CASE 0009 WAS WRITTEN FOR, against a real issued document rather than a fixture.
   * The narration is what went on the journal entry, and a posted entry is immutable. So
   * a document whose narration could still be edited is one that can be made to print
   * something its own day book entry does not say — which is why the trigger refuses it
   * even to a caller holding the connection directly.
   */
  it('will not let the narration drift away from the entry that carries it', async () => {
    const id = await drafted({ narration: 'Against PO 4471' })
    const issued = await issueDocument(db, { id }, NOW)

    expect(() =>
      connection.prepare(`UPDATE documents SET narration = 'Against PO 9999' WHERE id = ?`).run(id),
    ).toThrow(/DOCUMENT_NOT_DRAFT/)

    expect((await getEntry(db, issued.entryId!))!.narration).toBe('Against PO 4471')
    expect((await getDocument(db, id))!.narration).toBe('Against PO 4471')
  })

  /*
   * The same rule where it does real damage: an ISSUED document, with an entry in the
   * ledger. Un-issuing it would leave that entry posted against a document that is a
   * draft again — free to be edited, and free to be issued a second time under a second
   * number, with the sales register and the trial balance disagreeing by one invoice.
   */
  it('will not let an issued document be turned back into a draft', async () => {
    const id = await drafted()
    const issued = await issueDocument(db, { id }, NOW)

    expect(() =>
      connection
        .prepare(
          `UPDATE documents SET status = 'draft', number = NULL, issued_at = NULL WHERE id = ?`,
        )
        .run(id),
    ).toThrow(/DOCUMENT_NOT_DRAFT/)

    const after = await getDocument(db, id)
    expect(after!.status).toBe('issued')
    expect(after!.entryId).toBe(issued.entryId)
  })

  // ---- Refusals ----

  it('refuses a document that is not there', async () => {
    expect(await codeOf(() => issueDocument(db, { id: 'nobody' }, NOW))).toBe('DOCUMENT_NOT_FOUND')
  })

  /*
   * A party archived between drafting and issuing. `postEntry` refuses it, because 0005
   * makes naming a party part of what a receivable IS — and the refusal has to arrive
   * before the number is spent, which the transaction is what guarantees.
   */
  it('refuses a document whose party has been archived since it was drafted', async () => {
    const id = await drafted()
    connection.prepare(`UPDATE parties SET is_archived = 1 WHERE id = ?`).run(customer)

    expect(await codeOf(() => issueDocument(db, { id }, NOW))).toBe('PARTY_ARCHIVED')
    expect(await nextSequence()).toBe(1)
    expect((await getDocument(db, id))!.status).toBe('draft')
  })

  it('refuses to issue the same document twice', async () => {
    const id = await drafted()
    await issueDocument(db, { id }, NOW)

    expect(await codeOf(() => issueDocument(db, { id }, LATER))).toBe('DOCUMENT_NOT_DRAFT')
    /* And the second attempt did not spend a number on its way to being refused. */
    expect(await nextSequence()).toBe(2)
  })

  it('refuses a cancelled document', async () => {
    const id = await drafted()
    await issueDocument(db, { id }, NOW)
    await cancelDocument(db, { id }, LATER)

    expect(await codeOf(() => issueDocument(db, { id }, LATER))).toBe('DOCUMENT_NOT_DRAFT')
  })

  it('refuses a document with no lines on it', async () => {
    const id = await drafted({ lines: [] })

    expect(await codeOf(() => issueDocument(db, { id }, NOW))).toBe('DOCUMENT_EMPTY')
  })

  /*
   * Zero value AND zero tax. A line worth nothing is not a supply, and the entry it would
   * make has no lines at all — `INSUFFICIENT_LINES` from the ledger, which is a true
   * sentence about an entry the user never asked for and cannot see.
   */
  it('refuses a document whose lines are all worth nothing', async () => {
    const id = await drafted({
      lines: [
        line({
          quantity: '1.000',
          unitPrice: '0.00',
          taxableAmount: '0.00',
          ratePct: '0.000',
          taxes: [],
        }),
      ],
    })

    expect(await codeOf(() => issueDocument(db, { id }, NOW))).toBe('DOCUMENT_EMPTY')
  })

  /*
   * AN EXEMPT SUPPLY HAS VALUE AND NO TAX, and is an ordinary invoice. Value OR tax is
   * what makes a line real, not value AND tax — a nil-rated or exempt supply carries no
   * component at all, and a rule that wanted both would refuse a whole category of
   * lawful invoice while looking perfectly sensible.
   */
  it('issues an exempt supply, which carries no tax at all', async () => {
    const id = await drafted({
      lines: [line({ ratePct: '0.000', taxes: [] })],
    })

    const issued = await issueDocument(db, { id }, NOW)

    expect(issued.status).toBe('issued')
    expect(issued.totals.totalTax).toBe('0.00')
    expect((await accountBalance(db, account['1300']!)).balance).toBe('1000.00')
  })

  /* A line worth nothing beside one worth something is an ordinary invoice — a free
   * sample listed under the goods it came with. The rule is about the document. */
  it('issues a document carrying a line worth nothing beside a real one', async () => {
    const id = await drafted({
      lines: [
        line(),
        line({
          description: 'Free sample',
          quantity: '1.000',
          unitPrice: '0.00',
          taxableAmount: '0.00',
          ratePct: '0.000',
          taxes: [],
        }),
      ],
    })

    expect((await issueDocument(db, { id }, NOW)).status).toBe('issued')
  })

  /*
   * The two nulls `postingRuleFor` returns, and the two sentences they earn. A credit
   * note posts and its rule is simply not written; a quotation does not post at all, and
   * no amount of building would change that. One code, because from the caller's side
   * both are "not this document, not this build".
   */
  /*
   * A credit note posts, and its rule is not written. That is the only reason left for
   * this refusal: a quotation reaches none of it (see the `quotation` group below), so
   * `requireRule` no longer has to work out which kind of missing it is looking at.
   */
  it('refuses a kind whose posting rule is not built, and says so', async () => {
    const id = await drafted({ kind: 'credit-note' })

    const failure = await failureOf(() => issueDocument(db, { id }, NOW))

    expect(failure.code).toBe('DOCUMENT_KIND_UNSUPPORTED')
    expect(failure.details).toMatchObject({ kind: 'credit-note' })
    expect(failure.message).toContain('cannot be issued yet')
    expect(await nextSequence()).toBe(1)
  })

  it('refuses when no series is configured for the kind', async () => {
    const fresh = createQueryBuilder(freshBooks())
    await seedChart(fresh)
    await generateFiscalYear(fresh, { rule: aprilToMarch, startYear: 2026 })
    const party = await createParty(fresh, { name: 'X', countryCode: 'in', isCustomer: true })
    const document = await createDocument(fresh, { ...draft(), partyId: party.id }, NOW)

    expect(await codeOf(() => issueDocument(fresh, { id: document.id }, NOW))).toBe(
      'SERIES_NOT_CONFIGURED',
    )
  })

  // ---- Rule 3: all of it, or none of it ----

  /*
   * THE ROLLBACK. A closed period is the cleanest way to fail after the counter has moved
   * — the number is allocated before the entry can be built, because the entry carries it
   * — so this is the test that shows the transaction is real. Without it, `allocateNumber`
   * would leave a gap in a series rule 46(b) wants consecutive, and nothing would say so.
   */
  it('spends no number when the period will not take the posting', async () => {
    const id = await drafted()
    const period = (await listPeriods(db)).find((row) => row.startDate === '2026-04-01')!
    await closePeriod(db, period.id)

    expect(await codeOf(() => issueDocument(db, { id }, NOW))).toBe('PERIOD_CLOSED')

    expect(await nextSequence()).toBe(1)
    expect((await getDocument(db, id))!.status).toBe('draft')
    expect((await getDocument(db, id))!.number).toBeNull()
    expect(await listEntries(db)).toHaveLength(0)
  })

  it('spends no number when the chart has no account for the revenue', async () => {
    const id = await drafted()
    await clearAccountRole(db, 'sales')

    expect(await codeOf(() => issueDocument(db, { id }, NOW))).toBe('ROLE_UNMAPPED')

    expect(await nextSequence()).toBe(1)
    expect((await getDocument(db, id))!.status).toBe('draft')
    expect(await listEntries(db)).toHaveLength(0)
  })

  it('spends no number when the chart has no account for a tax component', async () => {
    const id = await drafted()
    await clearAccountRole(db, 'tax-output-sgst')

    const failure = await failureOf(() => issueDocument(db, { id }, NOW))

    expect(failure.code).toBe('ROLE_UNMAPPED')
    /* The domain's own sentence, naming the component. Restating it here would be a
     * second wording of the same failure, and this one already says what to add. */
    expect(failure.message).toContain('SGST')
    expect(await nextSequence()).toBe(1)
    expect(await listEntries(db)).toHaveLength(0)
  })

  /*
   * The series is left where it was, not merely the counter. `hasIssued` is derived from
   * whether a counter row exists, so a rolled-back allocation that left the row behind
   * would freeze the series' shape for a document that was never issued (0007).
   */
  it('leaves a series still changeable after a failed issue', async () => {
    const id = await drafted()
    await clearAccountRole(db, 'sales')
    await codeOf(() => issueDocument(db, { id }, NOW))

    expect((await getSeries(db, series))!.hasIssued).toBe(false)
  })

  /*
   * ONE ENTRY BELONGS TO AT MOST ONE DOCUMENT — put to the database rather than to the
   * schema. Deferred out of documents.test.ts on purpose: a journal entry cannot be
   * written straight to its table, because 0004's triggers refuse one whose date falls in
   * no period. Here real entries exist, so the constraint can be tested by trying to
   * break it. Without it two documents could both claim to have posted the same entry and
   * the sales register would total to more than the ledger.
   */
  it('will not let a second document claim the entry a first one posted', async () => {
    const first = await issueDocument(db, { id: await drafted() }, NOW)
    const second = await drafted()

    expect(() =>
      connection
        .prepare(
          `UPDATE documents SET status = 'issued', number = 'INV/2026-27/9999',
             entry_id = ?, issued_at = ? WHERE id = ?`,
        )
        .run(first.entryId, NOW, second),
    ).toThrow(/UNIQUE/i)
  })
})

// ---- Cancelling ------------------------------------------------------------

describe('cancelDocument', () => {
  it('cancels an issued document and keeps everything it was', async () => {
    const id = await drafted()
    const issued = await issueDocument(db, { id }, NOW)

    const cancelled = await cancelDocument(db, { id }, LATER)

    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cancelledAt).toBe(LATER)
    /* Rule 2: the number is kept. A released number is a gap somebody has to explain. */
    expect(cancelled.number).toBe('INV/2026-27/0001')
    expect(cancelled.entryId).toBe(issued.entryId)
    expect(cancelled.issuedAt).toBe(NOW)
    expect(cancelled.lines).toHaveLength(1)
  })

  /*
   * What the customer owes goes to zero, and nothing was written to make it. `outstanding`
   * was never a column — it is the movement on the control account — so reversing the
   * entry is the whole of cancelling, as far as any report is concerned.
   */
  it('reverses what it posted, leaving the customer owing nothing', async () => {
    const id = await drafted()
    await issueDocument(db, { id }, NOW)
    expect((await accountBalance(db, account['1300']!)).balance).toBe('1180.00')

    await cancelDocument(db, { id }, LATER)

    expect((await accountBalance(db, account['1300']!)).balance).toBe('0.00')
    expect((await accountBalance(db, account['4100']!)).balance).toBe('0.00')
    expect((await trialBalance(db)).balanced).toBe(true)
  })

  /* Never an edit and never a delete — invariant 3. Both entries stay, and the original
   * knows which one cancelled it. */
  it('keeps the original entry and adds a second one against it', async () => {
    const id = await drafted()
    const issued = await issueDocument(db, { id }, NOW)

    await cancelDocument(db, { id }, LATER)

    const original = await getEntry(db, issued.entryId!)
    expect(original).not.toBeNull()
    expect(original!.reversedByEntryId).not.toBeNull()
    expect(await listEntries(db)).toHaveLength(2)

    const reversal = await getEntry(db, original!.reversedByEntryId!)
    expect(reversal!.reversesEntryId).toBe(issued.entryId)
    /* The reversal keeps the source, so a drill-through from the document finds both
     * halves of the story rather than an entry belonging to nothing. */
    expect(reversal!.sourceId).toBe(id)
    expect(reversal!.sourceNumber).toBe('INV/2026-27/0001')
  })

  it('posts the reversal as of the document own date by default', async () => {
    const id = await drafted({ date: '2026-05-20' })
    const issued = await issueDocument(db, { id }, NOW)

    await cancelDocument(db, { id }, LATER)

    const original = await getEntry(db, issued.entryId!)
    expect((await getEntry(db, original!.reversedByEntryId!))!.date).toBe('2026-05-20')
  })

  it('posts the reversal where it is told to instead', async () => {
    const id = await drafted({ date: '2026-05-20' })
    const issued = await issueDocument(db, { id }, NOW)

    await cancelDocument(db, { id, date: '2026-06-30' }, LATER)

    const original = await getEntry(db, issued.entryId!)
    expect((await getEntry(db, original!.reversedByEntryId!))!.date).toBe('2026-06-30')
  })

  it('says in the day book what was cancelled, or whatever it was told', async () => {
    const first = await drafted()
    const issued = await issueDocument(db, { id: first }, NOW)
    await cancelDocument(db, { id: first }, LATER)
    const defaulted = await getEntry(db, (await getEntry(db, issued.entryId!))!.reversedByEntryId!)
    expect(defaulted!.narration).toBe('Cancellation of sales invoice INV/2026-27/0001')

    const second = await drafted()
    const other = await issueDocument(db, { id: second }, NOW)
    await cancelDocument(db, { id: second, narration: '  Duplicate of 0001  ' }, LATER)
    const given = await getEntry(db, (await getEntry(db, other.entryId!))!.reversedByEntryId!)
    expect(given!.narration).toBe('Duplicate of 0001')
  })

  /* The number stays spent. The next invoice takes the one after it, and the cancelled
   * number belongs to a document an officer can still be shown. */
  it('does not hand the cancelled number back to the next document', async () => {
    const id = await drafted()
    await issueDocument(db, { id }, NOW)
    await cancelDocument(db, { id }, LATER)

    expect((await issueDocument(db, { id: await drafted() }, LATER)).number).toBe(
      'INV/2026-27/0002',
    )
  })

  // ---- Refusals ----

  it('refuses a draft, which is deleted rather than cancelled', async () => {
    const id = await drafted()

    expect(await codeOf(() => cancelDocument(db, { id }, NOW))).toBe('DOCUMENT_NOT_ISSUED')
  })

  it('refuses a document that is already cancelled', async () => {
    const id = await drafted()
    await issueDocument(db, { id }, NOW)
    await cancelDocument(db, { id }, LATER)

    expect(await codeOf(() => cancelDocument(db, { id }, LATER))).toBe('DOCUMENT_ALREADY_CANCELLED')
  })

  it('refuses a document that is not there', async () => {
    expect(await codeOf(() => cancelDocument(db, { id: 'nobody' }, NOW))).toBe('DOCUMENT_NOT_FOUND')
  })

  /*
   * The other half of rule 3, from the cancelling side. If the reversal cannot post, the
   * document must not be marked cancelled — that state is a document reporting nothing
   * outstanding while its entry is still in the books, which is precisely the disagreement
   * between the register and the trial balance the rule exists to prevent.
   */
  it('leaves the document issued when the reversal will not post', async () => {
    const id = await drafted()
    await issueDocument(db, { id }, NOW)
    const period = (await listPeriods(db)).find((row) => row.startDate === '2026-04-01')!
    await closePeriod(db, period.id)

    expect(await codeOf(() => cancelDocument(db, { id }, LATER))).toBe('PERIOD_CLOSED')

    const still = await getDocument(db, id)
    expect(still!.status).toBe('issued')
    expect(still!.cancelledAt).toBeNull()
    expect(await listEntries(db)).toHaveLength(1)
    expect((await accountBalance(db, account['1300']!)).balance).toBe('1180.00')
  })

  /* Cancelling in a later open period is what a business does once the month is closed,
   * and it works because the date is the caller's to choose. */
  it('cancels into an open period when the original month is closed', async () => {
    const id = await drafted()
    await issueDocument(db, { id }, NOW)
    const april = (await listPeriods(db)).find((row) => row.startDate === '2026-04-01')!
    await closePeriod(db, april.id)

    const cancelled = await cancelDocument(db, { id, date: '2026-05-10' }, LATER)

    expect(cancelled.status).toBe('cancelled')
    expect((await accountBalance(db, account['1300']!)).balance).toBe('0.00')
  })
})

// ---- A kind that posts nothing ---------------------------------------------

/*
 * QUOTATIONS, which 0010 made issuable.
 *
 * The domain contract has said since it was written that every kind is issued and only
 * the kinds with a `sourceType` are also posted. 0008 disagreed by constraint — its CHECK
 * required an `entry_id` on anything issued — so a quotation could never leave draft, and
 * therefore could never be numbered, because rule 2 allocates the number at issue.
 *
 * What is worth asserting is not that the status changes. It is that a quotation goes
 * through the whole of issuing and touches the ledger nowhere.
 */
describe('issuing a quotation', () => {
  let quotationSeries: string

  beforeEach(async () => {
    quotationSeries = (
      await createSeries(db, {
        kind: 'quotation',
        label: 'Quotations',
        prefix: 'QT',
        separator: '/',
        includeFiscalYear: true,
        width: 4,
        resetOn: 'fiscal-year',
      })
    ).id
  })

  it('numbers it and issues it, and writes no journal entry', async () => {
    const id = await drafted({ kind: 'quotation' })

    const issued = await issueDocument(db, { id }, NOW)

    expect(issued.status).toBe('issued')
    expect(issued.number).toBe('QT/2026-27/0001')
    expect(issued.seriesId).toBe(quotationSeries)
    expect(issued.issuedAt).toBe(NOW)
    expect(issued.entryId).toBeNull()
    expect(await listEntries(db)).toHaveLength(0)
  })

  /* The ledger is untouched, which is the whole claim. A quotation that moved receivables
   * would be revenue recognised on a document nobody has agreed to. */
  it('leaves every balance where it was', async () => {
    await issueDocument(db, { id: await drafted({ kind: 'quotation' }) }, NOW)

    expect((await accountBalance(db, account['1300']!)).balance).toBe('0.00')
    expect((await accountBalance(db, account['4100']!)).balance).toBe('0.00')
  })

  /* Its own series and its own counter. An invoice issued afterwards is unaffected, which
   * is what having a series per kind is for. */
  it('draws from the quotation series, not the invoice one', async () => {
    await issueDocument(db, { id: await drafted({ kind: 'quotation' }) }, NOW)

    expect((await issueDocument(db, { id: await drafted() }, NOW)).number).toBe('INV/2026-27/0001')
    expect((await previewNumber(db, quotationSeries, YEAR)).nextSequence).toBe(2)
  })

  /*
   * A CLOSED MONTH DOES NOT STOP A QUOTATION. Whether a period is open is a statement
   * about the ledger, and a quotation never reaches it — refusing to quote a customer
   * because last month's books were closed would be a rule with no reason behind it. The
   * invoice beside it is still refused, which is what makes this a distinction rather
   * than a hole.
   */
  it('is issued into a closed month, where an invoice is not', async () => {
    const quotation = await drafted({ kind: 'quotation' })
    const invoice = await drafted()
    const april = (await listPeriods(db)).find((row) => row.startDate === '2026-04-01')!
    await closePeriod(db, april.id)

    expect((await issueDocument(db, { id: quotation }, NOW)).status).toBe('issued')
    expect(await codeOf(() => issueDocument(db, { id: invoice }, NOW))).toBe('PERIOD_CLOSED')
  })

  /* The books must still reach the date, because the fiscal year the counter is scoped by
   * comes from the period. */
  it('is refused when the books do not reach its date', async () => {
    const id = await drafted({ kind: 'quotation', date: '2031-01-15' })

    expect(await codeOf(() => issueDocument(db, { id }, NOW))).toBe('NO_PERIOD')
  })

  it('cancels with nothing to reverse, and keeps its number', async () => {
    const id = await drafted({ kind: 'quotation' })
    await issueDocument(db, { id }, NOW)

    const cancelled = await cancelDocument(db, { id }, LATER)

    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.number).toBe('QT/2026-27/0001')
    expect(cancelled.cancelledAt).toBe(LATER)
    expect(await listEntries(db)).toHaveLength(0)
  })

  it('still refuses a quotation with nothing on it', async () => {
    const id = await drafted({ kind: 'quotation', lines: [] })

    expect(await codeOf(() => issueDocument(db, { id }, NOW))).toBe('DOCUMENT_EMPTY')
  })
})

// ---- Composing -------------------------------------------------------------

/*
 * `postEntry` and `allocateNumber` both join a caller's transaction rather than opening
 * their own, which is what makes issuing one transaction at all. Kysely throws rather
 * than nesting, and the throw only ever arrives at runtime — so it is worth a test that
 * fails loudly the day somebody puts `db.transaction()` back.
 */
describe('composing inside one transaction', () => {
  it('issues from inside a transaction the caller opened', async () => {
    const id = await drafted()

    const issued = await db.transaction().execute((trx) => issueDocument(trx, { id }, NOW))

    expect(issued.number).toBe('INV/2026-27/0001')
    expect((await trialBalance(db)).balanced).toBe(true)
  })

  it('takes the caller transaction down with it when the posting fails', async () => {
    const id = await drafted()
    await clearAccountRole(db, 'sales')

    await expect(
      db.transaction().execute(async (trx) => {
        await allocateNumber(trx, series, YEAR)
        return issueDocument(trx, { id }, NOW)
      }),
    ).rejects.toThrow()

    /* Including the allocation the caller made before calling — which is the cost of
     * joining rather than nesting, stated in ./transaction.ts and demonstrated here. */
    expect(await nextSequence()).toBe(1)
  })
})

/** A second set of books, for the tests that need something missing from the first. */
function freshBooks(): SqliteDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-issuing-bare-'))
  directories.push(dir)
  const handle = openDatabase({ filePath: join(dir, 'company.coffer'), key: KEY })
  handles.push(handle)
  runMigrations(handle, MIGRATIONS)
  return handle
}
