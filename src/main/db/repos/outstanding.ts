/*
 * What a document still has against it, and what a receipt still has spare.
 *
 * Rule 3 of src/main/domain/receipts/types.ts, and rule 4 of the document contract, in
 * one file: neither figure is a column, and neither ever will be. What is outstanding is
 *
 *   the movement the document's entry made on the party's account,
 *   less what has been allocated against it.
 *
 * Read that as one sentence rather than two clauses, because everything below follows
 * from it and so does the property the reports in Phase 3 depend on:
 *
 *   party control balance  =  SUM(document outstanding)  -  SUM(receipt unallocated)
 *
 * Both sides read the same rows, so an aged report and the balance sheet cannot disagree
 * — a point 0005 makes about a party's balance and this file makes about one document's.
 *
 * ---------------------------------------------------------------------------
 * THE MOVEMENT IS READ OFF THE LINES THAT NAME THE PARTY, NOT OFF A ROLE
 *
 * The obvious query joins `account_roles` and looks for the account mapped to
 * `accounts-receivable`. It is wrong in a way that only shows up later: a business that
 * repoints that role — a perfectly ordinary thing to do while tidying a chart — would
 * find every invoice raised before the change reporting an outstanding of nothing, and
 * an aged report agreeing with itself at zero.
 *
 * What the posting rules actually guarantee is narrower and steadier: the party's id
 * rides on the control line AND ON NO OTHER (domain/documents/posting.ts, and the same in
 * domain/receipts/posting.ts). So "the lines of this entry that name this party" is the
 * control movement, by construction, and it stays true through any remapping.
 *
 * ---------------------------------------------------------------------------
 * A CANCELLED DOCUMENT COMES TO ZERO WITH NOTHING WRITTEN TO MAKE IT
 *
 * The reversal is a second entry carrying `reverses_entry_id`, so the query below takes
 * the entry AND anything reversing it, and the two net. There is no `status = 'issued'`
 * filter anywhere in this file and there must not be one: a filter is a thing somebody
 * forgets, and the arithmetic already gives the right answer. The document contract
 * predicted this in as many words — "a cancelled invoice's outstanding goes to zero
 * without anybody writing code to make it" — and this is the code not being written.
 *
 * ---------------------------------------------------------------------------
 * AN ALLOCATION ROW'S EXISTENCE MEANS IT COUNTS
 *
 * There is no join to `receipts` and no `status = 'posted'` filter on the allocation sum
 * either, and that is deliberate rather than an oversight: cancelling a receipt DELETES
 * its allocations (see `cancelReceipt`) instead of leaving them for every reader to
 * filter out. Ledger invariant 2 makes the same choice for the same reason — "a filter
 * someone forgets to write is how a draft leaks into a filed return".
 *
 * ---------------------------------------------------------------------------
 * SIGNED IN THE DOCUMENT'S OWN DIRECTION
 *
 * A sales invoice's control line is a debit and a purchase bill's is a credit, so a raw
 * `debit - credit` would report what a vendor is owed as a negative. `side` decides which
 * way round, which makes "what is still outstanding" a positive number for both — and
 * leaves a negative meaning the one thing it should: more has been allocated to this
 * document than it ever put on the account.
 */

import { D, ZERO, toMoneyString, type Decimal } from '@main/domain/money'
import { definitionOf, type DocumentKind } from '@main/domain/documents'

import type { CofferDb } from '../kysely'
import { RepoError } from './errors'

/** A document, reduced to what deciding its outstanding needs. */
export interface DocumentControl {
  id: string
  kind: string
  partyId: string
  /** Null while draft, which is the one case with no movement at all. */
  entryId: string | null
}

/**
 * What one document put on its party's account, in the document's own direction.
 *
 * Zero for a draft: it has posted nothing, so there is nothing to be outstanding. Zero
 * for a cancelled one too, and that falls out of the reversal rather than being asked
 * for.
 *
 * THE EARLY RETURN IS A PROVEN EQUIVALENT MUTANT and is kept for the query it saves.
 * Deleting it gives the same answer on every input: the `or` below would compare
 * `journal_entries.id` against null, which matches no row in SQL, so the fold runs over
 * an empty set and returns zero anyway. Recorded so the next mutation pass does not have
 * to work it out again.
 */
