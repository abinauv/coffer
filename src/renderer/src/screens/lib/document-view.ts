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
 * rail, what its empty state says, and which word a party goes by on that side.
 *
 * Nothing here touches money. A document's total arrives formatted from main and the
 * register prints it — see the note at the top of DocumentRegister.tsx about why there is
 * no total for the page.
 */

import type { BadgeTone } from '@renderer/components/atoms'
import type { IconName } from '@renderer/lib/icons'
import { navGroupLabel, type NavGroupId, type ScreenNav } from '@renderer/lib/screens'
import {
  chargesOnTerms,
  definitionOf,
  isDocumentKind,
  type DocumentKind,
  type TradeSide,
} from '@shared/documents'
import type { DocumentListRow, DocumentStatusDto } from '@shared/dto'

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
 * Where a kind's register sits in the rail.
 *
 * Ordered as a business works: the invoice first, because it is the document raised every
 * day, then the quotation before it and the note that corrects it. Receipts and payments
 * follow, because they are what happens to a document rather than a document, and the
 * parties and the aged report come after all of them.
 */
const NAV_ORDER: Readonly<Record<DocumentKind, number>> = {
  'sales-invoice': 1,
  quotation: 2,
  'credit-note': 3,
  'purchase-bill': 1,
  'debit-note': 2,
}

/*
 * The rail's glyph per kind, a record so a new kind does not compile without one. What is
 * raised is a page with lines; what corrects it carries a minus or a plus; a quotation's
 * lines are still to be settled.
 */
const NAV_ICON: Readonly<Record<DocumentKind, IconName>> = {
  'sales-invoice': 'invoice',
  quotation: 'quotation',
  'credit-note': 'note-minus',
  'purchase-bill': 'bill',
  'debit-note': 'note-plus',
}

/**
 * The rail entry for a kind's register.
 *
 * The group falls out of the side, which is the whole reason `side` is on the shared
 * table: a kind added on the purchase side appears under Purchases without anyone
 * deciding. The label is the plural from the same row, so the rail and the register's
 * own heading cannot disagree.
 */
export function registerNav(kind: DocumentKind): ScreenNav {
  const definition = definitionOf(kind)
  return {
    label: definition.pluralLabel,
    icon: NAV_ICON[kind],
    group: SIDE_WORDS[definition.side].navGroup,
    order: NAV_ORDER[kind],
  }
}

// ---- What a party is called on each side ------------------------------------

/*
 * ONE TOTAL RECORD OVER `TradeSide`, WHERE THERE WERE FIVE TERNARIES.
 *
 * `side === 'sales' ? x : y` is correct for exactly as long as the union has two members,
 * and stops being the same thing the moment it has three: a record does not compile until
 * the new member is answered for, and a conditional silently gives it whatever the last
 * branch said (CONVENTIONS §1.9). This codebase has measured that twice —
 * `receiptPostingRuleFor` posted a customer's refund onto accounts payable, and nothing in
 * the suite pointed at it.
 *
 * `TradeSide` is a closed two-member union today and there is no third side of a trade in
 * sight, so the risk here is smaller than it was there. What makes it worth writing out
 * anyway is that FIVE separate conditionals over one union were five places to get the
 * order of the two arms wrong, in a file where getting it wrong means calling a vendor a
 * customer. One row per side puts every word a side carries on one line, where a
 * transposition is visible by reading.
 */
interface SideWords {
  /** The role to ask `parties.list` for. */
  role: 'customer' | 'vendor'
  /** What the field is labelled. The user's word, not the schema's. */
  label: string
  /** What their own number for the document is called. */
  referenceLabel: string
  /** The hint under it. See `partyReferenceHint`. */
  referenceHint: string
  /** Which section this side's registers sit in. */
  navGroup: NavGroupId
}

const SIDE_WORDS: Readonly<Record<TradeSide, SideWords>> = {
  sales: {
    role: 'customer',
    label: 'Customer',
    referenceLabel: 'Their reference',
    referenceHint: 'A purchase order number, or whatever they asked you to quote.',
    navGroup: 'sales',
  },
  purchase: {
    role: 'vendor',
    label: 'Vendor',
    referenceLabel: 'Their invoice number',
    referenceHint:
      "The number on the supplier's own bill. It is what a return is matched against, so it is worth typing.",
    navGroup: 'purchases',
  },
}

/** The section a side's registers, parties and aged report sit in. */
export function sideNavGroup(side: TradeSide): NavGroupId {
  return SIDE_WORDS[side].navGroup
}

/**
 * The role to ask `parties.list` for.
 *
 * One party record can be both — a firm you buy from and sell to is ordinary, and 2.1a's
 * whole argument for one table rests on it — so this narrows a picker rather than
 * describing what the party IS.
 */
export function partyRoleFor(side: TradeSide): 'customer' | 'vendor' {
  return SIDE_WORDS[side].role
}

/** What the field is labelled. The user's word, not the schema's. */
export function partyLabel(side: TradeSide): string {
  return SIDE_WORDS[side].label
}

