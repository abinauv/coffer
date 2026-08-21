/*
 * Documents, against a real encrypted database.
 *
 * What is worth putting to the database rather than to a mock: the four rules of 0008 are
 * CHECKs and triggers, and the whole point of them is that they hold when the repository
 * does not run. Every one of those has a test here that writes straight to the table.
 *
 * The other subject is that NOTHING DERIVABLE IS STORED. A document read back has totals
 * on it that were computed on the way out, so the tests assert figures that exist in no
 * column — which is the property the design is for.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DATABASE_KEY_BYTES, closeDatabase, openDatabase, type SqliteDatabase } from '../connection'
import { createQueryBuilder, type CofferDb } from '../kysely'
import { runMigrations, rollbackMigrations } from '../migrate'
import { MIGRATIONS } from '../migrations'
import { createParty } from './parties'
import { createSeries } from './numbering'
import { isRepoError, type RepoError, type RepoErrorCode } from './errors'
import {
  MAX_DOCUMENT_PAGE,
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
} from './documents'
import { DOCUMENT_KINDS, postsToLedger } from '@main/domain/documents'
import type { CreateTaxedDocumentInput, TaxedLineInput } from '@shared/dto'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x5a)
const NOW = '2026-04-15T09:00:00.000Z'

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase
let db: CofferDb
let customer: string

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-documents-'))
  directories.push(dir)
  connection = openDatabase({ filePath: join(dir, 'company.coffer'), key: KEY })
  handles.push(connection)
  runMigrations(connection, MIGRATIONS)
  db = createQueryBuilder(connection)

  customer = (await createParty(db, { name: 'Bharat Steel', countryCode: 'in', isCustomer: true }))
    .id
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

function line(over: Partial<TaxedLineInput> = {}): TaxedLineInput {
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

const draft = (over: Partial<CreateTaxedDocumentInput> = {}): CreateTaxedDocumentInput => ({
  kind: 'sales-invoice',
  date: '2026-04-15',
  partyId: customer,
  placeOfSupplyCountry: 'IN',
  placeOfSupplyJurisdiction: '33',
  lines: [line()],
  ...over,
})

/** A document written straight to the table, bypassing the repository entirely. */
function writeDocument(id: string, over: Record<string, string | null> = {}): void {
  const values = {
    id,
    kind: 'sales-invoice',
    status: 'draft',
    number: null,
    document_date: '2026-04-15',
    party_id: customer,
    place_of_supply_country: 'in',
    rounding_policy: 'none',
    narration: '',
    entry_id: null,
    created_at: NOW,
    updated_at: NOW,
    issued_at: null,
    cancelled_at: null,
    ...over,
  }
  const columns = Object.keys(values)
  connection
    .prepare(
      `INSERT INTO documents (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(...Object.values(values))
}

// ---- Migration 0008 --------------------------------------------------------

describe('migration 0008', () => {
  it('creates the three tables and rolls back cleanly', () => {
    const tables = () =>
      connection
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
        )
        .all()
        .map((row) => row.name)

    expect(tables()).toEqual(
      expect.arrayContaining(['documents', 'document_lines', 'document_line_taxes']),
    )

    rollbackMigrations(connection, MIGRATIONS, { to: '0007' })
    const after = tables()
    expect(after).not.toContain('documents')
    expect(after).not.toContain('document_lines')
    expect(after).not.toContain('document_line_taxes')
    /* And the tables 0007 made are untouched, so the rollback stopped where it was told. */
    expect(after).toContain('numbering_series')
  })

  /*
   * Rule 2, put to the database. A draft has no number and anything else has one, in both
   * directions — the failure is not only a numbered draft but an issued document with no
   * number, which would print blank and file as nothing.
   */
  it('refuses a numbered draft and a numberless issued document', () => {
    expect(() => writeDocument('d-1', { number: 'INV/1' })).toThrow(/CHECK/i)

    /*
     * Cancelled rather than issued, deliberately. An ISSUED document with no number also
     * trips the rule-3 CHECK about `entry_id`, so it would throw whichever of the two was
     * still there — and a mutation weakening this rule to a one-way implication survived
     * because of exactly that. A cancelled document needs a number and needs no entry, so
     * only the rule under test can refuse it.
     */
    expect(() =>
      writeDocument('d-2', {
        status: 'cancelled',
        number: null,
        issued_at: NOW,
        cancelled_at: NOW,
      }),
    ).toThrow(/CHECK/i)
  })

  /*
   * One entry belongs to at most one document. Without it two documents could both claim
   * to have posted the same entry, and the sales register would total to more than the
   * ledger — the disagreement rule 3 exists to make impossible.
   *
   * Asserted on the schema rather than by inserting two rows, because a journal entry
   * cannot be written straight to its table: 0004's triggers refuse one whose date falls
   * in no period, which is the right behaviour and makes a raw fixture impossible. The
   * behavioural test belongs with issuing, where real entries exist — and is written
   * there. This one still fails if the constraint is dropped.
   */
  it('lets one journal entry belong to at most one document', () => {
    const ddl = connection
      .prepare<[], { sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'documents'`,
      )
      .get()

    expect(ddl?.sql).toMatch(/entry_id TEXT UNIQUE/)
  })

  it('refuses an issued document that has not posted', () => {
    expect(() =>
      writeDocument('d-1', { status: 'issued', number: 'INV/1', issued_at: NOW }),
    ).toThrow(/CHECK/i)
  })

  it('refuses a kind it has never heard of', () => {
    expect(() => writeDocument('d-1', { kind: 'sale-invoice' })).toThrow(/CHECK/i)
  })

  it('refuses a status it has never heard of', () => {
    expect(() => writeDocument('d-1', { status: 'sent' })).toThrow(/CHECK/i)
  })

  it('refuses a country code that is not two lower-case letters', () => {
    expect(() => writeDocument('d-1', { place_of_supply_country: 'IN' })).toThrow(/CHECK/i)
    expect(() => writeDocument('d-2', { place_of_supply_country: 'ind' })).toThrow(/CHECK/i)
  })

  it('ties the issue and cancellation times to the status', () => {
    expect(() => writeDocument('d-1', { issued_at: NOW })).toThrow(/CHECK/i)
    expect(() => writeDocument('d-2', { cancelled_at: NOW })).toThrow(/CHECK/i)
  })

  /*
   * A number is unique within its kind, not overall. `INV/1` on an invoice and on a credit
   * note are two documents in two series and a business numbering both from 1 is doing
   * nothing wrong; two sales invoices carrying one number is unfileable.
   */
  it('refuses one number twice on one kind, and allows it across kinds', () => {
    writeDocument('d-1', {
      status: 'cancelled',
      number: 'INV/1',
      issued_at: NOW,
      cancelled_at: NOW,
    })
    expect(() =>
      writeDocument('d-2', {
        status: 'cancelled',
        number: 'inv/1',
        issued_at: NOW,
        cancelled_at: NOW,
      }),
    ).toThrow(/UNIQUE/i)

    expect(() =>
      writeDocument('d-3', {
        kind: 'credit-note',
        status: 'cancelled',
        number: 'INV/1',
        issued_at: NOW,
        cancelled_at: NOW,
      }),
    ).not.toThrow()
  })

  it('lets any number of drafts have no number at all', () => {
    writeDocument('d-1')
    expect(() => writeDocument('d-2')).not.toThrow()
  })

  /* Rule 1, at the database. The repository checks first, so without this the trigger
   * could be deleted with nothing failing — the finding this project has hit in four
   * batches running. */
  it('freezes a document once it has left draft', () => {
    writeDocument('d-1', {
      status: 'cancelled',
      number: 'INV/1',
      issued_at: NOW,
      cancelled_at: NOW,
    })

    expect(() =>
      connection
        .prepare(`UPDATE documents SET document_date = '2026-05-01' WHERE id = 'd-1'`)
        .run(),
    ).toThrow(/DOCUMENT_NOT_DRAFT/)
    expect(() =>
      connection.prepare(`UPDATE documents SET number = 'INV/2' WHERE id = 'd-1'`).run(),
    ).toThrow(/DOCUMENT_NOT_DRAFT/)
    expect(() => connection.prepare(`DELETE FROM documents WHERE id = 'd-1'`).run()).toThrow(
      /DOCUMENT_NOT_DRAFT/,
    )
  })

  /*
   * 0009 goes back as cleanly as it came, which for a trigger means the OLD rule is in
   * place again rather than no rule at all. A `down` that dropped the trigger and stopped
   * would leave a database at 0008 with less protection than 0008 ever shipped, and
   * nothing would report it — the tables would all be there.
   */
  it('gives the looser rule back when 0009 is rolled off', () => {
    writeDocument('d-1', {
      status: 'cancelled',
      number: 'INV/1',
      issued_at: NOW,
      cancelled_at: NOW,
    })
    const editNarration = () =>
      connection.prepare(`UPDATE documents SET narration = 'Note' WHERE id = 'd-1'`).run()

    expect(editNarration).toThrow(/DOCUMENT_NOT_DRAFT/)

    rollbackMigrations(connection, MIGRATIONS, { to: '0008' })

    expect(editNarration).not.toThrow()
    /* The rest of 0008's rule is back too, not merely absent. */
    expect(() =>
      connection.prepare(`UPDATE documents SET number = 'INV/2' WHERE id = 'd-1'`).run(),
    ).toThrow(/DOCUMENT_NOT_DRAFT/)
  })

  /*
   * THE NARRATION IS FROZEN TOO, and it was not until 0009.
   *
   * 0008 let it move, on the grounds that it is not part of the supply. Then issuing was
   * built and the narration turned out to be what goes on the JOURNAL ENTRY — which is
   * immutable — so an editable narration was a document that could be made to print
   * something its own day book entry does not say. See 0009 for the whole argument; what
   * is asserted here is the rule that replaced it.
   */
  it('freezes the narration of an issued document, because the entry carries it', () => {
    writeDocument('d-1', {
      status: 'cancelled',
      number: 'INV/1',
      issued_at: NOW,
      cancelled_at: NOW,
    })

    expect(() =>
      connection
        .prepare(`UPDATE documents SET narration = 'Cancelled in error' WHERE id = 'd-1'`)
        .run(),
    ).toThrow(/DOCUMENT_NOT_DRAFT/)
  })

  /*
   * The number was frozen from 0008 and the series that produced it was not, so a
   * document that had left draft could be repointed at a series whose shape its number
   * does not match. Also 0009.
   *
   * Cancelled rather than issued, for the reason the rule-2 test above gives: an ISSUED
   * document needs an `entry_id`, and a journal entry cannot be written straight to its
   * table. The trigger reads `status <> 'draft'`, so cancelled exercises it exactly.
   */
  it('freezes the series a document that has left draft was numbered from', async () => {
    const series = await createSeries(db, { kind: 'sales-invoice', label: 'Domestic' })
    writeDocument('d-1', {
      status: 'cancelled',
      number: 'INV/1',
      series_id: series.id,
      issued_at: NOW,
      cancelled_at: NOW,
    })

    expect(() =>
      connection.prepare(`UPDATE documents SET series_id = NULL WHERE id = 'd-1'`).run(),
    ).toThrow(/DOCUMENT_NOT_DRAFT/)
  })

  /*
   * 0010, AND THE LIST IT KEEPS IN SQL.
   *
   * The corrected rule is "a document that POSTS and is issued has an entry", and a CHECK
   * cannot import a TypeScript union — so the kinds that post nothing are enumerated in
   * the migration. This is the test the migration's header promises: it asks the database
   * about every kind the domain knows and requires the two to agree, so a sixth kind that
   * posts nothing cannot be added to `DOCUMENT_KINDS` without something going red here.
   *
   * Put straight to the table on purpose. The repository answers first, so a test going
   * through `issueDocument` would pass with no CHECK at all.
   */
  it('lets exactly the kinds that post nothing be issued without an entry', () => {
    for (const definition of DOCUMENT_KINDS) {
      const write = () =>
        writeDocument(`d-${definition.kind}`, {
          kind: definition.kind,
          status: 'issued',
          number: `X/${definition.kind}`,
          issued_at: NOW,
          entry_id: null,
        })

      if (postsToLedger(definition.kind)) {
        expect(write, `${definition.kind} must not be issuable without an entry`).toThrow(/CHECK/i)
      } else {
        expect(write, `${definition.kind} posts nothing and must be issuable`).not.toThrow()
      }
    }
  })

  const issuedQuotation = (id: string) => () =>
    writeDocument(id, {
      kind: 'quotation',
      status: 'issued',
      number: `QT/${id}`,
      issued_at: NOW,
      entry_id: null,
    })

  /*
   * Rolling 0010 off puts 0008's stricter rule back — every issued document must have
   * posted — rather than merely leaving the table rebuilt. A `down` that returned the same
   * relaxed CHECK would look identical on every other test: the rows are all there, the
   * triggers all fire, and only a quotation would tell the difference.
   */
  it('makes a quotation unissuable again when 0010 is rolled off', () => {
    rollbackMigrations(connection, MIGRATIONS, { to: '0009' })

    expect(issuedQuotation('q-1')).toThrow(/CHECK/i)
  })

  /*
   * And the rollback is refused outright once one exists, rather than dropping it.
   *
   * The `down` copies every row into a table carrying 0008's rule, and an issued quotation
   * has no representation under it — so the copy fails and the whole migration rolls back.
   * That is the honest outcome: the alternative is a `down` that quietly discards numbered
   * documents, which is worse than refusing.
   */
  it('refuses to roll 0010 off while an issued quotation exists', () => {
    expect(issuedQuotation('q-2')).not.toThrow()

    expect(() => rollbackMigrations(connection, MIGRATIONS, { to: '0009' })).toThrow(/0010/)

    /* Nothing was lost, and the relaxed rule is still in force. */
    expect(connection.prepare(`SELECT status FROM documents WHERE id = 'q-2'`).get()).toMatchObject(
      { status: 'issued' },
    )
    expect(issuedQuotation('q-3')).not.toThrow()
  })

  /*
   * UN-ISSUING, which is what the IFNULLs in that trigger are actually for.
   *
   * `NEW.number <> OLD.number` is NULL when either side is NULL, and a trigger whose WHEN
   * evaluates to NULL does not fire — measured, not assumed: `0 OR NULL` is NULL in
   * SQLite, so a disjunction whose only true-ish term went NULL is a disjunction that
   * says nothing. An UPDATE clearing the status, the number and the stamps together
   * satisfies every CHECK on the row, so without the IFNULL the whole thing goes through
   * and the document is a draft again — editable, re-issuable under a second number, with
   * its journal entry still sitting in the ledger.
   *
   * A mutation removing the IFNULL survived the entire suite before this existed.
   */
  it('will not let a document that has left draft be turned back into one', () => {
    writeDocument('d-1', {
      status: 'cancelled',
      number: 'INV/1',
      issued_at: NOW,
      cancelled_at: NOW,
    })

    expect(() =>
      connection
        .prepare(
          `UPDATE documents
           SET status = 'draft', number = NULL, issued_at = NULL, cancelled_at = NULL
           WHERE id = 'd-1'`,
        )
        .run(),
    ).toThrow(/DOCUMENT_NOT_DRAFT/)

    expect(
      connection.prepare(`SELECT status, number FROM documents WHERE id = 'd-1'`).get(),
    ).toMatchObject({ status: 'cancelled', number: 'INV/1' })
  })

  /* What still moves, and must. `updated_at` is not on the frozen list, because
   * cancelling writes it — see `cancelDocument`, where the whole transition goes through
   * this trigger against a real issued document. */
  it('still lets the updated stamp move', () => {
    writeDocument('d-1', {
      status: 'cancelled',
      number: 'INV/1',
      issued_at: NOW,
      cancelled_at: NOW,
    })

    expect(() =>
      connection.prepare(`UPDATE documents SET updated_at = ? WHERE id = 'd-1'`).run(NOW),
    ).not.toThrow()
  })

  it('freezes the lines of a document that has left draft', async () => {
    const document = await createDocument(db, draft(), NOW)
    const lineId = document.lines[0]!.id
    connection
      .prepare(
        `UPDATE documents SET status = 'cancelled', number = 'INV/1', issued_at = ?, cancelled_at = ? WHERE id = ?`,
      )
      .run(NOW, NOW, document.id)

    expect(() =>
      connection.prepare(`UPDATE document_lines SET quantity = '9.000' WHERE id = ?`).run(lineId),
    ).toThrow(/DOCUMENT_NOT_DRAFT/)
    expect(() => connection.prepare(`DELETE FROM document_lines WHERE id = ?`).run(lineId)).toThrow(
      /DOCUMENT_NOT_DRAFT/,
    )
    expect(() =>
      connection
        .prepare(
          `INSERT INTO document_lines (id, document_id, line_number, description, quantity, unit_price, taxable_amount)
           VALUES ('extra', ?, 9, 'Sneaked in', '1.000', '1.00', '1.00')`,
        )
        .run(document.id),
    ).toThrow(/DOCUMENT_NOT_DRAFT/)
  })

  it('refuses a line amount that is not money at two places', async () => {
    const document = await createDocument(db, draft(), NOW)

    expect(() =>
      connection
        .prepare(
          `INSERT INTO document_lines (id, document_id, line_number, description, quantity, unit_price, taxable_amount)
           VALUES ('x', ?, 2, 'Bad', '1.000', '1.5', '1.50')`,
        )
        .run(document.id),
    ).toThrow(/CHECK/i)
  })

  /* A rebate shown as a line, and a returned quantity. Both are ordinary and both would
   * be refused by the ledger's unsigned shapes — see the note in 0008. */
  it('accepts a negative price and a negative quantity', async () => {
    const document = await createDocument(db, draft(), NOW)

    expect(() =>
      connection
        .prepare(
          `INSERT INTO document_lines (id, document_id, line_number, description, quantity, unit_price, taxable_amount)
           VALUES ('x', ?, 2, 'Rebate', '-1.000', '-200.00', '-200.00')`,
        )
        .run(document.id),
    ).not.toThrow()
  })

  /*
   * The three line CHECKs the repository also enforces, put to the database directly. A
   * test going through `createDocument` is answered by whichever layer runs first — and
   * the repository always does — so without these the constraints could be deleted with
   * nothing failing. Four batches running, this one.
   */
  it('refuses a line that says nothing, is numbered zero, or is not money', async () => {
    const document = await createDocument(db, draft(), NOW)
    const write = (lineNumber: number, description: string, taxable: string) => () =>
      connection
        .prepare(
          `INSERT INTO document_lines (id, document_id, line_number, description, quantity, unit_price, taxable_amount)
           VALUES (?, ?, ?, ?, '1.000', '1.00', ?)`,
        )
        .run(`x-${String(lineNumber)}`, document.id, lineNumber, description, taxable)

    expect(write(2, '   ', '1.00')).toThrow(/CHECK/i)
    expect(write(0, 'Numbered nothing', '1.00')).toThrow(/CHECK/i)
    expect(write(3, 'Not money', '1.5')).toThrow(/CHECK/i)
    expect(write(4, 'Fine', '1.00')).not.toThrow()
  })

  it('refuses two lines claiming the same position', async () => {
    const document = await createDocument(db, draft(), NOW)

    expect(() =>
      connection
        .prepare(
          `INSERT INTO document_lines (id, document_id, line_number, description, quantity, unit_price, taxable_amount)
           VALUES ('x', ?, 1, 'Duplicate', '1.000', '1.00', '1.00')`,
        )
        .run(document.id),
    ).toThrow(/UNIQUE/i)
  })

  it('refuses one component twice on one line', async () => {
    const document = await createDocument(db, draft(), NOW)
    const lineId = document.lines[0]!.id

    expect(() =>
      connection
        .prepare(
          `INSERT INTO document_line_taxes (document_line_id, code, label, rate_pct, amount)
           VALUES (?, 'CGST', 'CGST @ 9%', '9.000', '90.00')`,
        )
        .run(lineId),
    ).toThrow(/UNIQUE|PRIMARY/i)
  })

  it('takes the lines and their taxes with a draft that is thrown away', async () => {
    const document = await createDocument(db, draft(), NOW)
    await deleteDocument(db, document.id)

    const lines = connection
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM document_lines`)
      .get()
    const taxes = connection
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM document_line_taxes`)
      .get()

    expect(lines?.n).toBe(0)
    expect(taxes?.n).toBe(0)
  })
})

