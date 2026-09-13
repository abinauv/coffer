/*
 * 0018 — warehouses.
 *
 * Where stock is. One small table, and three decisions in it that have each been made
 * differently somewhere else in this schema on purpose.
 *
 * ---------------------------------------------------------------------------
 * A SURROGATE ID, WHERE A UNIT HAS NONE
 *
 * 0006 gave `units_of_measure` no id at all: the code IS the identity, because the code
 * is what a person types on a line and what prints on the invoice. A warehouse is the
 * other case. Its code is an internal handle — `MAIN`, `WH-2`, `GODOWN-A` — nothing
 * prints it on a customer's paperwork, and a business that reorganises its premises
 * renames one without meaning to rewrite every movement ever recorded against it. So the
 * id is the identity, the code is a label, and the code may change.
 *
 * That is the whole reason `updateWarehouse` in db/repos/stock.ts permits a code change
 * while `updateUnit` refuses one. Two tables, two answers, one question asked properly of
 * each.
 *
 * ---------------------------------------------------------------------------
 * UNIQUE IGNORING CASE, AND THE HALF OF THAT RULE THAT IS NOT IN THIS FILE
 *
 * `warehouses_code_unique` and `warehouses_name_unique` are both `COLLATE NOCASE`, for
 * 0006's reason: two rows reading `Main store` and `MAIN STORE` in a picker is stock
 * issued out of the wrong one, and no report would ever show it.
 *
 * MEASURED, AND IT IS A BUG THIS PROJECT HAS ALREADY SHIPPED: a NOCASE unique index and a
 * case-SENSITIVE comparison do not agree. `SELECT id FROM warehouses WHERE code = 'main'`
 * returns nothing while `MAIN` is present, and the very next INSERT is then refused by
 * the index with `UNIQUE constraint failed`. The user sees a raw constraint message
 * instead of "MAIN is already a warehouse in these books", and a repository check written
 * that way is not merely useless, it is unreachable. `assertCodeFree` in
 * db/repos/stock.ts compares `COLLATE NOCASE` for exactly this, and the test for it looks
 * up a lower-cased code rather than trusting that the two spellings agree.
 *
 * The code is NOT upper-cased the way a unit's is. 0006 upper-cases because a unit's code
 * is its primary key and SQLite's TEXT primary key is case-sensitive, so `kg` and `KG`
 * would both be admitted; here the NOCASE index is what refuses the second one, and
 * rewriting what somebody typed buys nothing.
 *
 * ---------------------------------------------------------------------------
 * NOT NULL AS WELL AS THE BLANK CHECK, WHICH IS NOT BELT AND BRACES
 *
 * `CHECK (length(trim(code)) > 0)` says nothing whatever about a missing code. A CHECK
 * whose expression evaluates to NULL PASSES — NULL is "no opinion", not false — so
 * `length(trim(NULL)) > 0` is NULL and the row goes in. Every required column here
 * carries `NOT NULL` beside its blank check, and the pair is one rule written in the two
 * halves SQLite needs to hear it in.
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS SEEDED HERE, AND SOMETHING HAS TO BE SEEDED SOMEWHERE
 *
 * A stock movement names a warehouse and the column is NOT NULL, so a company file with
 * no warehouse cannot record stock at all. That is precisely the shape of the bug 0012
 * found in `bootstrap.ts`: nothing created a numbering series, `defaultSeriesFor`
 * answered null for every kind, and issuing any document from the app failed against a
 * company file while every test passed, because every test created its own series first.
 *
 * A MIGRATION IS THE WRONG PLACE FOR IT even so. 0011 makes the argument for the company
 * profile — a migration cannot invent a business's own facts — and it applies with less
 * force here (`MAIN` / `Main store` is a defensible guess) but it applies. The stronger
 * reason is that a seed in a migration runs on EVERY existing company file, including the
 * ones belonging to businesses that keep no stock, and it would put a warehouse in front
 * of people who have no use for one and cannot delete it once a movement exists.
 *
 * So it is seeded where the chart of accounts and the numbering series are seeded, by
 * `setUpBooks`, when a company is created. `seedDefaultWarehouse` in db/repos/stock.ts is
 * that function, written in the same shape as `seedDefaultSeries` — it does nothing at
 * all if the file already has a warehouse — and the one line that calls it belongs in
 * `bootstrap.ts`, which this batch does not own. Until that line exists,
 * `defaultWarehouseId` refuses with `WAREHOUSE_NOT_CONFIGURED` and says what to do,
 * rather than letting a foreign key failure be the message.
 *
 * ---------------------------------------------------------------------------
 * FOUR RULES CONSIDERED AND NOT WRITTEN
 *
 * NO TRIGGER AT ALL, which 0006 was the first table-creating migration to say and this is
 * the second. The test is unchanged: a rule earns a trigger when breaking it corrupts a
 * report silently.
 *
 * AN ARCHIVED WAREHOUSE TAKES NO NEW MOVEMENT — as a trigger. The archived-account
 * decision in 0004, the archived-party decision in 0005 and the archived-unit decision in
 * 0006, arriving at the same answer for the third time: archiving is a stated intention
 * rather than a correctness rule, and a movement into an archived warehouse still
 * produces correct reports. Enforcing it here would also make it impossible to correct a
 * historical movement in a warehouse that has since been closed. The repository refuses
 * it and says why (`WAREHOUSE_ARCHIVED`).
 *
 * A WAREHOUSE HOLDING STOCK MAY NOT BE ARCHIVED — as a trigger. This one is genuinely
 * about a report: archiving a warehouse that still holds goods would drop its value off
 * every stock page while the balance sheet kept it. It is still not a trigger, because
 * the database cannot answer the question. "Holds stock" is a running total over the
 * movements, and under moving average the value side of that total is not even stored —
 * see 0019. A trigger that could only check the quantity would refuse a warehouse holding
 * nothing but a rounding remainder and permit one holding value at zero quantity, which
 * is a rule that is wrong in both directions. The repository asks the domain and refuses
 * (`WAREHOUSE_IN_USE`).
 *
 * A DEFAULT WAREHOUSE FLAG, the way `numbering_series.is_default` marks one series per
 * kind. Declined: `is_default` exists there because a document kind must resolve to
 * exactly one series with no user involved, and a partial unique index is what makes "at
 * most one" true. A stock movement always knows where it happened — a receipt happens at
 * the place the goods arrived — so a default is a convenience for a single-warehouse
 * business, not a resolution rule. `defaultWarehouseId` answers it with "the only one
 * there is", which is right for that business and correctly refuses to guess for any
 * other.
 *
 * A LOCATION, AN ADDRESS OR A JURISDICTION on the row. A warehouse in another state is a
 * different place of supply and changes the tax, which sounds like it belongs here and
 * does not: `computeTax` takes the supplier from `company_profile`, and a business with
 * premises in two states has two registrations and — under this schema — two company
 * files. Adding a jurisdiction column now would put a second, quieter answer to "where is
 * the supplier" in the database, and the two would disagree the day somebody used it.
 */

