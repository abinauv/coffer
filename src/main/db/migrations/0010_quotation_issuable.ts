/*
 * 0010 — a quotation may be issued without posting anything.
 *
 * A table rebuild, because SQLite cannot alter or drop a CHECK constraint. Read the note
 * on `withoutForeignKeys` in ../migrate.ts before changing anything here: the runner
 * switches foreign keys off for a migration and runs `foreign_key_check` before the
 * commit, and without that this file would silently delete every document line in the
 * company file.
 *
 * ---------------------------------------------------------------------------
 * WHAT 0008 GOT WRONG
 *
 * `CHECK (status <> 'issued' OR entry_id IS NOT NULL)` says that every issued document
 * has posted. The domain contract, written first, says something narrower:
 *
 *   "`issued` rather than `posted`, and the distinction is not cosmetic: in this codebase
 *   'posted' means specifically 'written to the ledger', and a quotation is issued without
 *   posting anything. EVERY KIND IS ISSUED; only the kinds with a `sourceType` are also
 *   posted, and that is a property of the kind rather than a second status somebody has to
 *   keep in step."   — domain/documents/types.ts, on `DocumentStatus`
 *
 * So the CHECK was stricter than the rule it was enforcing, and the cost was concrete: a
 * quotation could never leave draft, which meant it could never be numbered, because rule
 * 2 allocates the number at issue. A quotation with no number is not much use to anybody.
 *
 * 0008's own header noticed the tension and deferred it — "it goes from draft to whatever
 * Phase 3 decides". Phase 3 does not need to decide anything. The contract already had.
 *
 * ---------------------------------------------------------------------------
 * WHY THE KIND IS NAMED IN SQL
 *
 * The corrected rule is "a document that POSTS and is issued has an entry", and the
 * database cannot derive which kinds post — `sourceType: null` lives in a TypeScript
 * table. So the non-posting kinds are enumerated here, exactly as `DOCUMENT_KINDS` is
 * enumerated in 0008 and in 0007, and for the same reason: a CHECK cannot import a union,
 * and the alternative is no constraint at all.
 *
 * The list is one entry long and there is a test in the documents suite asserting it
 * agrees with `postsToLedger` for every kind the domain knows — so a sixth kind that posts
 * nothing cannot be added without something going red.
 *
 * WHAT IS NOT WEAKENED. A sales invoice, credit note, purchase bill or debit note still
 * cannot be `issued` without an `entry_id`. That is rule 3, it is the constraint that
 * makes "issued but not yet posted" unrepresentable, and it is untouched.
 */

import type { Migration } from '../migrate'

/**
 * The kinds that never reach the ledger, as data.
 *
 * `postsToLedger` in domain/documents/types.ts is the authority; this is the same fact
 * where a CHECK can see it. Kept as a list rather than `kind = 'quotation'` so that adding
 * to it is an edit to a list rather than a rewrite of an expression.
 */
const NON_POSTING_KINDS = `('quotation')`

/** 0008's table, with the one CHECK corrected. Everything else is copied verbatim. */
const DOCUMENTS_TABLE = `CREATE TABLE documents_rebuilt (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('sales-invoice', 'quotation', 'credit-note', 'purchase-bill', 'debit-note')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'issued', 'cancelled')),
  number TEXT,
  series_id TEXT REFERENCES numbering_series(id) ON DELETE RESTRICT,
  document_date TEXT NOT NULL,
  party_id TEXT NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  party_reference TEXT,
  place_of_supply_jurisdiction TEXT,
  place_of_supply_country TEXT NOT NULL,
  rounding_policy TEXT NOT NULL DEFAULT 'none'
    CHECK (rounding_policy IN ('whole-unit', 'none')),
  narration TEXT NOT NULL DEFAULT '',
  entry_id TEXT UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  issued_at TEXT,
  cancelled_at TEXT,
  CHECK (length(document_date) = 10),
  CHECK (length(place_of_supply_country) = 2),
  CHECK (place_of_supply_country = lower(place_of_supply_country)),
  CHECK ((status = 'draft') = (number IS NULL)),
  CHECK (status <> 'issued' OR entry_id IS NOT NULL OR kind IN %KINDS%),
  CHECK ((status = 'draft') = (issued_at IS NULL)),
  CHECK ((status = 'cancelled') <> (cancelled_at IS NULL))
) STRICT`

const COLUMNS = `id, kind, status, number, series_id, document_date, party_id, party_reference,
  place_of_supply_jurisdiction, place_of_supply_country, rounding_policy, narration, entry_id,
  created_at, updated_at, issued_at, cancelled_at`

