/*
 * 0005 — parties, and `journal_lines.party_id`.
 *
 * Who a document is with. The first migration of Phase 2, and the first one to add a
 * column to a table an earlier migration created.
 *
 * ---------------------------------------------------------------------------
 * ONE TABLE, TWO ROLES — NOT TWO TABLES
 *
 * A customer and a vendor are the same table with two flags, because in a small business
 * they are very often the same business. You buy transport from the firm you sell to;
 * your landlord buys from you. Two tables means two records for one company, two
 * outstanding balances, two opening figures, and a set-off nobody reconciles.
 *
 * `is_customer` and `is_vendor` are what a party *may* be, not what it has done. A
 * customer who has never bought is still a customer, and the CHECK below only refuses a
 * party that is neither — a record with no purpose in a set of books.
 *
 * ---------------------------------------------------------------------------
 * WHY A PARTY IS NOT AN ACCOUNT
 *
 * Tally gives every party its own ledger account under Sundry Debtors. Coffer does not,
 * and the reason is the balance sheet: a chart of accounts with four hundred customers
 * in it is not a chart anybody can read, and a balance sheet that lists each of them is
 * not a balance sheet. Reports already drop nothing that has been posted to, so every
 * one of those accounts would appear.
 *
 * Instead there is one control account, and `journal_lines.party_id` says whose money a
 * line is. A party's balance is then a sum over lines — the same shape as every other
 * balance in this codebase, and subject to the same invariant that nothing is stored
 * (CONVENTIONS §1). An aged receivables report and the balance sheet cannot disagree,
 * because they are one sum with a different grouping.
 *
 * ---------------------------------------------------------------------------
 * THE TRIGGER, AND WHY IT IS ONE
 *
 * `journal_lines_party_on_control` refuses a line that posts to the accounts mapped to
 * `accounts-receivable` or `accounts-payable` without naming a party. Money on the
 * balance sheet that is owed by nobody is not an error anyone sees — it is a control
 * account that stops agreeing with the sum of the party balances beneath it, silently,
 * from that day on. That is this codebase's test for what becomes a trigger.
 *
 * It reads `account_roles` live rather than pinning an account id, so remapping the role
 * moves the rule with it. Measured, not assumed: a line naming the account that used to
 * be receivables no longer needs a party, and one naming the account that now is, does.
 *
 * The lookup is by role and not by account type, which would be the obvious shortcut and
 * is wrong — most assets are not receivables, and `Advances to staff` is nobody's
 * outstanding invoice.
 *
 * ---------------------------------------------------------------------------
 * ADDING A COLUMN TO journal_lines
 *
 * `party_id` is nullable, and it has to be. SQLite's documentation says a column with a
 * REFERENCES clause may only be added with a default of NULL — but it does not enforce
 * that. `ALTER TABLE ... ADD COLUMN owner TEXT NOT NULL DEFAULT 'x' REFERENCES parties(id)`
 * is ACCEPTED, and then every INSERT into that table fails with `FOREIGN KEY constraint
 * failed` forever after, because each new row takes a default that references nothing.
 * The table becomes unwritable and the migration that did it has already run everywhere.
 * Measured, not read. Nullable is the only safe shape.
 *
 * Note also that the append-only triggers on `journal_lines` do not stand in the way:
 * ALTER TABLE is not an UPDATE and fires nothing.
 */

import type { Migration } from '../migrate'

/**
 * The roles whose accounts are party control accounts.
 *
 * Two of the `AccountRole` union in domain/ledger, named here as data. A CHECK
 * duplicating the whole union would be a second copy to keep in step; these two are
 * quoted because the rule is specifically about them.
 */
const CONTROL_ROLES = `('accounts-receivable', 'accounts-payable')`

