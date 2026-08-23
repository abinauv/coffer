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
import {
  chargeKindOn,
  definitionOf,
  type DocumentKind,
  type TradeSide,
} from '@main/domain/documents'
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

export interface OpenDocumentsOptions {
  partyId: string
  /** Which half of the trade. A receipt settles sales; a payment settles purchases. */
  side: TradeSide
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
   * CHARGES ONLY, AND THE `direction` TEST IS NOT COSMETIC. A receipt reduces what a
   * customer owes; a credit note ALSO reduces what a customer owes. Both are sales-side
   * documents that post, so until this filter existed the picker would have offered a
   * credit note as something an incoming receipt could settle — which is money arriving
   * to pay off a refund, and reads to the ledger as a customer paying us for a return we
   * gave them. It could not have been noticed before 0013, because nothing else posted.
   *
   * What settles a refund is a refund: paying a credit note is money going OUT, which is
   * a payment, and matching one against an invoice instead is offsetting — neither of
   * which this picker is. Both are owed work, and both are the next unit rather than a
   * widening of this filter.
   *
   * ONE KIND, NOT A LIST, AS OF 0013-3. This filter was written out here and it is the
   * same sentence `correctsKind` is built from and the same one the receipt screen heads
   * its allocation table with — three copies of "the one charge kind on this side that
   * posts", agreeing by inspection. `chargeKindOn` is that sentence said once, and it
   * REFUSES an ambiguous table rather than returning the first match, so the `= ?` below
   * is safe in a way `in (…)` never said out loud.
   */
  const kind = chargeKindOn(options.side)

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

  const movements = await movementsFor(db, options.partyId, documents)
  const allocated = await allocatedByDocument(
    db,
    rows.map((row) => row.id),
    options.exceptReceiptId,
  )

  const open: OpenDocumentRow[] = []
  for (const row of rows) {
    const movement = movements.get(row.id) ?? ZERO
    const outstanding = movement.minus(allocated.get(row.id) ?? ZERO)
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

export interface DocumentSettlementResult {
  movement: Decimal
  allocated: Decimal
  outstanding: Decimal
  receipts: SettlementRow[]
}

/**
 * What has been paid against one document, and what is left.
 *
 * The receipts are ordered by their own date, which is when the money arrived — not by
 * when somebody matched it, which nothing records on purpose (rule 2).
 */
export async function settlementFor(
  db: CofferDb,
  document: DocumentControl,
): Promise<DocumentSettlementResult> {
  const movement = await documentMovement(db, document)

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

  return { movement, allocated, outstanding: movement.minus(allocated), receipts }
}
