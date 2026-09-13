/*
 * What the workspace dashboard has to decide before it can draw anything.
 *
 * NOTHING HERE ADDS UP MONEY (CONVENTIONS §1.7), and a dashboard is where that rule is
 * most tempting to break: the obvious "total overdue" is the sum of every bucket but the
 * first, and the obvious "net position" is receivables less payables. Both are arithmetic
 * on money and neither is here. What the page shows instead is the figure main already
 * computed — `totals.total` for a side, `totals.buckets[i]` for a column, an item's own
 * `amount` — and where no channel returns a figure, the page does without it rather than
 * inventing one.
 *
 * WHAT IS DECIDED HERE IS SELECTION AND ORDER, which are not arithmetic:
 *
 *   `isNewCompany`     whether these books have been started at all — the difference
 *                      between a first day and six zeroes.
 *   `firstRunSteps`    what to do first, and which of it is already done.
 *   `mostOverdue`      which of two reports' items are late, worst first. Two lists
 *                      arriving separately have to be ordered by something, and main
 *                      cannot order across a call it did not make.
 *   `recentActivity`   documents and receipts as one sequence, newest first, for the
 *                      same reason.
 *
 * A PANEL IS A STATE, NOT A NULL. `Panel<T>` distinguishes "still reading" from "read and
 * empty" from "the read failed", because a dashboard is many independent reads and the
 * three must not collapse into one blank space. `isNewCompany` is where that pays: a
 * failed read is not an empty company, and a screen that treated it as one would greet a
 * business of ten years with a "welcome, add your first customer".
 */

import type { BadgeTone } from '@renderer/components/atoms'
import { definitionOf, isDocumentKind, type TradeSide } from '@shared/documents'
import type {
  AgedItem,
  AgedReport,
  AppError,
  DecimalString,
  DocumentSummary,
  ReceiptSummary,
  Result,
} from '@shared/dto'
import { isReceiptKind, receiptDefinitionOf } from '@shared/receipts'
import { agedTitle, columnFigure, isOverdue, type ItemTarget } from './ageing-view'
import {
  editorScreenId as documentEditorScreenId,
  statusLabel as documentStatusLabel,
  statusTone as documentStatusTone,
} from './document-view'
import {
  editorScreenId as receiptEditorScreenId,
  statusLabel as receiptStatusLabel,
  statusTone as receiptStatusTone,
} from './receipt-view'

// ---- One read, in the three states it can be in -----------------------------

/**
 * What the dashboard knows about one of its reads.
 *
 * THREE STATES RATHER THAN `T | null`. "Reading it now", "read it, there is nothing" and
 * "the read failed" are three different things to a reader, and the null that stands for
 * all three is the reason a broken panel looks like an empty one. Every derivation below
 * that could otherwise make a claim about books it has not seen takes a `Panel` for
 * exactly this reason.
 */
export type Panel<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly data: T }
  | { readonly state: 'failed'; readonly error: AppError }

/** A finished read, as a panel. The one place a `Result` becomes screen state. */
export function panelFrom<T>(result: Result<T>): Panel<T> {
  return result.ok
    ? { state: 'ready', data: result.data }
    : { state: 'failed', error: result.error }
}

// ---- The badge tones that exist ---------------------------------------------

/*
 * Every tone the Badge atom actually styles, as values.
 *
 * `BadgeTone` is a type and a type has no members at runtime, so something has to
 * enumerate them for a test to iterate — and a hand-written list would be a second copy
 * agreeing with the atom by inspection. `satisfies Record<BadgeTone, BadgeTone>` makes
 * this one total: a sixth tone added to the atom fails to compile here, and a tone the
 * atom no longer has is an excess key.
 *
 * IT IS WORTH THE CEREMONY BECAUSE THE FAILURE IS SILENT. `periodStatusTone` returned
 * `'info'` until 0016; `.badge--info` has no rule in atoms.css, so it would have rendered
 * an unstyled pill rather than throwing anything (see `ledger-format.ts`).
 */
const STYLED_TONES = {
  neutral: 'neutral',
  accent: 'accent',
  positive: 'positive',
  negative: 'negative',
  warning: 'warning',
} as const satisfies Record<BadgeTone, BadgeTone>

export const BADGE_TONES: readonly BadgeTone[] = Object.values(STYLED_TONES)

// ---- Is this company started at all? ----------------------------------------

/**
 * Whether these books hold nothing yet.
 *
 * FOUR CONDITIONS, AND EACH EXCLUDES SOMETHING THE OTHERS LET THROUGH. Both reads have
 * to have finished, because a failure is not an emptiness — a company with a decade of
 * invoices whose document list failed would otherwise be told to add its first customer.
 * And both have to be empty: a company with no documents may still have taken money on
 * account, and a company with no receipts is the ordinary state of one that invoices on
 * terms.
 */