export const m0005: Migration = {
  id: '0005',
  name: 'parties',

  up(db) {
    db.exec(
      `CREATE TABLE parties (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        legal_name TEXT,
        registration_number TEXT,
        jurisdiction_code TEXT,
        country_code TEXT NOT NULL,
        is_customer INTEGER NOT NULL DEFAULT 0 CHECK (is_customer IN (0, 1)),
        is_vendor INTEGER NOT NULL DEFAULT 0 CHECK (is_vendor IN (0, 1)),
        address_line1 TEXT,
        address_line2 TEXT,
        city TEXT,
        postal_code TEXT,
        email TEXT,
        phone TEXT,
        payment_terms_days INTEGER,
        credit_limit TEXT,
        notes TEXT,
        is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (length(trim(name)) > 0),
        CHECK (is_customer = 1 OR is_vendor = 1),
        CHECK (payment_terms_days IS NULL OR payment_terms_days >= 0),
        CHECK (credit_limit IS NULL OR credit_limit GLOB '[0-9]*.[0-9][0-9]')
      ) STRICT`,
    )

    /*
     * A credit limit is money, so it is a decimal string with exactly two places and no
     * sign — the same GLOB the ledger's amounts carry, and for the same reason: any sum
     * over it in SQL has to strip the point and add integer paise (see 0004).
     */

    /*
     * Names are unique ignoring case. Two customers really can be called `Sharma
     * Enterprises`, and this forces whoever enters the second to say which — a city, an
     * initial, anything. The alternative is an invoice raised against the wrong one of
     * two identical rows in a picker, which no report would ever show.
     */
    db.exec(`CREATE UNIQUE INDEX parties_name_unique ON parties (name COLLATE NOCASE)`)

    /*
     * A registration number identifies one business, so two parties carrying the same
     * GSTIN are one party entered twice.
     *
     * Unregistered parties are common and are not duplicates of each other, and what
     * makes that work is that NULLs do not collide in a unique index — not the `WHERE`
     * clause below. The clause only keeps those rows out of the index. Deleting it
     * therefore changes nothing observable, and a mutation that does so survives on
     * purpose; it is a size choice, not a rule.
     */
    db.exec(
      `CREATE UNIQUE INDEX parties_registration_unique
       ON parties (registration_number COLLATE NOCASE)
       WHERE registration_number IS NOT NULL`,
    )

    db.exec(`CREATE INDEX parties_customer ON parties (is_customer) WHERE is_customer = 1`)
    db.exec(`CREATE INDEX parties_vendor ON parties (is_vendor) WHERE is_vendor = 1`)

    // ---- Whose money a line is ----

    db.exec(
      `ALTER TABLE journal_lines
       ADD COLUMN party_id TEXT REFERENCES parties(id) ON DELETE RESTRICT`,
    )

    db.exec(`CREATE INDEX journal_lines_party ON journal_lines (party_id)`)

    db.exec(
      `CREATE TRIGGER journal_lines_party_on_control
       BEFORE INSERT ON journal_lines
       WHEN NEW.party_id IS NULL
         AND EXISTS (
           SELECT 1 FROM account_roles
           WHERE account_id = NEW.account_id AND role IN ${CONTROL_ROLES}
         )
       BEGIN
         SELECT RAISE(ABORT, 'PARTY_REQUIRED');
       END`,
    )

    /*
     * ---------------------------------------------------------------------------
     * TWO RULES CONSIDERED HERE AND DELIBERATELY NOT WRITTEN
     *
     * A PARTY ONLY ON A CONTROL ACCOUNT — the mirror of the trigger above. It looks
     * tidy and it is too tight. An advance received from a customer is a liability under
     * `Advance from customers`, which is not the receivables control account, and it is
     * unambiguously that customer's money; Phase 3 has the same shape for advances paid.
     * A rule that refused it would have to be migrated away, and a migration is never
     * edited. So a party is REQUIRED on a control line and PERMITTED anywhere.
     *
     * AN ARCHIVED PARTY TAKES NOTHING NEW — as a trigger. This is the archived-account
     * decision in 0004 exactly, and it comes out the same way. Reversing an old entry
     * re-inserts its lines carrying the party id they already had, so a trigger would
     * make every entry involving a party unreversible the moment that party was
     * archived. An entry that cannot be corrected is a worse problem than a posting
     * nobody meant to make. The repository refuses it instead, and lets a reversal
     * through by the same `allowArchived` route an archived account already uses.
     */
  },

  down(db) {
    /* SQLite can drop a column, but not one an index names — and dropping the index
     * first is cheaper than rebuilding the table. The trigger goes before the table it
     * reads, for the same reason 0004's do. */
    db.exec(`DROP TRIGGER journal_lines_party_on_control`)
    db.exec(`DROP INDEX journal_lines_party`)
    db.exec(`ALTER TABLE journal_lines DROP COLUMN party_id`)
    db.exec(`DROP TABLE parties`)
  },
}