// ---- The repository --------------------------------------------------------

describe('creating a draft', () => {
  it('keeps what it was given, with no number and no entry', async () => {
    const document = await createDocument(db, draft({ narration: '  Against PO 4471  ' }), NOW)

    expect(document.status).toBe('draft')
    expect(document.number).toBeNull()
    expect(document.entryId).toBeNull()
    expect(document.narration).toBe('Against PO 4471')
    expect(document.partyName).toBe('Bharat Steel')
    /* Lower-cased on the way in, because ISO codes are lower case here and the CHECK
     * refuses anything else. */
    expect(document.placeOfSupplyCountry).toBe('in')
  })

  /* A draft is made empty and filled in. Refusing an empty one would refuse the first
   * thing every user does — the rule that matters is that an empty one cannot be ISSUED. */
  it('takes a draft with no lines at all', async () => {
    const document = await createDocument(db, draft({ lines: [] }), NOW)

    expect(document.lines).toHaveLength(0)
    expect(document.totals.grandTotal).toBe('0.00')
  })

  it('numbers the lines from the order they arrived', async () => {
    const document = await createDocument(
      db,
      draft({ lines: [line({ description: 'First' }), line({ description: 'Second' })] }),
      NOW,
    )

    expect(document.lines.map((l) => [l.lineNumber, l.description])).toEqual([
      [1, 'First'],
      [2, 'Second'],
    ])
  })

  it('normalises every figure to its own scale', async () => {
    const document = await createDocument(
      db,
      draft({
        lines: [line({ quantity: '2', unitPrice: '500', taxableAmount: '1000', ratePct: '18' })],
      }),
      NOW,
    )
    const stored = document.lines[0]!

    expect(stored.quantity).toBe('2.000')
    expect(stored.unitPrice).toBe('500.00')
    expect(stored.ratePct).toBe('18.000')
    expect(stored.discount).toBe('0.00')
  })

  it('refuses a party that does not exist', async () => {
    expect(await codeOf(() => createDocument(db, draft({ partyId: 'nobody' }), NOW))).toBe(
      'PARTY_NOT_FOUND',
    )
  })

  it('refuses an archived party', async () => {
    const gone = await createParty(db, { name: 'Gone Ltd', countryCode: 'in', isCustomer: true })
    connection.prepare(`UPDATE parties SET is_archived = 1 WHERE id = ?`).run(gone.id)

    expect(await codeOf(() => createDocument(db, draft({ partyId: gone.id }), NOW))).toBe(
      'PARTY_ARCHIVED',
    )
  })

  /*
   * Both the repository and 0008 refuse this, and they report the same code — so the
   * assertion is on `details`, which only the repository fills in. Without that the
   * repository's check could be deleted and this test would still pass, on the CHECK.
   */
  it('refuses a line with nothing written on it, and says which line', async () => {
    const failure = await failureOf(() =>
      createDocument(db, draft({ lines: [line(), line({ description: '  ' })] }), NOW),
    )

    expect(failure.code).toBe('INVALID_LINE_AMOUNT')
    expect(failure.details).toMatchObject({ lineNumber: 2 })
  })

  it('refuses a figure that is not a number', async () => {
    expect(
      await codeOf(() => createDocument(db, draft({ lines: [line({ quantity: 'two' })] }), NOW)),
    ).toBe('INVALID_LINE_AMOUNT')
  })

  /*
   * The arithmetic, checked rather than trusted. The caller computed the taxable amount
   * because the caller asked the regime; this is what stops a bug there putting a figure
   * in the books that the invoice does not show.
   */
  it('refuses a taxable amount that its own line does not come to', async () => {
    const failure = await codeOf(() =>
      createDocument(db, draft({ lines: [line({ taxableAmount: '999.00' })] }), NOW),
    )

    expect(failure).toBe('LINE_TOTAL_MISMATCH')
  })

  /*
   * A LINE ROUNDS, and the check has to allow it.
   *
   * `lineAmount` is one of the defined rounding points in domain/money/scale.ts — "a
   * line's extended amount, fixed once before it contributes to any total" — so 0.333 kg
   * at 10.01 is 3.33333 and the line is 3.33. That is what prints and what goes in the
   * books.
   *
   * The check compares against the ROUNDED product for that reason. Comparing against the
   * raw one would refuse every line whose quantity and price do not multiply out to whole
   * paise, which is most lines sold by weight, and the message would say the amount was
   * wrong when it was the only right answer available.
   */
  it('allows a line whose own arithmetic does not land on a whole paisa', async () => {
    const document = await createDocument(
      db,
      draft({
        lines: [
          line({
            quantity: '0.333',
            unitPrice: '10.01',
            taxableAmount: '3.33',
            taxes: [],
          }),
        ],
      }),
      NOW,
    )

    expect(document.lines[0]?.taxableAmount).toBe('3.33')
  })

  /* And the check still has teeth: rounding is half a paisa, not a licence. */
  it('still refuses an amount that is a paisa out', async () => {
    expect(
      await codeOf(() =>
        createDocument(
          db,
          draft({
            lines: [line({ quantity: '0.333', unitPrice: '10.01', taxableAmount: '3.34' })],
          }),
          NOW,
        ),
      ),
    ).toBe('LINE_TOTAL_MISMATCH')
  })

  it('takes the discount out of the line before checking it', async () => {
    const document = await createDocument(
      db,
      draft({
        lines: [
          line({
            quantity: '2.000',
            unitPrice: '500.00',
            discount: '100.00',
            taxableAmount: '900.00',
          }),
        ],
      }),
      NOW,
    )

    expect(document.lines[0]?.taxableAmount).toBe('900.00')
    expect(document.totals.totalDiscount).toBe('100.00')
  })

  it('refuses a discount bigger than the line it comes off', async () => {
    expect(
      await codeOf(() =>
        createDocument(
          db,
          draft({ lines: [line({ discount: '2000.00', taxableAmount: '-1000.00' })] }),
          NOW,
        ),
      ),
    ).toBe('DISCOUNT_EXCEEDS_LINE')
  })
})

