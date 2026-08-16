/*
 * These tests run against real files on disk, not an in-memory database. The whole
 * point of this module is what ends up in the file, and an in-memory database has no
 * file to inspect.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
  closeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import RawDatabase from 'better-sqlite3-multiple-ciphers'
import {
  DATABASE_KEY_BYTES,
  type SqliteDatabase,
  checkIntegrity,
  checkpoint,
  closeDatabase,
  openDatabase,
} from './connection'
import { DbError } from './errors'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0xa7)
const OTHER_KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x3c)

const directories: string[] = []
const handles: SqliteDatabase[] = []

function tempPath(name = 'company.coffer'): string {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-connection-'))
  directories.push(dir)
  return join(dir, name)
}

function open(options: Parameters<typeof openDatabase>[0]): SqliteDatabase {
  const db = openDatabase(options)
  handles.push(db)
  return db
}

/** The code of a thrown DbError, or a description of whatever else was thrown. */
function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof DbError ? error.code : `not a DbError: ${String(error)}`
  }
  return 'did not throw'
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

describe('openDatabase', () => {
  it('creates a file whose contents are ciphertext', () => {
    const path = tempPath()
    const db = open({ filePath: path, key: KEY })
    db.exec(`CREATE TABLE notes (body TEXT NOT NULL) STRICT`)
    db.prepare(`INSERT INTO notes (body) VALUES (?)`).run('PLAINTEXT-CANARY')
    checkpoint(db)
    closeDatabase(db)

    const bytes = readFileSync(path)
    expect(bytes.length).toBeGreaterThan(0)
    /* An unencrypted SQLite file starts with the magic string "SQLite format 3". */
    expect(bytes.subarray(0, 15).toString('latin1')).not.toBe('SQLite format 3')
    expect(bytes.includes('PLAINTEXT-CANARY')).toBe(false)
  })

  it('never writes plaintext to the write-ahead log either', () => {
    const path = tempPath()
    const db = open({ filePath: path, key: KEY, journalMode: 'wal' })
    db.exec(`CREATE TABLE notes (body TEXT NOT NULL) STRICT`)
    db.prepare(`INSERT INTO notes (body) VALUES (?)`).run('WAL-CANARY')

    /* Deliberately not checkpointed: the row is still in the sidecar. */
    const wal = readFileSync(`${path}-wal`)
    expect(wal.length).toBeGreaterThan(0)
    expect(wal.includes('WAL-CANARY')).toBe(false)
  })

  it('round-trips data through a close and reopen', () => {
    const path = tempPath()
    const first = open({ filePath: path, key: KEY })
    first.exec(`CREATE TABLE amounts (value TEXT NOT NULL) STRICT`)
    /* Money is a decimal string, never a float — CONVENTIONS §3. */
    first.prepare(`INSERT INTO amounts (value) VALUES (?)`).run('1234.50')
    closeDatabase(first)

    const second = open({ filePath: path, key: KEY, mustExist: true })
    const row = second.prepare<[], { value: string }>(`SELECT value FROM amounts`).get()
    expect(row?.value).toBe('1234.50')
  })

  it('fails immediately on the wrong key, not on a later query', () => {
    const path = tempPath()
    const db = open({ filePath: path, key: KEY })
    db.exec(`CREATE TABLE notes (body TEXT) STRICT`)
    closeDatabase(db)

    expect(codeOf(() => openDatabase({ filePath: path, key: OTHER_KEY }))).toBe('DB_WRONG_KEY')
  })

  it('leaves no handle open when the key is rejected', () => {
    const path = tempPath()
    closeDatabase(open({ filePath: path, key: KEY }))

    expect(() => openDatabase({ filePath: path, key: OTHER_KEY })).toThrow(DbError)
    /* The file is not locked by a leaked handle: a correct key still opens it. */
    const reopened = open({ filePath: path, key: KEY, mustExist: true })
    expect(reopened.open).toBe(true)
  })

  it('encrypts a database that was created but never written to', () => {
    /*
     * Keying an empty file writes nothing, so without an explicit header write the
     * file would stay zero bytes and accept any key on the next open — quietly
     * starting a second set of books under a mistyped passphrase.
     */
    const path = tempPath()
    closeDatabase(open({ filePath: path, key: KEY }))

    expect(readFileSync(path).length).toBeGreaterThan(0)
    expect(codeOf(() => openDatabase({ filePath: path, key: OTHER_KEY }))).toBe('DB_WRONG_KEY')
  })

  it('cannot be read by a driver that applies no key at all', () => {
    const path = tempPath()
    const db = open({ filePath: path, key: KEY })
    db.exec(`CREATE TABLE notes (body TEXT) STRICT`)
    closeDatabase(db)

    const unkeyed = new RawDatabase(path)
    try {
      expect(() => unkeyed.prepare('SELECT count(*) FROM sqlite_master').get()).toThrow(
        /not a database/i,
      )
    } finally {
      unkeyed.close()
    }
  })

  it('rejects key material that is not 32 bytes, without creating a file', () => {
    for (const length of [0, 16, 31, 33, 64]) {
      const path = tempPath(`k${length}.coffer`)
      expect(codeOf(() => openDatabase({ filePath: path, key: new Uint8Array(length) }))).toBe(
        'DB_KEY_INVALID',
      )
      expect(existsSync(path)).toBe(false)
    }
  })

  it('applies the expected pragmas', () => {
    const db = open({ filePath: tempPath(), key: KEY, busyTimeoutMs: 7500 })

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('busy_timeout', { simple: true })).toBe(7500)
    /* 2 = FULL: a committed entry survives a power cut. */
    expect(db.pragma('synchronous', { simple: true })).toBe(2)
    expect(db.pragma('cipher', { simple: true })).toBe('sqlcipher')
  })

  it('enforces foreign keys', () => {
    const db = open({ filePath: tempPath(), key: KEY })
    db.exec(`CREATE TABLE parents (id INTEGER PRIMARY KEY) STRICT`)
    db.exec(
      `CREATE TABLE children (
         id INTEGER PRIMARY KEY,
         parent_id INTEGER NOT NULL REFERENCES parents(id)
       ) STRICT`,
    )

    expect(() => db.prepare(`INSERT INTO children VALUES (1, 99)`).run()).toThrow(
      /FOREIGN KEY constraint failed/i,
    )
  })

  it('can use a single-file journal mode for snapshot copies', () => {
    const path = tempPath()
    const db = open({ filePath: path, key: KEY, journalMode: 'delete' })
    db.exec(`CREATE TABLE notes (body TEXT) STRICT`)

    expect(db.pragma('journal_mode', { simple: true })).toBe('delete')
    expect(existsSync(`${path}-wal`)).toBe(false)
  })

  it('refuses to create the file when mustExist is set', () => {
    const path = tempPath('missing.coffer')
    expect(codeOf(() => openDatabase({ filePath: path, key: KEY, mustExist: true }))).toBe(
      'DB_OPEN_FAILED',
    )
    expect(existsSync(path)).toBe(false)
  })

  it('opens read-only without permitting writes', () => {
    const path = tempPath()
    const writable = open({ filePath: path, key: KEY, journalMode: 'delete' })
    writable.exec(`CREATE TABLE notes (body TEXT) STRICT`)
    writable.prepare(`INSERT INTO notes VALUES (?)`).run('kept')
    closeDatabase(writable)

    const readonly = open({ filePath: path, key: KEY, readonly: true, mustExist: true })
    const row = readonly.prepare<[], { body: string }>(`SELECT body FROM notes`).get()
    expect(row?.body).toBe('kept')
    expect(() => readonly.prepare(`INSERT INTO notes VALUES ('no')`).run()).toThrow(/readonly/i)
  })
})