/**
 * Everything that hangs off the table and therefore has to be put back by hand.
 *
 * `DROP TABLE` takes its indexes and its own triggers with it. The triggers on
 * `document_lines` survive, because they belong to that table — they only READ `documents`
 * — which is why they are not listed here. See `rebuild` for what that costs.
 *
 * This is the freeze trigger AS 0009 LEFT IT, not as 0008 wrote it. Recreating 0008's
 * version would silently roll 0009 back, and every test of it would still pass on a fresh
 * database because migrations run in order and the last one to touch the trigger wins.
 */
const REBUILD_TAIL = [
  `CREATE UNIQUE INDEX documents_number_unique
   ON documents (kind, number COLLATE NOCASE)
   WHERE number IS NOT NULL`,
  `CREATE INDEX documents_party ON documents (party_id)`,
  `CREATE INDEX documents_date ON documents (document_date)`,
  `CREATE INDEX documents_kind_status ON documents (kind, status)`,
  `CREATE TRIGGER documents_frozen_once_issued
   BEFORE UPDATE ON documents
   WHEN OLD.status <> 'draft'
     AND (NEW.kind <> OLD.kind
       OR NEW.document_date <> OLD.document_date
       OR NEW.party_id <> OLD.party_id
       OR NEW.rounding_policy <> OLD.rounding_policy
       OR NEW.place_of_supply_country <> OLD.place_of_supply_country
       OR NEW.narration <> OLD.narration
       OR IFNULL(NEW.place_of_supply_jurisdiction, '')
          <> IFNULL(OLD.place_of_supply_jurisdiction, '')
       OR IFNULL(NEW.number, '') <> IFNULL(OLD.number, '')
       OR IFNULL(NEW.series_id, '') <> IFNULL(OLD.series_id, '')
       OR IFNULL(NEW.entry_id, '') <> IFNULL(OLD.entry_id, ''))
   BEGIN
     SELECT RAISE(ABORT, 'DOCUMENT_NOT_DRAFT');
   END`,
  `CREATE TRIGGER documents_issued_not_deleted
   BEFORE DELETE ON documents
   WHEN OLD.status <> 'draft'
   BEGIN
     SELECT RAISE(ABORT, 'DOCUMENT_NOT_DRAFT');
   END`,
]

/**
 * The rebuild, and the one pragma that makes the rename possible.
 *
 * `ALTER TABLE ... RENAME TO` re-parses every trigger and view in the schema so it can
 * rewrite references to the old name. `document_lines` carries three triggers that read
 * `documents` in their WHEN clause, and at the moment of the rename `documents` has just
 * been dropped — so the re-parse fails outright:
 *
 *   error in trigger document_lines_frozen_on_insert: no such table: main.documents
 *
 * `legacy_alter_table = ON` is the documented way to say "rename the table and leave every
 * other object alone", which is exactly right here: nothing in the schema mentions
 * `documents_rebuilt`, so there is nothing to rewrite, and the three triggers already say
 * `documents` — the name the table is about to have again. Measured after the fact rather
 * than assumed: they still fire, and `document_lines` still cascades from `documents`.
 *
 * The alternative was to drop those three triggers and recreate them here. It works, and
 * it was rejected: it copies 0008's definitions into a second file where they can drift,
 * and it makes every future trigger on `document_lines` something this migration has to
 * know about.
 *
 * `finally`, because leaving the pragma on would change `ALTER TABLE` for the rest of the
 * session — including for a later migration that renames a column and does want its
 * references updated.
 */
function rebuild(db: Parameters<Migration['up']>[0], kinds: string): void {
  db.exec(DOCUMENTS_TABLE.replace('%KINDS%', kinds))
  db.exec(`INSERT INTO documents_rebuilt (${COLUMNS}) SELECT ${COLUMNS} FROM documents`)
  db.exec(`DROP TABLE documents`)

  db.pragma('legacy_alter_table = ON')
  try {
    db.exec(`ALTER TABLE documents_rebuilt RENAME TO documents`)
  } finally {
    db.pragma('legacy_alter_table = OFF')
  }

  for (const statement of REBUILD_TAIL) {
    db.exec(statement)
  }
}

export const m0010: Migration = {
  id: '0010',
  name: 'quotation_issuable',

  up(db) {
    rebuild(db, NON_POSTING_KINDS)
  },

  down(db) {
    /*
     * Back to a list nothing matches, which is 0008's rule exactly: every issued document
     * must have posted. `('')` rather than deleting the clause, so that `up` and `down`
     * differ in one value and cannot drift apart in shape.
     *
     * A rollback is refused if any quotation has been issued in the meantime — the CHECK
     * on the rebuilt table rejects the copy, and the whole migration rolls back. That is
     * the honest outcome: those rows have no representation under 0008's rule, and a
     * `down` that quietly dropped them would lose numbered documents.
     */
    rebuild(db, `('')`)
  },
}
