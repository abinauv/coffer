/*
 * 0020 and 0021, against a real encrypted database.
 *
 * EVERY RULE IS EXERCISED BY WRITING STRAIGHT AT THE TABLE. `createDocument` and the
 * documents service refuse some of the same things first — and one of them,
 * `EXPORT_TAX_PAYMENT_INVALID`, has no floor under it at all, which is exactly why the
 * ones that DO have a floor are tested here on their own. A test that only went through
 * the repository would pass against a database that had stopped checking, which is the
 * defence-in-depth blindness this codebase has been caught by in six separate batches.
 *
 * The two migrations share a file because they share a fixture and they are one decision
 * seen from two sides: what is true of a SUPPLY goes on the document (0020) and what is
 * true of what was BOUGHT goes on the line (0021).
 *
 * ── THE PART WORTH READING TWICE: THE FREEZE IS A LIST AND DOES NOT INHERIT ────────
 *
 * `documents_frozen_once_issued` enumerates the columns an issued document may not
 * change, so a column added afterwards is NOT frozen until the trigger is rewritten —
 * measured, not assumed. `document_lines_frozen_on_update` names no columns at all,
 * because a line is frozen against its parent's status, so a column added to
 * `document_lines` is frozen the moment it exists.
 *
 * Both halves are asserted below. Without the first, an issued export could be switched
 * between "with payment" and "under an undertaking" after the return was filed, and every
 * total on every page would still add up.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DATABASE_KEY_BYTES, closeDatabase, openDatabase, type SqliteDatabase } from '../connection'
import { rollbackMigrations, runMigrations } from '../migrate'
import { MIGRATIONS } from './index'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x20)
const NOW = '2026-04-01T00:00:00.000Z'

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-0020-'))
  directories.push(dir)
  connection = openDatabase({ filePath: join(dir, 'company.coffer'), key: KEY })
  handles.push(connection)
  runMigrations(connection, MIGRATIONS)

  connection
    .prepare(
      `INSERT INTO parties (id, name, country_code, is_customer, is_vendor, created_at, updated_at)
       VALUES ('p-1', 'Sunrise Components', 'in', 1, 1, ?, ?)`,
    )
    .run(NOW, NOW)

  writeStubEntry()
})

/**
 * One balanced journal entry, so an ISSUED document has something to name.
 *
 * 0010's CHECK — `status <> 'issued' OR entry_id IS NOT NULL OR kind IN ('quotation')` —
 * is rule 3 of domain/documents/types.ts written as a constraint: there is no
 * "issued but not yet posted" state to represent. Nothing to do with 0020, and it is what
 * every issued fixture in this file has to satisfy before any of 0020's rules can be
 * reached.
 *
 * THE INSERT ORDER IS BACKWARDS AND IS NOT A MISTAKE, and it is inside one transaction for
 * the same reason: `journal_entries_need_two_lines` refuses an entry that cannot already
 * see two lines carrying its id, `journal_lines_before_entry` refuses a line whose parent
 * exists, and the line's foreign key is DEFERRABLE INITIALLY DEFERRED — which defers it to
 * COMMIT, and every statement outside an explicit transaction is its own commit.
 */
function writeStubEntry(): void {
  connection
    .prepare(
      `INSERT INTO accounts (id, code, name, type, parent_id, is_group, is_archived,
         description, created_at, updated_at)
       VALUES ('acc-dr', '9001', 'Stub debit', 'asset', NULL, 0, 0, NULL, ?, ?),
              ('acc-cr', '9002', 'Stub credit', 'equity', NULL, 0, 0, NULL, ?, ?)`,
    )
    .run(NOW, NOW, NOW, NOW)

  connection
    .prepare(
      `INSERT INTO accounting_periods (id, fiscal_year_label, fiscal_year_start_year,
         period_index, granularity, label, start_date, end_date, status, closed_at, created_at)
       VALUES ('per-1', '2026-27', 2026, 1, 'month', 'Apr 2026', '2026-04-01', '2026-04-30',
               'open', NULL, ?)`,
    )
    .run(NOW)

  connection.exec('BEGIN')
  connection
    .prepare(
      `INSERT INTO journal_lines (id, entry_id, line_number, account_id, debit, credit,
         narration, party_id)
       VALUES ('jl-1', 'je-1', 1, 'acc-dr', '1.00', '0.00', NULL, NULL),
              ('jl-2', 'je-1', 2, 'acc-cr', '0.00', '1.00', NULL, NULL)`,
    )
    .run()
  connection
    .prepare(
      `INSERT INTO journal_entries (id, entry_number, entry_date, narration, source_type,
         source_id, source_number, period_id, reverses_entry_id, posted_at)
       VALUES ('je-1', 'JV-2026-27-0001', '2026-04-15', 'A rupee, so an issued document posts',
               'sales-invoice', NULL, NULL, 'per-1', NULL, ?)`,
    )
    .run(NOW)
  connection.exec('COMMIT')
}

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

