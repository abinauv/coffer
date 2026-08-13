/*
 * The encrypted SQLite connection.
 *
 * One company is one SQLCipher file (docs/ARCHITECTURE.md §6.3). This module opens
 * that file, applies the key, and proves the key was right before handing the handle
 * back. Nothing above it needs to know how SQLCipher is addressed.
 *
 * KEY HANDLING — the one rule this module has (docs/ARCHITECTURE.md §8):
 *
 *   The caller supplies 32 raw bytes. This module does not derive keys, does not see
 *   a passphrase, and does not touch Argon2. Deriving the key-encryption key and
 *   unwrapping the DEK belong to `src/main/security`; mixing the two would put
 *   passphrase material on the same code path as file handles.
 *
 * The key is applied as a RAW key — `x'<hex>'` — which tells SQLCipher to use the
 * bytes as the AES key directly with no further KDF. That is deliberate: the key
 * reaching this module is already the output of Argon2id, and running PBKDF2 over it
 * again would add hundreds of milliseconds per open and no security. Passing the raw
 * bytes to `db.key()` would NOT do this: the driver treats a plain byte buffer as a
 * passphrase and derives from it, which is a different (and slower) key entirely.
 *
 * The key literal is built as a byte buffer and zeroed immediately after use, so the
 * hex form of the key is never interned as an immutable JavaScript string.
 */

import Database from 'better-sqlite3-multiple-ciphers'
import { DbError } from './errors'

/** An open, keyed SQLite handle. */
export type SqliteDatabase = Database.Database

/** SQLCipher raw keys are 256-bit. Anything else is a caller bug, not a bad passphrase. */
export const DATABASE_KEY_BYTES = 32

/**
 * `wal` is the default: concurrent readers, fewer fsyncs, and the write-ahead log is
 * encrypted alongside the main file. `delete` leaves a single self-contained file,
 * which is what a backup copy wants — see `checkpoint()`.
 */
export type JournalMode = 'wal' | 'delete'

export interface OpenDatabaseOptions {
  /** Absolute path to the company database file. Its directory must already exist. */
  filePath: string
  /** Exactly {@link DATABASE_KEY_BYTES} bytes of raw key material. */
  key: Uint8Array
  /** Open without write access. Default false. */
  readonly?: boolean
  /** Fail instead of creating the file when it does not exist. Default false. */
  mustExist?: boolean
  /** How long to wait on a locked database before giving up. Default 5000ms. */
  busyTimeoutMs?: number
  /** Default `wal`. */
  journalMode?: JournalMode
}

export interface IntegrityReport {
  isOk: boolean
  /** Human-readable problems, empty when `isOk`. */
  problems: string[]
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000

/*
 * Every Coffer file uses the same cipher, always named explicitly. The driver's own
 * default is chacha20, so a file written without this pragma would not be readable by
 * a build that sets it — and vice versa. Pinning it here is what makes "copy the file
 * to another machine" work.
 */
const CIPHER = 'sqlcipher'

/**
 * Open (or create) an encrypted company database.
 *
 * Throws `DbError('DB_WRONG_KEY')` immediately if the key does not decrypt the file —
 * never on some later query.
 */
export function openDatabase(options: OpenDatabaseOptions): SqliteDatabase {
  const {
    filePath,
    key,
    readonly = false,
    mustExist = false,
    busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS,
    journalMode = 'wal',
  } = options

  if (key.length !== DATABASE_KEY_BYTES) {
    throw new DbError(
      'DB_KEY_INVALID',
      `A database key must be exactly ${DATABASE_KEY_BYTES} bytes; received ${key.length}.`,
    )
  }

  let db: SqliteDatabase
  try {
    db = new Database(filePath, {
      readonly,
      fileMustExist: mustExist,
      /* Also applied as PRAGMA busy_timeout, from the very first statement. */
      timeout: busyTimeoutMs,
    })
  } catch (error) {
    throw new DbError('DB_OPEN_FAILED', `Could not open the database file at ${filePath}.`, {
      cause: error,
    })
  }

  try {
    applyKey(db, key)
    verifyKey(db)
    /* Captured before any pragma writes to the file. */
    const isNewDatabase = pageCount(db) === 0
    applyPragmas(db, { readonly, journalMode })
    if (isNewDatabase && !readonly) {
      materialiseEncryptedHeader(db)
    }
    return db
  } catch (error) {
    closeQuietly(db)
    throw error
  }
}

/** Close the handle. Safe to call on an already-closed database. */
export function closeDatabase(db: SqliteDatabase): void {
  if (db.open) {
    db.close()
  }
}

/**
 * Fold the write-ahead log back into the main file.
 *
 * A backup is a file copy (docs/ARCHITECTURE.md §2), and in WAL mode the newest
 * committed data may still be sitting in the `-wal` sidecar. Call this before copying.
 * A clean `closeDatabase()` checkpoints and removes the sidecar on its own.
 */
export function checkpoint(db: SqliteDatabase): void {
  db.pragma('wal_checkpoint(TRUNCATE)')
}

/**
 * Ask SQLite whether the file is structurally sound and its foreign keys hold.
 *
 * Returns a report rather than throwing: "your file is damaged" is an answer, not an
 * exception. A `DbError` still escapes if the database cannot be read at all.
 */
export function checkIntegrity(db: SqliteDatabase): IntegrityReport {
  const problems: string[] = []

  let rows: unknown
  try {
    rows = db.pragma('integrity_check')
  } catch (error) {
    /* SQLite raises rather than reporting when the damage stops the check itself. */
    return { isOk: false, problems: [describeSqliteError(error)] }
  }

  for (const row of asRecords(rows)) {
    const value = row['integrity_check']
    if (typeof value === 'string' && value !== 'ok') {
      problems.push(value)
    }
  }

  try {
    for (const row of asRecords(db.pragma('foreign_key_check'))) {
      problems.push(
        `foreign key violation in table ${String(row['table'])} (rowid ${String(row['rowid'])}) ` +
          `referencing ${String(row['parent'])}`,
      )
    }
  } catch (error) {
    problems.push(describeSqliteError(error))
  }

  return { isOk: problems.length === 0, problems }
}

// ---- Internals ------------------------------------------------------------

function applyKey(db: SqliteDatabase, key: Uint8Array): void {
  /* The cipher must be selected before the key is applied. */
  db.pragma(`cipher='${CIPHER}'`)

  const literal = rawKeyLiteral(key)
  try {
    db.key(literal)
  } catch (error) {
    throw new DbError('DB_OPEN_FAILED', 'The database key could not be applied.', {
      cause: error,
    })
  } finally {
    /* The key is copied into SQLite's own memory by key(); ours is no longer needed. */
    literal.fill(0)
  }
}

/**
 * Force a decrypt of page 1. With the wrong key this throws `SQLITE_NOTADB` here,
 * rather than on whatever query happens to touch the disk first.
 */
function verifyKey(db: SqliteDatabase): void {
  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get()
  } catch (error) {
    const code = sqliteErrorCode(error)
    if (code === 'SQLITE_NOTADB') {
      /*
       * Indistinguishable at this level from a truncated file or a non-database:
       * both fail to produce a valid header after decryption. The message says so.
       */
      throw new DbError(
        'DB_WRONG_KEY',
        'The database could not be decrypted. The passphrase is wrong, or the file is not a Coffer database.',
        { cause: error },
      )
    }
    if (code === 'SQLITE_CORRUPT') {
      throw new DbError('DB_CORRUPT', 'The database file is damaged and cannot be read.', {
        cause: error,
      })
    }
    throw new DbError('DB_OPEN_FAILED', 'The database could not be read after opening.', {
      cause: error,
    })
  }
}

