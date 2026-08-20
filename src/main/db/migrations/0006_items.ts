/*
 * 0006 — units_of_measure and items.
 *
 * ---------------------------------------------------------------------------
 * WHAT GOES ON A LINE, AND WHAT DOES NOT
 *
 * Every column on `items` is a DEFAULT for a document line, never something the line
 * looks up afterwards. A document line stores its own description, quantity, price and
 * rate (see domain/documents/types.ts, rule 4 and the note beside `DocumentLine`), so
 * renaming an item or repricing it cannot rewrite an invoice that has already been
 * issued. An item is where a line STARTS.
 *
 * This is why there is no rule below tying an item to the documents that name it, and
 * why an item's price may be changed freely at any time. The invoice is the record; the
 * item is the convenience.
 *
 * ---------------------------------------------------------------------------
 * CUSTOM UNITS ARE THE POINT
 *
 * A business measures in what it measures in — bags, bundles, dozens — and being made to
 * pick from a fixed list is the first thing that makes software feel foreign. India's
 * UQC is a closed set, but it is a FILING concern: `regime_code` maps a company's own
 * unit onto it when a return is prepared, and the two are separate columns so that a
 * company invoicing in `BAGS` keeps saying `BAGS` on its own paperwork.
 *
 * ---------------------------------------------------------------------------
 * A UNIT'S CODE IS ITS IDENTITY, AND UPPER CASE IS A DATABASE RULE
 *
 * There is no surrogate id. The code is what the user types, what prints on the line,
 * and what an item refers to; a table of ids would mean a join to answer "what does this
 * line say".
 *
 * That makes the primary key the thing that has to be right, and SQLite's TEXT primary
 * key is CASE-SENSITIVE. Measured, not read: `KG` and `kg` are both admitted into a bare
 * `TEXT PRIMARY KEY`, so a business ends up with two units that print differently, sum
 * separately, and look like a typo to everyone but the software. The CHECK below closes
 * it and the repository normalises before it writes, so the two never meet.
 *
 * Measured and worth knowing: SQLite's `upper()` is ASCII-only without ICU, so this
 * CHECK admits a non-ASCII lower-case code such as `кг`. The repository's normalisation
 * is JavaScript's `toUpperCase()`, which is not ASCII-only, so nothing that goes through
 * it produces one — the CHECK is the floor under that, not a replacement for it.
 *
 * The foreign key from `items.unit_code` is case-sensitive for the same reason, and that
 * is not a detail: an item written with `kg` against a unit stored as `KG` is refused
 * outright with `FOREIGN KEY constraint failed`. Measured. Normalising the item's unit
 * code before writing it is what makes the reference resolve at all.
 *
 * ---------------------------------------------------------------------------
 * MONEY AND RATES ARE DIFFERENT SHAPES
 *
 * `sale_price` and `purchase_price` carry the same GLOB as the ledger's amounts (0004):
 * exactly two decimal places, no sign, no exponent. That CHECK is load-bearing rather
 * than cosmetic — any SQL sum over a money column strips the decimal point and adds
 * integer paise, which is exact only because every stored amount has exactly two places
 * and no sign.
 *
 * `tax_rate_pct` is a RATE and carries three places, because India has a slab that
 * halves into three: 0.25% on rough diamonds splits into CGST 0.125% and SGST 0.125%. At
 * two places the invoice would print a rate the tax was never computed from
 * (CONVENTIONS §3, and the note beside `SCALE.rate` in domain/money/scale.ts).
 *
 * Measured rather than reasoned about, on a scratch database. `[0-9]*.[0-9][0-9][0-9]`
 * accepts '18.000', '0.125' and '1234567.890'; it refuses '18.00', '18', '0.1250',
 * '-1.000', '.125', ' 18.000' and ''. It ALSO accepts '1..000' and '18.000.000', because
 * GLOB's `*` is any run of characters and not a run of digits — the same hole the money
 * GLOB in 0004 has. Both CHECKs constrain the tail and the first character, which is
 * exactly what the integer-paise arithmetic needs; they are a floor under a code path
 * that skipped `toRateString`, not a parser. `parseRate` is the parser.
 */

import type { Migration } from '../migrate'

/* Exactly two decimal places, no sign, no exponent — 0004's shape, unchanged, because
 * the balance trigger's integer arithmetic depends on every money column having it. */
