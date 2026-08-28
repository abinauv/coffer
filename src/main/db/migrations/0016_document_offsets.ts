/*
 * 0016 — a credit note may be set against the invoice it settles.
 *
 * The other half of 0015. 0015-1 gave a refund document a VOUCHER — money actually going
 * back to the customer — and left the commoner case unbuilt: the credit note nobody pays
 * out, which simply reduces the next invoice. Until this table there was no way to say
 * WHICH invoice, so an aged report showed the invoice in `Over 90 days` and the credit
 * note on account beside it, side by side, with nothing that could match them.
 *
 * ---------------------------------------------------------------------------
 * IT IS `receipt_allocations` AGAIN, WITH MONEY AT NEITHER END
 *
 * Read rule 2 at the top of domain/receipts/types.ts before this file. An allocation
 * matches TWO MOVEMENTS ON ONE CONTROL ACCOUNT THAT POINT OPPOSITE WAYS, and that
 * sentence never mentioned money — it was true of a receipt because a receipt moves
 * receivables the way a credit note does, which is exactly what `receiptFacing` now says
 * out loud in @shared/receipts.
 *
 * So an offset is the same row with a document at the end where a voucher used to be. It
 * moves no money, posts no entry and changes no balance; it may be rewritten where a
 * posted entry may not; it carries no date and no narration, for the reason 0012 gives —
 * giving it either would invite somebody to report on it as though something happened
 * when the matching was done.
 *
 * WHICH IS ALSO WHY IT IS NOT A COLUMN ON `documents`. A credit note may be set against
 * three invoices and an invoice may take credit from two notes; one column holds neither,
 * and one column holds no AMOUNT at all, which is the whole of what a partial offset is.
 *
 * ---------------------------------------------------------------------------
 * AND WHY IT IS NOT `original_document_id`, WHICH ALREADY POINTS THE RIGHT WAY
 *
 * The obvious objection, because 0013 already put a link from a credit note to an invoice
 * on the same table, proved by a trigger that checks very nearly the same four things.
 * Reusing it would be wrong twice over:
 *
 *   IT SAYS SOMETHING ELSE. 0013's link records what the note CORRECTS — the supply being
 *   undone, which GSTR-1 table 9B reports and which only the person raising it knows. An
 *   offset records what it SETTLES. The two are usually the same document and are not the
 *   same fact: a note raised for a short delivery in April may perfectly well be set
 *   against November's invoice, because a credit balance is money and money settles
 *   whatever the customer and the business agree it settles.
 *
 *   IT IS FROZEN AND SINGULAR. 0013 added the link to `documents_frozen_once_issued` on
 *   purpose: re-pointing it after issue would make a filed return disagree with the
 *   books. An offset is the opposite — it is decided AFTER both documents are issued,
 *   changed as often as the parties agree, and there may be several of them.
 *
 * The two coexist with no rule tying them together, and that is deliberate. A note that
 * corrects INV/12 and is set against INV/19 is an ordinary thing; a rule refusing it
 * would be this migration inventing a policy 0013 explicitly declined to have.
 *
 * ---------------------------------------------------------------------------
 * ONE EXPRESSION PROVES FOUR THINGS, AND IT IS 0013'S EXPRESSION
 *
 * `OFFSETS` below maps the refund end's kind to the one charge kind it may settle:
 *
 *   credit-note   -> sales-invoice
 *   debit-note    -> purchase-bill
 *   anything else -> NULL, which no kind can equal, so the trigger fires
 *
 * Comparing the charge end's kind against it proves, in one `IS NOT`:
 *
 *   the refund end really is a refund kind    — anything else gives NULL
 *   the charge end really is a charge kind    — it has to equal the mapping
 *   both are on the SAME side of the trade    — the mapping never crosses sides
 *   they face OPPOSITE ways                   — one charge kind, one refund kind
 *   they are not the same document            — no row is two kinds at once
 *
 * The last one is worth naming because it looks like a missing CHECK. 0013's header makes
 * the identical argument about self-reference, and it holds here for the identical
 * reason: a document cannot be both a credit note and a sales invoice, so a row pointing
 * at itself from both ends is a state the CASE has already made unreachable. Writing
 * `CHECK (charge_document_id <> refund_document_id)` would be a rule that can only ever
 * agree with the trigger above it — the shape this codebase has now deleted three times.
 *
 * `CORRECTS` in 0013 and `OFFSETS` here are the same mapping written twice, in two files,
 * and that is not an oversight either: 0013's is keyed on `NEW.kind` because the row being
 * checked IS the correction, and this one has to look the kind up because the row is
 * neither document. The agreement test in the documents suite covers both against
 * `correctionMap`, so a sixth kind cannot make them disagree quietly.
 *
 * ---------------------------------------------------------------------------
 * THE CAPS ARE REPOSITORY CHECKS, EXACTLY AS 0012 DECIDED
 *
 * An offset may not exceed what is unsettled at EITHER end, and neither cap is a trigger
 * here. That is not an omission — it is 0012's argument arriving unchanged, and this time
 * it applies to both ends rather than one:
 *
 *   IT DEPENDS ON THE LEDGER, and on which account currently fills a control role. Both
 *   can move under a row that is already written, so a trigger would answer with today's
 *   chart about last year's invoice and refuse an offset for a reason no user could act
 *   on.
 *
 *   IT DEPENDS ON THE DIRECTION of each document, which lives in a TypeScript table a
 *   CHECK cannot import — and since 0015 the figure is read in the document's own FACING,
 *   which is that table again.
 *
 *   AND WHAT IT PREVENTS IS VISIBLE. An over-offset document shows a negative
 *   outstanding, which a reader notices, rather than two reports quietly disagreeing.
 *
 * `document_offsets_within_receipt` HAS NO COUNTERPART EITHER, and that is the one place
 * the analogy with 0012 breaks. A receipt's own total is a column two tables away, so
 * 0012 could cap the voucher end in SQL; a refund document's total is its movement on the
 * control account, which is the ledger again. Both ends are the ledger here, so both ends
 * are `offsets.ts`'s business.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS SILENT, WHICH IS THE TEST FOR A TRIGGER
 *
 * Three rules ARE triggers, and each is here because breaking it corrupts a report
 * without producing anything a reader could see:
 *
 *   `document_offsets_same_party`. THE WORST ONE, and 0012's for the same reason. An
 *   offset across two parties takes A's outstanding down because B was credited. The
 *   control account still totals, the trial balance still ties, and both statements are
 *   quietly wrong from that day on.
 *
 *   `document_offsets_kinds`. A credit note set against another credit note takes both
 *   figures further from zero while the account is unmoved — the aged report's foot still
 *   equals the balance sheet, because an offset nets across its two ends whatever they
 *   are, and only the rows are nonsense. That is precisely the failure 0015-1 argued a
 *   refund made possible for allocations, one table across.
 *
 *   `documents_offset_not_cancelled`. 0012's `documents_allocated_not_cancelled`, and it
 *   has to watch BOTH ends: cancelling either document leaves the offset settling
 *   something the books say never happened. The remedy is one step — take the offset off
 *   first — so refusing costs a user very little and saves them a balance nobody can
 *   explain.
 *
 * And one more, which is not about corruption but about keeping the three above honest:
 * `document_offsets_immutable` refuses every UPDATE, so the rules only have to hold on
 * INSERT. `offsets.ts` replaces a refund document's whole set in one transaction, which
 * is what the record IS — a statement about which charges this credit settles, and half
 * a statement is not a smaller version of it.
 */

