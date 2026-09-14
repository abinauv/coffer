/*
 * The money registers' vocabulary, and the shapes their editor holds.
 *
 * ONE REGISTER AND ONE EDITOR FOR BOTH DIRECTIONS (0013-3), the same shape the document
 * screens took in 0013-2. A receipt and a payment differ in whose money it is, which way
 * it moved, and which documents it settles — and in nothing else a screen can see. The
 * words come from `@shared/receipts`, which is where the kind table moved so that the
 * label on a button and the control account a posting rule moves are read off one row.
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
import type { IconName } from '@renderer/lib/icons'
import type { ScreenNav } from '@renderer/lib/screens'
import { definitionOf, type TradeSide } from '@shared/documents'
import type { AllocationInput, OpenDocument, ReceiptStatusDto } from '@shared/dto'
import { receiptDefinitionOf, settles, type ReceiptKind } from '@shared/receipts'

// ---- Where each kind's screens live -----------------------------------------

/*
 * ONE KIND PER SCREEN, STILL. `receipts` is one table for both directions, and a register
 * mixing money out into a list of money in would invite reading a total that means
 * nothing. What changed in 0013-3 is that the second screen now exists: a payment had
 * nothing to settle until a purchase bill could be issued, which 0013-1 made possible.
 *
 * The ids are derived rather than listed, exactly as the document screens' are — and the
 * editor's id IS the kind, which is why the invoice screen's long-standing route to
 * `workspace/receipt` still resolves.
 */

/** The register that lists every voucher of this kind. */
export function registerScreenId(kind: ReceiptKind): string {
  return `${kind}-register`
}

/** The editor for one voucher of this kind. */
export function editorScreenId(kind: ReceiptKind): string {
  return kind
}

/**
 * Where a kind's register sits in the rail.
 *
 * Last in its group, after the documents, because a voucher is what happens TO a document
 * rather than a document. `document-view.ts` holds the orders above these.
 */
const NAV_ORDER: Readonly<Record<ReceiptKind, number>> = {
  receipt: 4,
  payment: 3,
  refund: 5,
  'refund-received': 4,
}

/*
 * The rail's glyph per kind: money into a tray or out of one, and a refund turning back.
 * The two refunds share a glyph and never a rail, one per side.
 */
const NAV_ICON: Readonly<Record<ReceiptKind, IconName>> = {
  receipt: 'money-in',
  payment: 'money-out',
  refund: 'refund',
  'refund-received': 'refund',
}

export function registerNav(kind: ReceiptKind): ScreenNav {
  const definition = receiptDefinitionOf(kind)
  return {
    label: definition.pluralLabel,
    icon: NAV_ICON[kind],
    group: definition.side === 'sales' ? 'sales' : 'purchases',
    order: NAV_ORDER[kind],
  }
}

// ---- What each kind is called -----------------------------------------------

/**
 * The role to ask `parties.list` for.
 *
 * One party record can be both, so this narrows a picker rather than describing what the
 * party IS — see the note on `partyRoleFor` in document-view.ts.
 */
export function partyRoleFor(side: TradeSide): 'customer' | 'vendor' {
  return side === 'sales' ? 'customer' : 'vendor'
}

/** What the party field is labelled. The user's word, not the schema's. */
export function partyLabel(side: TradeSide): string {
  return side === 'sales' ? 'Customer' : 'Vendor'
}

/**
 * What the documents this voucher settles are called.
 *
 * READ OFF THE DOCUMENT TABLE, not written out here. `settles` is the same function the
 * picker filters on and the same one 0015's trigger enumerates: the one kind a voucher of
 * this kind settles. The allocation table's heading and the picker's empty state both use
 * it, so a sixth document kind cannot leave this screen calling a bill an invoice.
 *
 * IT TOOK A SIDE UNTIL 0015 and could not have answered for a refund: a refund and a
 * receipt are both sales-side, and a heading reading "Sales invoices" over a list of
 * credit notes is the screen agreeing with the wrong half of the rule.
 */
