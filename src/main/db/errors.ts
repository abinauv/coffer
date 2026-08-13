/*
 * Database-layer errors.
 *
 * Every failure this layer can produce carries a stable `code`. The IPC boundary maps
 * that code onto an `AppError` (docs/CONVENTIONS.md §5) so the renderer can branch on
 * it — "wrong passphrase" needs a different screen from "this file was written by a
 * newer Coffer". Nothing below the IPC boundary returns a Result envelope; it throws,
 * and the handler translates.
 */

export type DbErrorCode =
  /** The caller supplied key material of the wrong size. A programming error. */
  | 'DB_KEY_INVALID'
  /** The file would not decrypt: wrong passphrase, or not a Coffer database at all. */
  | 'DB_WRONG_KEY'
  /** The file decrypted but SQLite reports structural damage. */
  | 'DB_CORRUPT'
  /** The file could not be opened at all — missing, locked, or no permission. */
  | 'DB_OPEN_FAILED'
  /** A migration threw. Its transaction was rolled back and the run stopped. */
  | 'DB_MIGRATION_FAILED'
  /** The database carries migrations newer than this build knows. Refuse to touch it. */
  | 'DB_SCHEMA_TOO_NEW'
  /** The database carries migrations this build has never heard of. Refuse likewise. */
  | 'DB_SCHEMA_UNKNOWN'
  /** The migration registry itself is malformed — duplicate or badly numbered ids. */
  | 'DB_MIGRATION_REGISTRY_INVALID'
  /** A rollback was asked for across a migration that declares no `down`. */
  | 'DB_MIGRATION_IRREVERSIBLE'

/** An error raised by `src/main/db`. Always carries a stable, machine-readable code. */
export class DbError extends Error {
  readonly code: DbErrorCode

  constructor(code: DbErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DbError'
    this.code = code
  }
}

export function isDbError(value: unknown): value is DbError {
  return value instanceof DbError
}
