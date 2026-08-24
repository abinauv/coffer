/*
 * 0014 — an invoice records when it falls due.
 *
 * One nullable column, two triggers to say when it must be there, a third replaced to
 * hold it still, and a backfill for the documents already issued. No table rebuild: the
 * column has no default and no REFERENCES clause, so `ALTER TABLE ADD COLUMN` takes it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DATE IS STORED AND NOT DERIVED, WHICH IS THE WHOLE DECISION
 *
 * The obvious version of an aged report needs no column at all. `parties` has carried
 * `payment_terms_days` since 0005, so a report could compute
 *
 *   due = document_date + the party's terms
 *
 * on the way past, and every invoice would age correctly against the terms that party is
 * on. That is the version this migration exists to refuse.
 *
 * Terms are a fact about a party TODAY. The date an invoice fell due is a fact about
 * THAT INVOICE, fixed the moment it was issued, and the two stop agreeing the first time
 * somebody moves a customer from 30 days to 15. Under the derived version that edit
 * silently re-ages every invoice that customer has ever had — including ones in months
 * that are closed, and ones on an aged report already printed, signed and sent to a bank.
 * Nothing would flag it, because nothing was wrong: the report simply answers a different
 * question than it did yesterday.
 *
 * So the due date joins the small set of facts that are STAMPED AT ISSUE rather than
 * looked up: the number, the series, the entry. It is nullable for exactly the reason
 * `number` is nullable — a draft has not been issued and therefore has none — and it is
 * frozen afterwards by the same trigger, so the parallel holds all the way down.
 *
 * ---------------------------------------------------------------------------
 * WHY ONLY TWO KINDS HAVE ONE
 *
 * A due date is the date an OBLIGATION matures, so a kind has one exactly when raising it
 * puts somebody in debt. `chargesOnTerms` in shared/documents.ts is that sentence, and
 * for the five kinds this build knows it comes to a sales invoice and a purchase bill.
 *
 *   quotation     offers a price and creates no obligation — there is nothing to be late
 *   credit note   CANCELS an obligation. Its own due date would be a date on which a
 *   debit note    refund became overdue, which is not a thing the books can act on: what
 *                 a correction needs is the invoice it offsets, and that is 0015's work
 *
 * The kinds are enumerated in SQL below because a trigger cannot import a union — the
 * same concession 0007, 0008, 0010 and 0013 all make. There is a test asserting this list
 * is exactly `DOCUMENT_KINDS.filter(chargesOnTerms)`, so a sixth kind cannot quietly
 * disagree with it.
 *
 * ---------------------------------------------------------------------------
 * THE RULE IS A BICONDITIONAL, AND THAT IS STRONGER THAN IT LOOKS
 *
 * `documents_due_date_valid_*` does not say "a due date must be a date". It says the
 * column is filled EXACTLY where it should be:
 *
 *   has a due date   <->   it charges on terms AND it has left draft
 *
 * A one-way rule would leave the two ways this can rot both legal. An issued invoice with
 * no due date reads to the report as a document that is never late, so it sits in the
 * newest bucket forever and the total still ties — the worst kind of wrong, because
 * nothing disagrees with anything. A quotation WITH one reads as an obligation that does
 * not exist. Both are refused here, by one expression, rather than by two checks that
 * could each be forgotten.
 *
 * `<> 'draft'` rather than `= 'issued'`, so a cancelled invoice keeps its due date. It
 * keeps its number for the same reason and by the same argument: what was issued was
 * issued, and a cancellation is a second fact about it rather than an unmaking of the
 * first.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BACKFILL IS THE DERIVED VERSION THIS FILE JUST ARGUED AGAINST
 *
 * For documents issued before today the stamp does not exist and cannot be recovered —
 * the terms in force when they were issued were never written down anywhere. The party's
 * current terms are the best available reconstruction, and they are exactly right for
 * every file whose terms have not changed, which is most of them.
 *
 * That is a real loss and it is stated rather than papered over. What the backfill buys is
 * that the invariant above holds for EVERY row, old and new, so the report can read the
 * column instead of defending against a null it could not interpret.
 *
 * `date(…, '+N days')` rather than a TypeScript loop, and a migration that imported
 * `addDays` from the domain would be the mistake: a migration must produce the same
 * schema in five years' time, and the domain is free to change. There is a test in this
 * folder that runs both and asserts they agree, which is the only place the two are
 * allowed to meet.
 *
 * `updated_at` is deliberately not touched. Nobody edited these documents; the schema
 * grew a column, and stamping every row as changed today would put a lie in the audit
 * trail to record a migration the `schema_migrations` table already records.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER IN `up` IS LOAD-BEARING IN BOTH DIRECTIONS
 *
 * The validity triggers are created BEFORE the backfill, so the backfill is checked by
 * the rule it exists to satisfy: a company file the `UPDATE` cannot bring into line
 * refuses to migrate, loudly, instead of opening with an aged report that quietly leaves
 * documents out.
 *
 * The freeze trigger is replaced AFTER it, and that way round is required rather than
 * tidy. 0013's version does not name `due_date`, so the backfill passes through it; the
 * version below does, so the same `UPDATE` run one statement later would abort on every
 * issued row. Swapping the two lines turns this migration into one that cannot run on any
 * file that has ever issued an invoice.
 */

