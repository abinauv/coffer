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
 *   0004  journal_entries, journal_lines   — posting engine                LANDED
 *
 * The tables each one creates are typed in ../schema.ts, and the invariants they enforce
 * are in src/main/domain/ledger/types.ts. Read the note there about inserting lines
 * before their parent entry before touching 0004: the deferred foreign key is what makes
 * the balance trigger possible, but three triggers rather than the key are what hold the
 * order in place, and none of them is an implementation detail anyone may change.
 *
 * ---------------------------------------------------------------------------
 * RESERVED NUMBERS — PHASE 2, MASTERS AND SALES
 *
 * Claimed at gate 2.0. The invariants they enforce are in
 * src/main/domain/documents/types.ts — the four rules at the top of that file.
 *
 *   0005  parties, plus journal_lines.party_id       — who a document is with  LANDED
 *   0006  items, units_of_measure                    — what is on its lines  LANDED
 *   0007  numbering_series, numbering_counters       — what its number is  LANDED
 *   0008  documents, document_lines,
 *         document_line_taxes                        — the document itself
 *   0009  receipts, allocations                      — what has been paid against one
 *
 * 0005 HAS LANDED, and its reasoning lives in its own file. Read that header before
 * writing anything that touches `journal_lines.party_id` — in particular the measured
 * finding that SQLite ACCEPTS a non-null default on an added REFERENCES column and then
 * leaves the table permanently unwritable.
 *
 * ONE OF THE REST DESERVES A WARNING BEFORE ANYONE WRITES IT.
 *
 * 0008 holds every trade document — quotation, invoice, credit note, bill, debit note —
 * in one table with a `kind` column. Read the note in domain/documents/types.ts on why
 * before splitting it: the five differ in three fields and are otherwise identical, and
 * five tables would mean five copies of the tax summary and a Phase 3 that is a schema
 * change rather than a posting rule.
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
import { m0004 } from './0004_journal'
import { m0005 } from './0005_parties'
import { m0006 } from './0006_items'
import { m0007 } from './0007_numbering'

export const MIGRATIONS: readonly Migration[] = [m0001, m0002, m0003, m0004, m0005, m0006, m0007]
