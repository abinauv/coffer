/*
 * 0013 — a credit note may name the invoice it corrects.
 *
 * One nullable column and two triggers. No table rebuild: `ALTER TABLE ADD COLUMN` can
 * carry a `REFERENCES` clause as long as the default is NULL, which this one is, and the
 * runner has foreign keys off for the duration anyway (see `withoutForeignKeys`).
 *
 * ---------------------------------------------------------------------------
 * WHY THE LINK EXISTS AT ALL, GIVEN NOTHING IN THE LEDGER READS IT
 *
 * The posting rule does not look at it and could not use it: a credit note that names
 * its invoice and one that does not post identically, because a return adjusts accounts,
 * not documents. This column is not for the ledger. It is for the return and for the
 * person reading the paper.
 *
 * GSTR-1 reports a credit note against the original invoice — table 9B carries the
 * original number and date — and an officer matching a return to the books asks the same
 * question. Deriving it later is not possible: two invoices to the same customer in the
 * same month for the same amount are ordinary, and nothing in the figures says which one
 * a credit note undid. It is a fact only the person raising it knows, so it is recorded
 * when they raise it or it is lost.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS OPTIONAL, WHICH IS THE PART THAT LOOKS WRONG
 *
 * A credit note against a single invoice is the common case and the law's default. It is
 * not the only legal one: since the 2019 amendment to section 34, a supplier may issue
 * ONE credit note against SEVERAL invoices — the post-sale discount a distributor settles
 * at the end of a quarter is exactly that, and it has no single original to name.
 *
 * So a NOT NULL column would refuse a document the law permits, and the refusal would
 * arrive at a user with no way round it. Optional, with the screens asking for it and the
 * common case filling it in, is the shape that fits both.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE TWO TRIGGERS PROVE, AND WHY IT IS ONE RULE RATHER THAN FOUR
 *
 * A link, where there is one, points at a document that could actually have been
 * corrected by this one: the same party, issued, and on the same side of the trade facing
 * the other way. All of that is one `EXISTS`, and the `CASE` is what carries the last
 * part —
 *
 *   credit note   -> sales-invoice
 *   debit note    -> purchase-bill
 *   anything else -> NULL, which no `kind =` can match, so the EXISTS fails
 *
 * — which means a SALES INVOICE CARRYING A LINK IS REFUSED BY THE SAME EXPRESSION, with
 * no separate check for it. That is deliberate rather than clever: a second trigger
 * saying "only a refund may correct something" would be a rule that can only ever agree
 * with this one, and the codebase has deleted two of those already.
 *
 * SELF-REFERENCE NEEDS NO CHECK EITHER, for the same reason. A credit note may only point
 * at a sales invoice, so it cannot point at itself, and `id = original_document_id` is a
 * state the CASE has already made unreachable.
 *
 * The kind names are enumerated in SQL because a CHECK cannot import a union — the same
 * concession 0007, 0008 and 0010 make. There is a test in the documents suite asserting
 * this mapping is exactly "the charge kind on the same side" for every refund kind the
 * domain knows, so a sixth kind cannot quietly disagree with it.
 *
 * ---------------------------------------------------------------------------
 * WHY CANCELLING THE ORIGINAL IS REFUSED
 *
 * The same argument 0012 makes about allocated money, and it lands in the same place. A
 * credit note against a cancelled invoice leaves the customer owed money for a supply
 * that, according to the books, never happened. The remedy is available and obvious —
 * cancel the credit note first, then the invoice — so refusing costs a user one extra
 * step and saves them a balance nobody can explain.
 *
 * The FOREIGN KEY handles deletion (`ON DELETE RESTRICT`) and cannot see cancellation,
 * which is an UPDATE. Hence the third trigger.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FREEZE TRIGGER IS REPLACED RATHER THAN LEFT ALONE
 *
 * `documents_frozen_once_issued` names every column that may not change after issue. A
 * new column not on that list is a new hole in rule 1: the link could be re-pointed at a
 * different invoice years later, silently, and the return already filed would no longer
 * match the books. It is dropped and recreated here with the column added.
 *
 * The version recreated below is 0010'S, not 0009's — 0010 rebuilt the table and put the
 * trigger back with it. Copying 0009's would roll 0010 back, and every test would still
 * pass on a fresh database, because migrations run in order and the last one to touch a
 * trigger wins. The same trap 0010's own header describes.
 */

import type { Migration } from '../migrate'

/**
 * Which kind corrects which, where a CHECK can see it.
 *
 * `DOCUMENT_KINDS` in domain/documents/types.ts is the authority: this is "the charge
 * kind on the same side" for each refund kind, and a test asserts it stays that.
 */
