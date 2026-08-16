/*
 * 0004 — journal_entries, journal_lines.
 *
 * The ledger itself. Everything before this migration was scaffolding: a chart of
 * accounts with nothing posted to it and periods with nothing in them. This is where
 * figures start existing, and it is the migration whose constraints matter most, because
 * every one of them protects a number somebody will file a return against.
 *
 * ---------------------------------------------------------------------------
 * HOW AN ENTRY IS WRITTEN, AND WHY IT LOOKS BACKWARDS
 *
 * THE LINES GO IN FIRST AND THE ENTRY LAST. SQLite has no deferred triggers, so nothing
 * can check a running total midway through inserting an entry's lines. Writing the lines
 * first — with the line's foreign key `DEFERRABLE INITIALLY DEFERRED`, so it may point
 * at an entry that does not exist yet — lets a `BEFORE INSERT` trigger on the entry see
 * the complete set and refuse it.
 *
 * THE DEFERRED KEY DOES NOT ENFORCE THAT ORDER BY ITSELF. This was measured, not
 * assumed, and the measurement contradicted what the ledger contract originally claimed:
 * an entry written before its lines commits perfectly happily, because a deferred key
 * only requires that the parent exist by COMMIT. And that order skips the balance check
 * entirely — the trigger fires while no line carries the entry's id yet, and the sum of
 * no lines is zero, which balances. The hole was silent and produced no error.
 *
 * Three triggers close it, and they are one mechanism rather than three rules:
 *
 *   1. `journal_entries_need_two_lines` — an entry must already see two lines carrying
 *      its id. An entry-first insert trips over this.
 *   2. `journal_lines_before_entry` — a line may not be added once its parent entry
 *      exists. This is what makes an entry final the instant it is written.
 *   3. `journal_entries_must_balance` — the sum.
 *
 * ---------------------------------------------------------------------------
 * HOW MONEY IS SUMMED IN SQL WITHOUT FLOATING POINT
 *
 * Amounts are decimal strings (CONVENTIONS §1). `SUM(debit)` would coerce them to REAL,
 * and REAL is exactly what a ledger may not use: summing ten rows of '0.10' that way
 * gives 1, but '0.07' three times plus '1234567.89' plus '0.01' gives
 * 1234568.1099999999. One paisa, and the trial balance stops tying.
 *
 * So the trigger strips the decimal point and sums PAISE AS INTEGERS, which is exact:
 *
 *     CAST(REPLACE(debit, '.', '') AS INTEGER)
 *
 * That is only sound because every stored amount really does carry exactly two decimal
 * places and no sign — which is what the GLOB CHECK below enforces, and why that CHECK
 * is load-bearing rather than cosmetic. It rejects '12.3', '12.345', '-1.00', '.50' and
 * '1e5'. `toMoneyString` produces the accepted shape for every value it is given.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT A TRIGGER
 *
 * ARCHIVED ACCOUNTS. Posting to one is refused by the repository and not here, because a
 * posting to an archived account still produces correct reports — it is simply not what
 * the user meant, which is the test this file applies to everything else. Making it a
 * trigger would also make an entry unreversible the moment one of its accounts was
 * archived, and an entry that cannot be corrected is a worse problem than the one the
 * rule would have solved.
 *
 * THE SET OF SOURCE TYPES. `SourceDocumentType` in domain/ledger is that list, and a
 * CHECK duplicating it would be a second copy to keep in step, in the one kind of file
 * that may never be edited.
 */

import type { Migration } from '../migrate'

/* Exactly two decimal places, no sign, no exponent. See the note above — the balance
 * trigger's integer arithmetic is only exact for values of this shape. */
const MONEY_SHAPE = `GLOB '[0-9]*.[0-9][0-9]'`

/** Paise, as an exact integer. Never `CAST(x AS REAL)`. */
const paise = (column: string) => `CAST(REPLACE(${column}, '.', '') AS INTEGER)`

