/*
 * The `app_metadata` table: what a company file says about itself.
 *
 * Created by migration 0001. Everything in it is file-level provenance — the format
 * marker, and the name and moment the company was created under. It is not the company
 * profile: address, registration numbers and invoice defaults are business data with
 * their own Phase 1 table, and putting them here is how the reference project ended up
 * with a single settings row that every screen wrote to.
 *
 * The display name is stored here as well as in the registry. The two can drift — the
 * registry is authoritative for what the user sees, and this copy is what identifies an
 * orphaned file once someone finally opens it.
 */

import type { SqliteDatabase } from '../db/connection'

/** Table created by migration 0001. */
export const METADATA_TABLE = 'app_metadata'

/** The value of `coffer.format` in every Coffer company database. */
export const COMPANY_FORMAT = 'coffer.company'

/** Keys written by this build. Migration 0001 seeds the two format keys. */
export const METADATA_KEYS = {
  format: 'coffer.format',
  formatVersion: 'coffer.format_version',
  displayName: 'company.display_name',
  createdAt: 'company.created_at',
} as const

interface MetadataRow {
  value: string
}

/** One metadata value, or null when the key has never been written. */
export function readMetadata(db: SqliteDatabase, key: string): string | null {
  const row = db
    .prepare<[string], MetadataRow>(`SELECT value FROM ${METADATA_TABLE} WHERE "key" = ?`)
    .get(key)
  return row?.value ?? null
}

/** Write one metadata value, replacing whatever was there. */
export function writeMetadata(db: SqliteDatabase, key: string, value: string): void {
  db.prepare<[string, string, string]>(
    `INSERT INTO ${METADATA_TABLE} ("key", value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT("key") DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString())
}

/**
 * True when this database says it is a Coffer company.
 *
 * A file that decrypts under this company's DEK is this company's file, so this is not a
 * security check — it is what keeps `addExisting` from quietly adopting some other
 * SQLCipher database that happens to share a key.
 */
export function isCompanyDatabase(db: SqliteDatabase): boolean {
  return readMetadata(db, METADATA_KEYS.format) === COMPANY_FORMAT
}