// ---- Helpers ---------------------------------------------------------------

interface DocumentOver {
  kind?: string
  status?: string
  number?: string | null
  country?: string
  exportTaxPayment?: string | null
  isReverseCharge?: number | null
}

/**
 * `due_date` is filled in for exactly the rows 0014's biconditional insists on: an issued
 * document of a kind that charges on terms, and nothing else. Not this migration's rule
 * and easy to trip over — the first version of this helper left it null and every issued
 * document was refused with `DOCUMENT_DUE_DATE_INVALID`, which is 0014's trigger working.
 */
const ON_TERMS = new Set(['sales-invoice', 'purchase-bill'])

function writeDocument(id: string, over: DocumentOver = {}): void {
  const status = over.status ?? 'draft'
  const kind = over.kind ?? 'sales-invoice'
  connection
    .prepare(
      `INSERT INTO documents (id, kind, status, number, document_date, party_id,
         place_of_supply_country, rounding_policy, narration, entry_id, created_at, updated_at,
         issued_at, cancelled_at, due_date, export_tax_payment, is_reverse_charge)
       VALUES (?, ?, ?, ?, '2026-04-15', 'p-1', ?, 'none', '', ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      id,
      kind,
      status,
      over.number === undefined ? (status === 'draft' ? null : `INV-${id}`) : over.number,
      over.country ?? 'in',
      /* `entry_id` is UNIQUE, so only ONE issued document per test may name the stub. Every
       * test below issues at most one, which is why this is not a factory. */
      status === 'draft' ? null : 'je-1',
      NOW,
      NOW,
      status === 'draft' ? null : NOW,
      status !== 'draft' && ON_TERMS.has(kind) ? '2026-05-15' : null,
      over.exportTaxPayment === undefined ? null : over.exportTaxPayment,
      over.isReverseCharge === undefined ? 0 : over.isReverseCharge,
    )
}

let nextLineNumber = 1

beforeEach(() => {
  nextLineNumber = 1
})

function writeLine(id: string, documentId: string, itcEligibility: string | null): void {
  connection
    .prepare(
      `INSERT INTO document_lines (id, document_id, line_number, description, quantity,
         unit_price, discount, taxable_amount, rate_pct, is_charge, itc_eligibility)
       VALUES (?, ?, ?, 'A thing', '1.000', '1000.00', '0.00', '1000.00', '18.000', 0, ?)`,
    )
    .run(id, documentId, (nextLineNumber += 1), itcEligibility)
}

function columnsOf(table: string): string[] {
  return connection
    .prepare<[string], { name: string }>(`SELECT name FROM pragma_table_info(?)`)
    .all(table)
    .map((row) => row.name)
}

// ---- 0020: the document's tax treatment ------------------------------------

describe('0020 — documents.export_tax_payment', () => {
  it('takes either flavour of a zero-rated supply', () => {
    expect(() =>
      writeDocument('d-1', { country: 'ae', exportTaxPayment: 'with-payment' }),
    ).not.toThrow()
    expect(() =>
      writeDocument('d-2', { country: 'ae', exportTaxPayment: 'without-payment' }),
    ).not.toThrow()
  })

  /*
   * NULL IS PERMITTED ON PURPOSE and the CHECK says so out loud. A CHECK whose expression
   * evaluates to NULL PASSES, so `export_tax_payment IN (...)` alone would admit a null by
   * ACCIDENT and be indistinguishable from this. Written out, the null is a decision.
   */
  it('takes no answer at all, which is every domestic supply', () => {
    expect(() => writeDocument('d-3', { exportTaxPayment: null })).not.toThrow()
    expect(
      connection
        .prepare<[], { export_tax_payment: string | null }>(
          `SELECT export_tax_payment FROM documents WHERE id = 'd-3'`,
        )
        .get()?.export_tax_payment,
    ).toBeNull()
  })

  it('refuses a word outside the vocabulary', () => {
    expect(() => writeDocument('d-4', { exportTaxPayment: 'maybe' })).toThrow(
      /CHECK constraint failed/,
    )
    /* Including the empty string, which is the one a form posts when nobody chose. */
    expect(() => writeDocument('d-5', { exportTaxPayment: '' })).toThrow(/CHECK constraint failed/)
  })

  /*
   * NO CONSTRAINT TIES IT TO THE PLACE OF SUPPLY, and this asserts the absence rather than
   * leaving it to be discovered. 0020's header argues it: the company's own country is a
   * mutable single row that can legitimately be empty, a `WHEN` that evaluates to NULL
   * does not fire, and hardcoding a country would put a regime in `db/`. What holds
   * instead is `DocumentsService`, which has the regime's own answer — and it is the one
   * rule in this pair with no floor under it.
   */
  it('does not refuse an export treatment on a domestic supply, which is the service’s rule', () => {
    expect(() =>
      writeDocument('d-6', { country: 'in', exportTaxPayment: 'without-payment' }),
    ).not.toThrow()
  })

  it('indexes only the rows that have one', () => {
    const index = connection
      .prepare<[], { sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'documents_export_tax_payment'`,
      )
      .get()

    expect(index?.sql).toContain('WHERE export_tax_payment IS NOT NULL')
  })
})

