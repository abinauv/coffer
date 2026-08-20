/*
 * 0009 — what an issued document may still change about itself.
 *
 * One trigger replaced, and it exists because building `issueDocument` turned something
 * 0008 documented as deliberate into a contradiction.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS WRONG
 *
 * 0008's `documents_frozen_once_issued` lists the columns that may not move once a
 * document has left draft, and `narration` was not among them. The test asserting that
 * justified it in a line: "Narration and the updated stamp are not part of the supply, so
 * they still move."
 *
 * That was true when it was written and stopped being true one batch later. A document's
 * narration is what `narrationFor` puts on the JOURNAL ENTRY (domain/documents/posting.ts),
 * and a posted entry is immutable — invariant 3, and three of 0004's triggers hold it
 * there. So an issued document whose narration could still be edited is one that can be
 * made to print something its own day book entry does not say, with nothing recording when
 * the two parted company. That is the disagreement rule 1 exists to prevent, and rule 1
 * already said so in as many words: not the figures, not the party, and not "just the
 * narration" (domain/documents/types.ts).
 *
 * Two files in this repository contradicted each other, and the resolution costs nothing
 * operational: the repository already refuses the edit (`assertDraft` in updateDocument),
 * so nothing legitimate relied on the gap. What it buys is the floor under a caller that
 * skipped the repository — which is the only reason any of these triggers exist.
 *
 * `series_id` joins them, with less argument needed. The NUMBER was already frozen and the
 * series that produced it was not, so an issued document could be repointed at a series
 * whose shape its number does not match — a register that cannot be reconciled against its
 * own counters, and 0007's `SERIES_IN_USE` guarding a link that had come loose.
 *
 * `updated_at` still moves, and must: cancelling writes it. So does nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHY A NEW MIGRATION RATHER THAN AN EDIT TO 0008
 *
 * CONVENTIONS §1.5. A company file that has run 0008 will never run it again, so editing
 * it would leave two databases built by the same Coffer carrying different triggers, with
 * nothing able to tell which is which. Fixed forward, at the cost of one DROP and one
 * CREATE — SQLite has no ALTER TRIGGER, and a trigger is cheap to replace whole.
 */

import type { Migration } from '../migrate'

/*
 * The full guard, replacing 0008's. Written out rather than assembled from a list, for
 * the reason 0008 gives about the CHECKs beside it: this is the sentence "an issued
 * document is frozen" and it should be readable as one.
 *
 * IFNULL on every nullable column. `NEW.number <> OLD.number` is NULL when either side is
 * NULL, and a trigger whose WHEN evaluates to NULL does not fire — so a comparison written
 * the obvious way would silently exempt exactly the transitions that set a column for the
 * first time. Both of the columns added here are nullable.
 */
const FROZEN = `NEW.kind <> OLD.kind
  OR NEW.document_date <> OLD.document_date
  OR NEW.party_id <> OLD.party_id
  OR NEW.rounding_policy <> OLD.rounding_policy
  OR NEW.place_of_supply_country <> OLD.place_of_supply_country
  OR NEW.narration <> OLD.narration
  OR IFNULL(NEW.place_of_supply_jurisdiction, '')
     <> IFNULL(OLD.place_of_supply_jurisdiction, '')
  OR IFNULL(NEW.number, '') <> IFNULL(OLD.number, '')
  OR IFNULL(NEW.series_id, '') <> IFNULL(OLD.series_id, '')
  OR IFNULL(NEW.entry_id, '') <> IFNULL(OLD.entry_id, '')`

export const m0009: Migration = {
  id: '0009',
  name: 'document_freeze',

  up(db) {
    db.exec(`DROP TRIGGER documents_frozen_once_issued`)
    db.exec(
      `CREATE TRIGGER documents_frozen_once_issued
       BEFORE UPDATE ON documents
       WHEN OLD.status <> 'draft' AND (${FROZEN})
       BEGIN
         SELECT RAISE(ABORT, 'DOCUMENT_NOT_DRAFT');
       END`,
    )
  },

  down(db) {
    /* 0008's trigger, restored exactly — narration and series mutable again. A `down`
     * that left the tighter rule in place would make a rollback something other than the
     * inverse of the migration, which is the one thing a rollback has to be. */
    db.exec(`DROP TRIGGER documents_frozen_once_issued`)
    db.exec(
      `CREATE TRIGGER documents_frozen_once_issued
       BEFORE UPDATE ON documents
       WHEN OLD.status <> 'draft'
         AND (NEW.kind <> OLD.kind
           OR NEW.document_date <> OLD.document_date
           OR NEW.party_id <> OLD.party_id
           OR NEW.rounding_policy <> OLD.rounding_policy
           OR NEW.place_of_supply_country <> OLD.place_of_supply_country
           OR IFNULL(NEW.place_of_supply_jurisdiction, '')
              <> IFNULL(OLD.place_of_supply_jurisdiction, '')
           OR IFNULL(NEW.number, '') <> IFNULL(OLD.number, '')
           OR IFNULL(NEW.entry_id, '') <> IFNULL(OLD.entry_id, ''))
       BEGIN
         SELECT RAISE(ABORT, 'DOCUMENT_NOT_DRAFT');
       END`,
    )
  },
}
