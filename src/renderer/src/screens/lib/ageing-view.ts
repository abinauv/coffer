/*
 * The aged report's vocabulary, and the four judgements the screen has to make.
 *
 * Every figure on the page arrives already totalled from main (CONVENTIONS §1.7), and
 * this file adds no arithmetic to them — not even the difference between the report's
 * foot and the control account when the two disagree. The notice states both figures and
 * lets the reader take one from the other, because a renderer that subtracts two amounts
 * is a renderer that has an opinion about money.
 *
 * WHAT IS DECIDED HERE IS WORDING AND WHERE A ROW GOES. Four of them are worth reading
 * before the screen, because each one is a rule the page would otherwise get wrong in a
 * way that looks right:
 *
 *   `isOverdue`      the flag the register deliberately does not have.
 *   `dueDateFor`     when a date under a "Due" heading is a lie.
 *   `itemTarget`     which rows can be opened, and why a receipt's kind had to be
 *                    carried across IPC for this to be answerable at all.
 *   `bucketNameIn`   the column an item fell in, taking the columns as an argument.
 */

import type { ScreenNav } from '@renderer/lib/screens'
import { definitionOf, isDocumentKind, type TradeSide } from '@shared/documents'
import type { AgedBucket, AgedItem, AgedPartyRow, DecimalString } from '@shared/dto'
import { isReceiptKind, receiptDefinitionOf } from '@shared/receipts'
import { editorScreenId as documentEditorScreenId } from './document-view'
import { editorScreenId as receiptEditorScreenId } from './receipt-view'

// ---- What each side's report is called --------------------------------------

/*
 * A TABLE, BECAUSE "RECEIVABLES" IS NOT DERIVABLE FROM "SALES". Everywhere else in the
 * renderer a side's words come off the kind table — a register's heading is a kind's
 * plural, a party column is `partyLabel(side)` — but the two names an aged report goes by
 * are the accountant's names for the two control accounts, and no row in `DOCUMENT_KINDS`
 * holds them.
 *
 * Keyed by `TradeSide` rather than by string, so a third side added to the kind table
 * fails to compile here instead of falling back to some generic wording. That is the
 * whole reason this is a `Record` and not a function with an `if`.
 */
interface SideWords {
  title: string
  navLabel: string
  lede: string
  /** What the totals row is called: the debt this report is a decomposition of. */
  totalLabel: string
  /** Shown when nobody has anything outstanding. */
  emptySentence: string
}

const SIDE_WORDS: Readonly<Record<TradeSide, SideWords>> = {
  sales: {
    title: 'Aged receivables',
    navLabel: 'Aged receivables',
    lede: 'What customers owe as at one day, by how long it has been outstanding. Every line on the receivables account is here, so the last figure equals the one on the balance sheet.',
    totalLabel: 'Owed to the business',
    emptySentence: 'No customer owes anything as at this date.',
  },
  purchase: {
    title: 'Aged payables',
    navLabel: 'Aged payables',
    lede: 'What the business owes suppliers as at one day, by how long it has been outstanding. Every line on the payables account is here, so the last figure equals the one on the balance sheet.',
    totalLabel: 'Owed by the business',
    emptySentence: 'Nothing is owed to any supplier as at this date.',
  },
}

export function agedTitle(side: TradeSide): string {
  return SIDE_WORDS[side].title
}

export function agedLede(side: TradeSide): string {
  return SIDE_WORDS[side].lede
}

export function agedTotalLabel(side: TradeSide): string {
  return SIDE_WORDS[side].totalLabel
}

export function agedEmptySentence(side: TradeSide): string {
  return SIDE_WORDS[side].emptySentence
}

/** The id the screen registers under. Derived, so the two sides cannot collide. */
export function agedScreenId(side: TradeSide): string {
  return `aged-${side}`
}

/*
 * UNDER REPORTS, NOT UNDER SALES. An aged report is a control account decomposed, and it
 * belongs beside the balance sheet whose receivables figure it has to equal — putting it
 * in the sidebar next to the statement it ties to is what makes the tie checkable by
 * somebody who did not read the code.
 *
 * The order is taken from the side's position in the kind table rather than written out,
 * so a third side gets a place in the sidebar without an edit here.
 */
const FIRST_AGED_NAV_ORDER = 5

export function agedNav(side: TradeSide, sideIndex: number): ScreenNav {
  return {
    label: SIDE_WORDS[side].navLabel,
    icon: 'ledger',
    group: 'reports',
    order: FIRST_AGED_NAV_ORDER + sideIndex,
  }
}

