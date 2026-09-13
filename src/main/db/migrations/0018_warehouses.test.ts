/*
 * 0018, against a real encrypted database.
 *
 * Straight at the table throughout. `createWarehouse` in repos/stock.ts refuses most of
 * this first and says a better sentence, which is exactly why a test that went through it
 * could not tell whether the constraints were still there.
 *
 * The NOCASE tests are the ones worth reading. A unique index that folds case and a
 * comparison that does not are two different opinions about the same question, and this
 * project has shipped code that held both.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DATABASE_KEY_BYTES, closeDatabase, openDatabase, type SqliteDatabase } from '../connection'
import { rollbackMigrations, runMigrations } from '../migrate'
import { MIGRATIONS } from './index'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x18)
const NOW = '2026-04-01T00:00:00.000Z'

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-0018-'))
  directories.push(dir)
  connection = openDatabase({ filePath: join(dir, 'company.coffer'), key: KEY })
  handles.push(connection)
  runMigrations(connection, MIGRATIONS)
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

function writeWarehouse(
  id: string,
  over: {
    code?: string | null
    name?: string | null
    description?: string | null
    isArchived?: number | null
  } = {},
): void {
  connection
    .prepare(
      `INSERT INTO warehouses (id, code, name, description, is_archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      over.code === undefined ? `WH-${id}` : over.code,
      over.name === undefined ? `Warehouse ${id}` : over.name,
      over.description ?? null,
      over.isArchived === undefined ? 0 : over.isArchived,
      NOW,
      NOW,
    )
}

describe('0018 — warehouses', () => {
  it('takes an ordinary warehouse', () => {
    expect(() =>
      writeWarehouse('w-1', { code: 'MAIN', name: 'Main store', description: 'Behind the office' }),
    ).not.toThrow()
  })

  describe('the code', () => {
    it('is unique ignoring case', () => {
      writeWarehouse('w-1', { code: 'MAIN' })

      expect(() => writeWarehouse('w-2', { code: 'main' })).toThrow(/UNIQUE constraint failed/)
      expect(() => writeWarehouse('w-3', { code: 'Main' })).toThrow(/UNIQUE constraint failed/)
    })

    /*
     * THE HALF OF THE RULE THAT IS NOT IN THE MIGRATION, pinned here so the repository
     * cannot quietly stop honouring it. A NOCASE index and a BINARY comparison disagree:
     * a lookup for 'main' finds nothing while 'MAIN' is present, and the insert that
     * follows is then refused by the index with a raw constraint message. Measured, and
     * it is the bug `assertCodeFree` in repos/stock.ts is written against.
     */
    it('is not found by a case-sensitive comparison, which is why the repository collates', () => {
      writeWarehouse('w-1', { code: 'MAIN' })

      const binary = connection
        .prepare<[], { id: string }>(`SELECT id FROM warehouses WHERE code = 'main'`)
        .all()
      const collated = connection
        .prepare<[], { id: string }>(`SELECT id FROM warehouses WHERE code COLLATE NOCASE = 'main'`)
        .all()

      expect(binary).toEqual([])
      expect(collated.map((row) => row.id)).toEqual(['w-1'])
    })

    it('refuses a blank one, and one that is only spaces', () => {
      expect(() => writeWarehouse('w-1', { code: '' })).toThrow(/CHECK constraint failed/)
      expect(() => writeWarehouse('w-2', { code: '   ' })).toThrow(/CHECK constraint failed/)
    })

    /* NOCASE folds case and not whitespace, so ' MAIN' would be a second row that prints
     * as the first one and totals separately from it. */
    it('refuses one with space around it', () => {
      expect(() => writeWarehouse('w-1', { code: ' MAIN' })).toThrow(/CHECK constraint failed/)
      expect(() => writeWarehouse('w-2', { code: 'MAIN ' })).toThrow(/CHECK constraint failed/)
    })

    /*
     * NOT NULL AS WELL AS THE BLANK CHECK, and this is the trap rather than belt and
     * braces: `length(trim(NULL)) > 0` is NULL, a CHECK whose expression is NULL PASSES,
     * so the blank check on its own says nothing whatever about a missing code.
     */
    it('refuses a missing one', () => {
      expect(() => writeWarehouse('w-1', { code: null })).toThrow(/NOT NULL constraint failed/)
    })
  })

  describe('the name', () => {
    it('is unique ignoring case', () => {
      writeWarehouse('w-1', { name: 'Main store' })

      expect(() => writeWarehouse('w-2', { code: 'OTHER', name: 'MAIN STORE' })).toThrow(
        /UNIQUE constraint failed/,
      )
    })

    it('refuses a blank one and a missing one', () => {
      expect(() => writeWarehouse('w-1', { name: '  ' })).toThrow(/CHECK constraint failed/)
      expect(() => writeWarehouse('w-2', { name: null })).toThrow(/NOT NULL constraint failed/)
    })
  })

  /* Two ways to say "nothing here" is one too many: a screen showing a description shows
   * an empty line for one of them. */
  it('refuses a blank description but takes a missing one', () => {
    expect(() => writeWarehouse('w-1', { description: '' })).toThrow(/CHECK constraint failed/)
    expect(() => writeWarehouse('w-2', { description: null })).not.toThrow()
  })

  it('refuses an archived flag that is neither 0 nor 1, and a missing one', () => {
    expect(() => writeWarehouse('w-1', { isArchived: 2 })).toThrow(/CHECK constraint failed/)
    expect(() => writeWarehouse('w-2', { isArchived: null })).toThrow(/NOT NULL constraint failed/)
  })

  /* Nothing is seeded. 0018's header is the argument for why a migration must not, and
   * this pins it so that adding a seed later is a decision rather than a drift. */
  it('creates no warehouse of its own', () => {
    expect(
      connection.prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM warehouses`).get()
        ?.count,
    ).toBe(0)
  })
})

describe('0018 down', () => {
  it('takes the table away, through the real registry', () => {
    rollbackMigrations(connection, MIGRATIONS, { to: '0016' })

    expect(
      connection
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'warehouses'`,
        )
        .all(),
    ).toEqual([])
  })

  it('leaves a database that migrates forward again', () => {
    writeWarehouse('w-1', { code: 'MAIN' })

    rollbackMigrations(connection, MIGRATIONS, { to: '0016' })
    runMigrations(connection, MIGRATIONS)

    expect(() => writeWarehouse('w-1', { code: 'MAIN' })).not.toThrow()
    expect(connection.pragma('foreign_key_check')).toEqual([])
  })
})
