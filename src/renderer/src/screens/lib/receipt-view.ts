/*
 * The receipt register's vocabulary, and the shapes the editor holds.
 *
 * Split out of the two screens for the reason every `screens/lib` module is: what can be
 * tested as a function should be, so a component test is left asserting what is on the
 * page rather than re-deriving what should be.
 *
 * NOTHING HERE ADDS UP MONEY, and the receipt editor is the second screen where that
 * costs something visible. A user typing allocations wants to see what is left of the
 * receipt, and this cannot tell them: adding the amounts they have typed is money
 * arithmetic (CONVENTIONS §1.7). What the screen does instead is what the invoice editor
 * does — save, and show what main returned, marked as belonging to the last saved
 * version while there are unsaved edits.
 *
 * WHAT REPLACES IT IS `outstanding`, WHICH MAIN ALREADY SENT. Every open document
 * arrives carrying what is left on it as a string, so "settle this one in full" is a
 * COPY rather than a sum — see `settleInFull`. That is most of the convenience with none
 * of the arithmetic, and it is exact by construction: the figure the screen puts in the
 * box is the figure main computed.
 */

import type { BadgeTone } from '@renderer/components/atoms'
import type { AllocationInput, OpenDocument, ReceiptStatusDto } from '@shared/dto'

/**
 * The kind these screens record.
 *
 * `receipts` is one table for both directions and a payment posts perfectly well today,
 * but a register that mixed money out into a list of money in would invite reading a
 * total that means nothing. Payments get their own screen when purchase bills get their
 * posting rule; until then there is nothing for one to settle.
 */
export const RECEIPT_KIND = 'receipt'

/**
 * Rows drawn per page.
 *
 * `listReceipts` caps a page at `MAX_RECEIPT_PAGE` (500) whatever it is asked for, so a
 * register that did not page would show the first page of a busy year and look complete.
 * The same 50 the invoice register uses, for the same reason: it fits without scrolling
 * past the toolbar.
 */
export const PAGE_SIZE = 50

const STATUS_LABELS: Readonly<Record<ReceiptStatusDto, string>> = {
  posted: 'Posted',
  cancelled: 'Cancelled',
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status as ReceiptStatusDto] ?? status
}

/**
 * The badge a status wears.
 *
 * Two states rather than the invoice register's three, and the accent has nowhere to go:
 * there is no draft, so no row has anything left to do. Posted is the settled normal and
 * cancelled recedes, exactly as `statusTone` in invoice-view.ts argues — a cancelled
 * receipt is how a bounced cheque is recorded properly, not a warning.
 */
export function statusTone(status: string): BadgeTone {
  return status === 'posted' ? 'positive' : 'neutral'
}

/** The status buttons, in the order a register is scanned. `''` is no filter. */
export function statusFilters(): ReadonlyArray<{ value: ReceiptStatusDto | ''; label: string }> {
  return [
    { value: '', label: 'All' },
    { value: 'posted', label: 'Posted' },
    { value: 'cancelled', label: 'Cancelled' },
  ]
}

// ---- What may be done to a receipt in each state ----------------------------

/*
 * Two verbs, not four. These mirror rule 1 in src/main/domain/receipts/types.ts rather
 * than restating it:
 *
 *   posted     allocate, cancel
 *   cancelled  nothing
 *
 * There is no edit and no delete anywhere in this file, and that is the contract. A
 * receipt records money that has already moved, so the only correction is a cancel; and a
 * number handed out is never released, so there is nothing to remove.
 */

/**
 * Allocating is the one thing about a posted receipt that may still change.
 *
 * Consistent rather than a hole in the freeze: an allocation moves no money and writes no
 * entry (rule 2). A business changes its mind about which invoice a payment settles
 * without anything in the ledger being wrong.
 */
export function canAllocate(status: ReceiptStatusDto): boolean {
  return status === 'posted'
}

/** Cancelling reverses the entry, drops what it settled, and KEEPS the number. */
export function canCancel(status: ReceiptStatusDto): boolean {
  return status === 'posted'
}

/** What the status line says the receipt is, in a sentence rather than a word. */
export function stateSentence(status: ReceiptStatusDto, number: string): string {
  if (status === 'cancelled') {
    return `Cancelled. ${number} is kept, and what it posted has been reversed.`
  }
  return `Posted as ${number}. The money is in the books; what it settles can still change.`
}

// ---- Allocations, as the form holds them ------------------------------------

/** One line of "these are the invoices this money pays". */
export interface AllocationDraft {
  documentId: string
  /** A string, because that is what an input carries. Blank means "none of it". */
  amount: string
}

/**
 * The allocation lines for a set of open documents, seeded from what is already matched.
 *
 * Keyed by document rather than held as a list, because the picker's rows ARE the
 * documents: a receipt cannot allocate to the same invoice twice (0012's UNIQUE), so
 * there is exactly one line per open document and no way to add or remove one.
 */
export function draftAllocations(
  open: readonly OpenDocument[],
  existing: readonly { documentId: string; amount: string }[],
): Record<string, string> {
  const byDocument = new Map(existing.map((row) => [row.documentId, row.amount]))
  const drafts: Record<string, string> = {}
  for (const document of open) {
    drafts[document.id] = byDocument.get(document.id) ?? ''
  }
  return drafts
}

/**
 * What "settle this one in full" puts in the box.
 *
 * A COPY of what main sent, never a sum. `outstanding` was computed in the main process
 * against the ledger, so the figure the screen writes is exact by construction — where
 * anything the renderer worked out would be a second answer to the same question, and
 * would disagree the first time a receipt was already part-allocated.
 */
export function settleInFull(document: OpenDocument): string {
  return document.outstanding
}

/**
 * The allocations to send, dropping the lines the user left blank.
 *
 * A BLANK IS NOT A ZERO. `AllocationInput.amount` must be positive — an allocation of
 * nothing is not a statement, and main refuses one — so a row nobody filled in is left
 * out rather than sent as '0.00'. A row typed as `0` IS sent, and main refuses it with a
 * sentence: the user meant something by typing it, and silently dropping it would leave
 * them looking at a figure the books do not have.
 */
export function toAllocationInputs(
  drafts: Readonly<Record<string, string>>,
): readonly AllocationInput[] {
  return Object.entries(drafts)
    .filter(([, amount]) => amount.trim() !== '')
    .map(([documentId, amount]) => ({ documentId, amount: amount.trim() }))
}
