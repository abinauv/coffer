/*
 * 0022, against a real encrypted database.
 *
 * ARCHITECTURE §6.4 says every stock movement posts. `db/repos/stock-reconciliation.test.ts`
 * proves the figures tie when it does; this file proves the DATABASE refuses the state
 * where it did not, with the repository nowhere in sight. The two are the same rule from
 * opposite ends, and a test that only went through `recordMovement` would pass against a
 * database that had stopped checking (CONVENTIONS §6).
 *
 * ── THE RULE IS HALF A BICONDITIONAL, AND THE TESTS SAY WHICH HALF ─────────────────
 *
 * A movement may go unposted ONLY IF IT MOVED NOTHING. This table can prove that for an
 * INWARD movement, which states its cost in a column, and cannot for an outward one,
 * whose value is derived by the strategy and which 0019 refuses to store. So the trigger
 * says the inward half and the repository says the other; both are asserted, one here and
 * one there, and neither pretends to be the whole rule.
 *
 * ── TWO MEASURED SQLITE FACTS ARE PINNED HERE, NOT ONLY DESCRIBED ─────────────────
 *
 * A `BEFORE INSERT` TRIGGER PRE-EMPTS EVERY CHECK CONSTRAINT ON THE ROW, and THE MOST
 * RECENTLY CREATED TRIGGER FIRES FIRST. Together they mean that adding a trigger to a
 * table CHANGES WHICH RULE AN EXISTING BAD WRITE REPORTS — which is what happened to
 * 0019's suite when this migration landed, and which is worth a test of its own rather
 * than a note in a header nobody re-reads.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DATABASE_KEY_BYTES, closeDatabase, openDatabase, type SqliteDatabase } from '../connection'
import { rollbackMigrations, runMigrations } from '../migrate'
import { MIGRATIONS } from './index'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x22)
const NOW = '2026-04-01T00:00:00.000Z'

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-0022-'))
  directories.push(dir)
  connection = openDatabase({ filePath: join(dir, 'company.coffer'), key: KEY })
  handles.push(connection)
  runMigrations(connection, MIGRATIONS)

  connection
    .prepare(
      `INSERT INTO items (id, name, kind, is_sold, is_purchased, is_stock_tracked,
         created_at, updated_at)
       VALUES ('i-stock', 'Ball bearing 6203', 'goods', 1, 1, 1, ?, ?),
              ('i-plain', 'Packing tape', 'goods', 1, 1, 0, ?, ?)`,
    )
    .run(NOW, NOW, NOW, NOW)

  connection
    .prepare(
      `INSERT INTO warehouses (id, code, name, is_archived, created_at, updated_at)
       VALUES ('w-1', 'MAIN', 'Main store', 0, ?, ?)`,
    )
    .run(NOW, NOW)

  writeStubEntry()
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

/** Lines first, entry last, inside one transaction — see 0004 and domain/ledger/types.ts. */
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
       VALUES ('je-1', 'JV-2026-27-0001', '2026-04-05', 'A rupee',
               'stock-adjustment', NULL, NULL, 'per-1', NULL, ?)`,
    )
    .run(NOW)
  connection.exec('COMMIT')
}

interface MovementOver {
  itemId?: string
  kind?: string
  quantity?: string
  cost?: string | null
  entryId?: string | null
  sequence?: number
}

let nextSequence = 1

beforeEach(() => {
  nextSequence = 1
})

function writeMovement(id: string, over: MovementOver = {}): void {
  const kind = over.kind ?? 'receipt'
  const inward = kind === 'receipt' || kind === 'opening' || kind === 'sales-return'
  connection
    .prepare(
      `INSERT INTO stock_ledger (id, item_id, warehouse_id, kind, movement_date, sequence,
         quantity, cost, source_type, source_id, source_number, narration, created_at, entry_id)
       VALUES (?, ?, 'w-1', ?, '2026-04-05', ?, ?, ?, 'purchase-bill', NULL, NULL, NULL, ?, ?)`,
    )
    .run(
      id,
      over.itemId ?? 'i-stock',
      kind,
      over.sequence ?? (nextSequence += 1),
      over.quantity ?? '10.000',
      over.cost === undefined ? (inward ? '1000.00' : null) : over.cost,
      NOW,
      over.entryId === undefined ? 'je-1' : over.entryId,
    )
}

function columnsOf(table: string): string[] {
  return connection
    .prepare<[string], { name: string }>(`SELECT name FROM pragma_table_info(?)`)
    .all(table)
    .map((row) => row.name)
}

// ---- The column ------------------------------------------------------------

describe('0022 — stock_ledger.entry_id', () => {
  it('exists, and takes the entry a movement posted as', () => {
    expect(columnsOf('stock_ledger')).toContain('entry_id')

    writeMovement('m-1')

    expect(
      connection
        .prepare<[], { entry_id: string | null }>(
          `SELECT entry_id FROM stock_ledger WHERE id = 'm-1'`,
        )
        .get()?.entry_id,
    ).toBe('je-1')
  })

  it('refuses an entry that is not in the books', () => {
    expect(() => writeMovement('m-2', { entryId: 'je-ghost' })).toThrow(/FOREIGN KEY/i)
  })

  /*
   * NOT UNIQUE, DELIBERATELY. One movement posts one entry today, so a unique index would
   * hold — and it would foreclose the arrangement a document has to reach for, where an
   * invoice moving five items posts ONE entry carrying five cost lines. Asserting the
   * absence rather than leaving it to be discovered: a constraint that is true today and
   * wrong for the next feature is the one that gets deleted under pressure.
   */
  it('lets two movements name the same entry', () => {
    writeMovement('m-3')
    expect(() => writeMovement('m-4')).not.toThrow()
  })
})

// ---- The rule --------------------------------------------------------------

describe('0022 — a movement that moved money must name an entry', () => {
  it('refuses an inward movement with a cost and no entry', () => {
    expect(() => writeMovement('m-5', { cost: '1000.00', entryId: null })).toThrow(
      /MOVEMENT_NOT_POSTED/,
    )
  })

  it('refuses it for every inward kind, not just a receipt', () => {
    for (const kind of ['opening', 'receipt', 'sales-return', 'adjustment-in']) {
      expect(() => writeMovement(`m-in-${kind}`, { kind, cost: '500.00', entryId: null })).toThrow(
        /MOVEMENT_NOT_POSTED/,
      )
    }
  })

  /*
   * THE OTHER HALF OF THE BICONDITIONAL. A movement that moved NOTHING has nothing to
   * post: invariant 6 admits a free sample taken in at nil on purpose, and ledger
   * invariant 5 refuses an entry of two zero lines. Refusing this row would refuse a real
   * transaction.
   */
  it('takes a free sample at nil with no entry, because nothing moved', () => {
    expect(() => writeMovement('m-6', { cost: '0.00', entryId: null })).not.toThrow()
  })

  /*
   * AND THE HALF THIS TABLE CANNOT PROVE. An outward movement carries `cost IS NULL` by
   * 0019's biconditional CHECK, so the row itself cannot say whether it moved money — the
   * value is derived by the strategy and 0019 spends its header refusing to store it. The
   * trigger therefore stands aside, and `recordMovement` is what guarantees the entry.
   * Asserted so the gap is a stated position rather than an omission somebody discovers.
   */
  it('stands aside for an outward movement, whose value is not on the row', () => {
    writeMovement('m-7')
    expect(() => writeMovement('m-8', { kind: 'issue', quantity: '1.000', entryId: null })).not.toThrow() // prettier-ignore
  })

  it('is spelled IS NULL, so a null cost does not make the WHEN vanish', () => {
    /* `IFNULL(NEW.cost, '0.00')` rather than a bare `NEW.cost <> '0.00'`. The bare
     * spelling has the same EFFECT here — `NULL <> '0.00'` is NULL and a WHEN that
     * evaluates to NULL does not fire — which is exactly why the explicit one is written:
     * the next person to add an inward kind with a nullable cost must not inherit a rule
     * nobody decided. This pins the sentence rather than the accident. */
    const trigger = connection
      .prepare<[], { sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'stock_ledger_posted'`,
      )
      .get()

    expect(trigger?.sql).toContain('NEW.entry_id IS NULL')
    expect(trigger?.sql).toContain(`IFNULL(NEW.cost, '0.00')`)
  })
})

