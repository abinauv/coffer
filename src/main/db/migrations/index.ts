/*
 * The migration registry.
 *
 * Every schema change Coffer has ever made, in order. `runMigrations(db, MIGRATIONS)`
 * applies the ones a given company file has not yet run — see ../migrate.ts.
 *
 * Empty for now, and deliberately so: Phase 0 builds the machinery, Phase 1 brings the
 * ledger. A database at this point has exactly one table, `schema_migrations`, and no
 * business tables at all.
 *
 * ---------------------------------------------------------------------------
 * ADDING A MIGRATION
 *
 *   1. Use the migration number reserved for your task. Never take "the next free
 *      one" — two people working in parallel will both take it (CONVENTIONS §8).
 *   2. Create `NNNN_snake_summary.ts` in this folder, exporting a `Migration`:
 *
 *        import type { Migration } from '../migrate'
 *
 *        export const m0001: Migration = {
 *          id: '0001',
 *          name: 'accounts',
 *          up(db) {
 *            db.exec(`CREATE TABLE accounts (...) STRICT`)
 *          },
 *          down(db) {
 *            db.exec(`DROP TABLE accounts`)
 *          },
 *        }
 *
 *      Money, quantity and rate columns are TEXT holding decimal strings — never REAL
 *      and never INTEGER (CONVENTIONS §3). There is no `company_id` column anywhere;
 *      a company is a separate file (ARCHITECTURE §6.3).
 *   3. Add the table's interface to ../schema.ts and register it on `Database`.
 *   4. Import it below and append it to MIGRATIONS.
 *
 * ---------------------------------------------------------------------------
 * A MERGED MIGRATION IS NEVER EDITED
 *
 * Not to fix a typo, not to add a column, not "because nobody has run it yet" —
 * someone has, and the databases that already ran it will never run it again. The
 * schema those files carry would then differ from the one this list claims to
 * produce, and nothing would detect the divergence. Fix it forward with a new
 * migration (CONVENTIONS §1.5).
 */

import type { Migration } from '../migrate'

export const MIGRATIONS: readonly Migration[] = []
