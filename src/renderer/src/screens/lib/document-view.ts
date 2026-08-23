/*
 * The document registers' vocabulary, and the one rule none of them computes.
 *
 * WAS `invoice-view.ts`, AND THE RENAME IS THE BATCH. There is one register component and
 * one editor, registered once per kind, because a quotation, an invoice, a credit note, a
 * bill and a debit note differ in what they are called, whose side they are on and which
 * of them may correct another — and in nothing else a screen can see. Five copies of
 * `Invoices.tsx` would be five places to fix the next paging bug.
 *
 * THE WORDS COME FROM `@shared/documents`, NOT FROM HERE. That table used to live in
 * `main/domain` where the renderer could not reach it; 0013-2 moved it down so that the
 * label on a button and the account a posting rule debits are read off the same row. What
 * is in this file is only what a SCREEN adds to it: where each register sits in the
 * sidebar, what its empty state says, and which word a party goes by on that side.
 *
 * Nothing here touches money. A document's total arrives formatted from main and the
 * register prints it — see the note at the top of DocumentRegister.tsx about why there is
 * no total for the page.
 */

import type { BadgeTone } from '@renderer/components/atoms'
import type { ScreenNav } from '@renderer/lib/screens'
import { definitionOf, type DocumentKind, type TradeSide } from '@shared/documents'
import type { DocumentStatusDto } from '@shared/dto'

/**
 * Rows drawn per page.
 *
 * The repository caps a page at `MAX_DOCUMENT_PAGE` (500) whatever it is asked for, so a
 * register that did not page would show the first page of a busy year and look complete.
 * 50 is what fits a screen without scrolling past the toolbar.
 */
export const PAGE_SIZE = 50

// ---- Where each kind's screens live -----------------------------------------

/*
 * TWO SCREEN IDS PER KIND, DERIVED RATHER THAN LISTED. A table of ten literal ids is a
 * table somebody has to add two rows to for a sixth kind, and forgetting one gives a
 * sidebar entry that navigates to a blank screen — a failure the type system cannot see,
 * because a route id is a string.
 *
 * The editor's id IS the kind, so a route reads `workspace/credit-note?id=…`. The
 * register's is the kind with a suffix rather than an English plural: `quotations` is a
 * word and `summarys` is not, and an id that pretends to be a word and is misspelled is
 * worse than one that never pretended.
 */

/** The register that lists every document of this kind. */
export function registerScreenId(kind: DocumentKind): string {
  return `${kind}-register`
}

/** The editor for one document of this kind. */
export function editorScreenId(kind: DocumentKind): string {
  return kind
}

/**
 * Where a kind's register sits in the sidebar.
 *
 * Ordered as a business works: what you send before what you correct, and the parties
 * above both. Receipts and payments come last on their side, because they are what
 * happens to a document rather than a document.
 */
const NAV_ORDER: Readonly<Record<DocumentKind, number>> = {
  quotation: 1,
  'sales-invoice': 2,
  'credit-note': 3,
  'purchase-bill': 1,
  'debit-note': 2,
}

/**
 * The sidebar entry for a kind's register.
 *
 * The group falls out of the side, which is the whole reason `side` is on the shared
 * table: a kind added on the purchase side appears under Purchases without anyone
 * deciding. The label is the plural from the same row, so the sidebar and the register's
 * own heading cannot disagree.
 */
export function registerNav(kind: DocumentKind): ScreenNav {
  const definition = definitionOf(kind)
  return {
    label: definition.pluralLabel,
    icon: 'ledger',
    group: definition.side === 'sales' ? 'sales' : 'purchases',
    order: NAV_ORDER[kind],
  }
}

// ---- What a party is called on each side ------------------------------------

/**
 * The role to ask `parties.list` for.
 *
 * One party record can be both — a firm you buy from and sell to is ordinary, and 2.1a's
 * whole argument for one table rests on it — so this narrows a picker rather than
 * describing what the party IS.
 */
export function partyRoleFor(side: TradeSide): 'customer' | 'vendor' {
  return side === 'sales' ? 'customer' : 'vendor'
}

/** What the field is labelled. The user's word, not the schema's. */
export function partyLabel(side: TradeSide): string {
  return side === 'sales' ? 'Customer' : 'Vendor'
}