/** What their own number for the document is called, which differs by side. */
export function partyReferenceLabel(side: TradeSide): string {
  return SIDE_WORDS[side].referenceLabel
}

/**
 * The hint under it — and on the purchase side this is not a nicety.
 *
 * A vendor's own invoice number is what a GSTR-2B reconciliation matches on. Calling it
 * "their reference" and leaving it blank makes every purchase in the books unmatchable
 * against what the supplier filed, which is discovered a year later by somebody else.
 */
export function partyReferenceHint(side: TradeSide): string {
  return SIDE_WORDS[side].referenceHint
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
 * What a register's search box says it searches: the three things `listDocuments` matches.
 * The party is named in the side's own word, so a purchase register says "vendor".
 */
export function registerSearchPlaceholder(side: TradeSide): string {
  return `Search by number, ${SIDE_WORDS[side].label.toLowerCase()} or narration`
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
  const section = navGroupLabel(SIDE_WORDS[definition.side].navGroup)
  return `A ${definition.label.toLowerCase()} needs a ${party} and the business details filled in — the ${party} under ${section}, the business details under Company. Then New ${definition.label.toLowerCase()} starts one.`
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
 * The badge a status wears — the design system's status set (§03).
 *
 * CANCELLED IS NOT A WARNING, AND NOTHING HERE IS. It is a settled, deliberate state —
 * the document was issued, the entry was reversed, and the number was kept so the series
 * has no hole. Colouring it as a problem would put a red mark against the one action a
 * user takes to correct a mistake properly, and make a register look alarming for having
 * been kept well. So it recedes to neutral, and `isStruckStatus` strikes it through.
 *
 * ISSUED IS THE ACCENT AND DRAFT IS NEUTRAL, which is the reverse of what this said before
 * the redesign, and the reason is the badge that is coming: `Paid`. Positive teal means
 * money went the right way, so it belongs to a settled invoice, not to one that has merely
 * been issued — an issued invoice painted positive would look paid. Issued takes the
 * product's own voice instead, and a draft, which has posted nothing, stays quiet.
 *
 * Typed as `BadgeTone` rather than as a union written out here, so a tone the atom does
 * not have cannot be returned. `periodStatusTone` next door was written the other way and
 * returned `'info'`, which is not a tone the atom has and has no rule in `atoms.css` — it
 * would have rendered an unstyled pill for whoever called it first, and its own test
 * pinned the wrong answer as correct. Both are fixed; the typing is what stops it
 * recurring, which is why it is worth stating here rather than only there.
 */
export function statusTone(status: string): BadgeTone {
  if (status === 'issued') return 'accent'
  return 'neutral'
}

/** Whether a status is a voided one, drawn struck through. Only `cancelled` is. */
export function isStruckStatus(status: string): boolean {
  return status === 'cancelled'
}

// ---- Settlement -------------------------------------------------------------

/**
 * The second badge a register row can wear: how much of it has been settled, and whether
 * it is late. Null for a row with nothing to say.
 *
 * THE STATE IS MAIN'S. `settlement` arrives worked out from the same figures as the aged
 * report; this only names it. What is decided here is words and a tone:
 *
 *   settled    Paid, or Refunded for a credit or debit note         positive
 *   part       Part paid / Part refunded                            warning
 *   late       Overdue 31d — takes the place of open or part        negative
 *
 * An open, on-time document gets no second badge: its status already says Issued, and a
 * row that said "Issued · Unpaid" for every invoice on the page would be noise.
 *
 * LATE IS A DATE COMPARISON, NOT MONEY, which is why it may be decided here. It needs a due
 * date (only kinds charged on terms carry one), something still outstanding, and a day
 * after the due date. Nought days is not late, as in the aged report: an invoice on 30-day
 * terms is not in default on the thirtieth day.
 */
export function settlementBadge(
  row: Pick<DocumentListRow, 'kind' | 'settlement' | 'dueDate'>,
  today: string,
): { label: string; tone: BadgeTone } | null {
  if (row.settlement === null || !isDocumentKind(row.kind)) return null
  const refund = definitionOf(row.kind).direction === 'refund'

  if (row.settlement === 'settled') return { label: refund ? 'Refunded' : 'Paid', tone: 'positive' }

  const late = chargesOnTerms(row.kind) && row.dueDate !== null ? daysAfter(row.dueDate, today) : 0
  if (late > 0) return { label: `Overdue ${String(late)}d`, tone: 'negative' }

  if (row.settlement === 'part') {
    return { label: refund ? 'Part refunded' : 'Part paid', tone: 'warning' }
  }
  return null
}

/** Whole days from `from` to `to`, both ISO dates. Negative when `to` is earlier. */
function daysAfter(from: string, to: string): number {
  const utc = (iso: string): number => {
    const [year = 0, month = 1, day = 1] = iso.split('-').map(Number)
    return Date.UTC(year, month - 1, day)
  }
  return Math.round((utc(to) - utc(from)) / 86_400_000)
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
