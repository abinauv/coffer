/*
 * 0001 — app_metadata.
 *
 * The baseline every company database carries: a small key/value table naming what the
 * file is, so that a database which decrypts can still be identified before a single
 * business table exists.
 *
 * WHY A KEY/VALUE TABLE AND NOT A ROW OF COLUMNS. The reference project kept a
 * single-row `settings` table that grew into the company profile, the invoice defaults
 * and the e-mail configuration, and every new field was a migration that rewrote it.
 * This table is deliberately not that (CONVENTIONS §9): it holds file-level facts about
 * the artefact — format, format version, the name it was created under — and nothing a
 * business screen will ever want. The company profile is a Phase 1 table with its own
 * columns and its own constraints.
 *
 * `coffer.format` is what makes "is this a Coffer company file" answerable. Migration
 * state lives in `schema_migrations` and is not duplicated here; `coffer.format_version`
 * versions the shape of THIS table, not the schema.
 *
 * Values are TEXT because the column is shared by every key. Nothing monetary is ever
 * stored here, so the decimal-string rule (CONVENTIONS §3) has no bearing on it.
 */

import type { Migration } from '../migrate'

/** The file format marker written into every company database. */
const FORMAT = 'coffer.company'

/** Version of the metadata table's own shape. */
const FORMAT_VERSION = '1'

export const m0001: Migration = {
  id: '0001',
  name: 'app_metadata',

  up(db) {
    /* `key` is quoted: it is not a reserved word in SQLite, but it reads as one and an
     * unquoted keyword-shaped identifier is the kind of thing that breaks on an engine
     * upgrade rather than in review. */
    db.exec(
      `CREATE TABLE app_metadata (
        "key" TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT`,
    )

    const now = new Date().toISOString()
    const insert = db.prepare<[string, string, string]>(
      `INSERT INTO app_metadata ("key", value, updated_at) VALUES (?, ?, ?)`,
    )
    insert.run('coffer.format', FORMAT, now)
    insert.run('coffer.format_version', FORMAT_VERSION, now)
  },

  down(db) {
    db.exec(`DROP TABLE app_metadata`)
  },
}
