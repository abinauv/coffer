/*
 * 0007 — numbering_series and numbering_counters.
 *
 * How a document gets the number a person quotes down the phone and an officer reads off
 * a return. Two tables: one holding the shape of a number, one holding what each series
 * has reached.
 *
 * ---------------------------------------------------------------------------
 * THE NUMBER IS ALLOCATED AT ISSUE AND NEVER RELEASED
 *
 * Rule 2 in domain/documents/types.ts, and it is what these two tables exist to make
 * true. Rule 46(b) wants an invoice series consecutive within a financial year, so a
 * draft holds no number — one handed out and abandoned leaves a gap somebody has to
 * explain to an officer — and a cancelled document keeps the number it was given.
 *
 * Everything else below follows from that one sentence. There is no operation that
 * lowers a counter, none that removes one, and none that changes the shape of a series
 * that has already handed a number to a document.
 *
 * ---------------------------------------------------------------------------
 * A NULLABLE KEY COLUMN IS A UNIQUE INDEX THAT DOES NOT ENFORCE UNIQUENESS
 *
 * `numbering_counters.fiscal_year_label` is NOT NULL, and the never-resetting scope is
 * the empty string rather than NULL. The domain models that scope as `null` and the
 * repository maps between them. The reason is 0005's registration index seen from the
 * other side: NULLs do not collide, so a nullable scope column would permit two counter
 * rows for one series — and two counters hand the same number to two invoices. That is
 * the failure a numbering scheme exists to prevent, arriving through the door marked
 * "the column is only sometimes meaningful".
 *
 * Measured, not read: in a STRICT table a PRIMARY KEY column is NOT NULL whether or not
 * it says so — a bare `PRIMARY KEY (a, b)` with `b TEXT` refuses a NULL `b`. The words
 * are written out anyway, because the rule above is the reason the column exists in that
 * shape and a reader should not have to know a STRICT-table subtlety to see it.
 *
 * ---------------------------------------------------------------------------
 * AT MOST ONE DEFAULT PER KIND
 *
 * Two defaults means "which series does a new invoice take?" is answered by whichever
 * row the query reached first, which is to say by the physical order of a table. The
 * partial unique index below makes it a constraint instead.
 *
 * ARCHIVED SERIES ARE OUT OF THAT INDEX, deliberately. An archived series is offered in
 * no picker and taken by no new document, so it is not a candidate for the slot and must
 * not occupy it: a business that archives its old invoice series and starts a new one
 * would otherwise have to remember to untick a flag on a row it can no longer see, and
 * the reward for forgetting is a constraint error naming an index. What the archived row
 * keeps is the flag it had, which is a record of what it once was and nothing more.
 *
 * ---------------------------------------------------------------------------
 * THREE TRIGGERS, AND WHY THEY ARE TRIGGERS
 *
 * This codebase's test for a trigger rather than a repository check is the one 0004 and
 * 0005 apply: does breaking the rule corrupt a report silently, or does it throw? All
 * three below corrupt silently, and each of them corrupts the same thing — a number that
 * two documents carry.
 *
 *   `numbering_counters_only_forward`. An UPDATE that lowers `next_sequence` reissues a
 *   number that is already on an issued invoice. Nobody sees an error; the register
 *   simply grows a second INV/2026-27/0007 and rule 46(b)'s consecutive series is gone.
 *   The comparison is `<=` and not `<`: the only legitimate write to this column is the
 *   allocation's own `+ 1`, and a write that leaves the counter where it was has moved
 *   nothing and handed out nothing. `BEFORE UPDATE OF next_sequence` rather than
 *   `BEFORE UPDATE`, so that touching `updated_at` alone is not caught by a `<=` that
 *   would be true of every unchanged row.
 *
 *   `numbering_counters_no_delete`. Deleting a counter row is releasing every number the
 *   series ever handed out, in one statement and with no error: the next allocation
 *   recreates the row at 1 and starts issuing numbers that are already on documents. The
 *   append-only shape 0004 gives `journal_lines` applied to the one row that must never
 *   go backwards.
 *
 *   `numbering_series_shape_frozen`. Changing the prefix, suffix, separator, width, year
 *   flag or reset rule of a series that has already numbered something produces a second
 *   series wearing the first one's name. Most of those changes only confuse; `reset_on`
 *   corrupts outright, and it is the reason this is a trigger rather than a note in the
 *   manual — moving a series from `never` to `fiscal-year` moves it to a different
 *   counter scope (see `counterScopeOf`), and a different scope is a fresh counter, which
 *   starts at 1 and reissues every number the series has given out. The trigger compares
 *   OLD against NEW rather than firing on the presence of a column in the SET list,
 *   because a settings screen posts the whole record back and re-sending an unchanged
 *   prefix is not a change.
 *
 *   `kind` is in that comparison although `UpdateNumberingSeriesInput` has no `kind`
 *   field — moving a series to another kind renumbers documents already issued under it,
 *   and a floor over a path nothing currently takes is the only kind that can be laid
 *   without breaking something, exactly as 0004 says of `accounts_no_group_with_postings`.
 *
 * ---------------------------------------------------------------------------
 * WHAT DELETING A SERIES MEANS
 *
 * `ON DELETE RESTRICT`, and it is the same sentence as the rest of this file. A counter
 * row exists only because an allocation created it, so a series with a counter is a
 * series whose numbers are on documents; deleting it would delete the record of how far
 * it had got, and the next series created in its place would start again at 1. CASCADE
 * would do exactly that, quietly, from a settings screen. A series that has numbered
 * something is archived, never deleted — the same answer 0005 gives for a party with
 * history, and for the same reason: the documents name it.
 *
 * That also makes "has this series issued anything?" a derived question with one answer
 * — whether a counter row exists — rather than a stored flag that would go stale
 * (CONVENTIONS §1.3). The repository, the trigger above and this foreign key all read it
 * the same way.
 */

