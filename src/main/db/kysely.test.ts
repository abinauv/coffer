import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import {
  DATABASE_KEY_BYTES,
  type SqliteDatabase,
  checkpoint,
  closeDatabase,
  openDatabase,
} from './connection'
import { createQueryBuilder } from './kysely'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x1d)

const directories: string[] = []
const handles: SqliteDatabase[] = []

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-kysely-'))
  directories.push(dir)
  return join(dir, 'company.coffer')
}

function open(filePath: string): SqliteDatabase {
  const db = openDatabase({ filePath, key: KEY })
  handles.push(db)
  return db
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

describe('createQueryBuilder', () => {
  it('queries through the connection it was given', async () => {
    const connection = open(tempPath())
    const db = createQueryBuilder(connection)

    await sql`CREATE TABLE amounts (label TEXT NOT NULL, value TEXT NOT NULL) STRICT`.execute(db)
    /* Money is a decimal string end to end — CONVENTIONS §3. */
    await sql`INSERT INTO amounts (label, value) VALUES (${'freight'}, ${'1234.50'})`.execute(db)

    const result = await sql<{ label: string; value: string }>`
      SELECT label, value FROM amounts
    `.execute(db)

    expect(result.rows).toEqual([{ label: 'freight', value: '1234.50' }])
  })

  it('shares one handle with the raw connection rather than opening a second', async () => {
    const connection = open(tempPath())
    const db = createQueryBuilder(connection)

    connection.exec(`CREATE TABLE amounts (value TEXT NOT NULL) STRICT`)
    await sql`INSERT INTO amounts (value) VALUES (${'99.99'})`.execute(db)

    /* Written through Kysely, read through the driver: the same open file. */
    const row = connection.prepare<[], { value: string }>(`SELECT value FROM amounts`).get()
    expect(row?.value).toBe('99.99')
    expect(connection.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('writes ciphertext, because the connection is the encrypted one', async () => {
    const path = tempPath()
    const connection = open(path)
    const db = createQueryBuilder(connection)

    await sql`CREATE TABLE notes (body TEXT NOT NULL) STRICT`.execute(db)
    await sql`INSERT INTO notes (body) VALUES (${'KYSELY-CANARY'})`.execute(db)
    checkpoint(connection)
    closeDatabase(connection)

    expect(readFileSync(path).includes('KYSELY-CANARY')).toBe(false)
  })

  it('rolls back a transaction that throws', async () => {
    const connection = open(tempPath())
    const db = createQueryBuilder(connection)
    await sql`CREATE TABLE notes (body TEXT NOT NULL) STRICT`.execute(db)

    await expect(
      db.transaction().execute(async (trx) => {
        await sql`INSERT INTO notes (body) VALUES (${'kept?'})`.execute(trx)
        throw new Error('deliberate failure')
      }),
    ).rejects.toThrow('deliberate failure')

    const count = connection.prepare<[], { n: number }>(`SELECT count(*) AS n FROM notes`).get()
    expect(count?.n).toBe(0)
  })

  it('closes the underlying connection when destroyed', async () => {
    const connection = open(tempPath())
    const db = createQueryBuilder(connection)
    await sql`SELECT 1`.execute(db)

    await db.destroy()

    expect(connection.open).toBe(false)
  })
})