import type { Migration } from '../migrate'

/**
 * The kinds that fall due, where a trigger can see them.
 *
 * `DOCUMENT_KINDS` in shared/documents.ts is the authority: this is
 * `filter(chargesOnTerms)`, and a test asserts it stays that.
 */
const ON_TERMS = `('sales-invoice', 'purchase-bill')`

/** The one condition, shared by the insert and the update trigger so it cannot drift. */
const DUE_DATE_IS_WRONG = `(NEW.due_date IS NOT NULL)
     <> (NEW.status <> 'draft' AND NEW.kind IN ${ON_TERMS})
   OR (NEW.due_date IS NOT NULL
       AND (length(NEW.due_date) <> 10 OR NEW.due_date < NEW.document_date))`

/**
 * What rule 1 freezes, exactly as 0013 left it.
 *
 * Copied rather than imported, for the reason the header gives about `addDays`: this list
 * is what the trigger said on the day this migration was written, and a later migration
 * editing 0013's copy must not silently change what this one does.
 */
const FROZEN_BY_0013: readonly string[] = [
  `NEW.kind <> OLD.kind`,
  `NEW.document_date <> OLD.document_date`,
  `NEW.party_id <> OLD.party_id`,
  `NEW.rounding_policy <> OLD.rounding_policy`,
  `NEW.place_of_supply_country <> OLD.place_of_supply_country`,
  `NEW.narration <> OLD.narration`,
  `IFNULL(NEW.place_of_supply_jurisdiction, '') <> IFNULL(OLD.place_of_supply_jurisdiction, '')`,
  `IFNULL(NEW.number, '') <> IFNULL(OLD.number, '')`,
  `IFNULL(NEW.series_id, '') <> IFNULL(OLD.series_id, '')`,
  `IFNULL(NEW.entry_id, '') <> IFNULL(OLD.entry_id, '')`,
  `IFNULL(NEW.original_document_id, '') <> IFNULL(OLD.original_document_id, '')`,
]

/** The one this migration adds. Without it a due date is re-datable after issue. */
const FROZEN_DUE_DATE = `IFNULL(NEW.due_date, '') <> IFNULL(OLD.due_date, '')`

function freezeTrigger(frozen: readonly string[]): string {
  return `CREATE TRIGGER documents_frozen_once_issued
   BEFORE UPDATE ON documents
   WHEN OLD.status <> 'draft'
     AND (${frozen.join('\n       OR ')})
   BEGIN
     SELECT RAISE(ABORT, 'DOCUMENT_NOT_DRAFT');
   END`
}

export const m0014: Migration = {
  id: '0014',
  name: 'document_due_date',

  up(db) {
    db.exec(`ALTER TABLE documents ADD COLUMN due_date TEXT`)

    db.exec(
      `CREATE TRIGGER documents_due_date_valid_insert
       BEFORE INSERT ON documents
       WHEN ${DUE_DATE_IS_WRONG}
       BEGIN
         SELECT RAISE(ABORT, 'DOCUMENT_DUE_DATE_INVALID');
       END`,
    )

    db.exec(
      `CREATE TRIGGER documents_due_date_valid_update
       BEFORE UPDATE ON documents
       WHEN ${DUE_DATE_IS_WRONG}
       BEGIN
         SELECT RAISE(ABORT, 'DOCUMENT_DUE_DATE_INVALID');
       END`,
    )

    /* Terms are per party and NULL means due on receipt, which is `+0 days` and not a
     * special case worth a branch. See the header on why this reconstruction is both
     * wrong in principle and the only thing available. */
    db.exec(
      `UPDATE documents
          SET due_date = (
                SELECT date(
                  documents.document_date,
                  '+' || IFNULL(parties.payment_terms_days, 0) || ' days'
                )
                FROM parties
                WHERE parties.id = documents.party_id
              )
        WHERE status <> 'draft' AND kind IN ${ON_TERMS}`,
    )

    db.exec(`DROP TRIGGER documents_frozen_once_issued`)
    db.exec(freezeTrigger([...FROZEN_BY_0013, FROZEN_DUE_DATE]))
  },

  down(db) {
    /*
     * The triggers go first because SQLite refuses to drop a column any of them mentions,
     * and the freeze trigger is one of them as of this migration.
     *
     * The column goes with them, and with it every due date that was stamped. A rollback
     * to before 0014 is a rollback to a schema with nowhere to put one; keeping the data
     * would mean keeping the column, which is not a rollback.
     */
    db.exec(`DROP TRIGGER documents_due_date_valid_insert`)
    db.exec(`DROP TRIGGER documents_due_date_valid_update`)
    db.exec(`DROP TRIGGER documents_frozen_once_issued`)
    db.exec(`ALTER TABLE documents DROP COLUMN due_date`)
    db.exec(freezeTrigger(FROZEN_BY_0013))
  },
}