const CORRECTS = `CASE NEW.kind
        WHEN 'credit-note' THEN 'sales-invoice'
        WHEN 'debit-note' THEN 'purchase-bill'
      END`

/** The one condition, shared by the insert and the update trigger so it cannot drift. */
const LINK_IS_IMPOSSIBLE = `NEW.original_document_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM documents original
     WHERE original.id = NEW.original_document_id
       AND original.party_id = NEW.party_id
       AND original.status = 'issued'
       AND original.kind = ${CORRECTS}
   )`

/**
 * What rule 1 freezes, exactly as 0010 listed it.
 *
 * A list rather than one string, so `up` and `down` are the same trigger with and without
 * one element. Deriving the rollback by cutting a line out of the finished SQL was the
 * first shape of this and it is a worse one: a change in whitespace makes the cut a
 * silent no-op, and the rollback would then keep enforcing a column it had just dropped.
 */
const FROZEN_BY_0010: readonly string[] = [
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
]

/** The one this migration adds. Without it the link is re-pointable after issue. */
const FROZEN_LINK = `IFNULL(NEW.original_document_id, '') <> IFNULL(OLD.original_document_id, '')`

function freezeTrigger(frozen: readonly string[]): string {
  return `CREATE TRIGGER documents_frozen_once_issued
   BEFORE UPDATE ON documents
   WHEN OLD.status <> 'draft'
     AND (${frozen.join('\n       OR ')})
   BEGIN
     SELECT RAISE(ABORT, 'DOCUMENT_NOT_DRAFT');
   END`
}

export const m0013: Migration = {
  id: '0013',
  name: 'document_links',

  up(db) {
    db.exec(
      `ALTER TABLE documents
       ADD COLUMN original_document_id TEXT REFERENCES documents(id) ON DELETE RESTRICT`,
    )

    /* Partial, because almost every row is NULL: only a correction carries one, and an
     * index over the NULLs would be most of the table saying nothing. Read from the
     * original's side — "what corrects this invoice" — which is the direction the
     * cancellation trigger and the invoice screen both ask in. */
    db.exec(
      `CREATE INDEX documents_original ON documents (original_document_id)
       WHERE original_document_id IS NOT NULL`,
    )

    db.exec(
      `CREATE TRIGGER documents_correction_valid_insert
       BEFORE INSERT ON documents
       WHEN ${LINK_IS_IMPOSSIBLE}
       BEGIN
         SELECT RAISE(ABORT, 'DOCUMENT_CORRECTION_INVALID');
       END`,
    )

    db.exec(
      `CREATE TRIGGER documents_correction_valid_update
       BEFORE UPDATE ON documents
       WHEN ${LINK_IS_IMPOSSIBLE}
       BEGIN
         SELECT RAISE(ABORT, 'DOCUMENT_CORRECTION_INVALID');
       END`,
    )

    /*
     * Cancelling something a credit note corrects. `OLD.status <> 'cancelled'` so the
     * trigger fires on the transition and not on every later update to a row that is
     * already cancelled — which would make a cancelled invoice unwritable rather than
     * uncancellable.
     */
    db.exec(
      `CREATE TRIGGER documents_corrected_not_cancelled
       BEFORE UPDATE ON documents
       WHEN NEW.status = 'cancelled' AND OLD.status <> 'cancelled'
         AND EXISTS (
           SELECT 1 FROM documents correction
           WHERE correction.original_document_id = OLD.id
             AND correction.status <> 'cancelled'
         )
       BEGIN
         SELECT RAISE(ABORT, 'DOCUMENT_CORRECTED');
       END`,
    )

    db.exec(`DROP TRIGGER documents_frozen_once_issued`)
    db.exec(freezeTrigger([...FROZEN_BY_0010, FROZEN_LINK]))
  },

  down(db) {
    db.exec(`DROP TRIGGER documents_correction_valid_insert`)
    db.exec(`DROP TRIGGER documents_correction_valid_update`)
    db.exec(`DROP TRIGGER documents_corrected_not_cancelled`)
    db.exec(`DROP TRIGGER documents_frozen_once_issued`)
    db.exec(`DROP INDEX documents_original`)

    /*
     * The column goes, and with it every link anybody recorded. That is a real loss and
     * it is stated rather than worked around: there is nowhere else to put it, and a
     * `down` that kept the column would not be a rollback.
     *
     * The triggers and the index are dropped FIRST because SQLite refuses to drop a
     * column any of them mention.
     */
    db.exec(`ALTER TABLE documents DROP COLUMN original_document_id`)
    db.exec(freezeTrigger(FROZEN_BY_0010))
  },
}