export function isNewCompany(
  documents: Panel<readonly DocumentSummary[]>,
  receipts: Panel<readonly ReceiptSummary[]>,
): boolean {
  if (documents.state !== 'ready') return false
  if (receipts.state !== 'ready') return false
  return documents.data.length === 0 && receipts.data.length === 0
}

// ---- What to do first -------------------------------------------------------

/**
 * How far along one first-run step is.
 *
 * `unknown` IS A REAL ANSWER AND NOT A LOADING FLAG. The read behind a step can fail, and
 * a step that then said "to do" would be telling a user to enter business details they
 * have already entered. Written as values with the type read off them, so a test can
 * iterate every state rather than remembering the list.
 */
export const STEP_STATES = ['done', 'todo', 'unknown'] as const
export type StepState = (typeof STEP_STATES)[number]

/** Whether the thing a panel was read for is there, given what the panel knows. */
export function stepState<T>(panel: Panel<T>, isDone: (data: T) => boolean): StepState {
  if (panel.state !== 'ready') return 'unknown'
  return isDone(panel.data) ? 'done' : 'todo'
}

const STEP_TONES: Readonly<Record<StepState, BadgeTone>> = {
  done: 'positive',
  todo: 'accent',
  unknown: 'neutral',
}

/** The badge a step wears. A total record, so a fourth state cannot default to a colour. */
export function stepTone(state: StepState): BadgeTone {
  return STEP_TONES[state]
}

const STEP_LABELS: Readonly<Record<StepState, string>> = {
  done: 'Done',
  todo: 'To do',
  unknown: 'Not checked',
}

export function stepLabel(state: StepState): string {
  return STEP_LABELS[state]
}

/*
 * Screens the dashboard links to that own their own ids.
 *
 * Collected rather than scattered, so a rename in someone else's file has one place to be
 * found. Ids that are DERIVED — a document editor, a register, an aged report — are taken
 * from the tables that build them instead, and so are absent here on purpose.
 */
export const LINKED_SCREENS = {
  companyProfile: 'company-profile',
  customers: 'customers',
  dayBook: 'day-book',
} as const

export interface FirstRunStep {
  id: string
  title: string
  body: string
  /** The button under it. Names where it goes, not what it does. */
  actionLabel: string
  screenId: string
  state: StepState
}

/**
 * The three things a brand-new company needs, in the order they have to happen.
 *
 * THE ORDER IS A DEPENDENCY, NOT A PREFERENCE. A document cannot be created until the
 * company profile exists — the service refuses it with `COMPANY_PROFILE_MISSING` — and it
 * needs a party to be addressed to. Listing "raise an invoice" first would send a first
 * user straight into the one screen that cannot work yet.
 *
 * Each state is passed in rather than derived here, because each comes from a different
 * read and one of them can fail while the others answer.
 */
export function firstRunSteps(states: {
  profile: StepState
  parties: StepState
  documents: StepState
}): readonly FirstRunStep[] {
  return [
    {
      id: 'profile',
      title: 'Fill in the business details',
      body: 'Your name, address and registration number. Every document these books raise is issued by them, and nothing can be raised until they are there.',
      actionLabel: 'Business details',
      screenId: LINKED_SCREENS.companyProfile,
      state: states.profile,
    },
    {
      id: 'parties',
      title: 'Add a customer or a supplier',
      body: 'One record covers both — the firm you buy transport from can be the firm you sell to. Their state decides the place of supply, so it is worth typing in full.',
      actionLabel: 'Customers',
      screenId: LINKED_SCREENS.customers,
      state: states.parties,
    },
    {
      id: 'first-document',
      title: 'Raise the first sales invoice',
      body: 'Issuing it allocates the number and posts the entry, in one transaction. Everything else on this screen fills in from there.',
      actionLabel: 'New sales invoice',
      screenId: documentEditorScreenId('sales-invoice'),
      state: states.documents,
    },
  ]
}

// ---- What is owed, each way -------------------------------------------------

/*
 * The dashboard's headings for the two sides.
 *
 * NOT `agedTitle`, WHICH IS THE ACCOUNTANT'S NAME. "Aged receivables" is right at the top
 * of the report it names and wrong as the first thing somebody reads after unlocking
 * their books; this is the same money in the words the owner would use. A total record
 * over `TradeSide`, so a third side has to be given a sentence rather than inheriting
 * one.
 */
const OUTSTANDING_TITLES: Readonly<Record<TradeSide, string>> = {
  sales: 'What customers owe you',
  purchase: 'What you owe suppliers',
}