describe('0020 — documents.is_reverse_charge', () => {
  it('backfills every existing document as forward charge', () => {
    /* Written before the column existed is not reachable from here — the migration has
     * already run — so the DEFAULT is asserted instead, which is the thing that did it. */
    connection
      .prepare(
        `INSERT INTO documents (id, kind, status, number, document_date, party_id,
           place_of_supply_country, rounding_policy, narration, created_at, updated_at)
         VALUES ('d-default', 'sales-invoice', 'draft', NULL, '2026-04-15', 'p-1', 'in',
                 'none', '', ?, ?)`,
      )
      .run(NOW, NOW)

    expect(
      connection
        .prepare<[], { is_reverse_charge: number }>(
          `SELECT is_reverse_charge FROM documents WHERE id = 'd-default'`,
        )
        .get()?.is_reverse_charge,
    ).toBe(0)
  })

  it('takes a 1 and a 0 and nothing else', () => {
    expect(() => writeDocument('d-7', { isReverseCharge: 1 })).not.toThrow()
    expect(() => writeDocument('d-8', { isReverseCharge: 0 })).not.toThrow()
    expect(() => writeDocument('d-9', { isReverseCharge: 2 })).toThrow(/CHECK constraint failed/)
  })

  /*
   * BOTH `NOT NULL` AND THE CHECK, because a CHECK that evaluates to NULL PASSES —
   * `NULL IN (0, 1)` is NULL, so the CHECK on its own would admit a null and every reader
   * would then need a `?? false`. This is the assertion that says the NOT NULL is doing
   * work rather than decorating.
   */
  it('refuses a null, which the CHECK on its own would have admitted', () => {
    expect(() => writeDocument('d-10', { isReverseCharge: null })).toThrow(
      /NOT NULL constraint failed/,
    )
  })

  it('is not confined to one side of the trade', () => {
    /* An outward supply under reverse charge carries a value and no liability; an inward
     * one makes this business liable AND entitled. Both are real, so neither is refused. */
    expect(() => writeDocument('d-11', { kind: 'sales-invoice', isReverseCharge: 1 })).not.toThrow()
    expect(() => writeDocument('d-12', { kind: 'purchase-bill', isReverseCharge: 1 })).not.toThrow()
  })
})