import type { Migration } from '../migrate'

/**
 * Which charge kind each refund kind may be set against, where a trigger can see it.
 *
 * `DOCUMENT_KINDS` in @shared/documents is the authority: this is "the charge kind on the
 * same side" for each refund kind, and it is 0013's `CORRECTS` with the kind looked up
 * rather than read off `NEW`. A test asserts both stay that.
 */
const OFFSETS = `CASE (SELECT kind FROM documents WHERE id = NEW.refund_document_id)
        WHEN 'credit-note' THEN 'sales-invoice'
        WHEN 'debit-note' THEN 'purchase-bill'
      END`

/** Unsigned money, exactly two places. 0004's shape, and what makes the CAST below safe. */
const MONEY_SHAPE = `GLOB '[0-9]*.[0-9][0-9]'`

/** Paise, as an exact integer. Sound only because `MONEY_SHAPE` is on the column. */
const paise = (column: string) => `CAST(REPLACE(${column}, '.', '') AS INTEGER)`

export const m0016: Migration = {
  id: '0016',
  name: 'document_offsets',

  up(db) {
    db.exec(
      `CREATE TABLE document_offsets (
        id TEXT PRIMARY KEY,
        charge_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
        refund_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
        amount TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (charge_document_id, refund_document_id),
        CHECK (amount ${MONEY_SHAPE}),
        CHECK (${paise('amount')} > 0)
      ) STRICT`,
    )

    /*
     * `RESTRICT` AT BOTH ENDS, where 0012 cascades from the receipt and restricts to the
     * document. That asymmetry was not a convention to copy — it came from the two ends
     * being different kinds of thing. An allocation belongs to its receipt: it is part of
     * what that receipt SAYS, so if a receipt could ever be deleted its matching goes
     * with it. Here both ends are documents with one lifecycle, and the row is a
     * statement about the pair rather than a possession of either.
     *
     * Neither path is reachable today — only a draft may be deleted and only an issued
     * document may be offset — so both are floors under a path nothing currently takes,
     * which 0007 says is the only kind that can be laid without breaking something. If
     * one ever opened, refusing is the safe direction: cascading from a document would
     * silently un-settle whatever stood at the other end.
     *
     * ONE ROW PER PAIR, for 0012's reason exactly. Two rows matching one note to one
     * invoice add up to the same money and say it twice, and every screen listing what
     * this note settles would show one invoice on two lines.
     */
    db.exec(`CREATE INDEX document_offsets_refund ON document_offsets (refund_document_id)`)

    /*
     * The UNIQUE index already serves lookups by `charge_document_id`, since it leads on
     * that column; the refund end has nothing in front of it and is the direction the
     * editor reads in — "what does this credit note settle" is the panel being drawn.
     */

    // ---- The rules that cannot be left to a repository ----

    db.exec(
      `CREATE TRIGGER document_offsets_same_party
       BEFORE INSERT ON document_offsets
       WHEN (SELECT party_id FROM documents WHERE id = NEW.charge_document_id)
            IS NOT (SELECT party_id FROM documents WHERE id = NEW.refund_document_id)
       BEGIN
         SELECT RAISE(ABORT, 'OFFSET_PARTY_MISMATCH');
       END`,
    )

    /*
     * `IS NOT` AND NOT `<>`, which 0012's header explains at length: a comparison against
     * NULL is NULL, a `WHEN` that evaluates to NULL does not fire, and a trigger that
     * does not fire is a rule that is not there.
     *
     * ON THIS TRIGGER IT IS AN EQUIVALENT MUTANT, exactly as it is on 0012's version, and
     * that is recorded here so a mutation pass does not investigate it twice. Both
     * subqueries can only be NULL for a row naming a document that is not there, and both
     * ends are `REFERENCES documents(id)` with foreign keys ON outside migrations — so no
     * insert can tell the two spellings apart, and no test can either. It stays as
     * `IS NOT` because a rule that is correct on its own is worth more than one that is
     * correct because of what is standing next to it.
     *
     * IT IS NOT EQUIVALENT ON `document_offsets_kinds` BELOW, which is the interesting
     * half. That one compares against a CASE, and the CASE answers NULL for a perfectly
     * real document — any charge kind at the refund end. So `<>` there would evaluate to
     * NULL, decline to fire, and admit an invoice set against an invoice, which is
     * precisely the row this migration exists to refuse. There is a test.
     */

    db.exec(
      `CREATE TRIGGER document_offsets_both_issued
       BEFORE INSERT ON document_offsets
       WHEN (SELECT status FROM documents WHERE id = NEW.charge_document_id) IS NOT 'issued'
         OR (SELECT status FROM documents WHERE id = NEW.refund_document_id) IS NOT 'issued'
       BEGIN
         SELECT RAISE(ABORT, 'DOCUMENT_NOT_ISSUED');
       END`,
    )

    /*
     * ONE TRIGGER FOR BOTH ENDS, where 0012 needed two because its two ends were two
     * tables. A draft has posted nothing, so settling against one settles against a
     * movement that does not exist; a cancelled document's movement has been reversed to
     * nothing, so settling against one does the same. Either way the figure disappears
     * from every report without appearing anywhere else.
     */

    db.exec(
      `CREATE TRIGGER document_offsets_kinds
       BEFORE INSERT ON document_offsets
       WHEN (SELECT kind FROM documents WHERE id = NEW.charge_document_id) IS NOT ${OFFSETS}
       BEGIN
         SELECT RAISE(ABORT, 'OFFSET_KIND_MISMATCH');
       END`,
    )

    db.exec(
      `CREATE TRIGGER document_offsets_immutable
       BEFORE UPDATE ON document_offsets
       BEGIN
         SELECT RAISE(ABORT, 'OFFSET_IMMUTABLE');
       END`,
    )

    db.exec(
      `CREATE TRIGGER documents_offset_not_cancelled
       BEFORE UPDATE ON documents
       WHEN NEW.status = 'cancelled' AND OLD.status <> 'cancelled'
         AND EXISTS (
           SELECT 1 FROM document_offsets
           WHERE charge_document_id = OLD.id OR refund_document_id = OLD.id
         )
       BEGIN
         SELECT RAISE(ABORT, 'DOCUMENT_OFFSET');
       END`,
    )

    /*
     * `OLD.status <> 'cancelled'` so it fires on the TRANSITION and not on every later
     * update to a row that is already cancelled — which would make a cancelled document
     * unwritable rather than uncancellable. 0013's header makes the same note about its
     * own version, and it is the kind of thing that is obvious once and never again.
     *
     * IT IS ALSO A DELIBERATE EQUIVALENT MUTANT HERE, recorded so a pass does not chase
     * it: the state it guards against is one this migration's other rules make
     * unreachable. A cancelled document cannot GAIN an offset — `both_issued` refuses it
     * — and a document with an offset cannot BE cancelled, which is this trigger. So no
     * row ever has both, and dropping the clause changes nothing observable. It stays
     * because the rule it states is the one a reader needs in order to know that a
     * cancelled invoice is still writable, and because the day either neighbour moves it
     * becomes load-bearing without anything failing.
     *
     * ---------------------------------------------------------------------------
     * A NOTE FOR WHOEVER REBUILDS `documents` NEXT
     *
     * `documents_offset_not_cancelled` is the SECOND trigger on `documents` created by a
     * migration that is not about `documents` — 0012 left the first. 0010's `REBUILD_TAIL`
     * recreates that table's triggers by hand, and a rebuild that copies it verbatim now
     * drops two rules rather than one, without failing anything, because the repository
     * checks both first and every test would still pass.
     */
  },

  down(db) {
    /*
     * The whole table goes, and unlike 0012's rollback that costs no money. An offset
     * moved nothing: dropping these rows leaves every balance, every entry and every
     * control account exactly as they were, and takes away only the statement about which
     * charge each credit was settling. What comes back is money on account, which is what
     * it was before anybody said otherwise.
     *
     * The trigger on `documents` is not `documents`' own and is dropped by nothing else.
     */
    db.exec(`DROP TRIGGER documents_offset_not_cancelled`)
    db.exec(`DROP TABLE document_offsets`)
  },
}
