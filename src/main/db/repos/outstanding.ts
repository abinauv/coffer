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
 *
 * ---------------------------------------------------------------------------
 * AND SINCE 0015, IN THE DOCUMENT'S DIRECTION AS WELL AS ITS SIDE
 *
 * `side` alone was enough while only CHARGE documents could be settled. A credit note is
 * on the sales side and moves receivables the other way, so its movement in the side's
 * signing is NEGATIVE — and `movement - allocated` on a credit note with a refund against
 * it would have driven the figure further from zero with every rupee actually refunded.
 *
 * `facing` is that fixed, and it is one multiplication rather than a second query or a
 * second set of rules: a refund document's figures are read with the sign flipped, so
 * "how much of this is still unsettled" comes out POSITIVE for all four kinds and a
 * negative still means the one thing it always meant. Everything else in this file — the
 * movement query, the allocation sum, the reversal netting — is untouched, because none
 * of it was wrong.
 *
 * ---------------------------------------------------------------------------
 * AND SINCE 0016, TWO SOURCES OF SETTLEMENT RATHER THAN ONE
 *
 * A voucher is not the only thing that settles a document. A credit note set against an
 * invoice settles it just as a receipt does, with no money moving — `document_offsets` is
 * the matching row for it, and every figure below is now
 *
 *   the movement, in the document's own facing,
 *   less what has been allocated to it from vouchers,
 *   less what has been offset against it from documents.
 *
 * ONE ROW IS READ BY BOTH ENDS, and that is the whole trick. An offset names a charge and
 * a refund, and it reduces what is unsettled on BOTH — because both figures are already
 * read in their own facing, so "what is left of this" points the same way whichever
 * document you are holding. No sign is applied to an offset anywhere in this file.
 *
 * WHICH IS ALSO WHY THE IDENTITY STILL HOLDS. Every matching row is subtracted at two
 * ends whose movements point opposite ways in the account's signing, so it cancels
 * exactly out of the control balance — which is what "an offset moves no money" means
 * arithmetically rather than as a claim. `ageing.test.ts` asserts it as a tie.
 */

import { D, ZERO, toMoneyString, type Decimal } from '@main/domain/money'
import { correctsKind, definitionOf, type DocumentKind } from '@main/domain/documents'
import { settles, type ReceiptKind } from '@shared/receipts'
import type { DateString } from '@shared/scalars'

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
 * ONE DOCUMENT THROUGH THE BATCH, rather than a second query saying the same thing. It
 * was written as its own query first, and a mutation pass found what that costs: the
 * reversal arm could be deleted from the BATCH with nothing failing, because the only
 * test that cancels a document went through this function and this function had its own
 * copy. Two implementations of one rule means each of them can be broken alone, and the
 * suite covers whichever one it happens to call. The cost of folding them together is one
 * `Map` allocation per call.
 */
export async function documentMovement(db: CofferDb, document: DocumentControl): Promise<Decimal> {
  return (await movementsFor(db, document.partyId, [document])).get(document.id) ?? ZERO
}

/**
 * A figure turned round into the DOCUMENT's own facing.
 *
 * A charge is already facing that way and comes back untouched; a refund's sign is
 * flipped. What that buys is one subtraction that is right for all four kinds: an
 * allocation always REDUCES what is unsettled, whichever way the document points, and a
 * refund is the case where the account's direction and the document's disagree.
 *
 * IT TAKES THE KIND AND NOT THE MOVEMENT, which is the part worth reading. Deriving the
 * facing from the movement's own sign would look identical on every row this codebase has
 * a test for and would be wrong on two it does not: a document that has come to nothing
 * has no sign to read, and an over-allocated one has the WRONG sign — so a credit note
 * refunded past its face value would flip to being treated as a charge, and the figure
 * naming the mistake would come back positive and look correct.
 */
function facing(kind: string, value: Decimal): Decimal {
  return definitionOf(kind as DocumentKind).direction === 'refund' ? value.negated() : value
}

