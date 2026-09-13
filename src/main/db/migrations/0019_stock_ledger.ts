/*
 * 0019 — the stock ledger.
 *
 * One row per movement, per item, per warehouse. The register that ARCHITECTURE §6.4
 * requires to reconcile with the general ledger, and the table Phase 4.2's reports and
 * Phase 4.3's posting rules both read.
 *
 * Read src/main/domain/inventory/types.ts first. The seven invariants at the top of it
 * are the contract this table stores, and three of the decisions below are that file's
 * decisions restated in SQL rather than new ones taken here.
 *
 * ===========================================================================
 * 1. WHAT ORDERS THE LEDGER, AND WHY NO RUNNING BALANCE IS STORED
 * ===========================================================================
 *
 * The card is ordered by DATE, then by SEQUENCE within the date. Never by sequence alone
 * and never by insertion order: a back-dated movement gets the highest sequence and the
 * earliest date, so the two orders disagree exactly in the case that matters.
 *
 * And they disagree about more than the order of the rows. Under moving weighted average
 * a back-dated receipt RE-AVERAGES THE POOL, so it changes what every issue after it
 * cost. That is not a presentation detail; it is the cost of goods sold on invoices that
 * are already printed.
 *
 * SO: IS THE RUNNING BALANCE STORED AND RECOMPUTED WHEN SOMETHING LANDS OUT OF ORDER, OR
 * DERIVED? DERIVED. There are no `balance_quantity` and `balance_value` columns on this
 * table, and it was not a close decision. Three arguments, in increasing order of how
 * much they settle it:
 *
 *   CONVENTIONS §1.3 IS THE FIRST, AND ON ITS OWN IT IS ARGUABLE. "No stored balances.
 *   Never add a column that caches a total the journal could contradict." The test it
 *   gives is whether the INPUTS can change — and here they can, because a back-dated
 *   movement inserts a new input in front of rows that are already written. §1.3 has a
 *   carve-out for exactly that shape (`due_date`, migration 0014: stamp it and freeze
 *   it), so the convention alone does not decide this. What kills the stored version is
 *   that FREEZING IS NOT AVAILABLE HERE. A due date frozen at issue stays true forever; a
 *   running balance frozen before a back-dated receipt is simply WRONG the moment the
 *   receipt lands, because the quantity on hand really did change. The only stored
 *   version that works is one that REWRITES every later row — an UPDATE path over rows
 *   that mirror immutable journal entries, plus a second implementation of the fold to
 *   drive it, which is the shape this codebase has deleted four times.
 *
 *   THE DOMAIN HAS ALREADY MADE THIS DECISION AND IS TESTED ON IT. Invariant 7: "THE
 *   STOCK CARD IS RECOMPUTED, NEVER STORED." `runStockCard` folds from an opening state
 *   every time, in date-then-sequence order, whatever order the rows arrived in. A column
 *   here would be a second answer to a question that module already answers, and the two
 *   would agree until the first back-dated delivery note.
 *
 *   AND THE THIRD ONE ENDS IT: A STORED OUTWARD VALUE IS A VALUE THE DOMAIN REFUSES TO
 *   TAKE BACK. Invariant 4 — an outward movement is VALUED by the strategy and may not
 *   carry a cost at all; `checkMovement` returns `COST_NOT_PERMITTED` for one that does.
 *   So a row that stored what an issue cost could not be read back into a `StockMovement`
 *   without stripping the figure off it again. This table stores a `StockMovement` and
 *   nothing a valuation produces, and the shapes therefore match with nothing in between
 *   them to get wrong.
 *
 * WHAT IT COSTS, STATED PLAINLY. Every read of a card or of stock on hand is O(movements
 * for that item in that warehouse), every time, with no cached answer to shortcut it. For
 * a small business that is thousands of rows and one index seek followed by a scan
 * (`stock_ledger_card` below). The alternative costs an update path, a second fold, and a
 * class of bug where the two disagree and only one of them is on the balance sheet.
 *
 * WHAT IT ALSO COSTS, WHICH IS THE HALF WORTH ARGUING ABOUT. Because the value of an
 * outward movement is derived at read time, recording a back-dated receipt CHANGES THE
 * COST OF A SALE THAT HAS ALREADY POSTED TO THE GENERAL LEDGER. The stock register moves
 * and the ledger cannot, because a posted entry is immutable. That is a real divergence
 * and it is not this migration's to fix: the answer is that Phase 4.2 posts a valuation
 * adjustment for the difference — a second entry, the same shape as a reversal — rather
 * than editing the first. It is recorded here because the schema is what makes it
 * possible to detect: `recordMovement` reports the balance after the movement IN CARD
 * ORDER separately from the closing balance, and for a back-dated movement those two
 * figures differ, which is the fact a posting rule needs.
 *
 * ===========================================================================
 * 2. WHAT IS STORED: A `StockMovement`, EXACTLY
 * ===========================================================================
 *
 *   item, warehouse, kind, date, sequence, quantity, cost
 *
 * `cost` is NULLABLE and its nullability is a rule rather than a convenience — invariant
 * 4, "who supplies the cost is decided by direction":
 *
 *   AN INWARD MOVEMENT STATES ITS COST. A purchase bill line already fixed it at money
 *   scale; a sales return brings back the cost the goods left at. There is nowhere else
 *   for that figure to come from, so it is stored.
 *
 *   AN OUTWARD MOVEMENT IS VALUED BY THE STRATEGY AND STATES NOTHING. Letting it carry a
 *   cost would let a caller price a sale at whatever it liked and the register would stop
 *   reconciling with the ledger in a way no report could show.
 *
 * `CHECK ((cost IS NOT NULL) = (kind IN ${INWARD}))` is that sentence as a biconditional,
 * in the shape CONVENTIONS §3 asks for: one rule, both directions at once, rather than
 * two checks of which somebody writes the one they were thinking about. Both halves have
 * teeth and the second is the dangerous one — an inward row with no cost values stock at
 * nothing, and the card that results is arithmetically impeccable.
 *
 * IT EARNS A DATABASE RULE RATHER THAN A REPOSITORY ONE because either violation makes a
 * report SHORTER rather than louder. `runStockCard` stops at the first movement it cannot
 * value and returns everything before it, with `quantityIn`, `costIn` and the closing
 * figure summed over that partial set — so a card holding six of thirteen movements ties
 * perfectly at its own foot while the item's real position is missing from it. That is
 * the wrong answer that agrees with everything.
 *
 * WHAT THE ASYMMETRY IN INVARIANT 6 LOOKS LIKE AT ROW LEVEL, since it is the invariant
 * this migration was asked to enforce. VALUE WITH NO QUANTITY IS ILLEGAL; QUANTITY WITH
 * NO VALUE IS LEGAL. At the level of a single row both of its halves are legal and
 * ordinary, and the CHECKs above are written so that both go in:
 *
 *   quantity '0.000' with a cost   — freight or duty capitalised onto stock already on
 *                                    hand. The average rises and nothing arrives.
 *   quantity with a cost of '0.00' — a free sample taken in at nil. The average falls.
 *
 * The illegal state is not a row, it is a STATE: value on hand with nothing on hand. That
 * is a running total, so this table structurally cannot see it — and it cannot even see
 * half of it, because the value going out is derived and not stored. It is refused by
 * `movingAverage.receive` at the point somebody can still fix it, and `checkState` names
 * it when a state is read back. Exactly the argument `INSUFFICIENT_STOCK` makes in
 * domain/inventory/types.ts and 0004 makes about a CHECK seeing one row.
 *
 * ===========================================================================
 * 3. THE LINK TO THE SOURCE DOCUMENT — TWO FACTS, TWO COLUMNS, NO DERIVATION
 * ===========================================================================
 *
 * `kind` is a `StockMovementKind`. `source_type` is a `SourceDocumentType`. THEY ARE NOT
 * THE SAME FACT AND NEITHER MAY BE STORED ON THE OTHER, which the domain says in as many
 * words and which one example settles: a single `stock-adjustment` document raises
 * `adjustment-in` for a stock-take surplus and `adjustment-out` for shrinkage, in the
 * same session, against the same document. One source, two kinds. And a `credit-note`
 * raises `sales-return` here while raising something else entirely in the ledger.
 *
 * So there is no CHECK, no trigger and no lookup table tying the two columns, and their
 * independence is deliberate rather than unfinished.
 *
 * `source_type`, `source_id` and `source_number` are `journal_entries`'s three columns,
 * named identically and meaning the same things, so a drill-through reads the same way
 * from either register. `source_number` is denormalised for the list, exactly as it is
 * there — a stock card of two hundred rows is not two hundred lookups.
 *
 * NO CHECK ON `source_type` AND NO FOREIGN KEY ON `source_id`. 0004's reasons, unchanged:
 * `SourceDocumentType` is the domain's list and a CHECK duplicating it would be a second
 * copy to keep in step inside the one kind of file that may never be edited; and a source
 * may be a document, a voucher, or nothing at all — an opening stock entry has no
 * document behind it.
 *
 * `kind` DOES get a CHECK, and the difference is that this table's own rules read it. The
 * cost biconditional needs the inward kinds in SQL whatever happens, so the list is here
 * either way; enumerating all seven beside it costs one line and refuses a movement kind
 * from a newer build rather than storing it as a direction nothing can determine. There
 * is a test asserting the two SQL lists are exactly `STOCK_MOVEMENT_KIND_LIST` and its
 * inward half, so an eighth kind cannot quietly disagree with them — the same guard 0014
 * puts on its `ON_TERMS` list.
 *
 * ===========================================================================
 * 4. ONE REGISTER PER (ITEM, WAREHOUSE)
 * ===========================================================================
 *
 * The pool is per item PER WAREHOUSE, not per item. That is what makes "the value held at
 * Kochi" a figure the register produces rather than one somebody allocates: a single
 * company-wide average, split across locations by quantity, would put a number on a
 * warehouse report that no movement ever produced.
 *
 * It follows that `sequence` is unique within (item, warehouse) rather than within an
 * item, and `stock_ledger_position` says so. A DUPLICATE SEQUENCE IS NOT COSMETIC:
 * `runStockCard` REFUSES a set containing one, outright, because two movements sharing a
 * sequence on one date would be ordered by whatever the sort did with a tie — and under
 * moving average issue-then-receive and receive-then-issue are different cards. A
 * duplicate therefore blanks the whole card rather than reordering two rows of it, which
 * is why the rule is a unique index rather than a check anybody could skip.
 *
 * A TRANSFER BETWEEN WAREHOUSES IS NOT A KIND HERE, and its absence is deliberate. It is
 * two movements — an outward one valued by the source location and an inward one stating
 * that same value — which is the only arrangement in which the value that leaves one
 * pool is exactly the value that joins the other. A single `transfer` row would have to
 * name two warehouses and would leave the receiving pool's cost to be invented.
 *
 * ===========================================================================
 * 5. WHICH RULES ARE TRIGGERS, AND WHICH ARE THE REPOSITORY'S
 * ===========================================================================
 *
 * The test, unchanged since 0004: a rule earns a trigger when breaking it corrupts a
 * REPORT rather than throwing.
 *
 * TRIGGERS
 *
 *   `stock_ledger_item_tracked` — a movement's item must keep a balance. Without it a
 *   service, or a consumable nobody counts, acquires a stock register: the valuation
 *   report carries a figure the general ledger's stock account never received, and both
 *   pages still total. 0017's CHECK stops a service from BEING stock-tracked; this stops
 *   the consequence for everything else, and the two are not the same rule.
 *
 *   `stock_ledger_no_update` / `stock_ledger_no_delete` — append-only, exactly as
 *   `journal_entries` and `journal_lines` are, and for a reason that is stronger here
 *   than there. Editing a movement changes what every LATER movement cost, and the
 *   general ledger entries those costs were posted as cannot be edited to match. A
 *   correction is another movement — that is what `adjustment-in` and `adjustment-out`
 *   are for — the same way a correction to the journal is a reversing entry.
 *
 *   `items_no_untrack_with_movements` — an item with movements may not stop keeping a
 *   balance. `accounts_no_group_with_postings` in 0004, in its inventory form: the rows
 *   stay in this table, the stock report stops listing the item, its value disappears
 *   from the page and stays on the balance sheet. Like 0004's, it guards a path nothing
 *   currently takes, which is the only time a floor like this can be laid.
 *
 * NOT TRIGGERS
 *
 *   INSUFFICIENT STOCK. A question about a running total, which a CHECK cannot see and a
 *   trigger could only answer by summing decimal text — which is floating point and loses
 *   a paisa. Refused by the domain, which says how much is on hand in the message.
 *
 *   VALUE ON HAND WITHOUT QUANTITY. The same, and worse: the value going out is not in
 *   this table at all, so no amount of SQL could reach the figure. Section 2 above.
 *
 *   AN ARCHIVED WAREHOUSE OR AN ARCHIVED ITEM. 0004, 0005 and 0006 all declined the
 *   equivalent, three times, for the reason that archiving is a stated intention rather
 *   than a correctness rule — and a trigger would make a historical movement
 *   uncorrectable the moment something it names is archived.
 *
 *   THE PERIOD BEING OPEN. The repository refuses a movement dated into a closed period,
 *   because a movement there changes the closing stock of a year that has been filed. It
 *   is not a trigger because the general ledger entry that accompanies every movement
 *   (ARCHITECTURE §6.4) is already refused by 0004's `journal_entries_period_open`, so
 *   the floor exists one table over and a second copy would be a second thing to keep in
 *   step.
 *
 * ===========================================================================
 * 6. TWO SQLITE FACTS THIS FILE DEPENDS ON, BOTH MEASURED
 * ===========================================================================
 *
 * `IS NOT 1`, NEVER `<> 1`, in `stock_ledger_item_tracked`. A `WHEN` that evaluates to
 * NULL does not fire, and `(SELECT is_stock_tracked FROM items WHERE id = ...) <> 1` is
 * NULL when no such item exists. Measured on a scratch database: the `<>` spelling admits
 * a movement naming an item that is not there, and the `IS NOT` spelling refuses it.
 *
 * IT IS NOT AN EQUIVALENT MUTANT, which is worth saying because 0016 records that its own
 * `IS NOT` is one. Foreign keys make the parent present during ordinary operation — but
 * the migration runner turns foreign keys OFF for the whole of every migration
 * (`withoutForeignKeys` in ../migrate.ts, because `defer_foreign_keys` does not stop
 * `ON DELETE CASCADE` firing on a `DROP TABLE`). A later migration writing into this
 * table runs in exactly the state where the two spellings differ, and this folder's test
 * reaches that state by switching the pragma off, so the `<>` mutant is killed rather
 * than reasoned about.
 *
 * DROPPING THIS TABLE DOES NOT FIRE ITS OWN `BEFORE DELETE` TRIGGER. Measured, because
 * the append-only trigger would otherwise make the table undroppable and `down` would
 * have to unpick itself. `DROP TABLE` performs an implicit delete for the purposes of
 * `ON DELETE CASCADE` (../migrate.ts's header measures that) and does NOT fire row
 * triggers, which are two different things about the same statement.
 *
 * `items_no_untrack_with_movements` IS ON `items` AND MUST BE DROPPED BY HAND in `down`,
 * before `stock_ledger` goes. 0004 does the same for `accounts_no_group_with_postings`
 * and for the same reason: a trigger left behind on a surviving table, reading a table
 * that no longer exists, is a schema that will not migrate forward again.
 *
 * AND A WARNING FOR WHOEVER REBUILDS `items` NEXT. `ALTER TABLE ... RENAME TO` re-parses
 * every trigger in the schema, so a rebuild of `items` now trips over
 * `stock_ledger_item_tracked`, which reads it. 0010's `REBUILD_TAIL` had to recreate
 * `documents`'s triggers by hand for exactly this; `items` has just acquired its first
 * foreign trigger and there is nothing yet that recreates it.
 */