export function outstandingTitle(side: TradeSide): string {
  return OUTSTANDING_TITLES[side]
}

/** The link out to the full report. Built from the report's own name, so it cannot drift. */
export function outstandingLinkLabel(side: TradeSide): string {
  return `Open the ${agedTitle(side).toLowerCase()}`
}

/** One column of the report's foot: what the column is called, and what stands in it. */
export interface BucketFigure {
  label: string
  /** Null where the report sent no figure for the column. Never a substituted nought. */
  figure: DecimalString | null
}

/**
 * The report's totals row, read across its own columns.
 *
 * Goes through `columnFigure` rather than indexing, so a report whose labels and figures
 * are of different lengths leaves a hole rather than borrowing the neighbouring column's
 * money — the reasoning is in `ageing-view.ts` and this is the second reader of it.
 */
export function bucketFigures(report: AgedReport): readonly BucketFigure[] {
  return report.buckets.map((bucket, index) => ({
    label: bucket.label,
    figure: columnFigure(report.totals.buckets, index),
  }))
}

// ---- What is late -----------------------------------------------------------

/** One late item, with the party it stands against and the side it came from. */
export interface OverdueRow {
  key: string
  side: TradeSide
  partyName: string
  item: AgedItem
}

/**
 * Every late item in one side's report.
 *
 * `isOverdue` IS BORROWED RATHER THAN REWRITTEN, and its second condition is the reason:
 * a credit note raised a hundred days ago has a hundred days on it and is not late by any
 * reading, because it stands to the party's credit. A dashboard that tested only the days
 * would put its loudest badge on the customer's own money.
 */
export function overdueRowsIn(side: TradeSide, report: AgedReport): readonly OverdueRow[] {
  return report.parties.flatMap((party) =>
    party.items.filter(isOverdue).map((item) => ({
      key: `${side}:${item.source}:${item.sourceId}`,
      side,
      partyName: party.partyName,
      item,
    })),
  )
}

/**
 * The worst of them, longest overdue first.
 *
 * ORDERED HERE BECAUSE NOTHING ELSE CAN. Each report arrives ordered by its own rule —
 * largest debt first, within a party oldest first — and neither knows about the other. A
 * dashboard showing "what needs attention" across both sides has to interleave them, and
 * the only ranking that means anything across a receivable and a payable is how late it
 * is.
 *
 * Copied before sorting: `sort` is in place, and the arrays here are derived from state.
 * Equal ages keep the order they arrived in, which is each report's own.
 */
export function mostOverdue(rows: readonly OverdueRow[], limit: number): readonly OverdueRow[] {
  return [...rows].sort((a, b) => b.item.daysOverdue - a.item.daysOverdue).slice(0, limit)
}

// ---- What has happened lately -----------------------------------------------

/*
 * The two things that happen in a set of books, as values.
 *
 * The type is read off the list rather than the list off the type, so every record keyed
 * by it below is total and a test can iterate the members without a second copy.
 */
export const ACTIVITY_SOURCES = ['document', 'receipt'] as const
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number]

/** A document or a voucher, in the one shape the dashboard lists both in. */
export interface ActivityRow {
  key: string
  source: ActivitySource
  id: string
  /** A `DocumentKind` or a `ReceiptKind`. A string, because the DTOs carry it as one. */
  kind: string
  /** What it is known by. A draft has no number and is named for what it is. */
  numberLabel: string
  date: string
  partyName: string
  status: string
  /** As main sent it. Nothing here totals a column of these. */
  amount: DecimalString
}

/**
 * What a document with no number is called.
 *
 * A draft has none and must not borrow one. The word is better than a blank cell, which
 * reads as a number that failed to load — the same argument `DocumentRegister` makes.
 */
export const DRAFT_NUMBER_LABEL = 'Draft'

export function documentActivity(rows: readonly DocumentSummary[]): readonly ActivityRow[] {
  return rows.map((row) => ({
    key: `document:${row.id}`,
    source: 'document',
    id: row.id,
    kind: row.kind,
    numberLabel: row.number ?? DRAFT_NUMBER_LABEL,
    date: row.date,
    partyName: row.partyName,
    status: row.status,
    amount: row.grandTotal,
  }))
}

export function receiptActivity(rows: readonly ReceiptSummary[]): readonly ActivityRow[] {
  return rows.map((row) => ({
    key: `receipt:${row.id}`,
    source: 'receipt',
    id: row.id,
    kind: row.kind,
    /* A voucher always has a number — there is no state in its life before it has one
     * (`ReceiptSummary`) — so there is nothing to substitute here. */
    numberLabel: row.number,
    date: row.date,
    partyName: row.partyName,
    status: row.status,
    amount: row.amount,
  }))
}