export function settlesLabel(kind: ReceiptKind): string {
  return definitionOf(settles(kind)).label
}

/** The lede under a register's heading. */
export function registerLede(kind: ReceiptKind): string {
  const definition = receiptDefinitionOf(kind)
  const verb = definition.direction === 'in' ? 'taken' : 'made'
  return `Every ${definition.label.toLowerCase()} these books have ${verb}, and how much of each is still on account.`
}

/** What the amount field asks for, which is the sentence most worth getting right. */
export function amountHint(kind: ReceiptKind): string {
  const definition = receiptDefinitionOf(kind)
  const other = definition.direction === 'in' ? 'payment' : 'receipt'
  const arrived = definition.direction === 'in' ? 'What arrived' : 'What you paid'
  return `${arrived}. Money going the other way is a ${other}, not a negative ${definition.label.toLowerCase()}.`
}

/** What the money account is called, which differs by which way the money went. */
export function accountLabel(kind: ReceiptKind): string {
  return receiptDefinitionOf(kind).direction === 'in'
    ? 'Account the money landed in'
    : 'Account the money came out of'
}

export function accountHint(kind: ReceiptKind): string {
  return receiptDefinitionOf(kind).direction === 'in'
    ? 'The bank or cash account it went into.'
    : 'The bank or cash account it came out of.'
}

/**
 * What an empty register says, when nothing has been filtered out.
 *
 * MONEY ON ACCOUNT IS NOT AN UNFINISHED JOB, and this sentence is where a user learns it.
 * A voucher does not need a document: it sits on account until somebody says what it
 * pays, which is an ordinary thing for a business to hold.
 */
export function emptyRegisterSentence(kind: ReceiptKind): string {
  const definition = receiptDefinitionOf(kind)
  const label = definition.label.toLowerCase()
  const party = partyLabel(definition.side).toLowerCase()
  const document = settlesLabel(kind).toLowerCase()
  const landed = definition.direction === 'in' ? 'land in' : 'come out of'
  return (
    `A ${label} needs a ${party} and an account for the money to ${landed}. New ${label} ` +
    `starts one — it does not need a ${document}, and money nobody has matched yet sits on ` +
    'account until you say what it pays.'
  )
}

/**
 * Rows drawn per page.
 *
 * `listReceipts` caps a page at `MAX_RECEIPT_PAGE` (500) whatever it is asked for, so a
 * register that did not page would show the first page of a busy year and look complete.
 * The same 50 the document registers use, for the same reason: it fits without scrolling
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
 * Two states rather than a document register's three, and the accent has nowhere to go:
 * there is no draft, so no row has anything left to do. Posted is the settled normal and
 * cancelled recedes, exactly as `statusTone` in document-view.ts argues — a cancelled
 * receipt is how a bounced cheque is recorded properly, not a warning.
 *
 * Posted stays positive where an issued document moved to the accent: a posted receipt IS
 * money that arrived, which is exactly what the positive tone means.
 */
export function statusTone(status: string): BadgeTone {
  return status === 'posted' ? 'positive' : 'neutral'
}

/** Whether a status is a voided one, drawn struck through. Only `cancelled` is. */
export function isStruckStatus(status: string): boolean {
  return status === 'cancelled'
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

/** What the status line says the voucher is, in a sentence rather than a word. */
export function stateSentence(status: ReceiptStatusDto, number: string): string {
  if (status === 'cancelled') {
    return `Cancelled. ${number} is kept, and what it posted has been reversed.`
  }
  return `Posted as ${number}. The money is in the books; what it settles can still change.`
}

/** What a new one says before it exists. Both kinds post the moment they are recorded. */
export function newSentence(kind: ReceiptKind): string {
  return receiptDefinitionOf(kind).direction === 'in'
    ? 'Money that has already arrived. Recording it posts it — there is no draft.'
    : 'Money that has already left. Recording it posts it — there is no draft.'
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