import type { Migration } from '../migrate'

/**
 * Every movement kind, where a trigger and a CHECK can see them.
 *
 * `STOCK_MOVEMENT_KIND_LIST` in domain/inventory/types.ts is the authority. A test
 * asserts this list is exactly it, and that `INWARD_KINDS` is exactly its `direction:
 * 'in'` half — a migration cannot import a union, so the two are joined by a test rather
 * than by the compiler (0014 makes the same concession for `ON_TERMS`).
 */
const MOVEMENT_KINDS = `('opening', 'receipt', 'issue', 'purchase-return', 'sales-return', 'adjustment-in', 'adjustment-out')`

/** The kinds that bring stock in, and therefore the kinds that state a cost. */
const INWARD_KINDS = `('opening', 'receipt', 'sales-return', 'adjustment-in')`

/* 0004's shape, unchanged: exactly two decimal places, no sign, no exponent. */
const MONEY_SHAPE = `GLOB '[0-9]*.[0-9][0-9]'`

/* Three places — a quantity, not money. 0017's shape, and `SCALE.quantity`'s meaning. */
const QUANTITY_SHAPE = `GLOB '[0-9]*.[0-9][0-9][0-9]'`

export const m0019: Migration = {
  id: '0019',
  name: 'stock_ledger',

  up(db) {
    db.exec(
      `CREATE TABLE stock_ledger (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
        warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ${MOVEMENT_KINDS}),
        movement_date TEXT NOT NULL CHECK (length(movement_date) = 10),
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        quantity TEXT NOT NULL CHECK (quantity ${QUANTITY_SHAPE}),
        cost TEXT,
        source_type TEXT NOT NULL CHECK (length(trim(source_type)) > 0),
        source_id TEXT,
        source_number TEXT,
        narration TEXT,
        created_at TEXT NOT NULL,
        CHECK (cost IS NULL OR cost ${MONEY_SHAPE}),
        CHECK ((cost IS NOT NULL) = (kind IN ${INWARD_KINDS}))
      ) STRICT`,
    )

    /*
     * `quantity` is NOT NULL and its GLOB refuses a minus sign, which is invariant 3 in
     * SQL: a movement carries HOW MUCH moved and its kind carries WHICH WAY. A negative
     * quantity here would be a second way to say "out", agreeing with the kind until the
     * day it did not, and every total would still add up (CONVENTIONS §1.10).
     *
     * ON DELETE RESTRICT at both ends, never SET NULL and never CASCADE. A movement whose
     * item or warehouse had been nulled is a row in the register that belongs to nothing
     * and appears on no report while still being in the file; a cascade is worse, because
     * deleting a warehouse would silently take a year of stock history with it and the
     * balance sheet would keep the value. The delete is refused, the repository names
     * what is in the way, and somebody archives it instead.
     */

    db.exec(
      `CREATE UNIQUE INDEX stock_ledger_position
       ON stock_ledger (item_id, warehouse_id, sequence)`,
    )

    /* The card's read path: one seek, then a scan already in the order the fold wants. */
    db.exec(
      `CREATE INDEX stock_ledger_card
       ON stock_ledger (item_id, warehouse_id, movement_date, sequence)`,
    )

    db.exec(`CREATE INDEX stock_ledger_warehouse ON stock_ledger (warehouse_id)`)
    db.exec(`CREATE INDEX stock_ledger_source ON stock_ledger (source_type, source_id)`)

    // ---- What may be written ----

    db.exec(
      `CREATE TRIGGER stock_ledger_item_tracked
       BEFORE INSERT ON stock_ledger
       WHEN (SELECT is_stock_tracked FROM items WHERE id = NEW.item_id) IS NOT 1
       BEGIN
         SELECT RAISE(ABORT, 'ITEM_NOT_STOCK_TRACKED');
       END`,
    )

    // ---- Append-only ----

    for (const event of ['UPDATE', 'DELETE'] as const) {
      db.exec(
        `CREATE TRIGGER stock_ledger_no_${event.toLowerCase()}
         BEFORE ${event} ON stock_ledger
         BEGIN
           SELECT RAISE(ABORT, 'MOVEMENT_IMMUTABLE');
         END`,
      )
    }

    // ---- The rule 0017 could not write, because this table did not exist ----

    db.exec(
      `CREATE TRIGGER items_no_untrack_with_movements
       BEFORE UPDATE OF is_stock_tracked ON items
       WHEN OLD.is_stock_tracked = 1 AND NEW.is_stock_tracked = 0
         AND EXISTS (SELECT 1 FROM stock_ledger WHERE item_id = NEW.id)
       BEGIN
         SELECT RAISE(ABORT, 'ITEM_IN_USE');
       END`,
    )

    /*
     * `OLD.is_stock_tracked = 1 AND NEW.is_stock_tracked = 0` so it fires on the
     * TRANSITION and not on every later write to a stocked item's row — the note 0013 and
     * 0016 both make about their own cancellation triggers, which is obvious once and
     * never again. Renaming a stock item, or repricing it, must not be refused because it
     * has movements.
     */
  },

  down(db) {
    /* The trigger on `items` first: it reads `stock_ledger`, and a trigger left on a
     * surviving table reading a dropped one is a schema that will not migrate forward.
     * 0004's `down` drops `accounts_no_group_with_postings` for the same reason.
     *
     * The append-only triggers need no such care — `DROP TABLE` does not fire them
     * (measured; see the header) — so the table goes in one statement, with its own
     * triggers and its indexes. */
    db.exec(`DROP TRIGGER items_no_untrack_with_movements`)
    db.exec(`DROP TABLE stock_ledger`)
  },
}
