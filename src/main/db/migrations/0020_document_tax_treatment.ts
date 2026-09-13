/*
 * 0020 — how a supply is taxed, as opposed to what the tax came to.
 *
 * Two columns on `documents`:
 *
 *   export_tax_payment  'with-payment' | 'without-payment', NULL on a domestic supply
 *   is_reverse_charge   whether the BUYER discharges the tax rather than the seller
 *
 * Both are INPUTS to `computeTax` and to a return, not outputs of either. Neither can be
 * derived from the figures on the document, and that is the whole reason they are
 * columns — see below, where each is argued separately, because they fail differently.
 *
 * ===========================================================================
 * 1. `export_tax_payment` IS NOT A REPORTING FLAG
 * ===========================================================================
 *
 * It looks like one. It is not, and the difference is a number on the invoice.
 *
 * A supply that leaves the country is INTER-STATE, so `computeTax` gives it the full
 * rate as a single integrated component. That is right for an export on which tax is
 * paid and refunded afterwards. It is WRONG for an export made under an undertaking,
 * where no tax is charged at all — and until this column existed there was no way to say
 * so except to set the line's rate to zero.
 *
 * THOSE ARE TWO DIFFERENT SUPPLIES AND THEY FILE INTO DIFFERENT BOXES. A supply carrying
 * a rate and no tax is ZERO-RATED: the credit on its inputs stays available and is
 * refundable. A supply carrying a rate of zero is NIL-RATED or exempt: it is inside the
 * tax and the credit on its inputs has to be reversed. Setting the rate to zero to get a
 * nil figure therefore does not merely mislabel the supply — it changes what the taxpayer
 * may claim, in the opposite direction, and every total on the return still adds up.
 *
 * So the rate stays on the line, the tax comes out at nothing, and this column is what
 * says which of the two happened. `computeTax` reads it (regimes/in-gst/tax.ts) and only
 * where the place of supply is an export; a value on a domestic supply cannot zero
 * anything, and the service refuses to store one in the first place.
 *
 * NO CHECK TIES IT TO THE PLACE OF SUPPLY, and the omission is deliberate rather than
 * missing. The biconditional CONVENTIONS §3 asks for would have to say "present exactly
 * when the supply leaves this country", and neither half of that is available to SQL
 * here:
 *
 *   WHICH COUNTRY IS "OURS" IS NOT ON THE ROW. It is `company_profile.country_code`, a
 *   single mutable row that can legitimately be empty. A trigger reading it would (a)
 *   compare against NULL for a company that has not filled its profile in, and a `WHEN`
 *   that evaluates to NULL DOES NOT FIRE — the same trap 0019 measured for
 *   `is_stock_tracked` — so the rule would be silently absent for exactly the files that
 *   need it most; and (b) retrospectively invalidate every document in the file the day
 *   somebody corrects the company's country, which is a field a user may edit.
 *
 *   HARDCODING `'in'` IS WORSE and is not available at all. CONVENTIONS §1.6: `db/` may
 *   not name a concrete regime, and "an export is a supply that does not go to India" is
 *   exactly that. 0008 declined to CHECK the place of supply against a list of
 *   jurisdictions for the same reason.
 *
 * WHAT HOLDS INSTEAD is `DocumentsService`, which is the one layer that has the regime's
 * own answer (`placeOfSupply().isExport`) and refuses the value on a supply that is not
 * an export. That is a repository-side rule with no floor under it, which is stated here
 * rather than glossed: the failure it guards against is a stray word in a column nothing
 * reads on a domestic document, and it is the only rule in this file without a database
 * behind it.
 *
 * THE CHECK IT DOES GET is the vocabulary, spelled with the NULL arm written out:
 * `CHECK (export_tax_payment IS NULL OR export_tax_payment IN (...))`. A CHECK whose
 * expression evaluates to NULL PASSES, so `export_tax_payment IN (...)` alone would admit
 * a NULL — which is the value we want anyway, so the shorter spelling would have been
 * accidentally correct and unrecognisably so. Written out, it says the null is allowed on
 * purpose.
 *
 * ===========================================================================
 * 2. `is_reverse_charge` IS `NOT NULL DEFAULT 0`, AND THE DEFAULT IS AN ASSERTION
 * ===========================================================================
 *
 * Every document either is under reverse charge or is not; there is no third state and
 * nothing to leave unsaid. So it is a boolean column with a CHECK on 0/1, and `NOT NULL`
 * as well as the CHECK — because a CHECK that evaluates to NULL passes, and `NULL IN
 * (0, 1)` is NULL. Two constraints for one rule, which is the shape every required column
 * in this schema takes.
 *
 * DEFAULT 0 backfills every existing document as forward charge, and that is a claim
 * rather than a shrug: forward charge is the ordinary case, and a document wrongly marked
 * reverse charge invents a cash liability that no input credit may discharge. The
 * opposite default would restate the tax position of every document in every file.
 *
 * IT IS NOT RESTRICTED BY KIND. Reverse charge arises on both sides: an outward supply
 * under it carries a value and no liability for this business, and an inward one makes
 * this business liable for the output tax AND entitled to the input credit — two postings
 * from one bill (domain/documents/posting.ts). A CHECK confining it to purchases would
 * refuse a fact that is true of sales.
 *
 * ===========================================================================
 * 3. BOTH JOIN THE FREEZE, WHICH IS WHY THIS MIGRATION REWRITES A TRIGGER
 * ===========================================================================
 *
 * `documents_frozen_once_issued` enumerates the columns an issued document may not
 * change. It is a LIST, so a column added afterwards is not frozen by it — measured on a
 * scratch database rather than assumed: adding a column and updating it on an issued row
 * goes straight through the old trigger.
 *
 * Both of these describe the supply and both are on the paper the customer holds and in
 * the return that was filed, so both are frozen at issue exactly as the place of supply
 * and the rounding policy are (rule 1, domain/documents/types.ts). 0013 and 0014 each
 * rebuilt this trigger for the same reason and this one follows them: drop it, and
 * recreate it with the full list, taken from what 0014 left rather than from what 0008
 * wrote. Recreating an older version would silently roll a later migration back, and
 * every test would still pass on a fresh database because the last migration to touch the
 * trigger wins.
 *
 * `IFNULL(x, '')` on the nullable one, matching every other nullable column in the list:
 * `NEW.export_tax_payment <> OLD.export_tax_payment` is NULL when either side is NULL,
 * and a `WHEN` that evaluates to NULL does not fire — so the plain spelling would leave a
 * value settable on an issued document exactly when it had none, which is the direction
 * that matters.
 */