describe('closeDatabase', () => {
  it('is safe to call twice', () => {
    const db = open({ filePath: tempPath(), key: KEY })
    closeDatabase(db)
    expect(() => closeDatabase(db)).not.toThrow()
    expect(db.open).toBe(false)
  })

  it('leaves no write-ahead log behind', () => {
    const path = tempPath()
    const db = open({ filePath: path, key: KEY })
    db.exec(`CREATE TABLE notes (body TEXT) STRICT`)
    closeDatabase(db)

    expect(existsSync(`${path}-wal`)).toBe(false)
    expect(existsSync(`${path}-shm`)).toBe(false)
  })
})

describe('checkIntegrity', () => {
  it('reports a healthy database as sound', () => {
    const db = open({ filePath: tempPath(), key: KEY })
    db.exec(`CREATE TABLE notes (body TEXT NOT NULL) STRICT`)
    db.prepare(`INSERT INTO notes VALUES (?)`).run('fine')

    expect(checkIntegrity(db)).toEqual({ isOk: true, problems: [] })
  })

  /*
   * The slowest test in the suite, and legitimately so: 500 individually encrypted
   * writes with `synchronous = FULL`, then a full `integrity_check` over a file that has
   * been deliberately damaged — which is the slow path, because SQLite walks the whole
   * b-tree once it starts finding faults.
   *
   * It measured 5.2s against the default 5s timeout on a loaded machine, so it failed
   * roughly one run in twenty with a message about a hanging test. Nothing was hanging.
   * The timeout is raised rather than the work reduced: fewer rows would leave the
   * scribble at offset 6000 landing outside the data pages, and the test would then pass
   * by finding no damage where it had also caused none.
   */
  it('reports damage instead of throwing', { timeout: 30_000 }, () => {
    const path = tempPath()
    const db = open({ filePath: path, key: KEY, journalMode: 'delete' })
    db.exec(`CREATE TABLE notes (body TEXT NOT NULL) STRICT`)
    const insert = db.prepare(`INSERT INTO notes VALUES (?)`)
    for (let i = 0; i < 500; i += 1) {
      insert.run(`row ${i}`)
    }
    closeDatabase(db)

    /* Scribble over a page past the header, so the file still decrypts and opens. */
    const handle = openSync(path, 'r+')
    writeSync(handle, Buffer.alloc(256, 0x5a), 0, 256, 6000)
    closeSync(handle)

    const damaged = open({ filePath: path, key: KEY, mustExist: true })
    const report = checkIntegrity(damaged)
    expect(report.isOk).toBe(false)
    expect(report.problems.length).toBeGreaterThan(0)
  })

  it('reports a foreign key violation left by an unchecked write', () => {
    const db = open({ filePath: tempPath(), key: KEY })
    db.exec(`CREATE TABLE parents (id INTEGER PRIMARY KEY) STRICT`)
    db.exec(
      `CREATE TABLE children (
         id INTEGER PRIMARY KEY,
         parent_id INTEGER NOT NULL REFERENCES parents(id)
       ) STRICT`,
    )
    /* Only a connection with foreign keys off could have written this row. */
    db.pragma('foreign_keys = OFF')
    db.prepare(`INSERT INTO children VALUES (1, 99)`).run()
    db.pragma('foreign_keys = ON')

    const report = checkIntegrity(db)
    expect(report.isOk).toBe(false)
    expect(report.problems.join(' ')).toContain('children')
  })
})