describe('0020 — the freeze, which had to be rewritten', () => {
  it('refuses changing either new column once the document is issued', () => {
    writeDocument('d-issued', {
      status: 'issued',
      country: 'ae',
      exportTaxPayment: 'with-payment',
    })

    expect(() =>
      connection
        .prepare(
          `UPDATE documents SET export_tax_payment = 'without-payment' WHERE id = 'd-issued'`,
        )
        .run(),
    ).toThrow(/DOCUMENT_NOT_DRAFT/)

    expect(() =>
      connection.prepare(`UPDATE documents SET is_reverse_charge = 1 WHERE id = 'd-issued'`).run(),
    ).toThrow(/DOCUMENT_NOT_DRAFT/)
  })

  /*
   * CLEARING IT IS A CHANGE TOO, and this is the direction the `IFNULL` spelling exists
   * for: `NEW.export_tax_payment <> OLD.export_tax_payment` is NULL when either side is
   * NULL, a `WHEN` that evaluates to NULL does not fire, and the plain spelling would
   * therefore let an issued export have its treatment ERASED — silently, and in exactly
   * the case where somebody wanted to hide it.
   */
  it('refuses clearing it', () => {
    writeDocument('d-lut', { status: 'issued', country: 'ae', exportTaxPayment: 'without-payment' })

    expect(() =>
      connection.prepare(`UPDATE documents SET export_tax_payment = NULL WHERE id = 'd-lut'`).run(),
    ).toThrow(/DOCUMENT_NOT_DRAFT/)
  })

  it('refuses setting one that was absent', () => {
    writeDocument('d-none', { status: 'issued', country: 'ae', exportTaxPayment: null })

    expect(() =>
      connection
        .prepare(`UPDATE documents SET export_tax_payment = 'with-payment' WHERE id = 'd-none'`)
        .run(),
    ).toThrow(/DOCUMENT_NOT_DRAFT/)
  })

  it('still refuses everything it refused before, so the rewrite lost nothing', () => {
    writeDocument('d-old', { status: 'issued' })

    for (const change of [
      `document_date = '2026-05-01'`,
      `place_of_supply_country = 'ae'`,
      `rounding_policy = 'whole-unit'`,
      `narration = 'edited'`,
      `number = 'INV-OTHER'`,
      `due_date = '2026-06-15'`,
    ]) {
      expect(
        () => connection.prepare(`UPDATE documents SET ${change} WHERE id = 'd-old'`).run(),
        change,
      ).toThrow(/DOCUMENT_NOT_DRAFT/)
    }
  })

  it('still lets a draft be edited', () => {
    writeDocument('d-draft')

    expect(() =>
      connection
        .prepare(
          `UPDATE documents SET is_reverse_charge = 1, export_tax_payment = NULL
                  WHERE id = 'd-draft'`,
        )
        .run(),
    ).not.toThrow()
  })
})

// ---- 0021: the line's credit eligibility -----------------------------------

