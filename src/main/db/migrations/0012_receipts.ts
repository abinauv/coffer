/*
 * 0012 — receipts, receipt_allocations, and a numbering series that can number them.
 *
 * The other half of an invoice: what has been paid against one. Read the THREE RULES at
 * the top of src/main/domain/receipts/types.ts before touching anything here; this
 * migration is those rules expressed as constraints, and each section below says which
 * one it is enforcing.
 *
 * ---------------------------------------------------------------------------
 * RULE 1 — A RECEIPT IS POSTED THE MOMENT IT EXISTS
 *
 * There is no draft, and the whole of that shows up as two words: `number TEXT NOT NULL`
 * and `entry_id TEXT NOT NULL`. A document's are both nullable because a document spends
 * part of its life without them; a receipt has no such part. The state 0008 needs a CHECK
 * to forbid — issued and not yet posted — is one this table cannot represent at all.
 *
 * `status` therefore has two values and not three. Correcting a receipt is what
 * correcting an issued invoice is: reverse the entry, keep the number, mark it cancelled.
 * Rule 50 wants a receipt voucher series consecutive for exactly the reason rule 46(b)
 * wants an invoice series consecutive.
 *
 * ---------------------------------------------------------------------------
 * RULE 2 — ALLOCATION IS NOT A LEDGER EVENT
 *
 * The invoice's debit and the receipt's credit both carry the party's id already, so the
 * control account is correct the instant a receipt posts, whether or not anybody has said
 * which invoice it pays. `receipt_allocations` is a MATCHING RECORD: it moves no money,
 * writes no entry and changes no balance.
 *
 * That is why an allocation may be rewritten while a posted entry may not, and it is also
 * why the row carries no date and no narration. Giving it either would invite somebody to
 * report on it as though money moved when the matching was done.
 *
 * ---------------------------------------------------------------------------
 * RULE 3 — NOTHING DERIVABLE IS STORED, AGAIN
 *
 * There is no `allocated`, no `unallocated`, no `is_settled` on `receipts`, and nothing
 * was added to `documents`. What a document has outstanding is the movement its entry
 * made on the party's control account less what has been allocated to it, and what a
 * receipt has spare is its amount less the same sum. Both are folds over rows that exist.
 *
 * ---------------------------------------------------------------------------
 * WHY `numbering_series` IS REBUILT
 *
 * Its `kind` CHECK names the five document kinds, and a receipt is not one of them. The
 * alternative was a private counter for receipts, and it was rejected on the strength of
 * what 0007 exists to prevent: `numbering_counters` is the one place in this codebase
 * that can hand the same number to two records, and a second copy of it is that failure
 * written twice. So the CHECK widens and everything else about the two tables is
 * untouched.
 *
 * SQLite cannot alter a CHECK, so this is a table rebuild — see 0010, which did the same
 * to `documents`, and the note on `withoutForeignKeys` in ../migrate.ts. This one is
 * simpler than 0010's in one specific way, MEASURED rather than assumed: no trigger
 * anywhere else in the schema reads `numbering_series`, so the rename does not need
 * `legacy_alter_table`. 0007's own trigger goes with the table and is put back below.
 *
 * ---------------------------------------------------------------------------
 * FOUR TRIGGERS, AND THE ONE RULE THAT IS DELIBERATELY NOT ONE
 *
 * The test this codebase applies (0004, 0005, 0007): does breaking the rule corrupt a
 * report silently, or does it produce something a reader can see?
 *
 *   `receipt_allocations_same_party`. THE WORST ONE, and the reason this section exists.
 *   An allocation whose receipt and document name different parties takes A's outstanding
 *   down because B paid. Nothing anywhere shows it — the control account still totals,
 *   the trial balance still ties, and both parties' statements are quietly wrong from
 *   that day on. It is 0005's control-line rule reached from the other side.
 *
 *   `receipt_allocations_document_issued`. A draft has posted nothing, so allocating to
 *   one takes money against a movement that does not exist. A cancelled document's
 *   movement has been reversed to nothing, so allocating to one does the same. Either way
 *   the money disappears from every report without appearing anywhere else.
 *
 *   `receipt_allocations_receipt_posted`. The mirror: a cancelled receipt's money has
 *   been reversed out of the books, and an allocation it still holds takes an invoice's
 *   outstanding down with money that is no longer there.
 *
 *   `documents_allocated_not_cancelled`. The same rule as the second one, seen from the
 *   door it would otherwise be reached through — cancel the invoice AFTER allocating and
 *   the allocation is against a cancelled document without anything having been inserted.
 *   The transition is refused, and the repository says so in a sentence first. Cancelling
 *   a RECEIPT is not treated the same way and deletes its allocations instead, which is
 *   the asymmetry worth reading twice: cancelling a receipt un-does money, and the
 *   invoices it was matched to correctly become unpaid again; cancelling a document
 *   leaves money that still exists and still belongs to the party, and detaching it
 *   silently would create on-account money nobody decided to create.
 *
 * AND ONE MORE, WHICH IS NOT ABOUT CORRUPTION BUT ABOUT ARITHMETIC.
 *
 *   `receipt_allocations_within_receipt` refuses a set of allocations adding up to more
 *   than the receipt holds. That is money invented, and it is cheap to check here because
 *   both figures are in two tables the row already names.
 *
 * THE CAP THE OTHER WAY ROUND IS A REPOSITORY CHECK, NOT A TRIGGER — allocating more to a
 * document than that document put on the control account. Three reasons, in order of
 * weight. It depends on the LEDGER and on which account currently fills a control role,
 * both of which can move under a row that is already written, so a trigger would be
 * answering with today's chart about last year's invoice and refusing allocations for a
 * reason no user could act on. It depends on the DIRECTION of the document, which lives
 * in a TypeScript table a CHECK cannot import. And what it prevents is visible: one
 * invoice showing a negative outstanding, which a reader notices, rather than two reports
 * quietly disagreeing. The repository refuses it with the figures named.
 *
 * ---------------------------------------------------------------------------
 * ALLOCATIONS ARE WRITTEN AND DELETED, NEVER EDITED
 *
 * `receipt_allocations_immutable` refuses every UPDATE. The repository replaces the whole
 * set for a receipt in one transaction, which is the natural shape for "these are the
 * invoices this money pays" — and it means the four rules above only have to hold on
 * INSERT. A trigger set that guards inserts while leaving updates open is a set with a
 * door in it, and this is one line instead of four more.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MIGRATION DOES NOT DO, AND THE BUG THAT MADE IT WORTH SAYING
 *
 * It does not seed a numbering series, and building it showed why one is needed. NOTHING
 * HAS EVER CREATED ONE: `setUpBooks` seeded a chart of accounts and two fiscal years and
 * stopped there, there is no numbering IPC group and no settings screen — so
 * `defaultSeriesFor` answered null for every kind and ISSUING ANY DOCUMENT FROM THE APP
 * FAILED WITH `SERIES_NOT_CONFIGURED`. Measured on a company file built the way the app
 * builds one, rather than reasoned about: `numbering_series` came back empty.
 *
 * Every test passed throughout, because each one that issues something creates its own
 * series first — which is the right thing for a test of issuing to do, and is exactly why
 * none of them could see it.
 *
 * The fix is in `setUpBooks` beside the chart and the periods, NOT here, and the line is
 * the one this codebase already draws: a migration produces a SCHEMA, and `setUpBooks`
 * produces usable BOOKS. A default numbering series is opening state of exactly the kind
 * the chart of accounts is, and putting it here would have been the only piece of it that
 * was not where the rest is — while also handing every repository test a configured
 * database to start from, which is how a fixture stops being able to see what it tests.
 *
 * WHAT THAT COSTS is a company file created before this change: it has books already, so
 * `setUpBooks` will not run again, and it still cannot issue anything. There is no
 * migration that can fix it honestly either, because it cannot tell that file apart from
 * one whose owner deleted a series on purpose. What fixes it is the numbering settings
 * screen, which a business wants anyway — nobody can currently choose their own invoice
 * prefix — and which is now recorded as owed.
 *
 * ---------------------------------------------------------------------------
 * A NOTE FOR WHOEVER REBUILDS `documents` NEXT
 *
 * `documents_allocated_not_cancelled` is a trigger on `documents` created by THIS file.
 * 0010's `REBUILD_TAIL` recreates that table's triggers by hand, and its header already
 * warns that recreating 0008's version of a trigger would silently roll 0009 back. The
 * same trap now has a second occupant: a rebuild of `documents` that copies 0010's tail
 * verbatim will drop this rule without failing anything, because the repository checks it
 * first and every test would still pass.
 */

