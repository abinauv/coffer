/*
 * Typings for `better-sqlite3-multiple-ciphers`.
 *
 * The package ships declarations at its root (`index.d.ts`) but its package.json
 * `exports` map has no `types` condition, so `moduleResolution: bundler` resolves the
 * runtime entry and finds no declarations beside it. The result is an implicit `any`
 * for the entire database layer, which CONVENTIONS §1.4 does not allow.
 *
 * The fork's API is better-sqlite3's — described by `@types/better-sqlite3`, already a
 * devDependency — plus SQLCipher's key management. This file bridges the two. It adds
 * no capability and invents no shape; if the package ever publishes a `types`
 * condition, delete this file.
 */

declare module 'better-sqlite3-multiple-ciphers' {
  import type BetterSqlite3 from 'better-sqlite3'

  /** better-sqlite3's Database, plus the cipher fork's key management. */
  interface EncryptedDatabase extends BetterSqlite3.Database {
    /**
     * Apply an encryption key (sqlite3_key). Returns an SQLite result code, 0 on
     * success. The buffer holds the key *as SQLite would read it in a PRAGMA*: the
     * ASCII bytes of `x'<hex>'` select a raw key, anything else is a passphrase to
     * derive from.
     */
    key(key: Buffer): number
    /** Re-encrypt an open database under a new key (sqlite3_rekey). */
    rekey(key: Buffer): number
  }

  namespace Database {
    export type Database = EncryptedDatabase
    export type Options = BetterSqlite3.Options
    export type PragmaOptions = BetterSqlite3.PragmaOptions
    export type RunResult = BetterSqlite3.RunResult
  }

  const Database: {
    new (filename?: string | Buffer, options?: BetterSqlite3.Options): EncryptedDatabase
    (filename?: string, options?: BetterSqlite3.Options): EncryptedDatabase
  }

  export = Database
}
