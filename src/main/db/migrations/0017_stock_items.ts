/*
 * 0017 — an item may keep a quantity balance.
 *
 * Two columns on `items`, and the whole of this migration is the argument for why the
 * first of them is not `kind`.
 *
 * ---------------------------------------------------------------------------
 * `kind` CLASSIFIES. `is_stock_tracked` SAYS WHETHER A BALANCE IS KEPT
 *
 * 0006 gave an item `kind IN ('goods', 'service')`, and it answers exactly one question:
 * which classification scheme applies. Goods carry an HSN, a service carries a SAC, and
 * the regime decides everything downstream of that. It is a FILING fact.
 *
 * Phase 4 needs an orthogonal one, and the two are not the same question wearing
 * different words:
 *
 *   PLENTY OF GOODS ARE NOT STOCKED. A workshop that buys consumables — cleaning
 *   materials, drill bits, packing tape — is buying goods with an HSN, charging tax on
 *   them where it sells them on, and has no intention of counting them. Under `kind`
 *   alone every one of those becomes a stock item that must be received before it can be
 *   issued, and a business that never wanted a stock register is told its purchase bill
 *   cannot be entered until it enters an opening stock it does not have.
 *
 *   AND A CHARGE IS GOODS-SHAPED AND HOLDS NOTHING. Freight raised as an item (0006's
 *   `is_charge`) is a line on an invoice with a classification code and no quantity that
 *   anyone counts.
 *
 * So the two are separate columns with no rule tying them in the direction people expect.
 * There is exactly ONE rule between them, and it goes the other way — see below.
 *
 * ---------------------------------------------------------------------------
 * A SERVICE MAY NOT BE STOCK-TRACKED, AND IT IS A CHECK RATHER THAN A REPOSITORY RULE
 *
 * The question this migration was asked to answer, so here is the answer with its
 * reasoning rather than a constraint on its own.
 *
 * IT IS A DATABASE RULE BECAUSE BREAKING IT CORRUPTS A REPORT INSTEAD OF THROWING. That
 * is this codebase's test for a constraint (0004's header, 0006's list of five rules
 * deliberately NOT written). A service carrying stock gets rows in `stock_ledger`; the
 * stock valuation report then carries a figure for something that has no stock, and the
 * general ledger's stock account never received it. Both pages still total. Nothing
 * disagrees with anything, which is the failure CONVENTIONS §1.10 says does not get
 * found.
 *
 * IT IS A CHECK RATHER THAN A TRIGGER because it is a statement about two columns of one
 * row and needs no lookup. A trigger would be the same rule spelled at greater length,
 * in two copies (INSERT and UPDATE), with the second one available to be forgotten.
 *
 * AND A CHECK ANSWERS BOTH DIRECTIONS AT ONCE, which is the half that matters. A
 * repository rule would be written on the path that turns stock tracking ON, because
 * that is the path somebody is thinking about while writing it. `updateItem` can also
 * change `kind`, and the rule nobody writes is the one that refuses turning a
 * stock-tracked item INTO a service — which leaves exactly the state the rule exists to
 * prevent, reached from the side nobody was watching. A CHECK is re-evaluated on every
 * write to the row, so both directions are the same sentence. CONVENTIONS §3 makes this
 * argument about `due_date` and it is the same argument.
 *
 * MEASURED, on a scratch database, because SQLite's documentation is not clear that
 * `ALTER TABLE ... ADD COLUMN` accepts a CHECK naming a column OTHER than the one being
 * added. It does, and the constraint is enforced on INSERT and on UPDATE alike: turning
 * a tracked item into a service is refused, and so is inserting a tracked service.
 * Existing rows are not re-checked, which is exactly right — the default below makes
 * every one of them `0`.
 *
 * ---------------------------------------------------------------------------
 * A REORDER LEVEL BELONGS TO AN ITEM THAT KEEPS A BALANCE
 *
 * `reorder_level` is nullable — most stock items never have one set, and Phase 4.2's
 * re-order report reads it. It is a QUANTITY and carries three places, the same shape
 * every quantity in this schema carries (CONVENTIONS §3).
 *
 * Its CHECK also refuses a reorder level on an item that keeps no balance, and that is
 * not tidiness. The re-order report asks "is what is on hand below this level"; an item
 * with no stock register has nothing on hand, so it is below every level ever set, and it
 * would sit on the re-order report forever telling somebody to buy something they do not
 * count. A row that is always wrong and never obviously wrong.
 *
 * Not a biconditional, deliberately: a stock item with no reorder level is the ordinary
 * case, so only one direction is a rule. Compare 0014's `due_date`, where both
 * directions are.
 *
 * ---------------------------------------------------------------------------
 * NO TABLE REBUILD, AND THE TRAP THAT SAYS WHY IT WOULD BE ONE
 *
 * `ADD COLUMN` takes both of these because neither carries a REFERENCES clause. 0005
 * measured what happens when one does: SQLite ACCEPTS
 * `ADD COLUMN ... NOT NULL DEFAULT 'x' REFERENCES other(id)` even though its own
 * documentation says it does not, and the table is then unwritable forever. The rule
 * that keeps this migration safe is that a NOT NULL added column has a non-null default
 * and NO foreign key.
 *
 * ---------------------------------------------------------------------------
 * THE `down` HAS AN ORDERING DEPENDENCY ON 0019, AND THE RUNNER SUPPLIES IT
 *
 * MEASURED, and it contradicts a plain reading of the documentation twice over:
 *
 *   `ALTER TABLE ... DROP COLUMN` SUCCEEDS HERE EVEN THOUGH A CHECK CONSTRAINT NAMES THE
 *   COLUMN. SQLite's documentation lists a CHECK as one of the things that make a column
 *   undroppable; on 3.53.4 the column and its CHECK are both removed and the statement
 *   returns cleanly. Verified against a scratch database and again by rolling the real
 *   registry back to nothing in this folder's test.
 *
 *   IT DOES NOT SUCCEED while a TRIGGER ON ANOTHER TABLE reads the column, which is a
 *   real constraint rather than a documentation quirk: 0019 puts a trigger on
 *   `stock_ledger` that reads `items.is_stock_tracked`, and dropping the column out from
 *   under it fails with `error in trigger ... no such column`. The rollback runner
 *   reverts newest first, so 0019's `down` has already dropped that table and its
 *   triggers by the time this one runs. There is a test that rolls the whole registry
 *   back rather than this migration alone, because reverting 0017 on its own is a thing
 *   the runner will not do and a test that did it would be testing a state no file
 *   reaches.
 *
 * The partial index goes first for the ordinary version of the same rule: a column that
 * is indexed cannot be dropped, and that one the documentation does mean.
 */