/**
 * What a caller is in the middle of rewriting, and therefore wants left out.
 *
 * ONE EXCLUSION, AND IT WAS TWO UNTIL A MUTATION PASS SAID OTHERWISE. The symmetry is
 * tempting — the receipt editor replaces one voucher's allocations, so surely the offset
 * panel replaces one refund document's offsets — but the second one had no caller: the
 * panel goes through the PICKER, which has its own exclusion, and `setOffsets` deletes
 * its rows before it reads anything. A parameter nothing passes is a line no test can
 * reach and no mutation can kill, and the codebase's answer to that is to remove it
 * rather than label it (`movementsFor`, one function down).
 *
 * An object rather than a positional argument, because the picker's options extend this
 * one and the two exclusions read as one idea at the call sites that have both.
 */
export interface UnsettledOptions {
  /** Treat this voucher's allocations as available again. */
  exceptReceiptId?: string
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
 * What has been offset against one document, from the other end of every match.
 *
 * EITHER END, AND ONE FUNCTION FOR BOTH. A row names a charge and a refund; asked about
 * an invoice it is the refund end that matters, and asked about a credit note it is the
 * charge end. The question — "how much of this has been settled by a document rather
 * than by money" — is the same question, so it is one query with an `OR` rather than two
 * functions a caller has to choose between correctly.
 *
 * NO EXCLUSION HERE, where `allocatedToDocument` above has one. Nothing needs it: the
 * only caller that replaces a set of offsets deletes them first, and the picker that has
 * to put a set back on the table goes through `offsetsByDocument`, which does carry one.
 * See `UnsettledOptions`.
 */
export async function offsetToDocument(db: CofferDb, documentId: string): Promise<Decimal> {
  const rows = await db
    .selectFrom('document_offsets')
    .select('amount')
    .where((eb) =>
      eb.or([eb('charge_document_id', '=', documentId), eb('refund_document_id', '=', documentId)]),
    )
    .execute()
  return rows.reduce<Decimal>((total, row) => total.plus(D(row.amount)), ZERO)
}

/**
 * What one document still has against it, in the DOCUMENT's own facing.
 *
 * The whole sentence at the top of this file, as one function. Negative is possible and
 * is not defended against here — it means more has been allocated than the document put
 * on the account, which is a state the repository refuses to create and which a report
 * should show rather than hide if a file ever holds one.
 *
 * `facing` is what makes that last sentence still true for a REFUND document. A credit
 * note's movement on the account is negative, so without it a credit note with nothing
 * refunded would read as -1,180 outstanding and every rupee actually paid back would take
 * it further from zero — and a negative would then mean two opposite things depending on
 * which kind you were holding.
 *
 * TWO SUBTRACTIONS SINCE 0016, and they are two only because they read two tables. A
 * credit note settled by a refund voucher and one settled by an offset against an invoice
 * are the same amount of settled, and both come off the same figure in the same
 * direction — which is what reading everything in the document's own facing bought.
 */
export async function outstandingForDocument(
  db: CofferDb,
  document: DocumentControl,
  options: UnsettledOptions = {},
): Promise<Decimal> {
  const movement = await documentMovement(db, document)
  const allocated = await allocatedToDocument(db, document.id, options.exceptReceiptId)
  const offset = await offsetToDocument(db, document.id)
  return facing(document.kind, movement).minus(allocated).minus(offset)
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

/**
 * Refuse to cancel a document standing at either end of an offset.
 *
 * `assertNotAllocated`'s twin, and the sentence is deliberately not the same. There the
 * remedy is on a receipt the user has to go and find; here it is on the OTHER DOCUMENT,
 * which is a different place to send somebody — so the message names the count rather
 * than a figure alone, because "1,180.00 has been offset" leaves a user looking for money
 * that never moved.
 *
 * 0016 enforces the same rule as a trigger on the transition, watching both ends. This is
 * the half that can say which.
 */
export async function assertNotOffset(db: CofferDb, documentId: string): Promise<void> {
  const offset = await offsetToDocument(db, documentId)
  if (offset.isZero()) return

  throw new RepoError(
    'DOCUMENT_OFFSET',
    `${toMoneyString(offset)} of this document is settled by an offset against another. ` +
      'Take the offset off first, so the other document goes back to being unsettled ' +
      'somewhere you can see it.',
    { documentId, offset: toMoneyString(offset) },
  )
}

// ---- Several documents at once ---------------------------------------------

/*
 * The batch versions, for the two screens that need them: a picker showing a customer's
 * open invoices, and an invoice showing what has been paid against it.
 *
 * Written as batches rather than as a loop over the single-document functions above, and
 * that is not premature: a picker for a customer with two hundred open invoices would
 * otherwise be four hundred queries opened one at a time inside one IPC call, which is
 * the shape `listDocuments` already refuses for its lines.
 */

/** A document with something still against it, as a picker lists one. */
export interface OpenDocumentRow {
  id: string
  kind: string
  /** Never null: only an issued document can be open, and those all have numbers. */
  number: string
  date: DateString
  grandTotal: Decimal
  outstanding: Decimal
}

/**
 * What each of several documents put on its party's account.
 *
 * One query for the lines and one fold, keyed by the ORIGINAL entry — a reversal is
 * folded into the entry it reverses, which is what makes a cancelled document come to
 * zero without a status filter anywhere (see the header).
 */
async function movementsFor(
  db: CofferDb,
  partyId: string,
  documents: readonly DocumentControl[],
): Promise<Map<string, Decimal>> {
  const totals = new Map<string, Decimal>()
  const entryIds = documents
    .map((document) => document.entryId)
    .filter((id): id is string => id !== null)
  if (entryIds.length === 0) return totals

  const rows = await db
    .selectFrom('journal_lines')
    .innerJoin('journal_entries', 'journal_entries.id', 'journal_lines.entry_id')
    .select([
      'journal_entries.id as entry_id',
      'journal_entries.reverses_entry_id as reverses_entry_id',
      'journal_lines.debit as debit',
      'journal_lines.credit as credit',
    ])
    .where('journal_lines.party_id', '=', partyId)
    .where((eb) =>
      eb.or([
        eb('journal_entries.id', 'in', entryIds),
        eb('journal_entries.reverses_entry_id', 'in', entryIds),
      ]),
    )
    .execute()

  const byEntry = new Map<string, Decimal>()
  for (const row of rows) {
    /*
     * A reversal counts against what it reverses, which is what makes a cancelled
     * document come to nothing with no status filter anywhere.
     *
     * There was a guard here skipping a key that is not in `entryIds`, and a mutation
     * pass showed it was dead: the WHERE above fetches only rows whose entry is in the
     * set or whose entry reverses one that is, so every key this loop computes is in the
     * set by construction. Removed rather than labelled — an unreachable branch is a
     * thing the next reader has to work out before they can ignore it.
     */
    const key = row.reverses_entry_id ?? row.entry_id
    byEntry.set(key, (byEntry.get(key) ?? ZERO).plus(D(row.debit)).minus(D(row.credit)))
  }

  for (const document of documents) {
    if (document.entryId === null) continue
    const raw = byEntry.get(document.entryId) ?? ZERO
    const side = definitionOf(document.kind as DocumentKind).side
    totals.set(document.id, side === 'sales' ? raw : raw.negated())
  }
  return totals
}

/** What has been allocated to each of several documents, in one query. */
async function allocatedByDocument(
  db: CofferDb,
  documentIds: readonly string[],
  exceptReceiptId?: string,
): Promise<Map<string, Decimal>> {
  const totals = new Map<string, Decimal>()
  if (documentIds.length === 0) return totals

  let query = db
    .selectFrom('receipt_allocations')
    .select(['document_id', 'amount'])
    .where('document_id', 'in', [...documentIds])
  if (exceptReceiptId !== undefined) {
    query = query.where('receipt_id', '!=', exceptReceiptId)
  }

  for (const row of await query.execute()) {
    totals.set(row.document_id, (totals.get(row.document_id) ?? ZERO).plus(D(row.amount)))
  }
  return totals
}

/**
 * What has been offset against each of several documents, in one query.
 *
 * A ROW IS COUNTED UNDER BOTH OF ITS ENDS, which is the difference from
 * `allocatedByDocument` and the reason this could not be one query with it. An offset
 * between INV/7 and CRN/2 reduces both, so when a picker is listing both — which it never
 * does, since a picker lists one kind — the same row appears twice on purpose.
 */
async function offsetsByDocument(
  db: CofferDb,
  documentIds: readonly string[],
  exceptRefundDocumentId?: string,
): Promise<Map<string, Decimal>> {
  const totals = new Map<string, Decimal>()
  if (documentIds.length === 0) return totals

  const ids = [...documentIds]
  let query = db
    .selectFrom('document_offsets')
    .select(['charge_document_id', 'refund_document_id', 'amount'])
    .where((eb) =>
      eb.or([eb('charge_document_id', 'in', ids), eb('refund_document_id', 'in', ids)]),
    )
  if (exceptRefundDocumentId !== undefined) {
    query = query.where('refund_document_id', '!=', exceptRefundDocumentId)
  }

  for (const row of await query.execute()) {
    for (const id of [row.charge_document_id, row.refund_document_id]) {
      /* The `OR` above brings back rows whose OTHER end is out of scope, so each id is
       * tested rather than trusted. Adding a figure under a document the caller never
       * asked about would be harmless in the map and wrong the moment somebody iterated
       * it instead of looking up. */
      if (!documentIds.includes(id)) continue
      totals.set(id, (totals.get(id) ?? ZERO).plus(D(row.amount)))
    }
  }
  return totals
}

export interface OpenDocumentsOptions {
  partyId: string
  /**
   * The voucher the picker is being filled for, which decides what it may list.
   *
   * A SIDE UNTIL 0015, and a side is no longer enough: a receipt and a refund are both
   * sales-side vouchers and they settle different documents. `settles()` answers it from
   * one place — see the note it carries about an allocation being two movements on one
   * account pointing opposite ways.
   */
  kind: ReceiptKind
  /**
   * Treat this receipt's allocations as available again.
   *
   * For the editor: opening a receipt that already settles INV/0007 in full must show
   * INV/0007 with that money back on it, or the user cannot see what they allocated and
   * cannot reduce it. Without this the list would simply not contain the invoice the
   * screen is displaying a line for.
   */
  exceptReceiptId?: string
}

/**
 * A party's documents with something still against them, oldest first.
 *
 * OLDEST FIRST, which is the one ordering decision here and it is not cosmetic: money
 * received without instructions settles the oldest invoice, and a picker that listed the
 * newest first would invite the opposite. `listDocuments` sorts newest first for the
 * opposite reason — a register is read as "what have I raised lately".
 *
 * A document whose outstanding has reached zero is left out; one that has gone NEGATIVE
 * is not, because that is a state worth seeing rather than hiding.
 */
export async function openDocumentsFor(
  db: CofferDb,
  options: OpenDocumentsOptions,
): Promise<OpenDocumentRow[]> {
  /*
   * ONE KIND, AND WHICH ONE IS THE VOUCHER'S BUSINESS. A receipt reduces what a customer
   * owes; a credit note ALSO reduces what a customer owes. Both are sales-side documents
   * that post, so a picker filtered on the side alone would offer a credit note as
   * something an incoming receipt could settle — money arriving to pay off a refund,
   * which reads to the ledger as a customer paying us for a return we gave them. It could
   * not have been noticed before 0013, because nothing else posted.
   *
   * 0013-3 fixed that by writing `charge` into the filter, which was right for as long as
   * a receipt was the only voucher on its side. IT IS NOT ANY MORE: a refund settles the
   * credit note, and the same picker fills for it. `settles()` is the one place that
   * decides, and it REFUSES an ambiguous table rather than returning the first match, so
   * the `= ?` below is safe in a way `in (…)` never said out loud.
   */
  return openOfKind(db, {
    partyId: options.partyId,
    kind: settles(options.kind),
    exceptReceiptId: options.exceptReceiptId,
  })
}

/**
 * What one refund document may be set against, or a refusal naming what it is.
 *
 * `correctsKind` is 0013's mapping and 0016's trigger, read from the third place that
 * needs it — and it answers null for anything that settles nothing, which is a screen
 * asking the wrong document for its offsets rather than a user error. So the sentence
 * says which document to open instead, and there is ONE of it: the picker and the write
 * path both come through here, because two copies of "a sales invoice settles nothing"
 * is two chances to disagree about which end of a match owns the set.
 */
export function offsetKindFor(document: DocumentControl): DocumentKind {
  const kind = correctsKind(document.kind as DocumentKind)
  if (kind === null) {
    throw new RepoError(
      'OFFSET_KIND_MISMATCH',
      `A ${definitionOf(document.kind as DocumentKind).label.toLowerCase()} settles nothing — ` +
        'it is what gets settled. An offset is set from the credit or debit note.',
      { documentId: document.id, documentKind: document.kind },
    )
  }
  return kind
}

/**
 * The charge documents one refund document may be set against, oldest first.
 *
 * The offset panel's picker, and it takes the DOCUMENT rather than a party and a kind
 * because both of those are already on it — and because a picker that took them
 * separately could be handed a credit note belonging to one customer and a party id
 * belonging to another, which is the failure 0016's `same_party` trigger exists for. One
 * argument cannot disagree with itself.
 *
 * What it may be set against is `offsetKindFor`'s answer, which is where the refusal for
 * a document that settles nothing lives.
 */
export async function openChargesFor(
  db: CofferDb,
  refund: DocumentControl,
): Promise<OpenDocumentRow[]> {
  return openOfKind(db, {
    partyId: refund.partyId,
    kind: offsetKindFor(refund),
    /* Its own offsets, back on the table it is drawing. Without this the panel would list
     * every invoice EXCEPT the ones it is already showing lines for. */
    exceptRefundDocumentId: refund.id,
  })
}

/** What both pickers actually ask for, once the kind has been decided. */
interface OpenOfKindOptions extends UnsettledOptions {
  partyId: string
  kind: DocumentKind
  /**
   * Treat this refund document's offsets as available again.
   *
   * The offset panel's, and it is live rather than defensive: opening a note that already
   * settles INV/0007 in full must show INV/0007 with that credit back on it, or the panel
   * lists every invoice except the ones it is drawing lines for.
   */
  exceptRefundDocumentId?: string
}

async function openOfKind(db: CofferDb, options: OpenOfKindOptions): Promise<OpenDocumentRow[]> {
  const kind = options.kind

  /*
   * `status = 'issued'` LOOKS REDUNDANT BESIDE THE ZERO TEST BELOW and is not quite. A
   * draft has no entry so its movement is nothing, and a cancelled document's reversal
   * nets it to nothing, so the arithmetic alone would drop both. What it also drops is a
   * DRAFT CARRYING AN ENTRY — which 0008's CHECKs permit, since they only constrain the
   * number and the stamps — and that one has a real movement and would be offered for
   * settlement. There is a test that builds exactly that row.
   */
  const rows = await db
    .selectFrom('documents')
    .select(['id', 'kind', 'number', 'document_date', 'party_id', 'entry_id'])
    .where('party_id', '=', options.partyId)
    .where('status', '=', 'issued')
    .where('kind', '=', kind)
    .orderBy('document_date', 'asc')
    .orderBy('number', 'asc')
    .execute()

  const documents = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    partyId: row.party_id,
    entryId: row.entry_id,
  }))

  const ids = rows.map((row) => row.id)
  const movements = await movementsFor(db, options.partyId, documents)
  const allocated = await allocatedByDocument(db, ids, options.exceptReceiptId)
  const offset = await offsetsByDocument(db, ids, options.exceptRefundDocumentId)

  const open: OpenDocumentRow[] = []
  for (const row of rows) {
    /* In the DOCUMENT's facing, so a credit note offers the refund screen the money it
     * has left rather than that figure with a minus in front of it. Every row here is of
     * one kind, so the flip is the same for all of them. */
    const movement = facing(row.kind, movements.get(row.id) ?? ZERO)
    const outstanding = movement
      .minus(allocated.get(row.id) ?? ZERO)
      .minus(offset.get(row.id) ?? ZERO)
    if (outstanding.isZero()) continue
    open.push({
      id: row.id,
      kind: row.kind,
      /* Never null while `status = 'issued'` — rule 2 of the document contract. The
       * fallback keeps the DTO honest rather than pushing an assertion into a screen. */
      number: row.number ?? '',
      date: row.document_date,
      grandTotal: movement,
      outstanding,
    })
  }
  return open
}