export const m0004: Migration = {
  id: '0004',
  name: 'journal',

  up(db) {
    db.exec(
      `CREATE TABLE journal_entries (
        id TEXT PRIMARY KEY,
        entry_number TEXT NOT NULL UNIQUE,
        entry_date TEXT NOT NULL,
        narration TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT,
        source_number TEXT,
        period_id TEXT NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
        reverses_entry_id TEXT UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
        posted_at TEXT NOT NULL,
        CHECK (length(entry_date) = 10),
        CHECK (length(trim(entry_number)) > 0),
        CHECK (reverses_entry_id IS NULL OR reverses_entry_id <> id)
      ) STRICT`,
    )

    /*
     * `reverses_entry_id` is UNIQUE, which is what makes an entry reversible at most
     * once. `ALREADY_REVERSED` is therefore a constraint rather than a check somebody
     * remembered to write, and it holds even if two reversals are attempted at once.
     */
    db.exec(`CREATE INDEX journal_entries_date ON journal_entries (entry_date)`)
    db.exec(`CREATE INDEX journal_entries_period ON journal_entries (period_id)`)
    db.exec(`CREATE INDEX journal_entries_source ON journal_entries (source_type, source_id)`)

    db.exec(
      `CREATE TABLE journal_lines (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL
          REFERENCES journal_entries(id) DEFERRABLE INITIALLY DEFERRED,
        line_number INTEGER NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        debit TEXT NOT NULL DEFAULT '0.00',
        credit TEXT NOT NULL DEFAULT '0.00',
        narration TEXT,
        CHECK (line_number >= 1),
        CHECK (debit ${MONEY_SHAPE}),
        CHECK (credit ${MONEY_SHAPE}),
        CHECK ((debit = '0.00') <> (credit = '0.00'))
      ) STRICT`,
    )

    /* Invariant 5, in SQL: exactly one of the two amounts is non-zero. The comparison is
     * against the literal '0.00' rather than against 0, because these are decimal
     * strings and a numeric comparison would be the floating-point coercion this whole
     * table is written to avoid. `toMoneyString` guarantees the canonical form. */

    db.exec(`CREATE INDEX journal_lines_entry ON journal_lines (entry_id)`)
    db.exec(`CREATE INDEX journal_lines_account ON journal_lines (account_id)`)
    db.exec(`CREATE UNIQUE INDEX journal_lines_slot ON journal_lines (entry_id, line_number)`)

    // ---- The three triggers that make an entry an entry ----

    db.exec(
      `CREATE TRIGGER journal_entries_must_balance
       BEFORE INSERT ON journal_entries
       WHEN (
         SELECT COALESCE(SUM(${paise('debit')} - ${paise('credit')}), 0)
         FROM journal_lines WHERE entry_id = NEW.id
       ) <> 0
       BEGIN
         SELECT RAISE(ABORT, 'UNBALANCED_ENTRY');
       END`,
    )

    /* Two, not one. A single-line entry cannot balance unless it is zero, and a zero
     * entry says nothing. This is also what refuses an entry written before its lines:
     * at that moment it can see none of them. */
    db.exec(
      `CREATE TRIGGER journal_entries_need_two_lines
       BEFORE INSERT ON journal_entries
       WHEN (SELECT COUNT(*) FROM journal_lines WHERE entry_id = NEW.id) < 2
       BEGIN
         SELECT RAISE(ABORT, 'INSUFFICIENT_LINES');
       END`,
    )

    /* A line may only be written while its entry does not yet exist. Once the entry is
     * in, nothing may be added to it — which is invariant 3 seen from the line side, and
     * the reason an entry cannot be quietly extended after it has been reconciled. */
    db.exec(
      `CREATE TRIGGER journal_lines_before_entry
       BEFORE INSERT ON journal_lines
       WHEN EXISTS (SELECT 1 FROM journal_entries WHERE id = NEW.entry_id)
       BEGIN
         SELECT RAISE(ABORT, 'ENTRY_IMMUTABLE');
       END`,
    )

    // ---- Append-only ----

    /*
     * Invariant 3. Not edited, not deleted, not "just fixing the narration" — for the
     * entry and for its lines alike. A correction is a reversing entry.
     *
     * These are the reason `down` drops the tables rather than trying to empty them.
     */
    for (const table of ['journal_entries', 'journal_lines'] as const) {
      for (const event of ['UPDATE', 'DELETE'] as const) {
        db.exec(
          `CREATE TRIGGER ${table}_no_${event.toLowerCase()}
           BEFORE ${event} ON ${table}
           BEGIN
             SELECT RAISE(ABORT, 'ENTRY_IMMUTABLE');
           END`,
        )
      }
    }

    // ---- Where an entry may land ----

    /* An entry's date must fall inside the period it claims. Otherwise the entry appears
     * in one month's report and its date says another, and the two disagree with no way
     * to tell which is right. */
    db.exec(
      `CREATE TRIGGER journal_entries_date_in_period
       BEFORE INSERT ON journal_entries
       WHEN NOT EXISTS (
         SELECT 1 FROM accounting_periods
         WHERE id = NEW.period_id
           AND NEW.entry_date >= start_date
           AND NEW.entry_date <= end_date
       )
       BEGIN
         SELECT RAISE(ABORT, 'ENTRY_PERIOD_MISMATCH');
       END`,
    )

    /* A closed or locked period takes nothing new. This is a trigger and not only a
     * repository check because posting into a filed period changes a figure that has
     * already been reported, which is precisely a wrong number rather than an error. */
    db.exec(
      `CREATE TRIGGER journal_entries_period_open
       BEFORE INSERT ON journal_entries
       WHEN (SELECT status FROM accounting_periods WHERE id = NEW.period_id) <> 'open'
       BEGIN
         SELECT RAISE(ABORT, 'PERIOD_CLOSED');
       END`,
    )

    /* A group totals its children and holds no figures of its own; a posting to one is
     * double-counted by every roll-up above it. */
    db.exec(
      `CREATE TRIGGER journal_lines_not_group
       BEFORE INSERT ON journal_lines
       WHEN (SELECT is_group FROM accounts WHERE id = NEW.account_id) = 1
       BEGIN
         SELECT RAISE(ABORT, 'ACCOUNT_IS_GROUP');
       END`,
    )

    /*
     * The rule migration 0002 deferred to here, because it could not reference a table
     * that did not exist yet: a leaf that has been posted to may not become a group.
     * Its own figures would become a total, and every roll-up above it would count them
     * twice. `UpdateAccountInput` has no `isGroup` field today, so this guards a path
     * nothing currently takes — which is the only time a floor like this can be laid.
     */
    db.exec(
      `CREATE TRIGGER accounts_no_group_with_postings
       BEFORE UPDATE OF is_group ON accounts
       WHEN OLD.is_group = 0 AND NEW.is_group = 1
         AND EXISTS (SELECT 1 FROM journal_lines WHERE account_id = NEW.id)
       BEGIN
         SELECT RAISE(ABORT, 'ACCOUNT_IN_USE');
       END`,
    )
  },

  down(db) {
    /* The append-only triggers refuse a DELETE, so the tables are dropped rather than
     * emptied — and the triggers are dropped first, since dropping a table whose trigger
     * references another table is fine but leaving one behind is not. */
    db.exec(`DROP TRIGGER accounts_no_group_with_postings`)
    db.exec(`DROP TABLE journal_lines`)
    db.exec(`DROP TABLE journal_entries`)
  },
}
