/*
 * 0015 — a refund is a voucher, and an allocation must point at what its voucher settles.
 *
 * Two table rebuilds and one trigger. `numbering_series` and `receipts` both carry a
 * `kind` CHECK naming the voucher kinds by hand — a CHECK cannot import a union — so
 * adding two kinds widens both, and SQLite cannot alter a CHECK. And
 * `receipt_allocations` gains the trigger 0012 CONSIDERED AND DELIBERATELY DID NOT WRITE
 * — because what that rule protects changed shape the moment a second voucher appeared on
 * a side.
 *
 * ---------------------------------------------------------------------------
 * THE RULE 0012 DECLINED, AND WHY IT IS WRITTEN NOW
 *
 * 0012's header names it: "A TRIGGER REQUIRING THE DOCUMENT'S KIND TO MATCH THE RECEIPT'S
 * SIDE — a payment may not settle a sales invoice." It gave two reasons for leaving it to
 * the repository, and it is worth taking them in turn, because one of them still stands
 * and the other has stopped being true.
 *
 * THE FIRST REASON STANDS AND IS ANSWERED. A CHECK naming the pairs here is a second copy
 * of two TypeScript tables that nothing keeps in step. True, and 0013 had already found
 * the answer one migration later: enumerate the mapping in SQL, and put a TEST beside the
 * domain asserting that the SQL and the table say the same thing. `CORRECTS` in 0013 is
 * that shape and `SETTLES` below is the same shape. A fifth voucher kind fails that test
 * rather than silently disagreeing with this file.
 *
 * THE SECOND REASON HAS STOPPED BEING TRUE, AND THAT IS THE WHOLE OF WHY THIS TRIGGER
 * EXISTS. 0012 argued that nothing about a wrong pairing is silent, "because the money
 * lands in the wrong party's statement immediately and visibly". That was right about the
 * mistake 0012 could make. With one voucher per side, a wrong pairing was always a
 * CROSS-ACCOUNT one: a payment against a sales invoice puts one end on receivables and
 * the other on payables, and two control accounts visibly stop agreeing with their own
 * documents.
 *
 * A refund is on the SAME side as a receipt and moves the SAME control account. So a
 * refund allocated to a sales invoice is same party, same side, same account, and the
 * only thing wrong with it is the DIRECTION: the customer's balance goes UP while one of
 * their invoices is marked settled. No statement looks odd. No control account moves
 * anywhere it should not. The only thing anywhere that can see it is an aged report
 * saying it does not tie, without being able to say why — which is precisely the class of
 * failure 0012's own test ("does breaking the rule corrupt a report silently, or does it
 * produce something a reader can see?") puts in a trigger.
 *
 * THE REPOSITORY STILL REFUSES IT FIRST, with a sentence naming the two kinds. This is
 * the floor under a write that never went through the repository — which is not
 * hypothetical: 0014-2's tests reached past it on purpose to build a report that does not
 * tie, and had to find an honest way to break one once this landed.
 *
 * ---------------------------------------------------------------------------
 * ONE EXPRESSION, NOT TWO, AND NOT FOUR
 *
 * The rule reads as two — the same side, and facing the other way — and it is written as
 * one lookup for the reason 0013 gives about `CORRECTS`: a second trigger saying "and the
 * sides must match" could only ever agree with this one, and the codebase has deleted
 * several of those. `SETTLES` maps each voucher kind to the ONE document kind it settles,
 * so a side mismatch and a direction mismatch are the same disagreement seen twice.
 *
 * It is stated as a mapping here and DERIVED in `@shared/receipts`, where `settles()`
 * works it out from the side and the money direction. That is not the SQL being lazy: a
 * CHECK cannot import a union and cannot do the derivation, so what it holds is the
 * derivation's OUTPUT, and the test asserting the two agree is what makes holding the
 * output safe.
 *
 * ---------------------------------------------------------------------------
 * TWO REBUILDS, AND THE SECOND ONE IS THE AWKWARD ONE
 *
 * `numbering_series` is the third rebuild of that table: 0007 wrote the CHECK with five
 * document kinds, 0012 widened it to `receipt` and `payment`, this adds the two refunds.
 * Nothing in the schema reads it from a trigger, so the rename needs no pragma — the same
 * measurement 0012 made and the reason its version is copied here unchanged.
 *
 * `receipts` IS THE ONE THAT NEEDS 0010'S PRAGMA. Its own `kind` CHECK names the two
 * voucher kinds, and three of `receipt_allocations`'s triggers read `receipts` in their
 * WHEN clause. `ALTER TABLE ... RENAME TO` re-parses every trigger in the schema to
 * rewrite references to the old name, and at the moment of the rename `receipts` has just
 * been dropped — so the re-parse fails outright with `no such table: main.receipts`.
 * `legacy_alter_table = ON` is the documented way to say "rename the table and leave every
 * other object alone", which is exactly right: nothing mentions `receipts_rebuilt`, and
 * the triggers already say `receipts`, the name the table is about to have again.
 *
 * WHAT THE ALTERNATIVE WOULD HAVE COST is 0010's argument and it is the same here: drop
 * those triggers and put them back, and 0012's definitions are copied into a second file
 * where they can drift, and every future trigger on `receipt_allocations` becomes
 * something this migration has to know about.
 *
 * `receipts` HAS NO TRIGGERS OF ITS OWN — checked rather than assumed — so its tail is
 * four indexes and nothing else. Foreign keys are already off: `runMigrations` turns them
 * off around every migration for exactly this, and its own header records the measured
 * finding that `defer_foreign_keys` does NOT stop `ON DELETE CASCADE` firing on a DROP.
 * Without that, dropping `receipts` would take every allocation with it.
 *
 * THE COPY IS THE POINT AND ALSO THE HAZARD. 0010's header names the trap and 0012's
 * repeats it: recreating a trigger from an older migration's version silently rolls a
 * later one back. Both table bodies and both tails below are 0012'S, verbatim, because
 * 0012 is the last migration to touch either. Nothing between 0012 and here has altered
 * them, which was CHECKED against 0013 and 0014 rather than assumed, and it is the only
 * reason this file may copy at all.
 */

