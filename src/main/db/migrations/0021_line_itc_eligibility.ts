/*
 * 0021 — whether credit may be taken, on the LINE.
 *
 * `document_lines.itc_eligibility`: 'eligible' | 'ineligible-17-5' | 'ineligible-other',
 * NULL where nothing has been recorded.
 *
 * ===========================================================================
 * 1. WHY THE LINE AND NOT THE DOCUMENT
 * ===========================================================================
 *
 * ONE BILL CAN CARRY A LAPTOP AND A STAFF CAR. Credit is available on the first and
 * blocked on the second, and they arrive on one piece of paper from one supplier with one
 * number. A document-level column would make a user split a real bill into two documents
 * to record a fact about one of its lines — which would then also split the supplier's
 * statement, the numbering and the payment against it.
 *
 * It is also where the POSTING RULE needs it. An ineligible line's tax is not recoverable,
 * so it is not an asset: it is part of what the thing cost, and it posts to the line's own
 * value account rather than to the input tax account (domain/documents/posting.ts). That
 * decision is taken per line, over the line's own account, and a document-level field
 * could not express a bill where one line's tax is an asset and the next line's is an
 * expense.
 *
 * ===========================================================================
 * 2. THREE MEMBERS, AND WHY THE TWO INELIGIBLE ONES ARE NOT ONE
 * ===========================================================================
 *
 * A return reports blocked credit and un-availed credit in different places, so
 * collapsing them into a single `is_eligible` boolean would lose which of the two a
 * figure was — and no later query could recover it, because the money is identical.
 *
 * NULL IS THE FOURTH STATE AND IT IS NOT ONE OF THE THREE. It means nothing was recorded,
 * which is every line written before this migration and every line a caller does not
 * speak for. A return resolves it to `eligible` and COUNTS the resolution as an issue,
 * rather than silently claiming the credit — the difference between an assumption stated
 * and an assumption made.
 *
 * DEFAULT NULL rather than DEFAULT 'eligible', for the same reason 0017 defaulted
 * `is_stock_tracked` to 0 rather than 1: a backfill is a claim about rows nobody looked
 * at. 'eligible' happens to be what the books already assert — an ineligible purchase
 * would have been costed into the expense — but writing it into every existing row would
 * make an inference indistinguishable from a decision, and there would then be nothing
 * left for the return to raise an issue about.
 *
 * ===========================================================================
 * 3. WHAT IS NOT CHECKED HERE, AND WHY
 * ===========================================================================
 *
 * IT IS NOT CONFINED TO PURCHASE-SIDE LINES. It is meaningless on a sales line and it is
 * not refused there, and the reason is that the rule would have to enumerate which
 * document kinds sit on the purchase side — a list that lives in `shared/documents.ts`
 * and that a migration cannot import. 0013 does enumerate a kind mapping in SQL and pays
 * for it with a test that asserts the two agree; that price is worth paying for a rule
 * whose violation corrupts a report, and this one's does not: a return reads
 * `itc_eligibility` only from inward documents, so a stray value on a sales line reaches
 * no figure and no box. The rule that matters is the one the repository states, and
 * `INWARD_ONLY` in repos/documents.ts is where it is stated.
 *
 * NO INDEX. The only reader is a return, which already has the period's documents and
 * their lines in hand; an index on a column with three values and one null across a
 * table read by document id would be a page nothing seeks into.
 *
 * ===========================================================================
 * 4. THE LINE FREEZE NEEDS NOTHING FROM THIS MIGRATION
 * ===========================================================================
 *
 * Worth stating, because 0020 one number earlier had to rewrite a trigger for exactly
 * this and this one does not. `document_lines_frozen_on_update` (0008) fires on ANY
 * update to a line whose document has left draft — it names no columns at all, because a
 * line has no status of its own and is frozen against its parent's. So a column added to
 * `document_lines` is frozen the moment it exists, while a column added to `documents` is
 * not frozen until the enumerated list is rewritten. Two triggers, two shapes, and only
 * one of them inherits.
 */

import type { Migration } from '../migrate'

/** The vocabulary, as data. `ItcEligibility` in shared/dto.ts is the authority. */
const ITC_ELIGIBILITIES = `('eligible', 'ineligible-17-5', 'ineligible-other')`

export const m0021: Migration = {
  id: '0021',
  name: 'line_itc_eligibility',

  up(db) {
    db.exec(
      `ALTER TABLE document_lines ADD COLUMN itc_eligibility TEXT
       CHECK (itc_eligibility IS NULL OR itc_eligibility IN ${ITC_ELIGIBILITIES})`,
    )

    /*
     * The NULL arm is written out rather than left to fall out of the semantics. A CHECK
     * whose expression evaluates to NULL PASSES, so `itc_eligibility IN (...)` on its own
     * would also admit a null — by accident, and unrecognisably. Spelled this way the
     * null is permitted on purpose and the next reader can tell.
     */
  },

  down(db) {
    db.exec(`ALTER TABLE document_lines DROP COLUMN itc_eligibility`)
  },
}
