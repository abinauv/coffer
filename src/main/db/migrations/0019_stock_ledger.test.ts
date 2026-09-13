/*
 * 0019, against a real encrypted database.
 *
 * EVERY TEST HERE WRITES STRAIGHT AT THE TABLE. `recordMovement` in repos/stock.ts
 * refuses most of this before any SQL runs — which is what makes the repository able to
 * say "there are 4.000 on hand and this takes out 6.000" — and it is also what makes a
 * test that goes through it unable to notice that a constraint has been deleted. Six
 * batches of this codebase have been caught by that; these are the constraints on their
 * own.
 *
 * Two of them are worth reading before the rest:
 *
 *   `agrees with the kind table` drives the cost biconditional with every kind the DOMAIN
 *   knows rather than a list retyped here. 0019 has to enumerate the kinds in SQL because
 *   a trigger cannot import a union; this is the join between the two, so an eighth kind
 *   fails here rather than in a report six months later.
 *
 *   `refuses a movement for an item that is not there` runs with foreign keys OFF, which
 *   is not an exotic state — the migration runner turns them off for the whole of every
 *   migration. It is the case that separates `IS NOT 1` from `<> 1`: a comparison against
 *   NULL is NULL, a `WHEN` that evaluates to NULL does not fire, and the `<>` spelling
 *   lets the row in. Without this test that mutation survives.
 *
 * ── EVERY ROW HERE NAMES A JOURNAL ENTRY, AND THAT IS 0022's DOING ─────────────────
 *
 * Migration 0022 refuses a movement that cost money and names no entry. So `writeMovement`
 * points every row at one stub entry — written raw here, like the items and the
 * warehouses, because this file's whole method is to reach the table with nothing in
 * front of it.
 *
 * IT HAD TO BE DONE, AND FOR A REASON WORTH RECORDING: A `BEFORE INSERT` TRIGGER
 * PRE-EMPTS EVERY CHECK CONSTRAINT ON THE ROW, AND THE MOST RECENTLY CREATED TRIGGER
 * FIRES FIRST. Both measured on 3.53.4 rather than read. Without the stub entry, a row
 * with a negative quantity — or a bad date, or a blank source type, or an item that keeps
 * no balance — reported `MOVEMENT_NOT_POSTED` instead of the rule the test was about, and
 * every one of these tests would have gone on passing while asserting a different
 * constraint from the one it names. That is the shape CONVENTIONS §6 warns about: the
 * measurement did not go missing, it quietly changed subject.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { STOCK_MOVEMENT_KINDS, directionOf } from '@main/domain/inventory'

import { DATABASE_KEY_BYTES, closeDatabase, openDatabase, type SqliteDatabase } from '../connection'
import { rollbackMigrations, runMigrations } from '../migrate'
import { MIGRATIONS } from './index'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x19)
const NOW = '2026-04-01T00:00:00.000Z'

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-0019-'))
  directories.push(dir)
  connection = openDatabase({ filePath: join(dir, 'company.coffer'), key: KEY })
  handles.push(connection)
  runMigrations(connection, MIGRATIONS)

  connection
    .prepare(
      `INSERT INTO items (id, name, kind, is_sold, is_purchased, is_stock_tracked,
         created_at, updated_at)
       VALUES ('i-stock', 'Ball bearing 6203', 'goods', 1, 1, 1, ?, ?),
              ('i-plain', 'Packing tape', 'goods', 1, 1, 0, ?, ?),
              ('i-service', 'Advice', 'service', 1, 0, 0, ?, ?)`,
    )
    .run(NOW, NOW, NOW, NOW, NOW, NOW)

  connection
    .prepare(
      `INSERT INTO warehouses (id, code, name, is_archived, created_at, updated_at)
       VALUES ('w-1', 'MAIN', 'Main store', 0, ?, ?), ('w-2', 'WH-2', 'Yard', 0, ?, ?)`,
    )
    .run(NOW, NOW, NOW, NOW)

  writeStubEntry()
})

/**
 * One balanced journal entry, so that rows written straight at `stock_ledger` can name
 * one and be judged on the rules this file is actually about (0022).
 *
 * WRITTEN RAW, in this file's own idiom, rather than through `setUpBooks` and the journal
 * repository. Two reasons and the second is the one that decides it: this file's method is
 * to reach the table with nothing in front of it, and `setUpBooks` seeds a warehouse
 * called MAIN, which is the code the fixture above already uses — the unique index would
 * refuse the second one and the failure would be about warehouses.
 *
 * THE INSERT ORDER IS BACKWARDS AND IS NOT A MISTAKE. `journal_entries_need_two_lines`
 * (0004) refuses an entry that cannot already see two lines carrying its id, and
 * `journal_lines_before_entry` refuses a line whose parent already exists. Lines first,
 * entry last, with the line's foreign key deferred. See domain/ledger/types.ts.
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

  /* ONE TRANSACTION, and it is not optional. The line's foreign key is DEFERRABLE
   * INITIALLY DEFERRED, which defers it to COMMIT — and every statement outside an
   * explicit transaction is its own commit, so writing the lines on their own fails the
   * key immediately. Measured here rather than reasoned about: the first version of this
   * helper had no BEGIN and reported `FOREIGN KEY constraint failed` on the lines. */
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
       VALUES ('je-1', 'JV-2026-27-0001', '2026-04-01',
               'A rupee, so a movement written past the repository has an entry to name',
               'stock-adjustment', NULL, NULL, 'per-1', NULL, ?)`,
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

interface MovementOver {
  itemId?: string
  warehouseId?: string
  kind?: string
  date?: string
  sequence?: number
  quantity?: string | null
  cost?: string | null
  sourceType?: string | null
  /** `null` writes a movement that names no entry — 0022's own subject. */
  entryId?: string | null
}

let nextSequence = 1

function writeMovement(id: string, over: MovementOver = {}): void {
  const kind = over.kind ?? 'receipt'
  const inward = kind === 'receipt' || kind === 'opening'
  connection
    .prepare(
      `INSERT INTO stock_ledger (id, item_id, warehouse_id, kind, movement_date, sequence,
         quantity, cost, source_type, source_id, source_number, narration, created_at, entry_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    )
    .run(
      id,
      over.itemId ?? 'i-stock',
      over.warehouseId ?? 'w-1',
      kind,
      over.date ?? '2026-04-05',
      over.sequence ?? (nextSequence += 1),
      over.quantity === undefined ? '10.000' : over.quantity,
      over.cost === undefined ? (inward ? '1000.00' : null) : over.cost,
      over.sourceType === undefined ? 'purchase-bill' : over.sourceType,
      NOW,
      over.entryId === undefined ? STUB_ENTRY : over.entryId,
    )
}

