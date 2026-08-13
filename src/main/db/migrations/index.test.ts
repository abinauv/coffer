/*
 * The registry's own invariants. These are written to hold for any list, so they keep
 * their value as migrations are added: the day two branches both claim '0007', this
 * test is what says so.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DATABASE_KEY_BYTES, type SqliteDatabase, closeDatabase, openDatabase } from '../connection'
import { appliedMigrations, currentVersion, runMigrations, validateRegistry } from '../migrate'
import { MIGRATIONS } from './index'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x42)

const directories: string[] = []
const handles: SqliteDatabase[] = []

function freshDb(): SqliteDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-registry-'))
  directories.push(dir)
  const db = openDatabase({ filePath: join(dir, 'company.coffer'), key: KEY })
  handles.push(db)
  return db
}

function tableNames(db: SqliteDatabase): string[] {
  return db
    .prepare<[], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all()
    .map((row) => row.name)
}

afterEach(() => {
  for (const db of handles.splice(0)) {
    try {
      closeDatabase(db)
    } catch {
      /* a test may have closed it already */
    }
  }
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

describe('MIGRATIONS', () => {
  it('is a valid registry: numbered ids, no duplicates, every one named', () => {
    expect(() => validateRegistry(MIGRATIONS)).not.toThrow()
  })

  it('is listed in the order it applies', () => {
    const ids = MIGRATIONS.map((migration) => migration.id)
    expect(ids).toEqual(validateRegistry(MIGRATIONS).map((migration) => migration.id))
  })

  it('numbers every migration to match its exported name', () => {
    for (const migration of MIGRATIONS) {
      expect(migration.id).toMatch(/^\d{4,}$/)
      expect(migration.name.trim()).not.toBe('')
      expect(typeof migration.up).toBe('function')
    }
  })

  it('applies to a fresh company database and is idempotent', () => {
    const db = freshDb()

    const first = runMigrations(db, MIGRATIONS)
    expect(first.applied).toEqual(MIGRATIONS.map((migration) => migration.id))

    const second = runMigrations(db, MIGRATIONS)
    expect(second.applied).toEqual([])
    expect(second.to).toBe(first.to)
    expect(appliedMigrations(db).map((migration) => migration.id)).toEqual(
      MIGRATIONS.map((migration) => migration.id),
    )
  })

  it('brings a fresh database to the head of the registry', () => {
    const db = freshDb()
    runMigrations(db, MIGRATIONS)

    expect(currentVersion(db)).toBe(MIGRATIONS.at(-1)?.id ?? null)
    expect(tableNames(db)).toContain('schema_migrations')
  })

  it('introduces no company_id column anywhere — one company is one file', () => {
    /* ARCHITECTURE §6.3. A missing WHERE clause cannot leak one company's data into
     * another's report if the column does not exist to be forgotten. */
    const db = freshDb()
    runMigrations(db, MIGRATIONS)

    const offenders = tableNames(db).filter((table) =>
      db
        .prepare<[string], { name: string }>(`SELECT name FROM pragma_table_info(?)`)
        .all(table)
        .some((column) => column.name === 'company_id'),
    )

    expect(offenders).toEqual([])
  })
})