/** One receipt's part in settling one document, as an invoice screen lists it. */
export interface SettlementRow {
  receiptId: string
  number: string
  date: DateString
  amount: Decimal
}

/**
 * One offset's part in settling one document, from the OTHER end of the match.
 *
 * The document named here is never the one being asked about: an invoice's panel lists
 * the credit notes set against it, and a credit note's lists the invoices it settles. One
 * row read from two directions, which is what the table is.
 */
export interface SettlementOffsetRow {
  offsetId: string
  documentId: string
  kind: string
  number: string
  date: DateString
  amount: Decimal
}

export interface DocumentSettlementResult {
  movement: Decimal
  allocated: Decimal
  /** What documents rather than money have settled. Zero until somebody says otherwise. */
  offset: Decimal
  outstanding: Decimal
  receipts: SettlementRow[]
  offsets: SettlementOffsetRow[]
}

/**
 * What has settled one document, from both sources, and what is left.
 *
 * The receipts are ordered by their own date, which is when the money arrived — not by
 * when somebody matched it, which nothing records on purpose (rule 2). The offsets are
 * ordered by the date of the document at the other end, for the same reason: an offset
 * has no date of its own and is not going to grow one.
 */
export async function settlementFor(
  db: CofferDb,
  document: DocumentControl,
): Promise<DocumentSettlementResult> {
  /* The document's own facing, for the reason the picker uses it: this figure is read by
   * a human beside the word "outstanding", and a credit note's is what is left to refund
   * or to offset, not a negative amount owed. */
  const movement = facing(document.kind, await documentMovement(db, document))

  const rows = await db
    .selectFrom('receipt_allocations')
    .innerJoin('receipts', 'receipts.id', 'receipt_allocations.receipt_id')
    .select([
      'receipts.id as receipt_id',
      'receipts.number as number',
      'receipts.receipt_date as receipt_date',
      'receipt_allocations.amount as amount',
    ])
    .where('receipt_allocations.document_id', '=', document.id)
    .orderBy('receipts.receipt_date', 'asc')
    .orderBy('receipts.number', 'asc')
    .execute()

  const receipts = rows.map((row) => ({
    receiptId: row.receipt_id,
    number: row.number,
    date: row.receipt_date,
    amount: D(row.amount),
  }))
  const allocated = receipts.reduce<Decimal>((total, row) => total.plus(row.amount), ZERO)

  const offsets = await offsetsOn(db, document.id)
  const offset = offsets.reduce<Decimal>((total, row) => total.plus(row.amount), ZERO)

  return {
    movement,
    allocated,
    offset,
    outstanding: movement.minus(allocated).minus(offset),
    receipts,
    offsets,
  }
}