import type { Migration } from '../migrate'

/**
 * Which document kind each voucher kind settles, where a trigger can see it.
 *
 * `RECEIPT_KINDS` in `@shared/receipts` is the authority and `settles()` is the
 * derivation; this is its output written out, because a CHECK cannot import a union. A
 * test in the receipts suite asserts the two agree, so a voucher kind added to the table
 * fails there rather than quietly falling through this CASE to NULL.
 *
 * NULL IS THE SAFE FALL-THROUGH AND IT IS DELIBERATE. `IS NOT` against a NULL right-hand
 * side is true for every document kind, so an unmapped voucher settles NOTHING rather
 * than everything — the same shape 0013's `CORRECTS` relies on to refuse a sales invoice
 * carrying a correction link.
 */
const SETTLES = `CASE (SELECT kind FROM receipts WHERE id = NEW.receipt_id)
        WHEN 'receipt' THEN 'sales-invoice'
        WHEN 'payment' THEN 'purchase-bill'
        WHEN 'refund' THEN 'credit-note'
        WHEN 'refund-received' THEN 'debit-note'
      END`

/** Everything a numbering series may number. `NumberedKind` is the authority. */
const NUMBERED_KINDS = `('sales-invoice', 'quotation', 'credit-note', 'purchase-bill', 'debit-note',
        'receipt', 'payment', 'refund', 'refund-received')`

/** 0012's list, unchanged, for `down`. */
const KINDS_BEFORE_REFUNDS = `('sales-invoice', 'quotation', 'credit-note', 'purchase-bill',
        'debit-note', 'receipt', 'payment')`

/** Every voucher kind. `ReceiptKind` in `@shared/receipts` is the authority. */
const VOUCHER_KINDS = `('receipt', 'payment', 'refund', 'refund-received')`

/** 0012's two, for `down`. */
const VOUCHER_KINDS_BEFORE_REFUNDS = `('receipt', 'payment')`

/** The two kinds this migration adds, for `down` to take its own rows back. */
const REFUND_KINDS = `('refund', 'refund-received')`

/** Unsigned money, exactly two places. 0012's, which is 0004's. */
const MONEY_SHAPE = `GLOB '[0-9]*.[0-9][0-9]'`

/** Paise, as an exact integer. Sound only because `MONEY_SHAPE` guards the column. */
const paise = (column: string) => `CAST(REPLACE(${column}, '.', '') AS INTEGER)`

/** 0012's table, with the one CHECK widened. Everything else is copied verbatim. */
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
 * 0012's, verbatim — which is 0007's two indexes and 0007's shape-freeze trigger, carried
 * forward once already. Written out rather than rebuilt from a loop so that a reader
 * comparing this file against 0012 can see they are the same rule.
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

/** 0012's table, with the one CHECK widened. Everything else is copied verbatim. */
const RECEIPTS_TABLE = `CREATE TABLE receipts_rebuilt (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN %KINDS%),
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
) STRICT`

