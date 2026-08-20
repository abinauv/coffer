/*
 * 0008 — documents, document_lines, document_line_taxes.
 *
 * The trade document itself. Read the FOUR RULES at the top of
 * src/main/domain/documents/types.ts before touching anything here; this migration is
 * those rules expressed as constraints, and each one below says which it is enforcing.
 *
 * ---------------------------------------------------------------------------
 * ONE TABLE FOR ALL FIVE KINDS
 *
 * Quotation, sales invoice, credit note, purchase bill and debit note differ in three
 * fields and are otherwise identical. Five tables would mean five copies of the line
 * structure and the tax block, five sets of triggers saying the same thing, and a Phase 3
 * that is a schema change rather than a posting rule. `kind` says which one it is.
 *
 * ---------------------------------------------------------------------------
 * RULE 1 — A DRAFT UNTIL ISSUED, FROZEN AFTERWARDS
 *
 * `documents_frozen_once_issued` refuses any UPDATE to a document that has left draft,
 * except to the two columns that record leaving it. The lines and their taxes are frozen
 * the same way, against their parent's status rather than their own — a line has no
 * status of its own and never should, because then a document and its lines could
 * disagree about whether the document was still editable.
 *
 * This is the ledger's immutability invariant seen from the document side, and it is
 * also plain GST law: the customer holds a copy and the return may already be filed, so
 * an issued invoice is corrected by a credit note and never by an edit. A trigger and not
 * a repository check, for the reason 0004 gives about posted entries — an edit that got
 * through leaves a document disagreeing with its own journal entry, with nothing to say
 * when it started.
 *
 * ---------------------------------------------------------------------------
 * RULE 2 — THE NUMBER IS ALLOCATED AT ISSUE AND NEVER RELEASED
 *
 * `CHECK ((status = 'draft') = (number IS NULL))` is the whole rule in one line: a draft
 * has no number and anything else has one. It holds in both directions, which matters —
 * the failure it prevents is not only a numbered draft but an issued document with no
 * number, which would print blank and file as nothing.
 *
 * A cancelled document KEEPS its number, which is why cancelling and deleting are
 * different operations rather than one with a flag. Rule 46(b) wants an invoice series
 * consecutive for the financial year, and a number handed back leaves a gap somebody has
 * to explain to an officer.
 *
 * ---------------------------------------------------------------------------
 * RULE 3 — ISSUING IS ONE TRANSACTION
 *
 * `CHECK (status <> 'issued' OR entry_id IS NOT NULL)`. There is no representable state
 * in which a document is issued and has not posted, so "issued but not yet posted" is not
 * a window somebody has to remember to close — it is a row the database will not hold.
 * That window is exactly the one in which the sales register and the trial balance
 * disagree and no query can say which is right.
 *
 * A quotation posts nothing, and its `sourceType` is null in the domain. It is therefore
 * never `issued`; it goes from draft to whatever Phase 3 decides, and the CHECK above
 * does not stand in the way because it only constrains `issued`.
 *
 * ---------------------------------------------------------------------------
 * RULE 4 — NOTHING DERIVABLE IS STORED
 *
 * There is no `grand_total`, no `taxable_value`, no `total_tax` and no `outstanding`.
 * Every figure on the foot of a document is `documentTotals()` over its lines, and what
 * is outstanding is a ledger fact — the movement the entry made on the party's control
 * account, less what has been allocated against it (0009). A stored total is a second
 * answer to the same question, and the two disagree from the first edit that goes through
 * code maintaining only one of them.
 *
 * The two deliberate exceptions are `document_lines.taxable_amount` and the whole of
 * `document_line_taxes`. Both are argued where they are declared: one is the number
 * handed to the regime and the multiplication that made it rounds; the other is the
 * regime's answer as of the document's own date, and rates change.
 */

import type { Migration } from '../migrate'

/*
 * The five kinds, as data. The same list 0007 constrains a numbering series to, and
 * quoted the same way and for the same reason: a CHECK cannot import a TypeScript union,
 * and a table that accepted any string would take `sale-invoice` from a typo and hold a
 * document nothing can ever post or print.
 */