import type { Migration } from '../migrate'

/**
 * The five `DocumentKind` values, quoted here as data.
 *
 * This one is the whole union, where 0005's control-role CHECK is deliberately two of
 * five and 0004 declines to CHECK `source_type` at all. The difference is who writes the
 * column: `source_type` is written by the ledger from a value the type system already
 * narrowed, while a series' `kind` is chosen by a person in a settings screen and stored
 * as text. A typo there produces a series that appears in no picker, draws no document
 * and reports no error — it simply sits in the table looking configured.
 *
 * The price is that a sixth document kind needs a migration to widen this list as well as
 * a row in `DOCUMENT_KINDS` and a posting rule. That is the price of refusing a series
 * nothing can ever use, and it is paid once per kind.
 */
const DOCUMENT_KINDS = `('sales-invoice', 'quotation', 'credit-note', 'purchase-bill', 'debit-note')`

/**
 * The columns that describe what a number LOOKS like, as opposed to what it is called.
 *
 * `label`, `is_default` and `is_archived` are not here on purpose: renaming a series,
 * moving the default elsewhere and putting one away change nothing about a number that
 * has already been printed.
 */
const SHAPE_COLUMNS = [
  'kind',
  'prefix',
  'suffix',
  'separator',
  'include_fiscal_year',
  'width',
  'reset_on',
] as const

const SHAPE_CHANGED = SHAPE_COLUMNS.map((column) => `NEW.${column} <> OLD.${column}`).join(
  '\n         OR ',
)