/**
 * Every offset one document stands at either end of, described by the other end.
 *
 * TWO JOINS TO ONE TABLE AND A CHOICE IN TYPESCRIPT, rather than a `UNION` of two queries
 * or a `CASE` picking columns in SQL. Both alternatives write "which end am I" twice, and
 * the whole hazard of a table with two foreign keys to one table is a reader — or an
 * editor — getting the ends the wrong way round in one of the two copies.
 */
async function offsetsOn(db: CofferDb, documentId: string): Promise<SettlementOffsetRow[]> {
  const rows = await db
    .selectFrom('document_offsets')
    .innerJoin('documents as charge', 'charge.id', 'document_offsets.charge_document_id')
    .innerJoin('documents as refund', 'refund.id', 'document_offsets.refund_document_id')
    .select([
      'document_offsets.id as id',
      'document_offsets.amount as amount',
      'document_offsets.charge_document_id as charge_id',
      'charge.kind as charge_kind',
      'charge.number as charge_number',
      'charge.document_date as charge_date',
      'document_offsets.refund_document_id as refund_id',
      'refund.kind as refund_kind',
      'refund.number as refund_number',
      'refund.document_date as refund_date',
    ])
    .where((eb) =>
      eb.or([
        eb('document_offsets.charge_document_id', '=', documentId),
        eb('document_offsets.refund_document_id', '=', documentId),
      ]),
    )
    .execute()

  return rows
    .map((row) => {
      const other =
        row.charge_id === documentId
          ? {
              id: row.refund_id,
              kind: row.refund_kind,
              number: row.refund_number,
              date: row.refund_date,
            }
          : {
              id: row.charge_id,
              kind: row.charge_kind,
              number: row.charge_number,
              date: row.charge_date,
            }
      return {
        offsetId: row.id,
        documentId: other.id,
        kind: other.kind,
        /* Never null: 0016 refuses an offset unless both ends are issued, and rule 2 of
         * the document contract gives every issued document a number. */
        number: other.number ?? '',
        date: other.date,
        amount: D(row.amount),
      }
    })
    .sort((left, right) =>
      left.date === right.date
        ? left.number.localeCompare(right.number)
        : left.date < right.date
          ? -1
          : 1,
    )
}