import type { Migration } from '../migrate'

/**
 * Everything a numbering series may number, as data.
 *
 * `NUMBERED_KINDS` in domain/documents/types.ts is the authority; this is the same fact
 * where a CHECK can see it, exactly as 0007 held the five and for the same reason — a
 * CHECK cannot import a union, and a series with a mistyped kind appears in no picker,
 * numbers nothing and reports no error. There is a test asserting the two agree.
 */
const NUMBERED_KINDS = `('sales-invoice', 'quotation', 'credit-note', 'purchase-bill', 'debit-note',
        'receipt', 'payment')`

/** 0007's list, unchanged, for `down`. */
const DOCUMENT_KINDS_ONLY = `('sales-invoice', 'quotation', 'credit-note', 'purchase-bill', 'debit-note')`

/** The two receipt kinds. `ReceiptKind` in domain/receipts is the authority. */
const RECEIPT_KINDS = `('receipt', 'payment')`

/** Unsigned money, exactly two places. The same shape 0004 pins `journal_lines` to. */
const MONEY_SHAPE = `GLOB '[0-9]*.[0-9][0-9]'`

/**
 * Paise, as an exact integer. Never `CAST(x AS REAL)`.
 *
 * Sound only because `MONEY_SHAPE` is on every column this is applied to — 0004's finding
 * that `SUM()` over decimal text is floating point, and loses a paisa on realistic
 * figures. The GLOB is what makes the CAST safe, and it is load-bearing here too.
 */