/** What their own number for the document is called, which differs by side. */
export function partyReferenceLabel(side: TradeSide): string {
  return side === 'sales' ? 'Their reference' : 'Their invoice number'
}

/**
 * The hint under it — and on the purchase side this is not a nicety.
 *
 * A vendor's own invoice number is what a GSTR-2B reconciliation matches on. Calling it
 * "their reference" and leaving it blank makes every purchase in the books unmatchable
 * against what the supplier filed, which is discovered a year later by somebody else.
 */
export function partyReferenceHint(side: TradeSide): string {
  return side === 'sales'
    ? 'A purchase order number, or whatever they asked you to quote.'
    : "The number on the supplier's own bill. It is what a return is matched against, so it is worth typing."
}

// ---- What each register says ------------------------------------------------

/**
 * Whether the counterparty wrote this document rather than the business.
 *
 * True of the purchase bill and nothing else: it arrives from a supplier and is entered,
 * where the other four are raised and sent. Worth a word of its own because the screens
 * say it out loud — "recorded" rather than "raised" — and because it is the one kind
 * whose most important number is somebody else's (see `partyReferenceHint`).
 *
 * Derived from the two fields the shared table already holds, not stored beside them: a
 * purchase that charges is a bill, and there is no second purchase charge kind.
 */
export function isCounterpartyAuthored(kind: DocumentKind): boolean {
  const definition = definitionOf(kind)
  return definition.side === 'purchase' && definition.direction === 'charge'
}

/** The lede under a register's heading. */
export function registerLede(kind: DocumentKind): string {
  const definition = definitionOf(kind)
  const singular = definition.label.toLowerCase()

  if (!definition.postsToLedger) {
    return `Every ${singular} these books have sent. A quotation is a price, not a supply — issuing one puts nothing in the ledger.`
  }

  const verb = isCounterpartyAuthored(kind) ? 'recorded' : 'raised'
  return `Every ${singular} these books have ${verb}, and every draft not yet issued.`
}

/**
 * What an empty register says, when nothing has been filtered out.
 *
 * Names what is missing rather than saying there is nothing: a register is empty on a
 * user's first day and on the day they mistyped a filter, and only one of those is worth
 * a sentence about parties and business details.
 */
export function emptyRegisterSentence(kind: DocumentKind): string {
  const definition = definitionOf(kind)
  const party = partyLabel(definition.side).toLowerCase()
  return `A ${definition.label.toLowerCase()} needs a ${party} and the business details filled in — both are in the sidebar. Then New ${definition.label.toLowerCase()} starts one.`
}

// ---- Status -----------------------------------------------------------------

const STATUS_LABELS: Readonly<Record<DocumentStatusDto, string>> = {
  draft: 'Draft',
  issued: 'Issued',
  cancelled: 'Cancelled',
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status as DocumentStatusDto] ?? status
}

/**
 * The badge a status wears.
 *
 * CANCELLED IS NOT A WARNING, AND NOTHING HERE IS. It is a settled, deliberate state —
 * the document was issued, the entry was reversed, and the number was kept so the series
 * has no hole. Colouring it as a problem would put a red mark against the one action a
 * user takes to correct a mistake properly, and make a register look alarming for having
 * been kept well. So it recedes to neutral, issued reads as the settled normal, and the
 * accent goes on the draft — the only row on the page with something still to do.
 *
 * Typed as `BadgeTone` rather than as a union written out here, so a tone the atom does
 * not have cannot be returned. `periodStatusTone` next door returns `'info'`, which is
 * not one — it has no caller yet, and it will not compile against a `Badge` when it gets
 * one.
 */
export function statusTone(status: string): BadgeTone {
  if (status === 'issued') return 'positive'
  if (status === 'draft') return 'accent'
  return 'neutral'
}

/** The status buttons, in the order a register is scanned. `''` is no filter. */
export function statusFilters(): ReadonlyArray<{ value: DocumentStatusDto | ''; label: string }> {
  return [
    { value: '', label: 'All' },
    { value: 'draft', label: 'Drafts' },
    { value: 'issued', label: 'Issued' },
    { value: 'cancelled', label: 'Cancelled' },
  ]
}