import type { Migration } from '../migrate'

/* Exactly three decimal places, no sign, no exponent — 0006's `RATE_SHAPE` by shape and
 * `SCALE.quantity` by meaning. Its known holes ('1..000' passes, because GLOB's `*` is
 * any run of characters) are 0006's holes, unchanged: this is a floor under a path that
 * skipped `toQuantityString`, not a parser. `parseQuantity` is the parser. */
const QUANTITY_SHAPE = `GLOB '[0-9]*.[0-9][0-9][0-9]'`

export const m0017: Migration = {
  id: '0017',
  name: 'stock_items',

  up(db) {
    db.exec(
      `ALTER TABLE items ADD COLUMN is_stock_tracked INTEGER NOT NULL DEFAULT 0
       CHECK (is_stock_tracked IN (0, 1) AND (is_stock_tracked = 0 OR kind = 'goods'))`,
    )

    /*
     * DEFAULT 0, so every item in every existing company file keeps no balance and
     * nothing that has already been entered changes meaning. The opposite default would
     * make every consumable a business has ever bought into a stock item overnight, and
     * the first purchase bill entered afterwards would be refused for want of an opening
     * stock nobody has.
     *
     * This is the only sense in which 0017 is not like 0014: there is no backfill and no
     * reconstruction, because "does this business count these" is not derivable from
     * anything in the file. It is a decision somebody makes, item by item.
     */

    db.exec(
      `ALTER TABLE items ADD COLUMN reorder_level TEXT
       CHECK (reorder_level IS NULL
              OR (reorder_level ${QUANTITY_SHAPE} AND is_stock_tracked = 1))`,
    )

    /* Added second, and it names the column added first. The order is load-bearing:
     * SQLite parses the CHECK when the column is added, so the reverse order fails with
     * `no such column`. */

    db.exec(
      `CREATE INDEX items_stock_tracked ON items (is_stock_tracked) WHERE is_stock_tracked = 1`,
    )

    /* Partial, like 0006's `items_sold` and `items_purchased`, and for the same reason:
     * every query that reads it wants the `1` side — the stock item picker, the
     * valuation report and the re-order report — and a business's stock items are a
     * small part of its item list. */
  },

  down(db) {
    db.exec(`DROP INDEX items_stock_tracked`)
    db.exec(`ALTER TABLE items DROP COLUMN reorder_level`)
    db.exec(`ALTER TABLE items DROP COLUMN is_stock_tracked`)
  },
}
