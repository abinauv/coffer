/*
 * 0022 — the movement's journal entry, as a column and as a rule.
 *
 * `stock_ledger.entry_id`, and one trigger that refuses a movement which moved money
 * without one.
 *
 * ===========================================================================
 * WHAT THIS COLUMN IS FOR, AND WHY IT IS NOT A CACHED ANYTHING
 * ===========================================================================
 *
 * ARCHITECTURE §6.4: "Every stock movement writes to the stock ledger AND posts to the
 * general ledger, so inventory value on the balance sheet always reconciles with the
 * stock register." 0019 built the register and posted nothing. This is the other half.
 *
 * It is worth being explicit that this does NOT contradict 0019's central decision. 0019
 * refuses to store a running balance or an outward movement's value, because both are
 * DERIVED and a back-dated movement changes them. An entry id is neither: it is the
 * identity of a row in another table, fixed the moment it is written and immutable
 * afterwards (ledger invariant 3). It is `documents.entry_id`, one table over, for the
 * same reason and with the same shape.
 *
 * ===========================================================================
 * WHY IT EARNS A TRIGGER, AND WHY THE TRIGGER STATES ONLY HALF THE RULE
 * ===========================================================================
 *
 * The test this schema uses, unchanged since 0004: a rule earns a trigger when breaking
 * it corrupts a REPORT rather than throwing.
 *
 * A MOVEMENT WITH NO ENTRY IS A BALANCE SHEET THAT DOES NOT TIE — and neither page says
 * so. The stock register shows the goods, the balance sheet does not carry their value,
 * both documents total correctly, and nothing in the product can point at the row. It is
 * exactly the shape CONVENTIONS §1.10 describes: a wrong answer that agrees with
 * everything. `recordMovement` posts first and writes second, so the repository is what
 * normally makes this true; this is the floor under a path that skipped it.
 *
 * THE RULE IS NOT "EVERY MOVEMENT NAMES AN ENTRY", AND WRITING IT THAT WAY WOULD REFUSE A
 * REAL TRANSACTION. A movement that moved no MONEY has nothing to post: a free sample
 * taken in at nil, or an issue out of a pool that is worth nothing because every receipt
 * into it was free. Invariant 6 in domain/inventory/types.ts admits both on purpose —
 * "QUANTITY CAN EXIST WITHOUT VALUE" — and a journal entry of two zero lines is refused by
 * ledger invariant 5, so there is no entry for such a movement to name. It is not a hole
 * in the reconciliation either: nothing moved, so nothing had to.
 *
 * SO THE RULE IS: A MOVEMENT MAY GO UNPOSTED ONLY IF IT MOVED NOTHING. And this table can
 * prove that for an INWARD movement and cannot for an outward one, because an inward
 * movement STATES its cost in a column and an outward one is VALUED by the strategy —
 * which is 0019's central decision and the one thing it refuses to store. So:
 *
 *   THE TRIGGER SAYS THE HALF THE ROW CAN PROVE. `IFNULL(NEW.cost, '0.00') <> '0.00'` is
 *   true for exactly the inward movements that cost something, and those must name an
 *   entry. An outward row carries `cost IS NULL` by the biconditional CHECK 0019 wrote,
 *   so `IFNULL` reads it as nothing moved and the trigger stands aside.
 *
 *   THE REPOSITORY SAYS THE OTHER HALF, with the figure the strategy produced in hand:
 *   every movement whose valued cost is non-zero posts, whichever way it went. That is
 *   where cost of goods sold is guarded, and it has no floor under it — stated here
 *   rather than glossed, because a rule with no floor that reads as though it has one is
 *   worse than a rule that says where it stops.
 *
 * WHAT WOULD CLOSE IT is not a cleverer trigger: it is the derived value being in the
 * table, which 0019 spends its whole header refusing for reasons that have not changed.
 *
 * ===========================================================================
 * THE THREE SQLITE FACTS THIS FILE DEPENDS ON, ALL MEASURED ON 3.53.4
 * ===========================================================================
 *
 * 1. `ADD COLUMN ... REFERENCES` MUST DEFAULT TO NULL. The documentation says so and the
 *    measurement agrees, but the interesting half is what happens when the rule is
 *    broken: `ADD COLUMN entry_id TEXT NOT NULL DEFAULT 'ghost' REFERENCES
 *    journal_entries(id)` is ACCEPTED. It does not fail at migration time. What then
 *    fails is every insert that TAKES the default — with `FOREIGN KEY constraint failed`
 *    and nothing naming the column — while an insert that states a real entry succeeds.
 *    So the table is not quite "unwritable forever": it is writable only through callers
 *    that happen to supply the column, which is worse, because the bug is invisible until
 *    the one caller that does not.
 *
 *    Hence: nullable column, and the NOT NULL said by a trigger instead.
 *
 * 2. A `WHEN` THAT EVALUATES TO NULL DOES NOT FIRE, so the guard is `NEW.entry_id IS
 *    NULL` and never `NEW.entry_id = NULL`. Re-measured: the `=` spelling admits the null
 *    row silently, which is the whole failure this trigger exists to prevent, wearing the
 *    trigger's name. 0019 records the same trap in its `IS NOT 1` form.
 *
 * 3. `ALTER TABLE ... ADD COLUMN` DOES NOT RE-PARSE THE SCHEMA'S TRIGGERS. Only `RENAME
 *    TO` does. `stock_ledger` carries `stock_ledger_item_tracked`, which reads `items`,
 *    and `items` carries `items_no_untrack_with_movements`, which reads `stock_ledger` —
 *    so a REBUILD of either table here would be 0010's `REBUILD_TAIL` trap on two tables
 *    at once. Measured, so that this migration could be certain it was not rebuilding
 *    anything: adding a column to a table that a foreign trigger reads succeeds and
 *    leaves the trigger in place.
 *
 * ===========================================================================
 * WHAT IT DOES NOT DO: BACKFILL
 * ===========================================================================
 *
 * A row written before this migration keeps a NULL `entry_id`, and there is no `UPDATE`
 * here that fills one in. 0014 backfilled a due date and its header argues for when that
 * is worth doing; the argument does not carry across. A due date is a RECONSTRUCTION from
 * facts the file still holds. An entry is not a value to reconstruct — it is a row in
 * `journal_entries` that would have to be MINTED, with an entry number from a sequence, a
 * period, a posting timestamp and two balanced lines against accounts resolved through the
 * role map, all inside a migration that runs with foreign keys off and no repository
 * available. A migration that posts to the ledger is a migration that can produce a
 * trial balance nobody entered.
 *
 * WHAT MAKES THAT ACCEPTABLE rather than a hole: `stock_ledger` arrived in 0019, in this
 * same phase, and no build carrying it has shipped. The set of rows this migration leaves
 * unposted is empty in every file that exists. Said plainly rather than assumed, because
 * the day it stops being true the answer is a repair action a user runs and can see —
 * not a migration.
 *
 * NO UNIQUE INDEX ON `entry_id`, deliberately. One movement posts one entry today, so a
 * unique index would hold. It would also foreclose the arrangement a document has to
 * reach for: an invoice moving five items should post ONE entry carrying five cost lines,
 * and five rows would then legitimately name it. A constraint that is true today and
 * wrong for the next feature is a constraint that gets deleted under pressure, which is a
 * worse outcome than not writing it.
 */

