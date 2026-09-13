/*
 * 0017, against a real encrypted database.
 *
 * EVERY RULE IS EXERCISED BY WRITING STRAIGHT AT THE TABLE. The repository refuses the
 * same things first (`setItemStockTracking` in repos/stock.ts), so a test that only went
 * through it would pass against a database that had stopped checking — the
 * defence-in-depth blindness this codebase has been caught by in six separate batches.
 * These are the constraints, on their own, with nothing in front of them.
 *
 * And one test deliberately does NOT write its own fixture: an item created through the
 * REAL `createItem` must come out keeping no balance. A test that inserted its own row
 * could not notice that the shipped path had started marking everything as stock.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DATABASE_KEY_BYTES, closeDatabase, openDatabase, type SqliteDatabase } from '../connection'
import { createQueryBuilder, type CofferDb } from '../kysely'
import { rollbackMigrations, runMigrations } from '../migrate'
import { createItem } from '../repos/items'
import { MIGRATIONS } from './index'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x17)

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase
let db: CofferDb

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-0017-'))
  directories.push(dir)
  connection = openDatabase({ filePath: join(dir, 'company.coffer'), key: KEY })
  handles.push(connection)
  runMigrations(connection, MIGRATIONS)
  db = createQueryBuilder(connection)
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

const NOW = '2026-04-01T00:00:00.000Z'

/** An item written past every repository. `kind` and the two new columns are the subject. */
function writeItem(
  id: string,
  over: { kind?: string; isStockTracked?: number | null; reorderLevel?: string | null } = {},
): void {
  connection
    .prepare(
      `INSERT INTO items (id, name, kind, is_sold, is_purchased, is_stock_tracked, reorder_level,
         created_at, updated_at)
       VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?)`,
    )
    .run(
      id,
      `Item ${id}`,
      over.kind ?? 'goods',
      over.isStockTracked === undefined ? 0 : over.isStockTracked,
      over.reorderLevel ?? null,
      NOW,
      NOW,
    )
}

function columnsOf(table: string): string[] {
  return connection
    .prepare<[string], { name: string }>(`SELECT name FROM pragma_table_info(?)`)
    .all(table)
    .map((row) => row.name)
}

function trackingOf(id: string): { is_stock_tracked: number; reorder_level: string | null } {
  const row = connection
    .prepare<[string], { is_stock_tracked: number; reorder_level: string | null }>(
      `SELECT is_stock_tracked, reorder_level FROM items WHERE id = ?`,
    )
    .get(id)
  if (row === undefined) {
    throw new Error(`No item ${id}.`)
  }
  return row
}