function applyPragmas(
  db: SqliteDatabase,
  options: { readonly: boolean; journalMode: JournalMode },
): void {
  if (!options.readonly) {
    /* Changing the journal mode writes to the file, so a read-only handle keeps
     * whatever mode the file already has. */
    db.pragma(`journal_mode = ${options.journalMode === 'wal' ? 'WAL' : 'DELETE'}`)
  }
  /* Off by default in SQLite, and a ledger without referential integrity is a
   * spreadsheet. This is per-connection, not per-file — it must be set on every open. */
  db.pragma('foreign_keys = ON')
  /* A committed invoice survives a power cut. The cost is one extra fsync per commit. */
  db.pragma('synchronous = FULL')
}

/**
 * Write the encrypted header of a brand-new database.
 *
 * Keying an empty file changes nothing on disk: the file stays zero bytes until
 * something is written, and a zero-byte file will happily accept a *different* key on
 * the next open. Setting `user_version` costs one page write and makes the file a real
 * encrypted database from the moment it is created, so a mistyped passphrase on the
 * second open fails instead of silently starting a second, parallel set of books.
 *
 * Coffer tracks its schema version in `schema_migrations`, so `user_version` itself is
 * unused and stays at 0.
 */
function materialiseEncryptedHeader(db: SqliteDatabase): void {
  db.pragma('user_version = 0')
}

function pageCount(db: SqliteDatabase): number {
  const value = db.pragma('page_count', { simple: true })
  return typeof value === 'number' ? value : 0
}

/**
 * Build the ASCII bytes of `x'<hex>'` without ever materialising the hex as a string.
 * JavaScript strings are immutable and interned — a key that becomes one cannot be
 * wiped. The returned buffer is the caller's to zero.
 */
function rawKeyLiteral(key: Uint8Array): Buffer {
  const HEX = '0123456789abcdef'
  const QUOTE = 0x27
  const buffer = Buffer.alloc(3 + key.length * 2)
  buffer[0] = 0x78 /* 'x' */
  buffer[1] = QUOTE
  for (let i = 0; i < key.length; i += 1) {
    const byte = key[i] ?? 0
    buffer[2 + i * 2] = HEX.charCodeAt(byte >> 4)
    buffer[3 + i * 2] = HEX.charCodeAt(byte & 0x0f)
  }
  buffer[buffer.length - 1] = QUOTE
  return buffer
}

function closeQuietly(db: SqliteDatabase): void {
  try {
    closeDatabase(db)
  } catch {
    /* Already failing; a close error would only mask the real one. */
  }
}

function sqliteErrorCode(error: unknown): string | null {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return null
}

function describeSqliteError(error: unknown): string {
  const code = sqliteErrorCode(error)
  const message = error instanceof Error ? error.message : String(error)
  return code === null ? message : `${code}: ${message}`
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter(
    (row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
  )
}