// ---- The flag the register deliberately does not have -----------------------

/**
 * Whether an item is late.
 *
 * `DocumentRegister` refuses this on purpose and its header says why: a register lists
 * documents and knows nothing about what has been paid against them, so an invoice
 * settled in full last week would wear the badge for ever. This page is the one that can
 * say it, because outstanding is what it is made of — every item here is money still
 * standing on the control account as at the report's date.
 *
 * TWO CONDITIONS, AND THE SECOND IS THE ONE THAT IS EASY TO DROP. A credit note raised a
 * hundred days ago has `daysOverdue` of a hundred and is not overdue by any reading:
 * nobody owes it, it stands to the party's credit, and `bucket` is null to say so. A flag
 * that looked only at the days would put a red badge on the customer's own money.
 *
 * Nought is not late. `daysOverdue` of nought means the money falls due today, and an
 * invoice on 30-day terms is not in default on the thirtieth day.
 */
export function isOverdue(item: AgedItem): boolean {
  return item.bucket !== null && item.daysOverdue > 0
}

/** How late, in words. Null where it is not late at all. */
export function overdueLabel(item: AgedItem): string | null {
  if (!isOverdue(item)) return null
  return `${String(item.daysOverdue)} ${item.daysOverdue === 1 ? 'day' : 'days'} overdue`
}

// ---- When a date under "Due" would be a lie ---------------------------------

/**
 * The date to print in the due column, or null for a dash.
 *
 * Every item carries a `dueDate` and not every one of them falls due. A receipt's is the
 * day the money arrived, carried only as a sort key — main's own comment says so — and
 * printing it under a heading that says "Due" would tell a reader that money already in
 * the bank becomes payable on the day it was banked.
 *
 * The test is the same one `isOverdue` makes: `bucket` is null exactly when the amount
 * stands to the party's credit, and a credit falls due on no day at all.
 */
export function dueDateFor(item: AgedItem): string | null {
  return item.bucket === null ? null : item.dueDate
}

// ---- Which column an item fell in -------------------------------------------

/** What money standing to a party's credit is called, wherever a column name is wanted. */
export const ON_ACCOUNT_LABEL = 'On account'

/**
 * The name of the column an item was placed in.
 *
 * TAKES THE COLUMNS AS AN ARGUMENT, so the unreachable case can be tested. `bucket` is an
 * index into the report's own `buckets` and main built both from one table, so an index
 * with no column cannot arrive from a report main produced. If it ever does, the page
 * says the row is unplaced rather than reading `buckets[0]` and quietly filing a
 * ninety-day debt under "Not yet due" — which is what any fallback to a real column
 * would do.
 */
export function bucketNameIn(buckets: readonly AgedBucket[], bucket: number | null): string {
  if (bucket === null) return ON_ACCOUNT_LABEL
  return buckets[bucket]?.label ?? 'Unplaced'
}

/**
 * What a column covers, said in full. Sits on the header as a title.
 *
 * The labels main sends are short enough to fit a column — "31-60 days" — and short
 * enough to be read as "31 to 60 days old", which they are not. They are ages past the
 * due date, and the difference is a month on every invoice written on 30-day terms.
 */
export function bucketRangeSentence(bucket: AgedBucket): string {
  const { fromDays, toDays } = bucket
  if (fromDays === null && toDays === null) return 'Every age'
  if (fromDays === null) return 'Not yet due as at the report date'
  if (toDays === null) return `${String(fromDays)} days or more past due`
  return `${String(fromDays)} to ${String(toDays)} days past due`
}

// ---- Reading a row across its columns ---------------------------------------

/**
 * The figure in one column of a row, or null where the row has no such column.
 *
 * The header row is drawn from `report.buckets` and the figures come from a parallel
 * array, so the two are the same length in any report main produced. NULL RATHER THAN
 * '0.00' when they are not: a nought is a figure and a reader would total the row and
 * find it right, whereas a blank cell under a column heading is visibly a hole. This is
 * the one place a screen could quietly invent money, and it does not.
 */
export function columnFigure(
  figures: readonly DecimalString[],
  index: number,
): DecimalString | null {
  return figures[index] ?? null
}

/**
 * A stable key for a row, including the one that names no party.
 *
 * Prefixed rather than bare, so the sentinel for "no party" cannot be an id. Not the
 * array index: the rows are ordered largest debt first and a reload can reorder them,
 * which would leave an expanded row open over a different party's items.
 */