describe('0017 — an item may keep a quantity balance', () => {
  it('adds both columns to items', () => {
    const columns = columnsOf('items')
    expect(columns).toContain('is_stock_tracked')
    expect(columns).toContain('reorder_level')
  })

  /*
   * THE SHIPPED PATH, not a fixture. `createItem` is what the application calls, and if
   * it started producing stock items the tests below would all still pass — every one of
   * them writes its own row. This is the only test that can notice.
   */
  it('leaves an item created through createItem keeping no balance', async () => {
    const item = await createItem(db, { name: 'Ball bearing 6203', kind: 'goods', isSold: true })

    expect(trackingOf(item.id)).toEqual({ is_stock_tracked: 0, reorder_level: null })
  })

  it('lets goods keep a balance', () => {
    expect(() => writeItem('i-1', { isStockTracked: 1 })).not.toThrow()
    expect(trackingOf('i-1').is_stock_tracked).toBe(1)
  })

  /*
   * THE RULE THIS MIGRATION WAS WRITTEN FOR. A service carrying stock puts a figure on
   * the valuation report that the general ledger's stock account never received, and both
   * pages still total.
   */
  it('refuses a service that keeps a balance', () => {
    expect(() => writeItem('i-2', { kind: 'service', isStockTracked: 1 })).toThrow(
      /CHECK constraint failed/,
    )
  })

  /*
   * THE DIRECTION A REPOSITORY RULE LEAVES OPEN. Somebody writing the rule thinks about
   * "may I turn tracking on"; `updateItem` can also change `kind`, and nothing would have
   * refused turning a stocked item INTO a service — the same state reached from the side
   * nobody was watching. A CHECK is re-evaluated on every write to the row, so it answers
   * both directions with one sentence.
   */
  it('refuses turning a stock-tracked item into a service', () => {
    writeItem('i-3', { isStockTracked: 1 })

    expect(() =>
      connection.prepare(`UPDATE items SET kind = 'service' WHERE id = 'i-3'`).run(),
    ).toThrow(/CHECK constraint failed/)
  })

  it('lets a service exist as long as it keeps no balance', () => {
    expect(() => writeItem('i-4', { kind: 'service' })).not.toThrow()
  })

  it('refuses a tracking flag that is neither 0 nor 1', () => {
    expect(() => writeItem('i-5', { isStockTracked: 2 })).toThrow(/CHECK constraint failed/)
  })

  /* NOT NULL as well as the CHECK. A CHECK whose expression is NULL PASSES, so the
   * `IN (0, 1)` test says nothing at all about a missing value. */
  it('refuses a missing tracking flag', () => {
    expect(() => writeItem('i-6', { isStockTracked: null })).toThrow(/NOT NULL constraint failed/)
  })

  describe('the reorder level', () => {
    it('is a quantity at three places', () => {
      expect(() => writeItem('r-1', { isStockTracked: 1, reorderLevel: '10.000' })).not.toThrow()
      expect(trackingOf('r-1').reorder_level).toBe('10.000')
    })

    it('refuses money scale, a negative, and an unpadded figure', () => {
      for (const level of ['10.00', '-1.000', '10', '10.0000']) {
        expect(
          () => writeItem(`r-${level}`, { isStockTracked: 1, reorderLevel: level }),
          `${level} is not a quantity`,
        ).toThrow(/CHECK constraint failed/)
      }
    })

    /*
     * An item that keeps no balance has nothing on hand, so it is below every level ever
     * set — it would sit on the re-order report forever telling somebody to buy something
     * they do not count. Always wrong, never obviously wrong.
     */
    it('refuses a level on an item that keeps no balance', () => {
      expect(() => writeItem('r-2', { reorderLevel: '10.000' })).toThrow(/CHECK constraint failed/)
    })

    it('is null for the ordinary stock item, which is not a rule in the other direction', () => {
      expect(() => writeItem('r-3', { isStockTracked: 1 })).not.toThrow()
      expect(trackingOf('r-3').reorder_level).toBeNull()
    })
  })

  it('indexes the stock items, and only those', () => {
    const index = connection
      .prepare<[], { sql: string | null }>(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'items_stock_tracked'`,
      )
      .get()

    expect(index?.sql).toMatch(/WHERE is_stock_tracked = 1/)
  })
})

/*
 * THE ROLLBACK, RUN AGAINST THE REAL REGISTRY RATHER THAN THIS MIGRATION ALONE.
 *
 * Reverting 0017 on its own is a thing the runner will not do, and a test that did it
 * would be testing a state no company file reaches: 0019 puts a trigger on `stock_ledger`
 * that reads `items.is_stock_tracked`, and `ALTER TABLE ... DROP COLUMN` is refused while
 * a trigger names the column — measured, and the one part of SQLite's documented
 * restriction on DROP COLUMN that this build actually enforces. What makes 0017's `down`
 * work is that the runner reverts newest first, so this exercises the order rather than
 * asserting it in a comment.
 */
describe('0017 down', () => {
  it('takes both columns and the index away, through the real registry', () => {
    rollbackMigrations(connection, MIGRATIONS, { to: '0016' })

    const columns = columnsOf('items')
    expect(columns).not.toContain('is_stock_tracked')
    expect(columns).not.toContain('reorder_level')
    expect(
      connection
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'items_stock_tracked'`,
        )
        .all(),
    ).toEqual([])
  })

  it('leaves a database that migrates forward again', () => {
    rollbackMigrations(connection, MIGRATIONS, { to: '0016' })
    const applied = runMigrations(connection, MIGRATIONS)

    expect(applied.applied).toEqual(['0017', '0018', '0019', '0020', '0021', '0022'])
    expect(columnsOf('items')).toContain('is_stock_tracked')
    expect(connection.pragma('foreign_key_check')).toEqual([])
  })

  /* And an item written before the rollback survives it. A `down` that dropped the table
   * and rebuilt it would lose every item in the file, and nothing else here would say so. */
  it('keeps the items', () => {
    writeItem('i-keep', { isStockTracked: 1, reorderLevel: '5.000' })

    rollbackMigrations(connection, MIGRATIONS, { to: '0016' })

    expect(
      connection
        .prepare<[], { id: string }>(`SELECT id FROM items`)
        .all()
        .map((row) => row.id),
    ).toEqual(['i-keep'])
  })
})
