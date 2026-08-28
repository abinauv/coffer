/*
 * Setting a credit note against the invoices it settles.
 *
 * `receipt_allocations`' write path with a document where the voucher was — read
 * `replaceAllocations` in ./receipts.ts beside this, because the two are deliberately the
 * same shape and the places they differ are the interesting part of the file.
 *
 * A FILE OF ITS OWN, for ./issuing.ts's reason. Drafting a document is documents.ts's
 * business; saying what one settles spans the ledger, both ends of a match and two sets
 * of rules, and burying it in documents.ts would hide the property that matters — that
 * the delete and every insert are inside one `inTransaction`, so a save that is refused
 * half way through leaves the set the user had before rather than the half it managed.
 *
 * ---------------------------------------------------------------------------
 * THE SET BELONGS TO THE REFUND DOCUMENT, AND ONLY TO IT
 *
 * A credit note is a pool of money drawn down by refunds and by offsets, which is exactly
 * a receipt's shape, so it owns the set for the reason a receipt owns its allocations. An
 * invoice's screen shows what has been set against it and does not edit it.
 *
 * That is not a UI preference. If both ends could replace an overlapping set, the last
 * save would silently drop the other's rows — the invoice's screen writing "these two
 * notes settle me" would delete a third note's offset that the invoice had never been
 * shown. One owner, and the rule is enforceable because `refund_document_id` is a column
 * a `DELETE` can name.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS DIFFERS FROM `replaceAllocations`, WHICH IS TWICE
 *
 * BOTH CAPS ARE LEDGER READS. There, the voucher's own total is a column — so the sum of
 * a receipt's allocations is checked against `receipts.amount` before anything is
 * fetched, and 0012 makes it a trigger as well. Here the refund end's capacity is its
 * movement on the control account, so it is a query like the other end's, and 0016 makes
 * neither a trigger (its header takes 0012's three reasons in turn).
 *
 * THE OWN-END CHECK IS ONE TOTAL, NOT ONE PER ROW. The whole set is against one refund
 * document, so summing it and asking once is both cheaper and a better sentence — "1500.00
 * was offset out of a credit note with 1180.00 left" names the figure the user has to
 * change. The far end has to be checked per row, because every row is a different
 * invoice.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE POSTS, AND THAT IS THE WHOLE POINT
 *
 * No entry, no period check, no number. An offset is rule 2 of domain/receipts/types.ts
 * for the second time: the control account and the party's balance were already right the
 * instant both documents were issued, whether or not anybody has said which settles
 * which. So this file may be called against a CLOSED period, and deliberately is — saying
 * in July which invoice an April credit note settled changes no figure in April, and
 * refusing it would be this layer inventing a rule the ledger does not have.
 */

import { randomUUID } from 'node:crypto'

import { parseMoney, toMoneyString, ZERO, type Decimal } from '@main/domain/money'
import { definitionOf, type DocumentKind } from '@main/domain/documents'
import type { OffsetInput, SetOffsetsInput } from '@shared/dto'

import type { CofferDb } from '../kysely'
import { RepoError, repoErrorFrom } from './errors'
import {
  offsetKindFor,
  outstandingForDocument,
  settlementFor,
  type DocumentControl,
  type DocumentSettlementResult,
} from './outstanding'
import { inTransaction } from './transaction'

/** A document row reduced to what both ends of an offset need to be judged. */
type OffsetEnd = DocumentControl & { number: string | null; status: string }

/**
 * Replace what one refund document settles.
 *
 * Returns the refund document's own settlement, read back inside the same transaction —
 * the shape `allocateReceipt` returns the receipt in, and for the same reason: the caller
 * is a screen redrawing the panel it just saved, and a second round trip could show it a
 * set somebody else had changed in between.
 */