const RECEIPTS_COLUMNS = `id, kind, status, number, series_id, receipt_date, party_id, amount,
  account_id, reference, narration, entry_id, created_at, updated_at, cancelled_at`

/** 0012's four indexes. The table carries no triggers of its own. */
const RECEIPTS_REBUILD_TAIL = [
  `CREATE UNIQUE INDEX receipts_number_unique
   ON receipts (kind, number COLLATE NOCASE)`,
  `CREATE INDEX receipts_party ON receipts (party_id)`,
  `CREATE INDEX receipts_date ON receipts (receipt_date)`,
  `CREATE INDEX receipts_kind_status ON receipts (kind, status)`,
]

function rebuildReceipts(db: Parameters<Migration['up']>[0], kinds: string): void {
  db.exec(RECEIPTS_TABLE.replace('%KINDS%', kinds))
  db.exec(
    `INSERT INTO receipts_rebuilt (${RECEIPTS_COLUMNS})
     SELECT ${RECEIPTS_COLUMNS} FROM receipts`,
  )
  db.exec(`DROP TABLE receipts`)

  /* See the header. `finally`, because leaving the pragma on would change `ALTER TABLE`
   * for the rest of the session — including for a later migration that renames a column
   * and does want its references updated. */
  db.pragma('legacy_alter_table = ON')
  try {
    db.exec(`ALTER TABLE receipts_rebuilt RENAME TO receipts`)
  } finally {
    db.pragma('legacy_alter_table = OFF')
  }

  for (const statement of RECEIPTS_REBUILD_TAIL) {
    db.exec(statement)
  }
}

export const m0015: Migration = {
  id: '0015',
  name: 'refund_vouchers',

  up(db) {
    /* The series first, because `receipts.series_id` references it and the rebuilt
     * receipts table is written against the name that exists when it is created. */
    rebuildSeries(db, NUMBERED_KINDS)
    rebuildReceipts(db, VOUCHER_KINDS)

    /*
     * BEFORE INSERT ONLY, and that is complete rather than partial: 0012's
     * `receipt_allocations_immutable` refuses every UPDATE, so a row that satisfied this
     * on the way in cannot be re-pointed afterwards. The one door left is a voucher
     * changing kind under a row already written, and `receipts` has no path that does it
     * — a voucher is cancelled and never re-kinded.
     */
    db.exec(
      `CREATE TRIGGER receipt_allocations_settles_kind
       BEFORE INSERT ON receipt_allocations
       WHEN (SELECT kind FROM documents WHERE id = NEW.document_id) IS NOT ${SETTLES}
       BEGIN
         SELECT RAISE(ABORT, 'ALLOCATION_KIND_MISMATCH');
       END`,
    )
  },

  down(db) {
    db.exec(`DROP TRIGGER receipt_allocations_settles_kind`)

    /*
     * The refund SERIES go, for the reason 0012's do: they exist only because this
     * migration widened the CHECK, so a rollback that left them behind would leave rows
     * the narrower table cannot hold and the copy would fail on every one of them.
     *
     * `ON DELETE RESTRICT` from `numbering_counters` is what makes that delete honest. A
     * series that has handed a number out has a counter row, so if any refund has ever
     * been recorded the delete is refused and the whole rollback undoes itself — which is
     * the right outcome, because those numbers are on vouchers and 0007's rule is that a
     * number handed out is never released.
     */
    /*
     * The refund VOUCHERS go before the table narrows, and this delete is the one that
     * says whether the rollback is honest. A refund that has been recorded is money that
     * moved and a number that was handed out, and `entry_id REFERENCES journal_entries`
     * with ON DELETE RESTRICT is not what stops it — the delete is on this side of the
     * key. So it is refused explicitly, rather than quietly discarding the vouchers a
     * business actually raised.
     */
    const recorded = db
      .prepare(`SELECT COUNT(*) AS n FROM receipts WHERE kind IN ${REFUND_KINDS}`)
      .get() as { n: number }
    if (recorded.n > 0) {
      throw new Error(
        `${String(recorded.n)} refund vouchers have been recorded in these books. ` +
          'Rolling 0015 back would discard them and the numbers they were issued under.',
      )
    }
    rebuildReceipts(db, VOUCHER_KINDS_BEFORE_REFUNDS)

    db.exec(`DELETE FROM numbering_series WHERE kind IN ${REFUND_KINDS}`)
    rebuildSeries(db, KINDS_BEFORE_REFUNDS)
  },
}