describe('what a document adds up to', () => {
  /* Nothing here is in a column. Every figure was folded on the way out, over the same
   * lines the posting rule will fold — which is what makes the printed total and the
   * journal entry the same arithmetic rather than two figures kept in step. */
  it('computes the foot of the document on the way out', async () => {
    const document = await createDocument(db, draft(), NOW)

    expect(document.totals.taxableValue).toBe('1000.00')
    expect(document.totals.totalTax).toBe('180.00')
    expect(document.totals.netTotal).toBe('1180.00')
    expect(document.totals.roundOff).toBe('0.00')
    expect(document.totals.grandTotal).toBe('1180.00')
  })

  it('has no stored total to disagree with', () => {
    const columns = connection
      .prepare<[], { name: string }>(`PRAGMA table_info(documents)`)
      .all()
      .map((row) => row.name)

    for (const forbidden of ['grand_total', 'total_tax', 'taxable_value', 'outstanding']) {
      expect(columns).not.toContain(forbidden)
    }
  })

  /*
   * The tax block is keyed by component AND rate, so an invoice carrying 18% goods and 5%
   * freight prints two CGST lines a customer can check. The ledger groups by component
   * alone — see the posting rule.
   */
  it('gathers the tax block by component and rate', async () => {
    const document = await createDocument(
      db,
      draft({
        lines: [
          line(),
          line({
            description: 'Freight',
            isCharge: true,
            quantity: '1.000',
            unitPrice: '200.00',
            taxableAmount: '200.00',
            ratePct: '5.000',
            taxes: [
              { code: 'CGST', label: 'CGST @ 2.5%', ratePct: '2.500', amount: '5.00' },
              { code: 'SGST', label: 'SGST @ 2.5%', ratePct: '2.500', amount: '5.00' },
            ],
          }),
        ],
      }),
      NOW,
    )

    expect(document.totals.taxSummary).toEqual([
      { code: 'CGST', label: 'CGST @ 9%', ratePct: '9.000', amount: '90.00' },
      { code: 'SGST', label: 'SGST @ 9%', ratePct: '9.000', amount: '90.00' },
      { code: 'CGST', label: 'CGST @ 2.5%', ratePct: '2.500', amount: '5.00' },
      { code: 'SGST', label: 'SGST @ 2.5%', ratePct: '2.500', amount: '5.00' },
    ])
    expect(document.totals.grandTotal).toBe('1390.00')
  })

  it('rounds only when the document says it should', async () => {
    const odd = draft({
      lines: [line({ unitPrice: '500.15', taxableAmount: '1000.30' })],
    })

    const plain = await createDocument(db, odd, NOW)
    expect(plain.totals.grandTotal).toBe('1180.30')

    const rounded = await createDocument(db, { ...odd, roundingPolicy: 'whole-unit' }, NOW)
    expect(rounded.totals.grandTotal).toBe('1180.00')
    expect(rounded.totals.roundOff).toBe('-0.30')
  })
})