/** The entry every row here names, unless a test is about not naming one. */
const STUB_ENTRY = 'je-1'

beforeEach(() => {
  nextSequence = 1
})

describe('0019 — the stock ledger', () => {
  it('takes an ordinary receipt and an ordinary issue', () => {
    expect(() => writeMovement('m-1', { kind: 'receipt', cost: '1000.00' })).not.toThrow()
    expect(() =>
      writeMovement('m-2', { kind: 'issue', quantity: '4.000', cost: null }),
    ).not.toThrow()
  })

  /*
   * THE COLUMNS THAT ARE NOT THERE ARE THE DESIGN, so their absence is asserted rather
   * than left to a reader of the migration. A running balance stored here would be a
   * second answer to a question `runStockCard` already answers, and a back-dated receipt
   * would make it wrong on every row after it.
   */
  it('stores no running balance', () => {
    const columns = connection
      .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('stock_ledger')`)
      .all()
      .map((row) => row.name)

    expect(columns).not.toContain('balance_quantity')
    expect(columns).not.toContain('balance_value')
    expect(columns).toEqual(
      expect.arrayContaining(['item_id', 'warehouse_id', 'kind', 'movement_date', 'sequence']),
    )
  })

  describe('who supplies the cost', () => {
    /*
     * COUNTED FROM THE DOMAIN'S KIND TABLE, NOT LISTED HERE. 0019 enumerates the inward
     * kinds in SQL because a CHECK cannot import a union, and this is the join: for every
     * kind the build knows, the database agrees with `directionOf` in BOTH directions.
     *
     * Both halves have teeth and the second is the dangerous one — an inward row with no
     * cost values stock at nothing and the card that results ties perfectly.
     */
    it('agrees with the kind table about which movements state a cost', () => {
      for (const definition of Object.values(STOCK_MOVEMENT_KINDS)) {
        const inward = directionOf(definition.kind) === 'in'
        const write =
          (suffix: string, cost: string | null): (() => void) =>
          () =>
            writeMovement(`m-${definition.kind}-${suffix}`, { kind: definition.kind, cost })

        if (inward) {
          expect(write('with', '100.00'), `${definition.kind} must state a cost`).not.toThrow()
          expect(write('without', null), `${definition.kind} must require one`).toThrow(
            /CHECK constraint failed/,
          )
        } else {
          expect(write('without', null), `${definition.kind} must not state one`).not.toThrow()
          expect(write('with', '100.00'), `${definition.kind} must refuse one`).toThrow(
            /CHECK constraint failed/,
          )
        }
      }
    })

    it('refuses a cost that is not money at two places', () => {
      for (const cost of ['100.0', '100', '100.000', '-100.00', '.50']) {
        expect(() => writeMovement(`m-${cost}`, { cost }), `${cost} is not an amount`).toThrow(
          /CHECK constraint failed/,
        )
      }
    })
  })

  /*
   * INVARIANT 6 AT ROW LEVEL, and both halves of it are legal here. The illegal state —
   * value on hand with nothing on hand — is a running total, so this table structurally
   * cannot see it, and it cannot even see half of it: the value going out is derived and
   * never stored. `movingAverage.receive` refuses it while somebody can still fix it.
   */
  describe('quantity and value, and the asymmetry between them', () => {
    it('takes freight: a cost with no quantity at all', () => {
      expect(() =>
        writeMovement('m-freight', { kind: 'receipt', quantity: '0.000', cost: '1200.00' }),
      ).not.toThrow()
    })

    it('takes a free sample: a quantity at no cost', () => {
      expect(() =>
        writeMovement('m-sample', { kind: 'receipt', quantity: '20.000', cost: '0.00' }),
      ).not.toThrow()
    })

    /* Invariant 3: a movement carries how much moved, and the kind carries which way. A
     * negative quantity would be a second way to say "out", agreeing with the kind right
     * up until it did not, and every total would still add up. */
    it('refuses a negative quantity, whatever the kind', () => {
      expect(() => writeMovement('m-neg', { quantity: '-1.000' })).toThrow(
        /CHECK constraint failed/,
      )
    })

    it('refuses a quantity that is not three places', () => {
      for (const quantity of ['1.00', '1.0000', '1', '.500']) {
        expect(
          () => writeMovement(`m-${quantity}`, { quantity }),
          `${quantity} is not a quantity`,
        ).toThrow(/CHECK constraint failed/)
      }
    })

    it('refuses a missing quantity', () => {
      expect(() => writeMovement('m-null', { quantity: null })).toThrow(
        /NOT NULL constraint failed/,
      )
    })
  })

  it('refuses a movement kind this build does not know', () => {
    expect(() => writeMovement('m-x', { kind: 'transfer' })).toThrow(/CHECK constraint failed/)
  })

  /* '2026-4-5' sorts before '2026-04-01' as text, and every comparison a stock card makes
   * is a string comparison — so a date a character short lands in the wrong place in the
   * fold rather than failing. */
  it('refuses a date that is not ten characters', () => {
    expect(() => writeMovement('m-d', { date: '2026-4-5' })).toThrow(/CHECK constraint failed/)
  })

  it('refuses a movement that does not say what raised it', () => {
    expect(() => writeMovement('m-s1', { sourceType: '  ' })).toThrow(/CHECK constraint failed/)
    expect(() => writeMovement('m-s2', { sourceType: null })).toThrow(/NOT NULL constraint failed/)
  })

  /*
   * A `source_type` IS NOT CONSTRAINED TO A LIST, and that is 0004's decision rather than
   * an omission: `SourceDocumentType` is the domain's union and a CHECK duplicating it
   * would be a second copy to keep in step inside a file that may never be edited.
   *
   * A movement KIND and a source type are also two different facts, which one row shows:
   * a `stock-adjustment` document raises `adjustment-in` for a surplus and
   * `adjustment-out` for shrinkage, in the same session, against the same document.
   */
  it('lets one source document raise movements of two different kinds', () => {
    expect(() =>
      writeMovement('m-surplus', {
        kind: 'adjustment-in',
        cost: '50.00',
        sourceType: 'stock-adjustment',
      }),
    ).not.toThrow()
    expect(() =>
      writeMovement('m-shrink', {
        kind: 'adjustment-out',
        cost: null,
        sourceType: 'stock-adjustment',
      }),
    ).not.toThrow()
  })

  describe('the position of a movement in its register', () => {
    it('refuses two movements sharing a sequence in one place', () => {
      writeMovement('m-1', { sequence: 1 })

      expect(() => writeMovement('m-2', { sequence: 1 })).toThrow(/UNIQUE constraint failed/)
    })

    /* A register is per (item, warehouse), so the same sequence in another place is
     * another register's row and not a collision. */
    it('lets two places use the same sequence', () => {
      writeMovement('m-1', { sequence: 1, warehouseId: 'w-1' })

      expect(() => writeMovement('m-2', { sequence: 1, warehouseId: 'w-2' })).not.toThrow()
    })

    it('refuses a sequence below one', () => {
      expect(() => writeMovement('m-0', { sequence: 0 })).toThrow(/CHECK constraint failed/)
    })
  })

  describe('the item must keep a balance', () => {
    it('refuses a movement for an item that keeps none', () => {
      expect(() => writeMovement('m-1', { itemId: 'i-plain' })).toThrow(/ITEM_NOT_STOCK_TRACKED/)
    })

    it('refuses one for a service, which can never keep one', () => {
      expect(() => writeMovement('m-2', { itemId: 'i-service' })).toThrow(/ITEM_NOT_STOCK_TRACKED/)
    })

    /*
     * THE CASE THAT SEPARATES `IS NOT 1` FROM `<> 1`.
     *
     * With foreign keys on, the parent is always there and the two spellings agree — but
     * the migration runner turns foreign keys OFF for the whole of every migration
     * (`withoutForeignKeys` in ../migrate.ts, because `defer_foreign_keys` does not stop
     * `ON DELETE CASCADE` firing on a `DROP TABLE`). In that state the subquery is NULL,
     * `NULL <> 1` is NULL, a `WHEN` that is NULL does not fire, and the `<>` spelling
     * admits the row. Measured, and this is the assertion that kills that mutation.
     */
    it('refuses a movement for an item that is not there, even with foreign keys off', () => {
      connection.pragma('foreign_keys = OFF')
      try {
        expect(() => writeMovement('m-3', { itemId: 'no-such-item' })).toThrow(
          /ITEM_NOT_STOCK_TRACKED/,
        )
      } finally {
        connection.pragma('foreign_keys = ON')
      }
    })
  })

  /*
   * APPEND-ONLY, exactly as `journal_entries` and `journal_lines` are — and here the
   * reason is sharper: editing a movement changes what every later movement cost, and the
   * entries those costs posted as cannot be edited to match. A correction is another
   * movement.
   */
  describe('append-only', () => {
    it('refuses an update', () => {
      writeMovement('m-1')

      expect(() =>
        connection.prepare(`UPDATE stock_ledger SET quantity = '9.000' WHERE id = 'm-1'`).run(),
      ).toThrow(/MOVEMENT_IMMUTABLE/)
    })

    it('refuses a delete', () => {
      writeMovement('m-1')

      expect(() => connection.prepare(`DELETE FROM stock_ledger WHERE id = 'm-1'`).run()).toThrow(
        /MOVEMENT_IMMUTABLE/,
      )
    })

    /* Not even the narration, which is the "just fixing a typo" case 0004 names. */
    it('refuses an update that changes nothing anybody would notice', () => {
      writeMovement('m-1')

      expect(() =>
        connection.prepare(`UPDATE stock_ledger SET narration = 'typo' WHERE id = 'm-1'`).run(),
      ).toThrow(/MOVEMENT_IMMUTABLE/)
    })
  })

  describe('an item with movements keeps its register', () => {
    it('refuses switching stock tracking off', () => {
      writeMovement('m-1')

      expect(() =>
        connection.prepare(`UPDATE items SET is_stock_tracked = 0 WHERE id = 'i-stock'`).run(),
      ).toThrow(/ITEM_IN_USE/)
    })

    /* It fires on the TRANSITION, not on every write to a stocked item's row: renaming or
     * repricing a stock item must not be refused because it has movements. */
    it('lets the item be renamed', () => {
      writeMovement('m-1')

      expect(() =>
        connection
          .prepare(`UPDATE items SET name = 'Ball bearing 6204' WHERE id = 'i-stock'`)
          .run(),
      ).not.toThrow()
    })

    it('lets an item with no movements switch its register off', () => {
      expect(() =>
        connection.prepare(`UPDATE items SET is_stock_tracked = 0 WHERE id = 'i-stock'`).run(),
      ).not.toThrow()
    })
  })

  /*
   * RESTRICT AT BOTH ENDS, never CASCADE. Deleting a warehouse must not silently take a
   * year of stock history with it while the balance sheet keeps the value.
   */
  describe('what a movement pins', () => {
    it('refuses deleting the warehouse it happened at', () => {
      writeMovement('m-1')

      expect(() => connection.prepare(`DELETE FROM warehouses WHERE id = 'w-1'`).run()).toThrow(
        /FOREIGN KEY constraint failed/,
      )
    })

    it('refuses deleting the item it is for', () => {
      writeMovement('m-1')

      expect(() => connection.prepare(`DELETE FROM items WHERE id = 'i-stock'`).run()).toThrow(
        /FOREIGN KEY constraint failed/,
      )
    })
  })
})

describe('0019 down', () => {
  it('takes the table and the trigger it left on items away, through the real registry', () => {
    writeMovement('m-1')

    rollbackMigrations(connection, MIGRATIONS, { to: '0016' })

    const objects = connection
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE name IN ('stock_ledger', 'items_no_untrack_with_movements')`,
      )
      .all()
    expect(objects).toEqual([])
  })

  /*
   * A trigger left on a surviving table reading a dropped one is a schema that will not
   * migrate forward again — which is what this asserts by actually migrating forward.
   * 0004's `down` drops `accounts_no_group_with_postings` for the same reason.
   */
  it('leaves a database that migrates forward again', () => {
    writeMovement('m-1')

    rollbackMigrations(connection, MIGRATIONS, { to: '0016' })
    const applied = runMigrations(connection, MIGRATIONS)

    expect(applied.applied).toEqual(['0017', '0018', '0019', '0020', '0021', '0022'])
    expect(connection.pragma('foreign_key_check')).toEqual([])
    expect(() => writeMovement('m-2')).toThrow(/ITEM_NOT_STOCK_TRACKED/)
  })

  it('rolls the whole registry back to nothing', () => {
    expect(() => rollbackMigrations(connection, MIGRATIONS, { to: null })).not.toThrow()

    expect(
      connection
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        )
        .all()
        .map((row) => row.name),
    ).toEqual(['schema_migrations'])
  })
})