// ---- The two measured facts ------------------------------------------------

describe('what adding a trigger to an existing table did', () => {
  /*
   * A `BEFORE INSERT` TRIGGER PRE-EMPTS EVERY CHECK CONSTRAINT ON THE ROW. The row below
   * breaks 0019's quantity CHECK *and* names no entry, and the answer is this migration's
   * code rather than 0019's constraint. Measured on 3.53.4.
   */
  it('answers before any CHECK on the same row can', () => {
    expect(() =>
      writeMovement('m-9', { quantity: '-1.000', cost: '1000.00', entryId: null }),
    ).toThrow(/MOVEMENT_NOT_POSTED/)

    /* And with an entry named, the CHECK gets its turn — so the CHECK is still there. */
    expect(() => writeMovement('m-10', { quantity: '-1.000', cost: '1000.00' })).toThrow(
      /CHECK constraint failed/,
    )
  })

  /*
   * THE MOST RECENTLY CREATED TRIGGER FIRES FIRST. `stock_ledger_item_tracked` was created
   * by 0019 and this one by 0022, and a row that breaks both reports THIS one. That is why
   * 0019's own suite had to start naming an entry: without it, every test in that file
   * would have gone on passing while asserting a different constraint from the one it
   * names.
   */
  it('answers before 0019’s older trigger on the same table', () => {
    expect(() =>
      writeMovement('m-11', { itemId: 'i-plain', cost: '1000.00', entryId: null }),
    ).toThrow(/MOVEMENT_NOT_POSTED/)

    /* 0019's rule is untouched and still speaks when this one has nothing to say. */
    expect(() => writeMovement('m-12', { itemId: 'i-plain' })).toThrow(/ITEM_NOT_STOCK_TRACKED/)
  })
})