describe('editing a draft', () => {
  it('writes only what it was given', async () => {
    const document = await createDocument(db, draft({ narration: 'First' }), NOW)
    const changed = await updateDocument(
      db,
      { id: document.id, date: '2026-04-20' },
      '2026-04-20T10:00:00.000Z',
    )

    expect(changed.date).toBe('2026-04-20')
    expect(changed.narration).toBe('First')
    expect(changed.lines).toHaveLength(1)
  })

  /* The grid the user is looking at IS the document, so a line set replaces rather than
   * patches — see the header on why a per-line protocol would be worse. */
  it('replaces every line when it is given lines', async () => {
    const document = await createDocument(db, draft(), NOW)
    const changed = await updateDocument(
      db,
      {
        id: document.id,
        lines: [
          line({ description: 'Something else', quantity: '1.000', taxableAmount: '500.00' }),
        ],
      },
      NOW,
    )

    expect(changed.lines).toHaveLength(1)
    expect(changed.lines[0]?.description).toBe('Something else')
    expect(changed.lines[0]?.lineNumber).toBe(1)
    expect(changed.totals.taxableValue).toBe('500.00')
  })

  it('takes the old lines taxes with them', async () => {
    const document = await createDocument(db, draft(), NOW)
    await updateDocument(db, { id: document.id, lines: [line({ taxes: [] })] }, NOW)

    const taxes = connection
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM document_line_taxes`)
      .get()
    expect(taxes?.n).toBe(0)
  })

  it('leaves the lines alone when it is not given any', async () => {
    const document = await createDocument(db, draft(), NOW)
    const changed = await updateDocument(db, { id: document.id, narration: 'Note' }, NOW)

    expect(changed.lines).toHaveLength(1)
    expect(changed.lines[0]?.id).toBe(document.lines[0]?.id)
  })

  it('empties a document when it is given an empty set', async () => {
    const document = await createDocument(db, draft(), NOW)
    const changed = await updateDocument(db, { id: document.id, lines: [] }, NOW)

    expect(changed.lines).toHaveLength(0)
  })

  it('refuses a document that does not exist', async () => {
    expect(await codeOf(() => updateDocument(db, { id: 'nobody' }, NOW))).toBe('DOCUMENT_NOT_FOUND')
  })

  /* Moving a draft onto an archived party is the same mistake as creating one against
   * them, and had nothing testing it. */
  it('refuses to move a draft onto an archived party', async () => {
    const document = await createDocument(db, draft(), NOW)
    const gone = await createParty(db, { name: 'Gone Ltd', countryCode: 'in', isCustomer: true })
    connection.prepare(`UPDATE parties SET is_archived = 1 WHERE id = ?`).run(gone.id)

    expect(await codeOf(() => updateDocument(db, { id: document.id, partyId: gone.id }, NOW))).toBe(
      'PARTY_ARCHIVED',
    )
  })

  /* Rule 1 from the repository, with a sentence somebody can act on rather than the
   * trigger's bare code. */
  it('refuses to edit a document that has been issued, and says what to do', async () => {
    const document = await createDocument(db, draft(), NOW)
    connection
      .prepare(
        `UPDATE documents SET status = 'cancelled', number = 'INV/1', issued_at = ?, cancelled_at = ? WHERE id = ?`,
      )
      .run(NOW, NOW, document.id)

    expect(await codeOf(() => updateDocument(db, { id: document.id, narration: 'x' }, NOW))).toBe(
      'DOCUMENT_NOT_DRAFT',
    )
  })
})

describe('throwing a draft away', () => {
  it('deletes a draft', async () => {
    const document = await createDocument(db, draft(), NOW)
    await deleteDocument(db, document.id)

    expect(await getDocument(db, document.id)).toBeNull()
  })

  it('refuses one that is no longer a draft', async () => {
    const document = await createDocument(db, draft(), NOW)
    connection
      .prepare(
        `UPDATE documents SET status = 'cancelled', number = 'INV/1', issued_at = ?, cancelled_at = ? WHERE id = ?`,
      )
      .run(NOW, NOW, document.id)

    expect(await codeOf(() => deleteDocument(db, document.id))).toBe('DOCUMENT_NOT_DRAFT')
  })

  it('refuses one that does not exist', async () => {
    expect(await codeOf(() => deleteDocument(db, 'nobody'))).toBe('DOCUMENT_NOT_FOUND')
  })
})

describe('the register', () => {
  it('lists documents with their party and what they come to', async () => {
    await createDocument(db, draft(), NOW)
    const rows = await listDocuments(db)

    expect(rows).toHaveLength(1)
    expect(rows[0]?.partyName).toBe('Bharat Steel')
    expect(rows[0]?.grandTotal).toBe('1180.00')
  })

  /* Each document rounds by its own policy, so two on one page may round differently and
   * both be right. */
  it('totals each document by its own rounding policy', async () => {
    const odd = { lines: [line({ unitPrice: '500.15', taxableAmount: '1000.30' })] }
    await createDocument(db, draft({ ...odd, narration: 'plain' }), NOW)
    await createDocument(
      db,
      draft({ ...odd, narration: 'rounded', roundingPolicy: 'whole-unit' }),
      NOW,
    )

    const rows = await listDocuments(db)
    const totals = rows.map((row) => row.grandTotal).sort()

    expect(totals).toEqual(['1180.00', '1180.30'])
  })

  it('filters by kind, status, party and date', async () => {
    await createDocument(db, draft({ date: '2026-04-01' }), NOW)
    await createDocument(db, draft({ date: '2026-05-01', kind: 'quotation' }), NOW)

    expect(await listDocuments(db, { kind: 'quotation' })).toHaveLength(1)
    expect(await listDocuments(db, { status: 'draft' })).toHaveLength(2)
    expect(await listDocuments(db, { status: 'issued' })).toHaveLength(0)
    expect(await listDocuments(db, { partyId: customer })).toHaveLength(2)
    expect(await listDocuments(db, { fromDate: '2026-04-15' })).toHaveLength(1)
    expect(await listDocuments(db, { toDate: '2026-04-15' })).toHaveLength(1)
  })

  it('searches the number, the party and the narration', async () => {
    await createDocument(db, draft({ narration: 'Against PO 4471' }), NOW)

    expect(await listDocuments(db, { search: 'bharat' })).toHaveLength(1)
    expect(await listDocuments(db, { search: '4471' })).toHaveLength(1)
    expect(await listDocuments(db, { search: 'nothing' })).toHaveLength(0)
  })

  /* A register is read as a sequence of documents, and the sequence is the one printed on
   * them — an invoice back-dated into last month belongs where its date says. */
  it('orders by the date the document bears, not by when the row was written', async () => {
    await createDocument(db, draft({ date: '2026-04-01', narration: 'first' }), NOW)
    await createDocument(db, draft({ date: '2026-06-01', narration: 'later' }), NOW)
    await createDocument(db, draft({ date: '2026-05-01', narration: 'middle' }), NOW)

    const dates = (await listDocuments(db)).map((row) => row.date)
    expect(dates).toEqual(['2026-06-01', '2026-05-01', '2026-04-01'])
  })

  it('pages', async () => {
    for (const day of ['01', '02', '03']) {
      await createDocument(db, draft({ date: `2026-04-${day}` }), NOW)
    }

    expect(await listDocuments(db, { limit: 2 })).toHaveLength(2)
    expect(await listDocuments(db, { limit: 2, offset: 2 })).toHaveLength(1)
  })

  /*
   * A ceiling a caller cannot raise. Every row on a page is a fold over its lines, so an
   * unbounded page is an unbounded amount of arithmetic asked for in one call.
   *
   * It has to cross the ceiling to test the ceiling. An earlier version of this asked for
   * ten thousand rows out of six and passed whether the clamp was there or not — the
   * mutation that removed `Math.min` survived it, which is the only reason this is
   * written the expensive way.
   */
  it('will not hand back more than a page however much is asked for', async () => {
    for (let index = 0; index < MAX_DOCUMENT_PAGE + 1; index += 1) {
      await createDocument(db, draft({ lines: [] }), NOW)
    }

    expect(await listDocuments(db, { limit: 4 })).toHaveLength(4)
    expect(await listDocuments(db, { limit: 10_000 })).toHaveLength(MAX_DOCUMENT_PAGE)
    expect(await listDocuments(db)).toHaveLength(MAX_DOCUMENT_PAGE)
  })
})
