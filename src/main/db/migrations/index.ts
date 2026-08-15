/*
 * The migration registry.
 *
 * Every schema change Coffer has ever made, in order. `runMigrations(db, MIGRATIONS)`
 * applies the ones a given company file has not yet run — see ../migrate.ts.
 *
 * ---------------------------------------------------------------------------
 * RESERVED NUMBERS — PHASE 1, THE LEDGER
 *
 * Claimed at gate 1.0 so that work proceeding in parallel cannot collide. A number is
 * reserved whether or not its file exists yet; taking a reserved one because it looks
 * free is how two migrations end up as 0003.
 *
 *   0001  app_metadata                                                    LANDED
 *   0002  accounts, account_roles          — chart of accounts             LANDED
 *   0003  accounting_periods               — fiscal periods                LANDED
 *   0004  journal_entries, journal_lines   — posting engine, with the balance triggers
 *
 * The tables each one creates are already typed in ../schema.ts, and the invariants
 * they must enforce are in src/main/domain/ledger/types.ts. Read the note there about
 * inserting lines before their parent entry before writing 0004 — the deferred foreign
 * key is what makes the balance trigger possible, and it is not an implementation
 * detail anyone may change.
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
 *        export const m0002: Migration = {
 *          id: '0002',
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
import { m0001 } from './0001_app_metadata'
import { m0002 } from './0002_accounts'
import { m0003 } from './0003_accounting_periods'

export const MIGRATIONS: readonly Migration[] = [m0001, m0002, m0003]