const paise = (column: string) => `CAST(REPLACE(${column}, '.', '') AS INTEGER)`

/** 0007's table, with the one CHECK widened. Everything else is copied verbatim. */
const SERIES_TABLE = `CREATE TABLE numbering_series_rebuilt (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN %KINDS%),
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
) STRICT`

const SERIES_COLUMNS = `id, kind, label, prefix, suffix, separator, include_fiscal_year, width,
  reset_on, is_default, is_archived, created_at, updated_at`

/**
 * Everything that hangs off `numbering_series` and therefore has to be put back by hand.
 *
 * `DROP TABLE` takes a table's indexes and its own triggers with it. The two triggers on
 * `numbering_counters` are that table's and survive; they do not read this one.
 *
 * `numbering_series_shape_frozen` is 0007's, reproduced here because it belongs to the
 * table being replaced. Its `SHAPE_CHANGED` list is written out rather than rebuilt from
 * a loop, so that a reader comparing this file against 0007 can see they are the same
 * rule — the trap 0010's header names, where recreating a trigger from an older
 * migration's version silently rolls a later one back.
 */
const SERIES_REBUILD_TAIL = [
  `CREATE UNIQUE INDEX numbering_series_label_unique
   ON numbering_series (kind, label COLLATE NOCASE)`,
  `CREATE UNIQUE INDEX numbering_series_default_per_kind
   ON numbering_series (kind)
   WHERE is_default = 1 AND is_archived = 0`,
  `CREATE TRIGGER numbering_series_shape_frozen
   BEFORE UPDATE ON numbering_series
   WHEN (NEW.kind <> OLD.kind
         OR NEW.prefix <> OLD.prefix
         OR NEW.suffix <> OLD.suffix
         OR NEW.separator <> OLD.separator
         OR NEW.include_fiscal_year <> OLD.include_fiscal_year
         OR NEW.width <> OLD.width
         OR NEW.reset_on <> OLD.reset_on)
     AND EXISTS (SELECT 1 FROM numbering_counters WHERE series_id = OLD.id)
   BEGIN
     SELECT RAISE(ABORT, 'SERIES_IN_USE');
   END`,
]