export async function setOffsets(
  db: CofferDb,
  input: SetOffsetsInput,
  now: string,
): Promise<DocumentSettlementResult> {
  return inTransaction(db, async (trx) => {
    const refund = await requireEnd(trx, input.refundDocumentId)
    const chargeKind = offsetKindFor(refund)
    assertIssued(refund)

    /*
     * DELETED FIRST, AND EVERY FIGURE BELOW IS READ AFTERWARDS. This is what makes
     * re-saving an unchanged set a no-op rather than a refusal: the caps would otherwise
     * count the rows being replaced and tell the user their own credit note is used up.
     * `replaceAllocations` does the same and passes an `exceptReceiptId` as well, which
     * is a documented equivalent mutant there; nothing is passed here, because the
     * deletion is the only thing that makes it true and a second spelling of the same
     * exclusion would be a rule agreeing with itself.
     */
    await trx.deleteFrom('document_offsets').where('refund_document_id', '=', refund.id).execute()

    const lines = readLines(input.offsets)
    if (lines.length === 0) return settlementFor(trx, refund)

    const total = lines.reduce<Decimal>((sum, line) => sum.plus(line.amount), ZERO)
    await assertWithin(trx, refund, total, 'own')

    for (const line of lines) {
      const charge = await requireEnd(trx, line.chargeDocumentId)
      assertIssued(charge)
      assertKind(charge, chargeKind, refund)
      assertSameParty(charge, refund)
      await assertWithin(trx, charge, line.amount, 'far')

      await trx
        .insertInto('document_offsets')
        .values({
          id: randomUUID(),
          charge_document_id: charge.id,
          refund_document_id: refund.id,
          amount: toMoneyString(line.amount),
          created_at: now,
        })
        .execute()
        .catch((error: unknown) => {
          throw repoErrorFrom(error, 'OFFSET_KIND_MISMATCH')
        })
    }

    return settlementFor(trx, refund)
  })
}

/**
 * The lines, judged without touching the database.
 *
 * EVERYTHING THAT CAN BE DECIDED HERE IS DECIDED HERE, which is `replaceAllocations`'
 * ordering rule and the reason it carries a note: a check that runs after the insert that
 * trips a constraint can never answer, and a repository check that a trigger reaches
 * first is one no test can tell from a deleted one.
 */
function readLines(
  offsets: readonly OffsetInput[],
): { chargeDocumentId: string; amount: Decimal }[] {
  const seen = new Set<string>()
  const lines: { chargeDocumentId: string; amount: Decimal }[] = []

  for (const offset of offsets) {
    if (seen.has(offset.chargeDocumentId)) {
      /*
       * Two rows against one invoice add up to the same money and say it twice, and the
       * panel listing what this note settles would show one invoice on two lines. 0016's
       * UNIQUE would catch it; this catches it before the first insert, with the document
       * named.
       */
      throw new RepoError(
        'OFFSET_EXCEEDS_DOCUMENT',
        'The same document is offset against twice in one set. Put it on one line.',
        { documentId: offset.chargeDocumentId },
      )
    }
    seen.add(offset.chargeDocumentId)
    lines.push({ chargeDocumentId: offset.chargeDocumentId, amount: readAmount(offset.amount) })
  }
  return lines
}

/**
 * The amount, at money scale and worth recording.
 *
 * Zero and negative are refused by one rule rather than two, exactly as an allocation's
 * are: an offset says two documents settle each other, and neither of those does. The
 * direction is which column the document id lands in, never the sign — 0016's unsigned
 * shape refuses a negative at the table as well.
 */
function readAmount(value: string): Decimal {
  let amount: Decimal
  try {
    amount = parseMoney(value)
  } catch (error) {
    throw new RepoError(
      'OFFSET_AMOUNT_INVALID',
      `${JSON.stringify(value)} is not an amount of money.`,
      { value },
      { cause: error },
    )
  }
  if (amount.greaterThan(0)) return amount

  throw new RepoError(
    'OFFSET_AMOUNT_INVALID',
    'An offset of nothing is not a statement. Take the line off instead.',
    { value },
  )
}

