/*
 * The receipt contract — money received from a customer, money paid to a vendor, and
 * which invoices it settles.
 *
 * A receipt is the other half of an invoice. Phase 2 built the half that says what is
 * owed; this is the half that says what has been paid. Types and pure definitions only,
 * the same as `domain/documents` beside it: no I/O, no clock, and nothing that knows a
 * tax regime exists.
 *
 * ---------------------------------------------------------------------------
 * THREE RULES
 *
 * 1. A RECEIPT IS POSTED THE MOMENT IT EXISTS. There is no draft. A trade document has a
 *    draft stage because an invoice is built up before it means anything, and the number
 *    and the legal weight attach at the moment it is issued. A receipt records money that
 *    has ALREADY MOVED — it is a statement about the past, not a proposal — so there is
 *    nothing to build up and nothing to decide later.
 *
 *    That is not a convenience. A draft receipt would be a row saying money arrived that
 *    the ledger has not seen, and a customer's balance that disagrees with the payment
 *    they made and can quote the reference for. It is exactly the window rule 3 forbids
 *    for documents, arriving under a different name. So `number` and `entryId` are both
 *    required here, where a document's are nullable, and 0012 writes both as NOT NULL.
 *
 *    A mistake is corrected the way an issued invoice is: the entry is reversed, the
 *    number is kept, the status becomes `cancelled`. Rule 50 wants a receipt voucher
 *    series consecutive for exactly the reason rule 46(b) wants an invoice series
 *    consecutive, so nothing hands a number back.
 *
 * 2. ALLOCATION IS NOT A LEDGER EVENT, AND THIS IS THE ONE TO READ TWICE. Both the
 *    invoice's debit and the receipt's credit already carry the party's id, so the
 *    control account and the party's balance are correct the instant the receipt posts,
 *    whether or not anybody has said WHICH invoice it pays. Saying which is a matching
 *    record and nothing more: it moves no money, posts no entry and changes no balance.
 *
 *    Which is why an allocation may be changed afterwards while a posted entry may not,
 *    and why the two facts do not contradict each other. A receipt with nothing allocated
 *    is money on account — an ordinary thing a business has, not an unfinished task.
 *
 * 3. WHAT IS OUTSTANDING IS STILL A LEDGER FACT. `domain/documents/types.ts` says it and
 *    nothing here weakens it: an invoice's outstanding is the movement its entry made on
 *    the party's control account, LESS what has been allocated against it. There is no
 *    `paid` status, no `amount_paid` column and no `outstanding` column, in either table.
 *
 *    The identity that falls out of it is worth writing down, because every report in
 *    Phase 3 depends on it:
 *
 *      party control balance  =  SUM(document outstanding)  -  SUM(receipt unallocated)
 *
 *    Both sides read the same allocation rows, so an aged report and the balance sheet
 *    cannot disagree — but only if the report SHOWS the unallocated money rather than
 *    quietly dropping it. A receipt on account is not an error and must not be hidden.
 *
 * ---------------------------------------------------------------------------
 * ONE TABLE FOR BOTH DIRECTIONS
 *
 * A payment to a vendor is a receipt with the two lines swapped and the control account
 * changed. Everything else — a party, a date, an amount, a bank account, a reference,
 * a set of allocations, and every rule above — is identical. So `kind` says which one it
 * is, exactly as it does for the five trade documents, and for the same reason: two
 * tables would be two copies of the allocation rules, and the second copy is where the
 * cross-party check gets forgotten.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO `method` COLUMN, AND THAT IS DELIBERATE
 *
 * Cash, NEFT, IMPS, UPI, cheque, card. The obvious column, and it was considered and not
 * written. The account the money moved through already says cash or bank, which is the
 * only part of it any report here groups by; the difference between NEFT and IMPS changes
 * nothing in these books. What a user actually needs is the thing that identifies the
 * money on a bank statement, and that is `reference` — a cheque number, a UTR, a UPI
 * reference — which is free text because it is somebody else's format.
 *
 * The cost of being wrong about that is asymmetric, which is what settled it. A closed
 * list in a CHECK is a table rebuild on the day somebody's payment app is not on it; a
 * free-text reference that later wants grouping is a column somebody adds.
 */

import { ZERO, type Decimal } from '@main/domain/money'
import type { AccountRole, SourceDocumentType } from '@main/domain/ledger'
import { receiptDefinitionOf, type ReceiptKind } from '@shared/receipts'
import type { DateString } from '@shared/scalars'

// ---- Kinds -----------------------------------------------------------------

/*
 * THE TABLE ITSELF LIVES IN `@shared/receipts`, and it moved there in 0013-3 — one batch
 * after the document kinds moved, for the same reason and with the same split.
 *
 * The screens need to know what a payment is called, whose side it is on and which way
 * the money went; the renderer cannot import `@main/*`. What stays here is what the
 * LEDGER does with a kind, which is an `AccountRole` and a `SourceDocumentType` — the
 * ledger's own vocabulary, and nothing a screen can use.
 */

export type { MoneyDirection, ReceiptKind, ReceiptKindDefinition } from '@shared/receipts'

export {
  RECEIPT_KINDS,
  receiptDefinitionOf,
  receiptFacing,
  settledBy,
  settledByIn,
  settledDirection,
  settles,
  settlesSide,
} from '@shared/receipts'

/** What the ledger does with a voucher of one kind. */
export interface ReceiptTreatment {
  /**
   * The control account this kind moves.
   *
   * A role and never a code, the same as every posting rule: a rule asks for where
   * receivables go, never for `1100`. It is stated rather than derived from `side`
   * because the derivation would be two facts agreeing, which is the shape gate 2.0's
   * `levy` field turned out to be — except here they would agree by coincidence rather
   * than by meaning, since nothing says a sales-side voucher must move receivables.
   */
  controlRole: AccountRole
  /** What the ledger records this as. Never null — a receipt always posts. */
  sourceType: SourceDocumentType
}