const DOCUMENT_KINDS = `('sales-invoice', 'quotation', 'credit-note', 'purchase-bill', 'debit-note')`

/** Three places — 0.125 is half of India's 0.25% slab. See 0006 and CONVENTIONS §3. */
const RATE_SHAPE = `GLOB '[0-9]*.[0-9][0-9][0-9]'`

/*
 * SIGNED SHAPES, AND WHY THE LEDGER'S ARE NOT.
 *
 * A rebate shown as a line is a negative value and a returned quantity on a credit note
 * is a negative quantity — both real, both ordinary. The posting rule already turns an
 * account that comes out negative into a debit (domain/documents/posting.ts), so nothing
 * downstream is surprised by one.
 *
 * The integer-paise arithmetic survives it, measured on a scratch table rather than read:
 * `CAST(REPLACE('-200.00', '.', '') AS INTEGER)` is -20000, sign and all, and summing it
 * with 25000 gives 5000. The shape still refuses `200.0`, `200`, `1e5`, `-.50` and
 * `- 200.00`, which is what makes the CAST safe.
 *
 * It does admit `-0.00`, which nobody types deliberately and which behaves as zero
 * everywhere downstream — `Decimal('-0').isZero()` is true, so the posting rule's bucket
 * skips it like any other nothing. Left alone rather than given a CHECK of its own: a
 * rule earns one by naming a failure, and there is no failure to name here.
 *
 * `journal_lines` keeps the UNSIGNED shape and must. A journal line's side is its sign,
 * so a negative debit would be a second way to say a credit, and the two would disagree
 * about which the balance trigger should believe.
 */
const signedShape = (column: string, places: number) => {
  const digits = '[0-9]'.repeat(places)
  return `${column} GLOB '[0-9]*.${digits}' OR ${column} GLOB '-[0-9]*.${digits}'`
}

/** Money that may be negative — a line's price, discount, taxable amount and tax. */
const signedMoney = (column: string) => signedShape(column, 2)

/** A quantity, which is three places and may also be negative. */
const signedQuantity = (column: string) => signedShape(column, 3)