describe('0021 — document_lines.itc_eligibility', () => {
  beforeEach(() => {
    writeDocument('d-bill', { kind: 'purchase-bill' })
  })

  it('takes each of the three, and no answer at all', () => {
    expect(() => writeLine('l-1', 'd-bill', 'eligible')).not.toThrow()
    expect(() => writeLine('l-2', 'd-bill', 'ineligible-17-5')).not.toThrow()
    expect(() => writeLine('l-3', 'd-bill', 'ineligible-other')).not.toThrow()
    expect(() => writeLine('l-4', 'd-bill', null)).not.toThrow()
  })

  it('refuses a word outside the vocabulary', () => {
    expect(() => writeLine('l-5', 'd-bill', 'blocked')).toThrow(/CHECK constraint failed/)
    expect(() => writeLine('l-6', 'd-bill', '')).toThrow(/CHECK constraint failed/)
  })

  /*
   * IT DOES NOT BACKFILL, and 0021's header argues why: `eligible` is what the books
   * already assert, but writing it into every existing row would make an inference
   * indistinguishable from a decision — and there would then be nothing for a return to
   * raise an issue about.
   */
  it('leaves a line that says nothing saying nothing', () => {
    connection
      .prepare(
        `INSERT INTO document_lines (id, document_id, line_number, description, quantity,
           unit_price, discount, taxable_amount, rate_pct, is_charge)
         VALUES ('l-silent', 'd-bill', 9, 'A thing', '1.000', '1.00', '0.00', '1.00', '0.000', 0)`,
      )
      .run()

    expect(
      connection
        .prepare<[], { itc_eligibility: string | null }>(
          `SELECT itc_eligibility FROM document_lines WHERE id = 'l-silent'`,
        )
        .get()?.itc_eligibility,
    ).toBeNull()
  })

  /*
   * NOT CONFINED TO THE PURCHASE SIDE HERE, deliberately — the rule needs the list of
   * purchase-side kinds, which lives in `@shared/documents` and which a migration cannot
   * import. `assertEligibilityIsInward` in repos/documents.ts is where it is stated, and a
   * stray value reaches no figure and no box because a return reads the column only from
   * inward documents.
   */
  it('does not refuse one on a sales line, which is the repository’s rule', () => {
    writeDocument('d-invoice', { kind: 'sales-invoice' })

    expect(() => writeLine('l-sales', 'd-invoice', 'ineligible-17-5')).not.toThrow()
  })

  /*
   * THE HALF THAT NEEDED NO MIGRATION. `document_lines_frozen_on_update` (0008) names no
   * columns — a line has no status of its own and is frozen against its parent's — so a
   * column added to this table is frozen the moment it exists. That is the opposite of
   * `documents`, one table over, and the difference is why 0020 had to rewrite a trigger
   * and 0021 did not.
   */
  it('is frozen once the document is issued, with no trigger rewritten to do it', () => {
    writeLine('l-frozen', 'd-bill', 'eligible')
    connection
      .prepare(
        `UPDATE documents SET status = 'issued', number = 'BILL-1', issued_at = ?,
                  due_date = '2026-05-15', entry_id = 'je-1'
                WHERE id = 'd-bill'`,
      )
      .run(NOW)

    expect(() =>
      connection
        .prepare(
          `UPDATE document_lines SET itc_eligibility = 'ineligible-17-5'
                  WHERE id = 'l-frozen'`,
        )
        .run(),
    ).toThrow(/DOCUMENT_NOT_DRAFT/)
  })
})

// ---- Rolling back ----------------------------------------------------------

describe('0020 and 0021 down', () => {
  it('takes both columns away and puts the freeze back as 0014 left it', () => {
    rollbackMigrations(connection, MIGRATIONS, { to: '0019' })

    expect(columnsOf('documents')).not.toContain('export_tax_payment')
    expect(columnsOf('documents')).not.toContain('is_reverse_charge')
    expect(columnsOf('document_lines')).not.toContain('itc_eligibility')

    const trigger = connection
      .prepare<[], { sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'documents_frozen_once_issued'`,
      )
      .get()
    expect(trigger?.sql).toContain('due_date')
    expect(trigger?.sql).not.toContain('export_tax_payment')
  })

  it('leaves a database that migrates forward again', () => {
    rollbackMigrations(connection, MIGRATIONS, { to: '0019' })
    const applied = runMigrations(connection, MIGRATIONS)

    expect(applied.applied).toEqual(['0020', '0021', '0022'])
    expect(columnsOf('documents')).toContain('export_tax_payment')
    expect(connection.pragma('foreign_key_check')).toEqual([])
  })

  /* A document written before the rollback survives it. A `down` that rebuilt the table
   * would lose every document in the file, and nothing else here would say so. */
  it('keeps the documents', () => {
    writeDocument('d-keep', { country: 'ae', exportTaxPayment: 'without-payment' })

    rollbackMigrations(connection, MIGRATIONS, { to: '0019' })

    expect(
      connection
        .prepare<[], { id: string }>(`SELECT id FROM documents`)
        .all()
        .map((row) => row.id),
    ).toEqual(['d-keep'])
  })
})
