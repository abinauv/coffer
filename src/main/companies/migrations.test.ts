/*
 * Migration 0001 and the metadata it seeds, against a real encrypted file.
 *
 * The migration lives in src/main/db/migrations/ and is reached through
 * COMPANY_MIGRATIONS, which is the list a company database is actually brought up to.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DATABASE_KEY_BYTES,
  type SqliteDatabase,
  closeDatabase,
  openDatabase,
} from '../db/connection'
import { currentVersion, rollbackMigrations, runMigrations, validateRegistry } from '../db/migrate'
import {
  COMPANY_FORMAT,
  METADATA_KEYS,
  isCompanyDatabase,
  readMetadata,
  writeMetadata,
} from './metadata'
import { COMPANY_MIGRATIONS } from './migrations'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x5c)

const directories: string[] = []
const handles: SqliteDatabase[] = []

function freshDatabase(): SqliteDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'coffer-migration-'))
  directories.push(directory)
  const database = openDatabase({ filePath: join(directory, 'company.coffer'), key: KEY })
  handles.push(database)
  return database
}

function tableNames(database: SqliteDatabase): string[] {
  return database
    .prepare<[], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all()
    .map((row) => row.name)
}

afterEach(() => {
  for (const database of handles.splice(0)) {
    try {
      closeDatabase(database)
    } catch {
      /* a test may have closed it already */
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5 })
  }
})

describe('COMPANY_MIGRATIONS', () => {
  it('is a valid registry, in order, with 0001 in it', () => {
    expect(() => validateRegistry(COMPANY_MIGRATIONS)).not.toThrow()
    expect(COMPANY_MIGRATIONS.map((migration) => migration.id)).toContain('0001')
    expect(COMPANY_MIGRATIONS.map((migration) => migration.id)).toEqual(
      validateRegistry(COMPANY_MIGRATIONS).map((migration) => migration.id),
    )
  })

  it('adds the migration exactly once, however the registry lists it', () => {
    const ids = COMPANY_MIGRATIONS.map((migration) => migration.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('migration 0001', () => {
  it('creates app_metadata and says what the file is', () => {
    const database = freshDatabase()
    runMigrations(database, COMPANY_MIGRATIONS)

    expect(tableNames(database)).toContain('app_metadata')
    expect(readMetadata(database, METADATA_KEYS.format)).toBe(COMPANY_FORMAT)
    expect(readMetadata(database, METADATA_KEYS.formatVersion)).toBe('1')
    expect(isCompanyDatabase(database)).toBe(true)
  })

  it('runs once and stays put', () => {
    const database = freshDatabase()
    const first = runMigrations(database, COMPANY_MIGRATIONS)
    const second = runMigrations(database, COMPANY_MIGRATIONS)

    expect(first.applied).toContain('0001')
    expect(second.applied).toEqual([])
    expect(currentVersion(database)).toBe(first.to)
  })

  it('can be rolled back', () => {
    const database = freshDatabase()
    runMigrations(database, COMPANY_MIGRATIONS, { to: '0001' })

    rollbackMigrations(database, COMPANY_MIGRATIONS, { to: null })

    expect(tableNames(database)).not.toContain('app_metadata')
    expect(currentVersion(database)).toBeNull()
  })

  it('has no company_id column — one company is one file', () => {
    const database = freshDatabase()
    runMigrations(database, COMPANY_MIGRATIONS)

    for (const table of tableNames(database)) {
      const columns = database
        .prepare<[string], { name: string }>(`SELECT name FROM pragma_table_info(?)`)
        .all(table)
        .map((row) => row.name)
      expect(columns).not.toContain('company_id')
    }
  })
})

describe('metadata', () => {
  it('writes a value, reads it back, and replaces it', () => {
    const database = freshDatabase()
    runMigrations(database, COMPANY_MIGRATIONS)

    expect(readMetadata(database, 'company.display_name')).toBeNull()

    writeMetadata(database, METADATA_KEYS.displayName, 'Acme Traders')
    expect(readMetadata(database, METADATA_KEYS.displayName)).toBe('Acme Traders')

    writeMetadata(database, METADATA_KEYS.displayName, 'Acme Trading')
    expect(readMetadata(database, METADATA_KEYS.displayName)).toBe('Acme Trading')

    const rows = database
      .prepare<[string], { count: number }>(
        `SELECT count(*) AS count FROM app_metadata WHERE "key" = ?`,
      )
      .get(METADATA_KEYS.displayName)
    expect(rows?.count).toBe(1)
  })
})