import type { Migration } from '../migrate'

/** The vocabulary, as data. `ExportTaxPayment` in shared/dto.ts is the authority. */
const EXPORT_TAX_PAYMENTS = `('with-payment', 'without-payment')`

/**
 * Every column an issued document may not change, AS 0014 LEFT IT plus this migration's
 * two.
 *
 * Copied forward rather than derived, because a migration cannot import from another
 * migration without making a landed file's behaviour depend on a later edit to it. The
 * cost is that this list has to be read against 0014's before it is changed, and the
 * documents suite asserts the trigger's effect for every column rather than its text.
 */
const FROZEN = [
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
  `IFNULL(NEW.due_date, '') <> IFNULL(OLD.due_date, '')`,
  /* This migration's two. */
  `IFNULL(NEW.export_tax_payment, '') <> IFNULL(OLD.export_tax_payment, '')`,
  `NEW.is_reverse_charge <> OLD.is_reverse_charge`,
]

/** What 0014 left, so `down` can put it back exactly. */
const FROZEN_BEFORE_0020 = FROZEN.slice(0, -2)

function freezeTrigger(frozen: readonly string[]): string {
  return `CREATE TRIGGER documents_frozen_once_issued
   BEFORE UPDATE ON documents
   WHEN OLD.status <> 'draft'
     AND (${frozen.join('\n       OR ')})
   BEGIN
     SELECT RAISE(ABORT, 'DOCUMENT_NOT_DRAFT');
   END`
}

export const m0020: Migration = {
  id: '0020',
  name: 'document_tax_treatment',

  up(db) {
    db.exec(
      `ALTER TABLE documents ADD COLUMN export_tax_payment TEXT
       CHECK (export_tax_payment IS NULL OR export_tax_payment IN ${EXPORT_TAX_PAYMENTS})`,
    )

    db.exec(
      `ALTER TABLE documents ADD COLUMN is_reverse_charge INTEGER NOT NULL DEFAULT 0
       CHECK (is_reverse_charge IN (0, 1))`,
    )

    /* No `REFERENCES` on either, so neither trips the trap 0005 measured: `ADD COLUMN ...
     * NOT NULL DEFAULT 'x' REFERENCES other(id)` is accepted, and every later insert that
     * takes the default then fails the foreign key — re-measured for this batch on 3.53.4,
     * where an insert NAMING a real parent still succeeds and only the default is poison. */

    /* An export is a small fraction of a file and the return asks for exactly that
     * fraction, so the index is partial for the reason 0017's is. */
    db.exec(
      `CREATE INDEX documents_export_tax_payment
       ON documents (export_tax_payment)
       WHERE export_tax_payment IS NOT NULL`,
    )

    db.exec(`DROP TRIGGER documents_frozen_once_issued`)
    db.exec(freezeTrigger(FROZEN))
  },

  down(db) {
    /* The trigger first: it names both columns, and although `DROP COLUMN` succeeds while
     * a CHECK names the column (measured, and the documentation denies it), a TRIGGER
     * naming it is the case that genuinely refuses — 0017's header records the same
     * finding from the other side. */
    db.exec(`DROP TRIGGER documents_frozen_once_issued`)
    db.exec(freezeTrigger(FROZEN_BEFORE_0020))
    db.exec(`DROP INDEX documents_export_tax_payment`)
    db.exec(`ALTER TABLE documents DROP COLUMN is_reverse_charge`)
    db.exec(`ALTER TABLE documents DROP COLUMN export_tax_payment`)
  },
}