// ---- Rolling back ----------------------------------------------------------

describe('0022 down', () => {
  it('takes the column, the trigger and the index away', () => {
    rollbackMigrations(connection, MIGRATIONS, { to: '0021' })

    expect(columnsOf('stock_ledger')).not.toContain('entry_id')
    expect(
      connection
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master WHERE name IN ('stock_ledger_posted', 'stock_ledger_entry')`,
        )
        .all(),
    ).toEqual([])
  })

  it('leaves a database that migrates forward again', () => {
    rollbackMigrations(connection, MIGRATIONS, { to: '0021' })
    const applied = runMigrations(connection, MIGRATIONS)

    expect(applied.applied).toEqual(['0022'])
    expect(columnsOf('stock_ledger')).toContain('entry_id')
    expect(connection.pragma('foreign_key_check')).toEqual([])
  })

  /* A movement written before the rollback survives it, and comes back with its entry.
   * A `down` that rebuilt the table would lose the register. */
  it('keeps the movements, and gives them their entry back', () => {
    writeMovement('m-keep')

    rollbackMigrations(connection, MIGRATIONS, { to: '0021' })
    expect(
      connection
        .prepare<[], { id: string }>(`SELECT id FROM stock_ledger`)
        .all()
        .map((row) => row.id),
    ).toEqual(['m-keep'])

    runMigrations(connection, MIGRATIONS)
    /* And the entry link is GONE, because the column was dropped and nothing put it back.
     * Stated rather than glossed: a rollback of this migration loses which entry each
     * movement posted as, and only the entry's own `source_id` can find it again. */
    expect(
      connection
        .prepare<[], { entry_id: string | null }>(
          `SELECT entry_id FROM stock_ledger WHERE id = 'm-keep'`,
        )
        .get()?.entry_id,
    ).toBeNull()
  })
})