export const m0007: Migration = {
  id: '0007',
  name: 'numbering',

  up(db) {
    db.exec(
      `CREATE TABLE numbering_series (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ${DOCUMENT_KINDS}),
        label TEXT NOT NULL,
        prefix TEXT NOT NULL DEFAULT '',
        suffix TEXT NOT NULL DEFAULT '',
        separator TEXT NOT NULL DEFAULT '',
        include_fiscal_year INTEGER NOT NULL DEFAULT 0 CHECK (include_fiscal_year IN (0, 1)),
        width INTEGER NOT NULL DEFAULT 4,
        reset_on TEXT NOT NULL DEFAULT 'fiscal-year' CHECK (reset_on IN ('fiscal-year', 'never')),
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
        is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (length(trim(label)) > 0),
        CHECK (width >= 0 AND width <= 12)
      ) STRICT`,
    )

    /*
     * THE WIDTH RANGE. Zero is a real choice and the floor: a series that prints `1`,
     * `2`, `17` with no padding at all is somebody's existing series, and refusing it
     * would be refusing the one thing this table exists to allow. The ceiling is not
     * about storage — it is about a number a person has to read out. Twelve digits is
     * already a thousand times more documents than a small business will raise in its
     * life, and nothing ever reaches the ceiling by counting: `paddedSequence` GROWS past
     * the width rather than truncating, because a truncated sequence is a number an
     * earlier document already carries. The bound catches a settings screen that sent a
     * width of 400, not a business that issued too many invoices.
     *
     * Measured, not read: STRICT does not make this CHECK redundant. A STRICT table
     * stores the text `'4'` in an INTEGER column as the integer 4 quite happily — it
     * refuses only what it cannot convert without loss, so `'wide'` and `4.5` are turned
     * away and `'400'` is not.
     */

    /*
     * A label is unique within a kind, ignoring case. Two rows reading `Export` and
     * `EXPORT` in the same picker is an invoice raised under the wrong series, and the
     * only evidence afterwards is a number in the wrong sequence. Across kinds they are
     * free: a `Main` invoice series and a `Main` quotation series are not duplicates of
     * each other, and forcing a business to invent a second word would be inventing a
     * problem.
     */
    db.exec(
      `CREATE UNIQUE INDEX numbering_series_label_unique
       ON numbering_series (kind, label COLLATE NOCASE)`,
    )

    /* One default per kind, among the series a document could actually take. See the
     * header for why the archived ones are outside this index rather than inside it. */
    db.exec(
      `CREATE UNIQUE INDEX numbering_series_default_per_kind
       ON numbering_series (kind)
       WHERE is_default = 1 AND is_archived = 0`,
    )

    db.exec(
      `CREATE TABLE numbering_counters (
        series_id TEXT NOT NULL REFERENCES numbering_series(id) ON DELETE RESTRICT,
        fiscal_year_label TEXT NOT NULL,
        next_sequence INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (series_id, fiscal_year_label),
        CHECK (next_sequence >= 1)
      ) STRICT`,
    )

    /*
     * The primary key IS the uniqueness rule: one counter per series per scope. It is
     * declared as the key rather than as a separate unique index because there is nothing
     * else identifying a row here — a counter is its scope.
     *
     * `next_sequence >= 1` is the floor, not the start. It says a counter never counts
     * down to zero and never wraps; the allocation writes 1 into a new row and hands out
     * the value it finds, so the smallest number this table can ever produce is 1.
     */

    // ---- The three rules that cannot be left to a repository ----

    db.exec(
      `CREATE TRIGGER numbering_counters_only_forward
       BEFORE UPDATE OF next_sequence ON numbering_counters
       WHEN NEW.next_sequence <= OLD.next_sequence
       BEGIN
         SELECT RAISE(ABORT, 'SERIES_IN_USE');
       END`,
    )

    db.exec(
      `CREATE TRIGGER numbering_counters_no_delete
       BEFORE DELETE ON numbering_counters
       BEGIN
         SELECT RAISE(ABORT, 'SERIES_IN_USE');
       END`,
    )

    db.exec(
      `CREATE TRIGGER numbering_series_shape_frozen
       BEFORE UPDATE ON numbering_series
       WHEN (${SHAPE_CHANGED})
         AND EXISTS (SELECT 1 FROM numbering_counters WHERE series_id = OLD.id)
       BEGIN
         SELECT RAISE(ABORT, 'SERIES_IN_USE');
       END`,
    )

    /*
     * ---------------------------------------------------------------------------
     * FOUR RULES CONSIDERED HERE AND DELIBERATELY NOT WRITTEN
     *
     * `include_fiscal_year = 1` IMPLIES `reset_on = 'fiscal-year'` — as a CHECK. It
     * looks like tidying up an obviously silly combination and it would take two real
     * configurations away. The two flags are independent on purpose and `counterScopeOf`
     * says so in as many words: a business may want the year printed while the sequence
     * runs on across years, and another may reset silently each year without showing it,
     * whose numbers repeat between years and whose books are kept a year to a file. Both
     * are legal under rule 46(b), which asks for consecutive within a financial year and
     * nothing about what is printed. A CHECK here would have to be migrated away, and a
     * merged migration is never edited.
     *
     * A SHAPE FOR `fiscal_year_label` — a CHECK that it looks like `2026-27`. What a
     * fiscal year is called belongs to the fiscal calendar (domain/time), and a company
     * whose year runs January to December labels it `2026` with no hyphen in sight. The
     * column is a scope key; the only thing this table needs of it is that it is exactly
     * the label the number carries, which is a repository concern and not a shape.
     *
     * A FOREIGN KEY FROM `fiscal_year_label` TO `accounting_periods` — so that a counter
     * can only exist for a year the books know. `fiscal_year_label` is not unique over
     * there (a year is many periods) so it could not be a key without a new table, and
     * the rule would be wrong even if it could: the empty-string scope belongs to no year
     * at all, and periods for next year are generated when somebody gets round to it,
     * which must not be the thing that stops an invoice being issued.
     *
     * AN INDEX ON `kind`. A company has a handful of series and a scan of five rows is
     * cheaper than the page the index would live on. The two unique indexes above exist
     * for their constraints, not for their speed.
     */
  },

  down(db) {
    /* `numbering_series_shape_frozen` reads `numbering_counters`, so it goes before the
     * table it reads. The two triggers on `numbering_counters` are dropped with it —
     * DROP TABLE takes a table's own triggers and fires none of them, which is what lets
     * a table whose BEFORE DELETE trigger refuses every delete be dropped at all. */
    db.exec(`DROP TRIGGER numbering_series_shape_frozen`)
    db.exec(`DROP TABLE numbering_counters`)
    db.exec(`DROP TABLE numbering_series`)
  },
}