/**
 * Documents and vouchers as one sequence, newest first.
 *
 * ORDERED HERE, AND THAT IS NOT DISTRUST OF MAIN. Each list arrives newest first already;
 * what no channel can do is interleave two of them, because the merge happens after both
 * answers have crossed the bridge. Taking the newest few of each and then the newest few
 * of the union is exact — nothing outside a list's own first `limit` rows can be newer
 * than all of them.
 *
 * COMPARED AS TEXT. A date is `YYYY-MM-DD`, so lexicographic order IS chronological order
 * and nothing has to be parsed into a `Date` to sort it.
 */
export function recentActivity(
  documents: readonly DocumentSummary[],
  receipts: readonly ReceiptSummary[],
  limit: number,
): readonly ActivityRow[] {
  return [...documentActivity(documents), ...receiptActivity(receipts)]
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))
    .slice(0, limit)
}

/*
 * Three total records over `ActivitySource` rather than three conditionals.
 *
 * A `row.source === 'document' ? … : …` is correct for exactly as long as there are two
 * sources, and gives the third one whatever the last branch said (CONVENTIONS §1.9). A
 * record does not compile until the new member has been answered for.
 */
const ACTIVITY_LABELS: Readonly<Record<ActivitySource, (kind: string) => string>> = {
  document: (kind) => (isDocumentKind(kind) ? definitionOf(kind).label : kind),
  receipt: (kind) => (isReceiptKind(kind) ? receiptDefinitionOf(kind).label : kind),
}

/**
 * What a row is, in the user's words.
 *
 * A kind this build does not know keeps its own name. It is more use to whoever is
 * reading than a word invented for it here, and it says plainly that the file has been
 * written by something newer.
 */
export function activityLabel(row: ActivityRow): string {
  return ACTIVITY_LABELS[row.source](row.kind)
}

const ACTIVITY_STATUS_LABELS: Readonly<Record<ActivitySource, (status: string) => string>> = {
  document: documentStatusLabel,
  receipt: receiptStatusLabel,
}

export function activityStatusLabel(row: ActivityRow): string {
  return ACTIVITY_STATUS_LABELS[row.source](row.status)
}

/*
 * The two status vocabularies are NOT interchangeable, which is why this is a record of
 * two functions and not one shared call. A document's `issued` is a receipt's `posted`,
 * and the document table's answer for an unknown status is `neutral` — so lending it to a
 * receipt would draw every posted voucher in the quiet tone reserved for a cancelled one.
 */
const ACTIVITY_TONES: Readonly<Record<ActivitySource, (status: string) => BadgeTone>> = {
  document: documentStatusTone,
  receipt: receiptStatusTone,
}

export function activityTone(row: ActivityRow): BadgeTone {
  return ACTIVITY_TONES[row.source](row.status)
}

const ACTIVITY_TARGETS: Readonly<Record<ActivitySource, (row: ActivityRow) => ItemTarget | null>> =
  {
    document: (row) =>
      isDocumentKind(row.kind)
        ? { screenId: documentEditorScreenId(row.kind), params: { id: row.id } }
        : null,
    receipt: (row) =>
      isReceiptKind(row.kind)
        ? { screenId: receiptEditorScreenId(row.kind), params: { id: row.id } }
        : null,
  }

/**
 * The editor a row opens, or null where there is nowhere to go.
 *
 * Null is an answer rather than a failure: a kind these books do not recognise has no
 * editor in this build, and the row is drawn as text. A route to a screen that does not
 * resolve is a blank page rather than a message.
 */
export function activityTarget(row: ActivityRow): ItemTarget | null {
  return ACTIVITY_TARGETS[row.source](row)
}

// ---- How much of each list is shown -----------------------------------------

/**
 * Rows drawn in a "needs attention" panel.
 *
 * Small on purpose. A dashboard panel listing forty drafts is a register with none of a
 * register's filters, and the registers are one click away in the sidebar.
 */
export const ATTENTION_LIMIT = 5

/** Rows drawn in the activity panel, and asked of each of the two channels behind it. */
export const ACTIVITY_LIMIT = 6

/**
 * One page of a list that was asked for one row more than it shows.
 *
 * The extra row IS the answer to "is there more of this", with no count query and no way
 * to be off by one — the mechanism `DocumentRegister` pages with, borrowed for a panel
 * that says "and there are others" rather than offering a Next.
 */
export function pageOf<T>(
  rows: readonly T[],
  limit: number,
): { rows: readonly T[]; hasMore: boolean } {
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit }
}