export function rowKey(row: AgedPartyRow): string {
  return row.partyId === null ? 'no-party' : `party:${row.partyId}`
}

/**
 * What to print where a number goes.
 *
 * Only an issued document reaches a control account and every issued document is
 * numbered, so the empty string is main keeping the DTO honest rather than a case that
 * happens. Naming it is better than a blank cell, which reads as a number that failed to
 * load — and better than a button with no label, which cannot be clicked on purpose.
 */
export function itemNumberLabel(item: AgedItem): string {
  return item.number === '' ? 'Unnumbered' : item.number
}

// ---- Where a row opens ------------------------------------------------------

export interface ItemTarget {
  screenId: string
  params: Readonly<Record<string, string>>
}

/*
 * The two predicates are `@shared`'s. `AgedItem.kind` is a string on the wire because the
 * DTO cannot name two enums in one field, so every reader of it has to narrow — this file
 * did it privately, and so did the dashboard's view model and the PDF mapper, until the
 * integration gate hoisted one copy into the tables' own modules.
 */

/**
 * The screen an item opens, or null where there is nowhere to go.
 *
 * WHY `kind` CROSSES IPC AT ALL. A receipt's kind is what says whether the row opens the
 * receipts editor or the payments one, and the report's own side does not answer it:
 * `domain/receipts/types.ts` states on purpose that a voucher's control account is
 * declared and not derived from its side, and a refund to a customer is money out on the
 * sales side. Guessing "sales report, therefore a receipt" would open the wrong editor on
 * exactly the rows whose value is that they can be opened, so 0014-3 carried the kind
 * across rather than inferring it.
 *
 * NULL IS AN ANSWER AND NOT A FAILURE. A journal entry — an opening balance, a manual
 * correction — has no editor in this product, and a kind these books do not recognise is
 * a company file written by a newer build. Both are drawn as text. The alternative is a
 * route to a screen that does not resolve, which is a blank page rather than a message.
 */
export function itemTarget(item: AgedItem): ItemTarget | null {
  if (item.kind === null) return null
  if (item.source === 'document' && isDocumentKind(item.kind)) {
    return { screenId: documentEditorScreenId(item.kind), params: { id: item.sourceId } }
  }
  if (item.source === 'receipt' && isReceiptKind(item.kind)) {
    return { screenId: receiptEditorScreenId(item.kind), params: { id: item.sourceId } }
  }
  return null
}

/**
 * What an item is, in the user's words.
 *
 * The kind's own label where there is one, so a row says "Sales invoice" and not
 * "document". A journal entry has no kind and is named for what it is — an opening
 * balance and a manual correction both arrive this way, and neither is an error.
 */
export function itemSourceLabel(item: AgedItem): string {
  if (item.source === 'journal') return 'Journal entry'
  if (item.kind === null) return item.source === 'receipt' ? 'Voucher' : 'Document'
  if (item.source === 'document' && isDocumentKind(item.kind)) return definitionOf(item.kind).label
  if (item.source === 'receipt' && isReceiptKind(item.kind)) {
    return receiptDefinitionOf(item.kind).label
  }
  /* A kind from a newer build. Its own name is more use to whoever is reading than a
   * word this build invented for it. */
  return item.kind
}

// ---- The row that names nobody ----------------------------------------------

/**
 * Whether a row is money on the control account that names no party.
 *
 * Every posting rule that touches a control account carries a party, so this is a defect
 * in the books rather than a party without a name — main's own comment in the repository
 * says as much. It is still a row: the money is real, and dropping it is the one thing
 * that would make the foot disagree with the account.
 *
 * So the page draws it, marks it, and says once what it means. `partyName` already
 * carries a sentence rather than a name; what this decides is whether the row wears the
 * marker.
 */
export function isUnattributed(row: AgedPartyRow): boolean {
  return row.partyId === null
}

/*
 * Whether the report has such a row at all — the note is worth showing only then.
 *
 * At most one. The repository groups the control account's lines by `party_id`, so every
 * line naming nobody lands in a single group, which is why the note below says "one row"
 * and not "some rows".
 */
export function hasUnattributed(rows: readonly AgedPartyRow[]): boolean {
  return rows.some(isUnattributed)
}

export const UNATTRIBUTED_NOTE =
  'One row below is money sitting on this account with no party against it. Every posting rule that reaches a control account records one, so this is worth looking into — the entry behind it was most likely written by hand.'