import type { Migration } from '../migrate'

export const m0022: Migration = {
  id: '0022',
  name: 'stock_ledger_entry',

  up(db) {
    db.exec(`ALTER TABLE stock_ledger ADD COLUMN entry_id TEXT REFERENCES journal_entries(id)`)

    /* ON DELETE is absent, which means RESTRICT: an entry a movement names cannot be
     * deleted. Nothing deletes an entry — `journal_entries_no_delete` in 0004 refuses it
     * outright — so this is a second lock on a door that is already bolted, and it costs
     * nothing to say twice. What it must NOT be is SET NULL, which would turn a deletion
     * somewhere else into a silent violation of the rule below. */

    db.exec(
      `CREATE TRIGGER stock_ledger_posted
       BEFORE INSERT ON stock_ledger
       WHEN NEW.entry_id IS NULL AND IFNULL(NEW.cost, '0.00') <> '0.00'
       BEGIN
         SELECT RAISE(ABORT, 'MOVEMENT_NOT_POSTED');
       END`,
    )

    /* `IFNULL(NEW.cost, '0.00')` and never a bare `NEW.cost <> '0.00'`: an outward row
     * carries a NULL cost, `NULL <> '0.00'` is NULL, and a `WHEN` that evaluates to NULL
     * does not fire — so the bare spelling would have had the same effect here by
     * ACCIDENT, and the next person to add an inward kind with a nullable cost would have
     * inherited a rule nobody had decided. The `IFNULL` says "an outward row is not this
     * trigger's business" out loud. */

    /* The drill-through: given an entry, which movements posted it. The other direction
     * is the primary key. */
    db.exec(`CREATE INDEX stock_ledger_entry ON stock_ledger (entry_id)`)
  },

  down(db) {
    db.exec(`DROP INDEX stock_ledger_entry`)
    db.exec(`DROP TRIGGER stock_ledger_posted`)
    db.exec(`ALTER TABLE stock_ledger DROP COLUMN entry_id`)

    /* The trigger goes before the column, because a trigger naming a dropped column is
     * what `DROP COLUMN` genuinely refuses — 0017 measured that a CHECK naming it does
     * NOT refuse, which is the surprising half and the reason the two are not the same
     * precaution. */
  },
}