const MONEY_SHAPE = `GLOB '[0-9]*.[0-9][0-9]'`

/* Three places. A rate is not money and the extra place is not decoration: see above. */
const RATE_SHAPE = `GLOB '[0-9]*.[0-9][0-9][0-9]'`

export const m0006: Migration = {
  id: '0006',
  name: 'items',

  up(db) {
    db.exec(
      `CREATE TABLE units_of_measure (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        decimal_places INTEGER NOT NULL CHECK (decimal_places BETWEEN 0 AND 3),
        regime_code TEXT,
        is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (code = upper(code)),
        CHECK (code = trim(code)),
        CHECK (length(trim(code)) > 0),
        CHECK (length(trim(name)) > 0)
      ) STRICT`,
    )

    /*
     * Three CHECKs on the code rather than one, so that a violation says which rule it
     * broke. They guard the same failure from three sides: `kg`, ` KG` and `KG ` are all
     * a second row that prints as the first one and totals separately from it.
     *
     * `decimal_places` runs 0 to 3. Storage scale is 3dp everywhere (CONVENTIONS §3) and
     * this is narrower: it is about the unit rather than the column. Half a box is not a
     * quantity, and a screen that accepts one produces an invoice line nobody can pick.
     *
     * It has no column DEFAULT. The repository's is 3 — the storage scale, so a unit
     * imposes nothing extra until somebody says it should — and a default written in two
     * places is two places to disagree.
     */

    db.exec(
      `CREATE TABLE items (
        id TEXT PRIMARY KEY,
        code TEXT,
        name TEXT NOT NULL,
        description TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('goods', 'service')),
        unit_code TEXT REFERENCES units_of_measure(code) ON DELETE RESTRICT,
        classification_code TEXT,
        tax_rate_pct TEXT,
        sale_price TEXT,
        purchase_price TEXT,
        is_charge INTEGER NOT NULL DEFAULT 0 CHECK (is_charge IN (0, 1)),
        is_sold INTEGER NOT NULL DEFAULT 0 CHECK (is_sold IN (0, 1)),
        is_purchased INTEGER NOT NULL DEFAULT 0 CHECK (is_purchased IN (0, 1)),
        sales_account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
        purchase_account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
        is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (length(trim(name)) > 0),
        CHECK (is_sold = 1 OR is_purchased = 1),
        CHECK (code IS NULL OR length(trim(code)) > 0),
        CHECK (sale_price IS NULL OR sale_price ${MONEY_SHAPE}),
        CHECK (purchase_price IS NULL OR purchase_price ${MONEY_SHAPE}),
        CHECK (tax_rate_pct IS NULL OR tax_rate_pct ${RATE_SHAPE})
      ) STRICT`,
    )

    /*
     * `is_sold = 1 OR is_purchased = 1` is a party's two flags in another table and for
     * the same reason: a record that is neither cannot appear in any picker in the
     * application and cannot reach a document line, which makes it a row that exists
     * only to confuse whoever finds it.
     *
     * A blank code is refused rather than stored, because the partial index below treats
     * '' as a value: two items that both "have no SKU" written as '' would collide with
     * each other and be reported as a duplicate code, which is the opposite of true.
     * NULL is how an item says it has no code.
     */

    /*
     * ON DELETE RESTRICT on all three references, and the alternatives were considered.
     *
     * SET NULL on `unit_code` would leave items measured in nothing the moment a unit was
     * tidied away, and the next invoice line would print a bare quantity.
     *
     * SET NULL on either account is worse, because null is not "unknown" here — it means
     * "use the account the document kind implies". An item quietly reverting to the
     * default posts its value somewhere other than every invoice raised before it did,
     * and no report says when that happened. That is silent corruption, which is exactly
     * what this codebase refuses to make recoverable-looking.
     *
     * RESTRICT instead: the delete is refused, the repository says which record is in the
     * way, and somebody makes a decision.
     */

    /*
     * Names are unique ignoring case. Two rows reading `Ball bearing 6203` and `BALL
     * BEARING 6203` in a picker is an invoice line raised against the wrong one, priced
     * from the wrong one, and taxed at the wrong rate — and no report would ever show it.
     */
    db.exec(`CREATE UNIQUE INDEX items_name_unique ON items (name COLLATE NOCASE)`)

    /*
     * The business's own SKU, unique ignoring case among the items that have one.
     *
     * Read the note on `parties_registration_unique` in 0005: what makes "among the items
     * that have one" work is that NULLs do not collide in a unique index, NOT the `WHERE`
     * clause, which only keeps those rows out of the index. Deleting the clause changes
     * nothing observable and a mutation that does so survives on purpose.
     */
    db.exec(
      `CREATE UNIQUE INDEX items_code_unique
       ON items (code COLLATE NOCASE)
       WHERE code IS NOT NULL`,
    )

    db.exec(`CREATE INDEX items_unit ON items (unit_code)`)
    db.exec(`CREATE INDEX items_sold ON items (is_sold) WHERE is_sold = 1`)
    db.exec(`CREATE INDEX items_purchased ON items (is_purchased) WHERE is_purchased = 1`)

    /*
     * ---------------------------------------------------------------------------
     * FIVE RULES CONSIDERED HERE AND DELIBERATELY NOT WRITTEN
     *
     * NO TRIGGER IS WRITTEN BY THIS MIGRATION AT ALL, which is the first time that has
     * been true of a table-creating migration in this codebase, so it needs saying
     * rather than passing unremarked. The test is 0004's and 0005's: a rule earns a
     * trigger when breaking it corrupts a report silently. Every rule below either
     * throws where it matters or is not a rule.
     *
     * AN ITEM MAY NOT NAME A GROUP ACCOUNT — as a trigger. A group totals its children
     * and holds no figures of its own, so an item defaulting a line to one looks like
     * exactly the kind of thing that earns a trigger. It does not, because 0004's
     * `journal_lines_not_group` already refuses the posting: the failure is an abort at
     * issue time, not a figure counted twice. What an earlier refusal buys is a better
     * sentence at a better moment, and a sentence is the repository's job —
     * `ITEM_ACCOUNT_IS_GROUP` in items.ts.
     *
     * It would also not catch the case it is imagined for. An account that is a leaf when
     * the item is saved may become a group afterwards, and that change is made on
     * `accounts`; catching it would mean extending `accounts_no_group_with_postings` to
     * refuse a chart reorganisation on account of an item nothing has yet posted through.
     * That is a legitimate operation being blocked to prevent a posting that is already
     * blocked.
     *
     * AN UPPER BOUND ON tax_rate_pct. Refused twice over. It cannot be written honestly:
     * `tax_rate_pct <= '100.000'` is a string comparison and lexicographic order puts
     * '18.000' ABOVE '100.000' (measured), while a numeric comparison is the REAL
     * coercion this whole schema exists to avoid. And the bound itself is wrong — GST
     * compensation cess runs far above 100% on some goods, so the rule would have to be
     * migrated away, and a migration is never edited.
     *
     * A UNIQUE NAME FOR A UNIT. Two units both called `Kilograms`, one coded `KG` and one
     * `KGS`. Unlike two identically named parties, these are visibly different everywhere
     * they appear: the code is the identity, it prints on the line, and a picker shows it
     * beside the name. The rule would mostly fire on the case it should serve — importing
     * the unit list a business already keeps.
     *
     * AN ARCHIVED UNIT TAKES NO NEW ITEM — as a trigger. The archived-account decision in
     * 0004 and the archived-party decision in 0005, arriving at the same answer for the
     * same reason: archiving is a stated intention, not a correctness rule, and enforcing
     * it in the database makes old records unamendable the moment something they name is
     * archived. The repository refuses it and says why.
     *
     * ANYTHING THAT VALIDATES AN HSN OR SAC. Not a rule this file can hold. Which
     * classification codes exist, and what shape they take, is the regime's business, and
     * `db/` may not name a concrete regime (CONVENTIONS §1.6). The same line parties.ts
     * draws at a GSTIN, drawn again here.
     */
  },

  down(db) {
    /* `items` first: it holds the reference to `units_of_measure`, and dropping a parent
     * out from under a live foreign key is how a rollback leaves a database that will not
     * migrate forward again. Indexes go with their table. */
    db.exec(`DROP TABLE items`)
    db.exec(`DROP TABLE units_of_measure`)
  },
}