export const m0008: Migration = {
  id: '0008',
  name: 'documents',

  up(db) {
    db.exec(
      `CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ${DOCUMENT_KINDS}),
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft', 'issued', 'cancelled')),
        number TEXT,
        series_id TEXT REFERENCES numbering_series(id) ON DELETE RESTRICT,
        document_date TEXT NOT NULL,
        party_id TEXT NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
        party_reference TEXT,
        place_of_supply_jurisdiction TEXT,
        place_of_supply_country TEXT NOT NULL,
        rounding_policy TEXT NOT NULL DEFAULT 'none'
          CHECK (rounding_policy IN ('whole-unit', 'none')),
        narration TEXT NOT NULL DEFAULT '',
        entry_id TEXT UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        issued_at TEXT,
        cancelled_at TEXT,
        CHECK (length(document_date) = 10),
        CHECK (length(place_of_supply_country) = 2),
        CHECK (place_of_supply_country = lower(place_of_supply_country)),
        CHECK ((status = 'draft') = (number IS NULL)),
        CHECK (status <> 'issued' OR entry_id IS NOT NULL),
        CHECK ((status = 'draft') = (issued_at IS NULL)),
        CHECK ((status = 'cancelled') <> (cancelled_at IS NULL))
      ) STRICT`,
    )

    /*
     * `entry_id` is UNIQUE, so one journal entry belongs to at most one document. Without
     * it two documents could name the same entry and both claim to have posted it, and
     * the sales register would total to more than the ledger — which is the disagreement
     * rule 3 exists to make impossible. The same trick 0004 uses for `reverses_entry_id`.
     *
     * The last two CHECKs are the same statement twice, written the way each reads best.
     * A draft has no issue time and anything else has one; a cancelled document has a
     * cancellation time and nothing else does. Both are `=` or `<>` between two boolean
     * expressions, which SQLite evaluates as 1 and 0.
     */

    /*
     * A number is unique within its kind, and that is the rule rather than unique
     * overall. `INV/2026-27/0001` on a sales invoice and on a credit note are two
     * different documents in two different series, and a business that numbers both from
     * `0001` is doing nothing wrong. Two sales invoices carrying one number is the
     * failure: it is what an officer matches against, and the second one is unfileable.
     *
     * Partial, because drafts have no number and NULLs would otherwise fill the index.
     */
    db.exec(
      `CREATE UNIQUE INDEX documents_number_unique
       ON documents (kind, number COLLATE NOCASE)
       WHERE number IS NOT NULL`,
    )

    db.exec(`CREATE INDEX documents_party ON documents (party_id)`)
    db.exec(`CREATE INDEX documents_date ON documents (document_date)`)
    db.exec(`CREATE INDEX documents_kind_status ON documents (kind, status)`)

    db.exec(
      `CREATE TABLE document_lines (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        line_number INTEGER NOT NULL,
        item_id TEXT REFERENCES items(id) ON DELETE RESTRICT,
        description TEXT NOT NULL,
        quantity TEXT NOT NULL,
        unit_code TEXT REFERENCES units_of_measure(code) ON DELETE RESTRICT,
        unit_price TEXT NOT NULL,
        discount TEXT NOT NULL DEFAULT '0.00',
        taxable_amount TEXT NOT NULL,
        rate_pct TEXT NOT NULL DEFAULT '0.000',
        classification_code TEXT,
        is_charge INTEGER NOT NULL DEFAULT 0 CHECK (is_charge IN (0, 1)),
        account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
        UNIQUE (document_id, line_number),
        CHECK (line_number >= 1),
        CHECK (length(trim(description)) > 0),
        CHECK (${signedQuantity('quantity')}),
        CHECK (${signedMoney('unit_price')}),
        CHECK (${signedMoney('discount')}),
        CHECK (${signedMoney('taxable_amount')}),
        CHECK (rate_pct ${RATE_SHAPE})
      ) STRICT`,
    )

    /*
     * ON DELETE CASCADE from the document, and it is safe precisely because a document
     * that has been issued cannot be deleted — the trigger below refuses it. So the only
     * cascade that can ever run is a draft being thrown away, taking lines that never
     * reached the ledger with it. Without that trigger this cascade would be a way to
     * silently unpick a posted invoice.
     *
     * ON DELETE RESTRICT everywhere else. An item, unit or account named on a line that
     * has been issued is part of the historical record of that supply; letting it be
     * deleted would leave a line that prints a blank where the tariff code was.
     *
     * `line_number` is unique within a document and starts at 1. It is the order the user
     * put them in, never a sort key derived from anything — see `DocumentLine` in the
     * domain. Rows come back ordered by it, so an invoice reprints in the order it was
     * typed rather than the order SQLite happens to hold.
     */

    db.exec(`CREATE INDEX document_lines_document ON document_lines (document_id)`)
    db.exec(`CREATE INDEX document_lines_item ON document_lines (item_id)`)

    db.exec(
      `CREATE TABLE document_line_taxes (
        document_line_id TEXT NOT NULL
          REFERENCES document_lines(id) ON DELETE CASCADE,
        code TEXT NOT NULL,
        label TEXT NOT NULL,
        rate_pct TEXT NOT NULL,
        amount TEXT NOT NULL,
        PRIMARY KEY (document_line_id, code),
        CHECK (length(trim(code)) > 0),
        CHECK (rate_pct ${RATE_SHAPE}),
        CHECK (${signedMoney('amount')})
      ) STRICT`,
    )

    /*
     * The key is the line and the component, so one line cannot carry CGST twice. It can
     * carry CGST at one rate and SGST at another, which is the ordinary case, and a
     * document can carry CGST at two rates across two lines — which is why the printed
     * tax summary groups by code AND rate while the ledger groups by code alone (see
     * domain/documents/totals.ts and the posting rule).
     *
     * `label` is stored rather than built from the code and the rate. The wording belongs
     * to the regime, an invoice must reprint exactly as it was issued, and a label
     * assembled at print time would quietly restyle every historical document the day
     * somebody improved the format.
     */

    // ---- Rule 1, as three triggers ----

    /*
     * FROZEN ONCE ISSUED. The exceptions are the columns that record the transition
     * itself: a document leaving draft writes its status, number, series, entry, issue
     * time and updated_at in the same statement, and cancelling writes status and
     * cancelled_at. Everything describing the supply is refused.
     */
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

    db.exec(
      `CREATE TRIGGER documents_issued_not_deleted
       BEFORE DELETE ON documents
       WHEN OLD.status <> 'draft'
       BEGIN
         SELECT RAISE(ABORT, 'DOCUMENT_NOT_DRAFT');
       END`,
    )

    /*
     * A LINE HAS NO STATUS OF ITS OWN, and is frozen against its parent's.
     *
     * Giving a line its own status would let a document and its lines disagree about
     * whether the document was editable, and there is no answer to which of them is
     * right. One trigger per operation because SQLite has no `BEFORE INSERT OR UPDATE OR
     * DELETE`, and because an insert reads NEW while a delete reads OLD.
     */
    for (const [operation, row] of [
      ['INSERT', 'NEW'],
      ['UPDATE', 'OLD'],
      ['DELETE', 'OLD'],
    ] as const) {
      db.exec(
        `CREATE TRIGGER document_lines_frozen_on_${operation.toLowerCase()}
         BEFORE ${operation} ON document_lines
         WHEN EXISTS (
           SELECT 1 FROM documents
           WHERE id = ${row}.document_id AND status <> 'draft'
         )
         BEGIN
           SELECT RAISE(ABORT, 'DOCUMENT_NOT_DRAFT');
         END`,
      )
    }

    /*
     * ---------------------------------------------------------------------------
     * THREE RULES CONSIDERED HERE AND DELIBERATELY NOT WRITTEN
     *
     * A DOCUMENT MUST HAVE AT LEAST ONE LINE — as a CHECK or a trigger. It cannot be one
     * and should not be: a draft is created empty and filled in, which is what a draft is
     * for, and a rule refusing an empty document would refuse the first thing every user
     * does. The rule that matters is that an EMPTY DOCUMENT CANNOT BE ISSUED, which is
     * about the transition rather than the row, and belongs with the rest of issuing
     * (`DOCUMENT_EMPTY` in the repository).
     *
     * THE PLACE OF SUPPLY MUST BE A JURISDICTION THE REGIME KNOWS. Not this file's
     * business. Which jurisdictions exist is the regime's (`TaxRegime.jurisdictions`), and
     * `db/` may not name a concrete regime — the same line drawn at a GSTIN in 0005 and an
     * HSN code in 0006. What is checked here is the shape of the country code, which is
     * ISO and not a tax question.
     *
     * A CANCELLED DOCUMENT'S ENTRY MUST BE REVERSED — as a trigger. The fact is true and
     * the enforcement would be wrong. It is a statement about two tables at a moment the
     * transaction is only half way through: the reversal is posted and the status is set
     * in one transaction, and a BEFORE UPDATE trigger fires while whichever came second
     * has not happened yet. SQLite has no deferred triggers (see 0004's note, which cost
     * this project a day). The repository does both or neither.
     */
  },

  down(db) {
    /* Children before parents, and triggers before the tables they read — the order 0004
     * and 0005 both use, for the same reason: a trigger left behind on a dropped table is
     * a rollback that half-completes. */
    for (const operation of ['insert', 'update', 'delete']) {
      db.exec(`DROP TRIGGER document_lines_frozen_on_${operation}`)
    }
    db.exec(`DROP TRIGGER documents_issued_not_deleted`)
    db.exec(`DROP TRIGGER documents_frozen_once_issued`)
    db.exec(`DROP TABLE document_line_taxes`)
    db.exec(`DROP TABLE document_lines`)
    db.exec(`DROP TABLE documents`)
  },
}