async function requireEnd(db: CofferDb, documentId: string): Promise<OffsetEnd> {
  const row = await db
    .selectFrom('documents')
    .select(['id', 'kind', 'status', 'number', 'party_id', 'entry_id'])
    .where('id', '=', documentId)
    .executeTakeFirst()

  if (row === undefined) {
    throw new RepoError('DOCUMENT_NOT_FOUND', 'That document is not in these books.', {
      documentId,
    })
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    number: row.number,
    partyId: row.party_id,
    entryId: row.entry_id,
  }
}

/**
 * Both ends, and the same sentence for both.
 *
 * A draft has posted nothing, so an offset against one settles a movement that does not
 * exist; a cancelled document's movement has been reversed to nothing, so an offset
 * against one does the same. 0016 refuses both with one trigger for the same reason this
 * refuses them with one function.
 */
function assertIssued(document: OffsetEnd): void {
  if (document.status === 'issued') return

  throw new RepoError(
    'DOCUMENT_NOT_ISSUED',
    document.status === 'draft'
      ? 'A draft has posted nothing, so there is nothing to settle. Issue it first.'
      : `${document.number ?? 'That document'} has been cancelled and settles nothing.`,
    { documentId: document.id, status: document.status },
  )
}

function assertKind(charge: OffsetEnd, expected: DocumentKind, refund: OffsetEnd): void {
  if (charge.kind === expected) return

  throw new RepoError(
    'OFFSET_KIND_MISMATCH',
    `${definitionOf(refund.kind as DocumentKind).pluralLabel} are set against ` +
      `${definitionOf(expected).pluralLabel.toLowerCase()}. ` +
      `${charge.number ?? 'That document'} is a ` +
      `${definitionOf(charge.kind as DocumentKind).label.toLowerCase()}.`,
    { documentId: charge.id, documentKind: charge.kind, refundKind: refund.kind },
  )
}

/**
 * One party, and it is the rule 0016 makes a trigger because breaking it is silent.
 *
 * An offset across two parties takes A's outstanding down because B was credited, and
 * nothing anywhere shows it: the control account still totals and the trial balance still
 * ties. Both statements are quietly wrong from that day on.
 */
function assertSameParty(charge: OffsetEnd, refund: OffsetEnd): void {
  if (charge.partyId === refund.partyId) return

  throw new RepoError(
    'OFFSET_PARTY_MISMATCH',
    `${charge.number ?? 'That document'} belongs to a different party. ` +
      "One party's credit cannot settle another's invoice.",
    { documentId: charge.id, chargePartyId: charge.partyId, refundPartyId: refund.partyId },
  )
}

/**
 * Refuse an offset larger than what the document has left, at whichever end.
 *
 * The cap 0016 declines to make a trigger, and its header gives 0012's three reasons for
 * that. What this adds is the figures, and the `end` is only there to change the sentence:
 * a user looking at a credit note that has run out needs a different instruction from one
 * who has aimed too much at a particular invoice.
 *
 * `outstandingForDocument` is what makes this one function rather than two. It reads in
 * the DOCUMENT's own facing, so "what is left" is a positive number at both ends and the
 * comparison is the same comparison — which is the 0015 change earning its keep in the
 * batch after the one that made it.
 */
async function assertWithin(
  db: CofferDb,
  document: OffsetEnd,
  amount: Decimal,
  end: 'own' | 'far',
): Promise<void> {
  const outstanding = await outstandingForDocument(db, document)
  if (amount.lessThanOrEqualTo(outstanding)) return

  const named = document.number ?? 'That document'
  throw new RepoError(
    'OFFSET_EXCEEDS_DOCUMENT',
    end === 'own'
      ? `${named} has ${toMoneyString(outstanding)} left to set against anything, and ` +
          `${toMoneyString(amount)} was set. Reduce the lines until they come to what is left.`
      : `${named} has ${toMoneyString(outstanding)} outstanding, and ` +
          `${toMoneyString(amount)} was offset against it.`,
    {
      documentId: document.id,
      outstanding: toMoneyString(outstanding),
      requested: toMoneyString(amount),
    },
  )
}
