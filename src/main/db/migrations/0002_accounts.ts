/*
 * 0002 — accounts, account_roles.
 *
 * The chart of accounts, as a tree. Groups total their children and hold no postings of
 * their own; leaves are what a journal line may name.
 *
 * WHAT THE DATABASE ENFORCES, AND WHY EACH ONE IS HERE RATHER THAN IN A REPOSITORY.
 * Every rule below is one that, if broken, corrupts reports rather than throwing —
 * which means the failure would surface as a wrong number weeks later, with no way to
 * tell when it started:
 *
 *   - A parent must be a group. Nesting under a leaf makes the leaf both a figure and
 *     a total, and every roll-up double-counts it.
 *   - A child carries its parent's type. An asset nested under an income group would
 *     appear on the profit and loss and vanish from the balance sheet.
 *   - An account may not be its own parent. The trivial cycle, caught in SQL; longer
 *     ones need a walk and are caught in the repository.
 *   - A referenced account cannot be deleted. `ON DELETE RESTRICT` on both the parent
 *     link and the role mapping.
 *
 * WHAT IT DELIBERATELY DOES NOT ENFORCE. There is no rule here that a group must stay
 * a group. Whether a leaf may become a group depends on whether anything has posted to
 * it, and `journal_lines` does not exist until 0004 — a trigger written now would have
 * to reference a table that is not there. That check belongs with the posting engine.
 *
 * Codes are unique case-insensitively. A chart holding both `CASH` and `cash` is one
 * where somebody will eventually pick the wrong one, and no report would show it.
 */

import type { Migration } from '../migrate'

export const m0002: Migration = {
  id: '0002',
  name: 'accounts',

  up(db) {
    db.exec(
      `CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL
          CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
        parent_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
        is_group INTEGER NOT NULL DEFAULT 0 CHECK (is_group IN (0, 1)),
        is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (parent_id IS NULL OR parent_id <> id),
        CHECK (length(trim(code)) > 0),
        CHECK (length(trim(name)) > 0)
      ) STRICT`,
    )

    db.exec(`CREATE UNIQUE INDEX accounts_code_unique ON accounts (code COLLATE NOCASE)`)
    db.exec(`CREATE INDEX accounts_parent ON accounts (parent_id)`)
    db.exec(`CREATE INDEX accounts_type ON accounts (type)`)

    /* Written as two triggers rather than one so that a violation says which rule it
     * broke. "FOREIGN KEY constraint failed" taught nobody anything; these messages are
     * read by whoever is looking at a stack trace at the time. */
    for (const event of ['INSERT', 'UPDATE OF parent_id, type'] as const) {
      const suffix = event === 'INSERT' ? 'insert' : 'update'
      db.exec(
        `CREATE TRIGGER accounts_parent_is_group_${suffix}
         BEFORE ${event} ON accounts
         WHEN NEW.parent_id IS NOT NULL
           AND (SELECT is_group FROM accounts WHERE id = NEW.parent_id) = 0
         BEGIN
           SELECT RAISE(ABORT, 'ACCOUNT_PARENT_NOT_GROUP');
         END`,
      )
      db.exec(
        `CREATE TRIGGER accounts_type_matches_parent_${suffix}
         BEFORE ${event} ON accounts
         WHEN NEW.parent_id IS NOT NULL
           AND (SELECT type FROM accounts WHERE id = NEW.parent_id) <> NEW.type
         BEGIN
           SELECT RAISE(ABORT, 'ACCOUNT_TYPE_MISMATCH');
         END`,
      )
    }

    /*
     * Which account fills a semantic slot. Keyed by role, so a role maps to exactly one
     * account while one account may serve several — which is what a small business
     * actually does with, say, sales and sales returns.
     *
     * The role names are not constrained to a list here. `AccountRole` in
     * domain/ledger/types.ts is that list, and a CHECK duplicating it would be a second
     * copy to keep in step, in the one kind of file that may never be edited.
     */
    db.exec(
      `CREATE TABLE account_roles (
        role TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        updated_at TEXT NOT NULL,
        CHECK (length(trim(role)) > 0)
      ) STRICT`,
    )

    db.exec(`CREATE INDEX account_roles_account ON account_roles (account_id)`)

    /* A group is a total, so it can no more fill a role than it can take a posting. */
    db.exec(
      `CREATE TRIGGER account_roles_not_group
       BEFORE INSERT ON account_roles
       WHEN (SELECT is_group FROM accounts WHERE id = NEW.account_id) = 1
       BEGIN
         SELECT RAISE(ABORT, 'ACCOUNT_IS_GROUP');
       END`,
    )
  },

  down(db) {
    db.exec(`DROP TABLE account_roles`)
    db.exec(`DROP TABLE accounts`)
  },
}
