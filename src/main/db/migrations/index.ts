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
 *         document_line_taxes                        — the document itself  LANDED
 *   0009  documents_frozen_once_issued, replaced     — narration and series, frozen too  LANDED
 *   0010  documents, rebuilt                         — a quotation may be issued  LANDED
 *   0011  company_profile                            — who these books are for  LANDED
 *   0012  receipts, receipt_allocations,
 *         numbering_series rebuilt                   — what has been paid against one  LANDED
 *   0013  documents.original_document_id             — the invoice a credit note corrects  LANDED
 *   0014  documents.due_date                         — when an invoice falls due  LANDED
 *
 * ---------------------------------------------------------------------------
 * RESERVED NUMBERS — PHASE 3, AGEING AND OFFSETTING
 *
 *   0015  numbering_series rebuilt,
 *         receipt_allocations_settles_kind          — a refund is a voucher  LANDED
 *   0016  document_offsets                          — which invoice a credit note settles  LANDED
 *
 * 0016 IS `receipt_allocations` WITH MONEY AT NEITHER END, and its header is the argument
 * for why that is one table rather than a column on `documents` — and, more usefully, for
 * why it is NOT the `original_document_id` link 0013 already added. Those two point the
 * same way and say different things: 0013 records what a credit note CORRECTS, which is
 * frozen at issue because a filed return names it, and 0016 records what it SETTLES,
 * which is decided afterwards and changed as often as the parties agree.
 *
 * IT ALSO PUTS A SECOND FOREIGN TRIGGER ON `documents`. Read the note at the foot of
 * 0016's `up` before rebuilding that table: 0010's `REBUILD_TAIL` recreates the triggers
 * by hand, and there are now two rules on it that were written elsewhere.
 *
 * 0015 WRITES A RULE 0012 CONSIDERED AND DECLINED, and its header is the argument for why
 * that is a correction rather than a reversal: with one voucher per side a wrong pairing
 * was always cross-account and therefore visible, and a refund is on the same side as a
 * receipt and moves the same control account. Read it before adding a voucher kind — the
 * `SETTLES` mapping there is the output of a derivation in `@shared/receipts`, and a test
 * asserts the two agree.
 *
 * 0014 IS THE FIRST MIGRATION TO BACKFILL A COLUMN rather than leave it null, and its
 * header is the argument for why — read it before adding a second one. The short version:
 * the value it fills in is a RECONSTRUCTION and cannot be anything better, and it is worth
 * having anyway because it makes the column's invariant hold for every row in the file,
 * old and new, which is what lets a reader trust it instead of defending against it.
 *
 * 0012 HAS LANDED, and it rebuilds `numbering_series` as well as adding two tables. A
 * receipt voucher is numbered for the reason an invoice is (rule 50 against rule 46(b)),
 * and 0007's `kind` CHECK named the five document kinds only. The alternative was a
 * second counter table kept privately for receipts, which is the one failure 0007 exists
 * to prevent, written twice. Read 0012's header before adding a sixth numbered kind.
 *
 * RECEIPTS HAVE MOVED THREE TIMES, from 0009 to 0010 to 0011 to 0012. Twice for a
 * correction to the documents table that had to land before anything was built on top of
 * it, and once for the company profile — which is not a correction but a table Phase 1
 * promised and nothing needed until tax had to name a supplier. See below.
 *
 * 0011 WAS RESERVED FOR RECEIPTS AND IS NOT ANY MORE, and this time not because anything
 * was wrong. `TaxRegime.computeTax` takes a supplier and a customer and decides CGST+SGST
 * against IGST from whether their jurisdictions match; 0005 gave Coffer the customer, and
 * there was nowhere to put the supplier. The profile has to exist before the tax service
 * can be written, and receipts are not started. Moving a reservation nothing has been
 * built on costs a line.
 *
 * 0009 WAS RESERVED FOR RECEIPTS AND IS NOT ANY MORE. Building `issueDocument` showed
 * that 0008 left a document's narration editable after issue, while the entry it had
 * become could not be — so the two could be made to disagree. That earned the next number
 * rather than an edit to 0008, and receipts moved to 0010. Renumbering a reservation
 * nothing has been built on costs a line; editing a landed migration cannot be undone.
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
 * RESERVED NUMBERS — PHASE 4, STOCK
 *
 * Claimed at gate 4.0. The invariants they enforce are in
 * src/main/domain/inventory/types.ts — the seven at the top of that file.
 *
 *   0017  items.is_stock_tracked, items.reorder_level  — which items keep a balance  LANDED
 *   0018  warehouses                                   — where the stock is  LANDED
 *   0019  stock_ledger                                 — the register itself  LANDED
 *   0020  documents.export_tax_payment,
 *         documents.is_reverse_charge                  — how a supply is taxed  LANDED
 *   0021  document_lines.itc_eligibility               — whether credit may be taken  LANDED
 *   0022  stock_ledger.entry_id                        — every movement posts  LANDED
 *
 * 0022 IS THE OTHER HALF OF 0019 AND OF ARCHITECTURE §6.4. The register wrote rows and
 * posted nothing; this adds the entry each movement posts as, and a trigger that refuses a
 * movement without one. Read its header before deciding that a column holding an id is a
 * cached figure: 0019 refuses to store a running balance BECAUSE a back-dated movement
 * changes it, and an entry id is fixed the moment it is written and immutable afterwards.
 * It also measures the `ADD COLUMN ... NOT NULL DEFAULT 'x' REFERENCES` trap from the
 * other side — the statement is accepted, and what fails afterwards is every insert that
 * takes the default, with an error naming no column.
 *
 * 0022 DOES NOT BACKFILL, and its header says why in full. The short version: an entry is
 * not a value to reconstruct, it is a row that would have to be minted with a number, a
 * period and two balanced lines, inside a migration running with foreign keys off. What
 * makes that acceptable is that `stock_ledger` arrived in 0019, in this same phase, and no
 * build carrying it has shipped.
 *
 * 0020 REWRITES `documents_frozen_once_issued` AND 0021 DOES NOT NEED TO, which is the
 * distinction to carry away from the pair. The document freeze ENUMERATES its columns, so
 * a column added afterwards is not frozen until the list is rewritten (measured: the
 * update goes straight through). The line freeze names no columns at all — a line is
 * frozen against its parent's status — so a column added to `document_lines` is frozen
 * the moment it exists. 0013 and 0014 both rebuilt the document trigger; 0020 is the
 * third, and it copies 0014's list forward rather than 0008's, because recreating an
 * older version would silently roll a later migration back and every test would still
 * pass on a fresh database.
 *
 * 0019 STORES A `StockMovement` AND NOTHING A VALUATION PRODUCES, and its header is the
 * argument for why there are no `balance_quantity` and `balance_value` columns on it.
 * Read it before adding one. The short version has three parts and the third settles it:
 * a running balance cannot be frozen the way 0014's due date can, because a back-dated
 * receipt really does change what is on hand; the domain has already decided the card is
 * recomputed and is tested on it (invariant 7); and an outward movement's value is a
 * figure `checkMovement` REFUSES to accept back (`COST_NOT_PERMITTED`), so a column
 * holding one could not be read into the shape the strategy takes.
 *
 * 0019 ALSO PUTS `items`'s FIRST FOREIGN TRIGGER ON IT. `stock_ledger_item_tracked` reads
 * `items.is_stock_tracked`, so a rebuild of `items` now has to recreate it — the trap
 * 0010's `REBUILD_TAIL` exists for, arriving on a second table. And the same reference is
 * why 0017's `down` only works after 0019's has run: `ALTER TABLE ... DROP COLUMN` is
 * refused while a trigger names the column. The rollback runner reverts newest first, so
 * the order is supplied rather than hoped for, and the registry test rolls the whole list
 * back rather than one migration to prove it.
 *
 * 0017 ADDS TWO COLUMNS WITH CHECK CONSTRAINTS AND NO TABLE REBUILD, which is worth
 * knowing because SQLite's documentation suggests neither is available. `ADD COLUMN`
 * accepts a CHECK naming a DIFFERENT column of the same row (0017 uses one to refuse a
 * stock-tracked service), and `DROP COLUMN` succeeds even though a CHECK names the column
 * being dropped. Both measured on 3.53.4 rather than read.
 *
 * NOTHING SEEDS A WAREHOUSE, AND SOMETHING MUST. 0018's header explains why a migration is
 * the wrong place for it; `seedDefaultWarehouse` in db/repos/stock.ts is the right one and
 * `bootstrap.ts` is where it should be called, beside `seedDefaultSeries`. Until that line
 * exists a company file created by the app has no warehouse and no stock can be recorded
 * in it — the exact shape of the bug 0012 found, which every test missed because every
 * test built its own fixture first.
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
import { m0008 } from './0008_documents'
import { m0009 } from './0009_document_freeze'
import { m0010 } from './0010_quotation_issuable'
import { m0011 } from './0011_company_profile'
import { m0012 } from './0012_receipts'
import { m0013 } from './0013_document_links'
import { m0014 } from './0014_document_due_date'
import { m0015 } from './0015_refund_vouchers'
import { m0016 } from './0016_document_offsets'
import { m0017 } from './0017_stock_items'
import { m0018 } from './0018_warehouses'
import { m0019 } from './0019_stock_ledger'
import { m0020 } from './0020_document_tax_treatment'
import { m0021 } from './0021_line_itc_eligibility'
import { m0022 } from './0022_stock_ledger_entry'

export const MIGRATIONS: readonly Migration[] = [
  m0001,
  m0002,
  m0003,
  m0004,
  m0005,
  m0006,
  m0007,
  m0008,
  m0009,
  m0010,
  m0011,
  m0012,
  m0013,
  m0014,
  m0015,
  m0016,
  m0017,
  m0018,
  m0019,
  m0020,
  m0021,
  m0022,
]