function rebuildSeries(db: Parameters<Migration['up']>[0], kinds: string): void {
  db.exec(SERIES_TABLE.replace('%KINDS%', kinds))
  db.exec(
    `INSERT INTO numbering_series_rebuilt (${SERIES_COLUMNS})
     SELECT ${SERIES_COLUMNS} FROM numbering_series`,
  )
  db.exec(`DROP TABLE numbering_series`)
  db.exec(`ALTER TABLE numbering_series_rebuilt RENAME TO numbering_series`)

  for (const statement of SERIES_REBUILD_TAIL) {
    db.exec(statement)
  }
}

export const m0012: Migration = {
  id: '0012',
  name: 'receipts',

  up(db) {
    rebuildSeries(db, NUMBERED_KINDS)

    db.exec(
      `CREATE TABLE receipts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ${RECEIPT_KINDS}),
        status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'cancelled')),
        number TEXT NOT NULL,
        series_id TEXT NOT NULL REFERENCES numbering_series(id) ON DELETE RESTRICT,
        receipt_date TEXT NOT NULL,
        party_id TEXT NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
        amount TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        reference TEXT NOT NULL DEFAULT '',
        narration TEXT NOT NULL DEFAULT '',
        entry_id TEXT NOT NULL UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        cancelled_at TEXT,
        CHECK (length(receipt_date) = 10),
        CHECK (length(trim(number)) > 0),
        CHECK (amount ${MONEY_SHAPE}),
        CHECK (${paise('amount')} > 0),
        CHECK ((status = 'cancelled') <> (cancelled_at IS NULL))
      ) STRICT`,
    )

    /*
     * `amount > 0` IN PAISE, NOT `amount <> '0.00'`. The string comparison would let
     * '0.000' through if the GLOB ever loosened, and more to the point it says the wrong
     * thing: what is being refused is a receipt for nothing, which is an arithmetic fact
     * about the value and not a fact about how it was written down.
     *
     * A receipt of nothing is not a harmless empty row. It would post two lines that are
     * neither a debit nor a credit, which ledger invariant 5 refuses — so without this
     * CHECK the failure arrives from the journal, about a line, at a user who typed a
     * receipt. It is refused here where the mistake was made.
     *
     * NEGATIVE IS REFUSED BY THE SHAPE. A receipt for minus five thousand is a payment,
     * and 0008's signed shapes are deliberately not reused: a document line may be
     * negative because a rebate is a real line, and a receipt may not because the
     * direction is `kind` and never the sign. Two ways to say the same thing is exactly
     * what `journal_lines` refuses for its own columns, for the same reason.
     */

    db.exec(
      `CREATE UNIQUE INDEX receipts_number_unique
       ON receipts (kind, number COLLATE NOCASE)`,
    )
    db.exec(`CREATE INDEX receipts_party ON receipts (party_id)`)
    db.exec(`CREATE INDEX receipts_date ON receipts (receipt_date)`)
    db.exec(`CREATE INDEX receipts_kind_status ON receipts (kind, status)`)

    /*
     * NOT NULL on `number` where 0008 makes it nullable, and the unique index therefore
     * has no `WHERE number IS NOT NULL`. That is rule 1 again: a document's number is
     * absent while it is a draft and the partial index exists to let drafts coexist; a
     * receipt has no such state, so every row has a number and every one of them collides
     * with a duplicate.
     */

    db.exec(
      `CREATE TABLE receipt_allocations (
        id TEXT PRIMARY KEY,
        receipt_id TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
        amount TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (receipt_id, document_id),
        CHECK (amount ${MONEY_SHAPE}),
        CHECK (${paise('amount')} > 0)
      ) STRICT`,
    )

    /*
     * ONE ROW PER PAIR. Two rows matching the same receipt to the same invoice add up to
     * the same money and say it twice, and every screen that lists "what this receipt
     * paid" would show one invoice on two lines. The arithmetic would survive it; the
     * reading would not.
     *
     * `ON DELETE CASCADE` from `receipts` and `ON DELETE RESTRICT` to `documents`, which
     * looks inconsistent and is not. An allocation belongs to its receipt — it is part of
     * what that receipt says — so if a receipt could ever be deleted its matching goes
     * with it. It does not belong to the document, and a document that something is
     * matched against must not be removable underneath it. Neither path is reachable
     * today: a receipt is cancelled and never deleted, and only a draft may be deleted
     * while only an issued document may be allocated to. Both are floors under a path
     * nothing currently takes, which is the only kind that can be laid without breaking
     * something (0007).
     */
    db.exec(`CREATE INDEX receipt_allocations_document ON receipt_allocations (document_id)`)

    // ---- The rules that cannot be left to a repository ----

    db.exec(
      `CREATE TRIGGER receipt_allocations_same_party
       BEFORE INSERT ON receipt_allocations
       WHEN (SELECT party_id FROM receipts WHERE id = NEW.receipt_id)
            IS NOT (SELECT party_id FROM documents WHERE id = NEW.document_id)
       BEGIN
         SELECT RAISE(ABORT, 'ALLOCATION_PARTY_MISMATCH');
       END`,
    )

    /*
     * `IS NOT` AND NOT `<>`, and this is the 2.2c finding written down where it can be
     * seen. A comparison against NULL is NULL, a `WHEN` that evaluates to NULL does not
     * fire, and a trigger that does not fire is a rule that is not there. `IS NOT` is
     * SQLite's null-safe inequality: two NULLs are equal to each other and a NULL differs
     * from anything else.
     *
     * SWAPPING IT FOR `<>` IS A PROVEN EQUIVALENT MUTANT TODAY, and that is worth writing
     * down rather than discovering twice. The only way a subquery here comes back NULL is
     * a row naming a receipt or a document that does not exist — and both of those are
     * refused anyway, by `receipt_allocations_receipt_posted` and by
     * `receipt_allocations_document_issued`, whose own `IS NOT` turns a NULL status into
     * a refusal. So no insert can tell the two spellings apart while all three rules are
     * present, and no test can either.
     *
     * It stays as `IS NOT` because that is precisely the condition under which it would
     * start to matter: delete either neighbour and this becomes the rule holding the
     * line, at which point `<>` would evaluate to NULL, decline to fire, and let a
     * cross-party allocation through in silence. A rule that is correct on its own is
     * worth more than one that is correct because of what is standing next to it.
     */

    db.exec(
      `CREATE TRIGGER receipt_allocations_document_issued
       BEFORE INSERT ON receipt_allocations
       WHEN (SELECT status FROM documents WHERE id = NEW.document_id) IS NOT 'issued'
       BEGIN
         SELECT RAISE(ABORT, 'DOCUMENT_NOT_ISSUED');
       END`,
    )

    db.exec(
      `CREATE TRIGGER receipt_allocations_receipt_posted
       BEFORE INSERT ON receipt_allocations
       WHEN (SELECT status FROM receipts WHERE id = NEW.receipt_id) IS NOT 'posted'
       BEGIN
         SELECT RAISE(ABORT, 'RECEIPT_CANCELLED');
       END`,
    )

    db.exec(
      `CREATE TRIGGER receipt_allocations_within_receipt
       BEFORE INSERT ON receipt_allocations
       WHEN ${paise('NEW.amount')}
            + IFNULL((SELECT SUM(${paise('amount')}) FROM receipt_allocations
                      WHERE receipt_id = NEW.receipt_id), 0)
            > IFNULL((SELECT ${paise('amount')} FROM receipts WHERE id = NEW.receipt_id), 0)
       BEGIN
         SELECT RAISE(ABORT, 'ALLOCATION_EXCEEDS_RECEIPT');
       END`,
    )

    db.exec(
      `CREATE TRIGGER receipt_allocations_immutable
       BEFORE UPDATE ON receipt_allocations
       BEGIN
         SELECT RAISE(ABORT, 'ALLOCATION_IMMUTABLE');
       END`,
    )

    db.exec(
      `CREATE TRIGGER documents_allocated_not_cancelled
       BEFORE UPDATE ON documents
       WHEN NEW.status = 'cancelled' AND OLD.status <> 'cancelled'
         AND EXISTS (SELECT 1 FROM receipt_allocations WHERE document_id = OLD.id)
       BEGIN
         SELECT RAISE(ABORT, 'DOCUMENT_ALLOCATED');
       END`,
    )

    /*
     * ---------------------------------------------------------------------------
     * THREE RULES CONSIDERED HERE AND DELIBERATELY NOT WRITTEN
     *
     * A CHECK THAT `account_id` IS A BANK OR CASH ACCOUNT. It cannot be written honestly:
     * `account_roles` holds one `bank` and one `cash`, and a business with four bank
     * accounts posts to three that fill no role at all. What the repository refuses is
     * what is actually wrong — a group account, an archived one, or the control account
     * the other line of the same entry is already using.
     *
     * A TRIGGER REQUIRING THE DOCUMENT'S KIND TO MATCH THE RECEIPT'S SIDE — a payment may
     * not settle a sales invoice. It is a real rule and it belongs one layer up, because
     * which side a kind sits on is a column in a TypeScript table (`RECEIPT_KINDS`,
     * `DOCUMENT_KINDS`) and a CHECK naming the pairs here would be a second copy of both
     * that nothing keeps in step. The repository refuses it; nothing about it is silent,
     * because the money lands in the wrong party's statement immediately and visibly.
     *
     * A FOREIGN KEY FROM `receipts.entry_id` WITH `ON DELETE CASCADE`. Deleting a journal
     * entry is not a thing this codebase does — invariant 3 — and if it ever became one,
     * cascading would delete the receipt and leave the invoice it settled looking unpaid.
     * `RESTRICT` says the entry cannot go while the receipt names it, which is the same
     * answer 0008 gives.
     */
  },

  down(db) {
    /*
     * The dependants go first: `receipt_allocations` references `receipts`, and the
     * trigger this migration put on `documents` is not `documents`' own and is not
     * dropped by anything else.
     *
     * The receipt and payment SERIES go too, and they have to: they exist only because
     * this migration widened the CHECK, so a rollback that left them behind would leave
     * rows the narrower table cannot hold and the copy would fail on every one of them.
     *
     * `ON DELETE RESTRICT` from `numbering_counters` is what makes that delete honest. A
     * series that has handed a number out has a counter row, so if any receipt has ever
     * been recorded the delete is refused and the whole rollback undoes itself. That is
     * the right outcome: those numbers are on vouchers, and 0007's rule is that a number
     * handed out is never released.
     */
    db.exec(`DROP TRIGGER documents_allocated_not_cancelled`)
    db.exec(`DROP TABLE receipt_allocations`)
    db.exec(`DROP TABLE receipts`)
    db.exec(`DELETE FROM numbering_series WHERE kind IN ${RECEIPT_KINDS}`)
    rebuildSeries(db, DOCUMENT_KINDS_ONLY)
  },
}