/**
 * How the ledger treats each kind.
 *
 * TOTAL OVER `ReceiptKind`, which is what makes it safe: every voucher posts, so a kind
 * added to the shared table does not compile until it says which control account it moves
 * and what an entry records it as. The document side needs an `Extract`ed subset for the
 * same guarantee because a quotation posts nothing; here there is no such case, and
 * `@shared/receipts` says why it carries no `postsToLedger`.
 */
const TREATMENTS: Readonly<Record<ReceiptKind, ReceiptTreatment>> = {
  receipt: { controlRole: 'accounts-receivable', sourceType: 'receipt' },
  payment: { controlRole: 'accounts-payable', sourceType: 'payment' },
  /*
   * THE TWO ROWS THAT MAKE `controlRole` EARN ITS KEEP. A refund paid is sales-side and
   * moves RECEIVABLES, the same account a receipt moves and the opposite way; a refund
   * received is purchase-side and moves payables. A derivation from `side` would have
   * given the same four answers, which is exactly the coincidence the field's own comment
   * warns about — the difference is that here the coincidence is now visible, because
   * `direction` disagrees with `side` on two of the four rows and the control account
   * does not.
   */
  refund: { controlRole: 'accounts-receivable', sourceType: 'refund' },
  'refund-received': { controlRole: 'accounts-payable', sourceType: 'refund-received' },
}

/** What the ledger does with a voucher of this kind. */
export function receiptTreatmentOf(kind: ReceiptKind): ReceiptTreatment {
  /* `receiptDefinitionOf` first, so an unknown kind is refused with the sentence about a
   * newer build rather than reaching an index that would answer undefined. */
  receiptDefinitionOf(kind)
  return TREATMENTS[kind]
}

// ---- Status ----------------------------------------------------------------

/**
 * Where a receipt is in its life. Two states, not three.
 *
 * There is no `draft`, for rule 1, and there is no `allocated` or `settled` — how much of
 * a receipt has been matched is a sum over its allocations, and a status column would be
 * a stored balance wearing a different hat. It would also be wrong in a way nobody could
 * see: an allocation edited on the other side of the screen does not know it was supposed
 * to go back and flip a flag.
 */
export type ReceiptStatus = 'posted' | 'cancelled'

export const RECEIPT_STATUSES: readonly ReceiptStatus[] = ['posted', 'cancelled'] as const

/** A cancelled receipt is kept and listed, and settles nothing. */
export function isLiveReceipt(status: ReceiptStatus): boolean {
  return status === 'posted'
}

/** Only a receipt that has not already been cancelled may be cancelled. */
export function isCancellable(status: ReceiptStatus): boolean {
  return status === 'posted'
}

/**
 * Whether allocations may be written against a voucher in this state.
 *
 * The same answer as `isLiveReceipt` today, and a separate function on purpose: they are
 * different questions — "does this count towards what the party owes" and "may this be
 * matched to an invoice" — and a kind of receipt that counts but cannot be re-matched is
 * a thing a later phase may want. 0012 enforces this one as a trigger as well, because a
 * cancelled receipt still holding allocations takes an invoice's outstanding down with
 * money that was reversed out of the books.
 */
export function acceptsAllocations(status: ReceiptStatus): boolean {
  return status === 'posted'
}

// ---- The receipt -----------------------------------------------------------

/**
 * A receipt as the domain sees it, ready to post.
 *
 * `number` is non-null and so is everything else that matters, because rule 1 says there
 * is no state in which one of these exists without them. Compare `PostableDocument`,
 * which has to be a narrowed version of `TradeDocument` for exactly the reason this does
 * not: a document spends part of its life without a number.
 */
export interface PostableReceipt {
  id: string
  kind: ReceiptKind
  number: string
  /** The date the money moved, which is also the date it posts as of. */
  date: DateString
  partyId: string
  /**
   * How much moved. Non-negative, always.
   *
   * The DIRECTION is the kind and never the sign — the same rule `journal_lines` follows,
   * and for the same reason: a negative receipt would be a second way to say a payment,
   * and the two would disagree about which the control account should believe. A refund
   * to a customer is money OUT on the sales side, which is a third row in the table above
   * rather than a negative amount — 0012 does not build it, and the note in ./posting.ts
   * says what it would take.
   */
  amount: Decimal
  /** The bank or cash account the money moved through. Chosen, never derived. */
  accountId: string
  /** Whatever identifies this money on a statement — a cheque number, a UTR. */
  reference: string
  /** Free text that becomes the journal entry's narration. */
  narration: string
}

// ---- Allocation ------------------------------------------------------------

/**
 * How much of one receipt settles one document.
 *
 * A matching record, not a posting (rule 2). It carries no date of its own and no
 * narration: it is not an event that happened, it is a statement about two events that
 * already did, and giving it a date would invite somebody to report on it as though the
 * money moved when the matching was done.
 */
export interface ReceiptAllocation {
  id: string
  receiptId: string
  documentId: string
  /** Non-negative, and never zero — an allocation of nothing is not a statement. */
  amount: Decimal
}

/**
 * What one document has had allocated to it, from a set of allocations.
 *
 * A fold rather than a column, which is rule 3. Takes whatever it is given and sums it:
 * WHICH allocations count — a cancelled receipt's do not — is decided by the caller that
 * fetched them, because that filter belongs in the query and not in an arithmetic
 * helper that cannot see a status.
 */
export function allocatedTotal(allocations: readonly ReceiptAllocation[]): Decimal {
  return allocations.reduce<Decimal>((total, allocation) => total.plus(allocation.amount), ZERO)
}