import type { Migration } from '../migrate'

export const m0018: Migration = {
  id: '0018',
  name: 'warehouses',

  up(db) {
    db.exec(
      `CREATE TABLE warehouses (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (length(trim(code)) > 0),
        CHECK (code = trim(code)),
        CHECK (length(trim(name)) > 0),
        CHECK (description IS NULL OR length(trim(description)) > 0)
      ) STRICT`,
    )

    /*
     * `code = trim(code)` beside the blank check, as 0006 does for a unit: ` MAIN` and
     * `MAIN ` are a second row that prints as the first one and totals separately from
     * it, and the NOCASE index below cannot see the difference between them because
     * NOCASE folds case and not whitespace.
     *
     * `description` is refused as blank rather than stored as '', for the reason 0006
     * refuses a blank item code: two ways to say "nothing here" is one too many, and a
     * screen that shows a description shows an empty line for one of them.
     */

    db.exec(`CREATE UNIQUE INDEX warehouses_code_unique ON warehouses (code COLLATE NOCASE)`)
    db.exec(`CREATE UNIQUE INDEX warehouses_name_unique ON warehouses (name COLLATE NOCASE)`)

    /*
     * BOTH are unique, where 0006 makes an item's name unique and declines to make a
     * unit's name unique. The difference is what a picker shows: a unit picker shows
     * `KG — Kilograms` and the code disambiguates two rows with one name, so the rule
     * would fire mostly on the case it should serve. A warehouse picker shows the name,
     * because the name is what somebody who works there calls it, and two warehouses both
     * called `Main store` is stock issued out of the wrong one.
     */

    db.exec(`CREATE INDEX warehouses_active ON warehouses (is_archived) WHERE is_archived = 0`)
  },

  down(db) {
    /* Indexes go with the table. Nothing references `warehouses` yet — 0019 is what adds
     * the reference — so there is no parent to drop out from under a live foreign key. */
    db.exec(`DROP TABLE warehouses`)
  },
}