export async function documentMovement(db: CofferDb, document: DocumentControl): Promise<Decimal> {
  if (document.entryId === null) return ZERO

  const lines = await db
    .selectFrom('journal_lines')
    .innerJoin('journal_entries', 'journal_entries.id', 'journal_lines.entry_id')
    .select(['journal_lines.debit', 'journal_lines.credit'])
    .where('journal_lines.party_id', '=', document.partyId)
    .where((eb) =>
      eb.or([
        eb('journal_entries.id', '=', document.entryId),
        eb('journal_entries.reverses_entry_id', '=', document.entryId),
      ]),
    )
    .execute()

  const raw = lines.reduce<Decimal>(
    (total, line) => total.plus(D(line.debit)).minus(D(line.credit)),
    ZERO,
  )

  return definitionOf(document.kind as DocumentKind).side === 'sales' ? raw : raw.negated()
}

/**
 * What has been allocated to one document, from every receipt.
 *
 * `exceptReceiptId` is for the caller that is about to REPLACE one receipt's allocations
 * and needs to know what the others hold — asking without it would count the rows it is
 * in the middle of rewriting and refuse the user's own money twice.
 *
 * Its only caller deletes those rows first, so today it excludes nothing and a mutation
 * dropping it survives. Kept, and labelled, for the reason `assertWithinDocument` gives:
 * the deletion is one line away from moving, and this is the argument that would stop
 * that becoming a bug nobody could see.
 */
export async function allocatedToDocument(
  db: CofferDb,
  documentId: string,
  exceptReceiptId?: string,
): Promise<Decimal> {
  let query = db
    .selectFrom('receipt_allocations')
    .select('amount')
    .where('document_id', '=', documentId)
  if (exceptReceiptId !== undefined) {
    query = query.where('receipt_id', '!=', exceptReceiptId)
  }

  const rows = await query.execute()
  return rows.reduce<Decimal>((total, row) => total.plus(D(row.amount)), ZERO)
}

/**
 * What one document still has against it.
 *
 * The whole sentence at the top of this file, as one function. Negative is possible and
 * is not defended against here — it means more has been allocated than the document put
 * on the account, which is a state the repository refuses to create and which a report
 * should show rather than hide if a file ever holds one.
 */
export async function outstandingForDocument(
  db: CofferDb,
  document: DocumentControl,
  exceptReceiptId?: string,
): Promise<Decimal> {
  const movement = await documentMovement(db, document)
  const allocated = await allocatedToDocument(db, document.id, exceptReceiptId)
  return movement.minus(allocated)
}

/** What has been allocated out of one receipt. */
export async function allocatedFromReceipt(db: CofferDb, receiptId: string): Promise<Decimal> {
  const rows = await db
    .selectFrom('receipt_allocations')
    .select('amount')
    .where('receipt_id', '=', receiptId)
    .execute()
  return rows.reduce<Decimal>((total, row) => total.plus(D(row.amount)), ZERO)
}

/**
 * Refuse to cancel a document that money has been allocated against.
 *
 * Called from `cancelDocument`, and living here rather than in receipts.ts so that
 * issuing depends on the arithmetic and not on the receipt repository — which would be a
 * circle, since a receipt is settled against a document.
 *
 * 0012 enforces the same rule as a trigger on the transition. This is the half that can
 * name the figure, and the sentence matters more than usual: the user is looking at an
 * invoice and the money is on a receipt they have to go and find. Detaching it silently
 * instead would turn it into on-account money nobody decided to create, and they would
 * notice only by wondering why a customer's balance stopped matching their own list.
 */
export async function assertNotAllocated(db: CofferDb, documentId: string): Promise<void> {
  const allocated = await allocatedToDocument(db, documentId)
  if (allocated.isZero()) return

  throw new RepoError(
    'DOCUMENT_ALLOCATED',
    `${toMoneyString(allocated)} has been receipted against this document. ` +
      'Take the allocation off the receipt first, so that money goes somewhere you chose.',
    { documentId, allocated: toMoneyString(allocated) },
  )
}
