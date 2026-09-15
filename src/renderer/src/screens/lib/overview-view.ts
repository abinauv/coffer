/*
 * What the Overview has to decide before it can draw anything.
 *
 * NOTHING HERE ADDS UP MONEY (CONVENTIONS §1.7), and a dashboard is where that rule is
 * most tempting to break: the obvious "net position" is receivables less payables, and
 * the obvious "cash" is a sum of bank balances. Every figure the page shows is one main
 * computed — an aged report's `totals.total`, a party's own `total`, the cash and bank
 * total and the month's net profit from `reports.overviewFigures`. Where no channel
 * returns a figure, the page does without it rather than inventing one.
 *
 * WHAT IS DECIDED HERE IS SELECTION, ORDER, COUNTING AND WORDS, none of which is money:
 *
 *   `isNewCompany`     whether these books have been started at all.
 *   `firstRunSteps`    what to do first, and which of it is already done.
 *   `oldestOwed`       who has owed the longest, for "Owed to you, oldest first".
 *   `attentionItems`   the handful of real signals worth interrupting somebody with,
 *                      worst first.
 *   `figureNote`s      the line under each figure: how many, how many late, which days.
 *
 * A PANEL IS A STATE, NOT A NULL. `Panel<T>` distinguishes "still reading" from "read and
 * empty" from "the read failed", because a dashboard is many independent reads and the
 * three must not collapse into one blank space. `isNewCompany` is where that pays: a
 * failed read is not an empty company, and a screen that treated it as one would greet a
 * business of ten years with "add your first customer".
 */

import type { BadgeTone } from '@renderer/components/atoms'
import { definitionOf, isDocumentKind, type TradeSide } from '@shared/documents'
import type { AgedItem, AgedReport, AppError, DocumentListRow, Result } from '@shared/dto'
import { agedScreenId, isOverdue, type ItemTarget } from './ageing-view'
import { formatDate, formatDayRange } from './dates'
import { editorScreenId as documentEditorScreenId } from './document-view'
import { isNegativeAmount, isZeroAmount } from './ledger-format'

// ---- One read, in the three states it can be in -----------------------------

/**
 * What the dashboard knows about one of its reads.
 *
 * THREE STATES RATHER THAN `T | null`. "Reading it now", "read it, there is nothing" and
 * "the read failed" are three different things to a reader, and the null that stands for
 * all three is the reason a broken panel looks like an empty one.
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
 * enumerate them for a test to iterate. `satisfies Record<BadgeTone, BadgeTone>` makes
 * this one total: a sixth tone added to the atom fails to compile here, and a tone the
 * atom no longer has is an excess key. Worth the ceremony because the failure is silent —
 * a tone with no rule in atoms.css renders an unstyled pill rather than throwing.
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
 * Both counts have to have answered, because a failure is not an emptiness — a company
 * with a decade of invoices whose count failed would otherwise be told to add its first
 * customer. And both have to be nought: a company with no documents may still have taken
 * money on account.
 */
export function isNewCompany(documents: Panel<number>, receipts: Panel<number>): boolean {
  if (documents.state !== 'ready') return false
  if (receipts.state !== 'ready') return false
  return documents.data === 0 && receipts.data === 0
}

// ---- What to do first -------------------------------------------------------

/**
 * How far along one first-run step is.
 *
 * `unknown` IS A REAL ANSWER AND NOT A LOADING FLAG. The read behind a step can fail, and
 * a step that then said "to do" would be telling a user to enter business details they
 * have already entered.
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
 * Screens the dashboard links to that own their own ids. Collected rather than scattered,
 * so a rename in someone else's file has one place to be found. Derived ids — an editor,
 * a register, an aged report — come from the tables that build them.
 */
export const LINKED_SCREENS = {
  companyProfile: 'company-profile',
  customers: 'customers',
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
 * needs a party to be addressed to.
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
      title: 'Add your first customer',
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

/**
 * The step the day-one screen's main button offers: the first not yet known to be done.
 *
 * A step whose read failed counts as not done. Offering it again costs a click; skipping it
 * would send somebody to raise an invoice their books cannot issue yet.
 */
export function nextFirstRunStep(steps: readonly FirstRunStep[]): FirstRunStep | null {
  return steps.find((step) => step.state !== 'done') ?? null
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
 * reading, because it stands to the party's credit.
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
 * The late items, longest overdue first. Copied before sorting, because `sort` is in
 * place and the arrays here are derived from state; equal ages keep the report's order.
 */
export function mostOverdue(rows: readonly OverdueRow[]): readonly OverdueRow[] {
  return [...rows].sort((a, b) => b.item.daysOverdue - a.item.daysOverdue)
}

// ---- The four figures ---------------------------------------------------------

/** One word, singular or plural, for a count this file already has. */
function counted(count: number, singular: string, plural = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : plural}`
}

/*
 * Charges counted, not money: an item on one side's report with something owed on it. The
 * report lists what stands to a party's credit as well, and "3 unpaid" must not count a
 * credit note as a thing somebody has not paid.
 */
function chargesIn(report: AgedReport): number {
  return report.parties.reduce(
    (sum, party) =>
      sum +
      party.items.filter((item) => !isNegativeAmount(item.amount) && !isZeroAmount(item.amount))
        .length,
    0,
  )
}

/** The line under "Owed to you" and "You owe": how many are open, and how many are late. */
export function outstandingNote(side: TradeSide, report: AgedReport): string {
  const open = chargesIn(report)
  if (open === 0) return 'Nothing outstanding'
  const late = overdueRowsIn(side, report).length
  return `${String(open)} unpaid · ${String(late)} overdue`
}

/** The line under "Cash and bank": how many accounts the figure is made of. */
export function cashNote(accountCount: number): string {
  if (accountCount === 0) return 'No account fills the cash or bank role'
  return `across ${counted(accountCount, 'account')}`
}

/** The line under "This month, net": the days it covers, and what it is. */
export function monthNote(fromDate: string, toDate: string): string {
  return `${formatDayRange(fromDate, toDate)} · income less expenses`
}

/** "As at 13 Sep 2026 · financial year 2026-27", with the year left off until it is known. */
export function asAtLine(today: string, financialYear: string | null): string {
  const date = `As at ${formatDate(today)}`
  return financialYear === null ? date : `${date} · financial year ${financialYear}`
}

// ---- Owed to you, oldest first ------------------------------------------------

/** One party on the "Owed to you" list. */
export interface OwedRow {
  key: string
  partyId: string | null
  partyName: string
  /** The party's own total, as main sent it. */
  total: string
  /** How late their oldest charge is. Nought or below is not yet due. */
  daysOverdue: number
}

/** Rows on the list. A dashboard list of forty is a report with none of its columns. */
export const OWED_LIMIT = 5

/**
 * The parties who owe something, the one whose oldest charge is latest first.
 *
 * ORDERED BY AGE, NOT BY AMOUNT, which is the reverse of the report. The report leads with
 * the largest debt because it is read for the balance; this list is read for who to ring
 * first, and a small invoice ninety days late is the call to make before a large one due
 * tomorrow. A party whose total stands to their credit owes nothing and is not listed.
 */
export function oldestOwed(report: AgedReport, limit: number = OWED_LIMIT): readonly OwedRow[] {
  const rows: OwedRow[] = []
  for (const party of report.parties) {
    if (isNegativeAmount(party.total) || isZeroAmount(party.total)) continue
    const charges = party.items.filter((item) => item.bucket !== null)
    const oldest = charges.reduce(
      (worst, item) => Math.max(worst, item.daysOverdue),
      Number.NEGATIVE_INFINITY,
    )
    rows.push({
      key: party.partyId ?? `unnamed:${party.partyName}`,
      partyId: party.partyId,
      partyName: party.partyName,
      total: party.total,
      daysOverdue: Number.isFinite(oldest) ? oldest : 0,
    })
  }
  return rows.sort((a, b) => b.daysOverdue - a.daysOverdue).slice(0, limit)
}

/** How late, in words: "61 days overdue", or "Not yet due". */
export function ageLabel(daysOverdue: number): string {
  if (daysOverdue <= 0) return 'Not yet due'
  return `${counted(daysOverdue, 'day')} overdue`
}

/**
 * The badge an age wears. Past thirty days is the bad tone and anything late is a warning:
 * thirty days is the first bucket every aged report in these books draws, so the colour
 * changes where the report's own columns do.
 */
export function ageTone(daysOverdue: number): BadgeTone {
  if (daysOverdue > 30) return 'negative'
  if (daysOverdue > 0) return 'warning'
  return 'neutral'
}

// ---- Needs your attention -------------------------------------------------------

export const ATTENTION_TONES = ['negative', 'warning', 'info'] as const
export type AttentionTone = (typeof ATTENTION_TONES)[number]

/** One thing worth interrupting somebody with. */
export interface AttentionItem {
  id: string
  tone: AttentionTone
  title: string
  note: string
  /** Where acting on it happens. Absent where there is nowhere to go yet. */
  target?: ItemTarget
  /** The button's words, where there is a target. */
  actionLabel?: string
}

export interface AttentionSources {
  receivables: Panel<AgedReport>
  payables: Panel<AgedReport>
  draftCount: Panel<number>
  newestDraft: Panel<readonly DocumentListRow[]>
  recoveryCodesRemaining: number
}

/*
 * The words each side uses. A total record over the side, so the purchase side cannot
 * inherit "customers" from a conditional written for sales.
 */
const SIDE_ATTENTION: Readonly<
  Record<TradeSide, { charge: string; who: string; report: string; tone: AttentionTone }>
> = {
  sales: { charge: 'invoice', who: 'customers owe', report: 'aged receivables', tone: 'negative' },
  purchase: { charge: 'bill', who: 'you owe suppliers', report: 'aged payables', tone: 'warning' },
}

/**
 * The real signals, worst first. Nothing is here that the books cannot prove today.
 *
 * FIVE KINDS, AND WHAT IS LEFT OUT IS DELIBERATE. The design also shows a return not yet
 * looked at, a backup days old and an item below its reorder level. None of those is
 * recorded anywhere yet — no backup date is stored, no return screen exists, no stock level
 * is read — so they arrive with the work that records them (design plan R3).
 *
 *   an aged report that does not agree with its account    negative
 *   invoices past their due date                            negative
 *   bills past their due date                               warning
 *   recovery codes spent, or nearly                         negative / warning
 *   drafts not yet issued                                   info
 *
 * A read that failed contributes nothing here: its own failure is shown where the figure
 * would have been, and "nothing needs your attention" is only said when every read answered.
 */
export function attentionItems(sources: AttentionSources): readonly AttentionItem[] {
  const items: AttentionItem[] = []

  for (const [side, panel] of [
    ['sales', sources.receivables],
    ['purchase', sources.payables],
  ] as const) {
    if (panel.state !== 'ready') continue
    const words = SIDE_ATTENTION[side]
    const report = panel.data

    if (!report.ties) {
      items.push({
        id: `${side}:ties`,
        tone: 'negative',
        title: `What ${words.who} does not agree with ${report.accountCode} · ${report.accountName}`,
        note: `The ${words.report} lists every row behind it. The difference is somewhere among them.`,
        target: { screenId: agedScreenId(side), params: {} },
        actionLabel: `Open the ${words.report}`,
      })
    }

    const late = mostOverdue(overdueRowsIn(side, report))
    const worst = late[0]
    if (worst !== undefined) {
      const allDocuments = late.every((row) => row.item.source === 'document')
      const noun = allDocuments ? words.charge : 'amount'
      items.push({
        id: `${side}:overdue`,
        tone: words.tone,
        title: `${counted(late.length, noun)} ${late.length === 1 ? 'is' : 'are'} past the due date`,
        note: `Oldest is ${counted(worst.item.daysOverdue, 'day')} · ${worst.partyName}`,
        target: { screenId: agedScreenId(side), params: {} },
        actionLabel: `Open the ${words.report}`,
      })
    }
  }

  if (sources.recoveryCodesRemaining === 0) {
    items.push({
      id: 'recovery-codes',
      tone: 'negative',
      title: 'No recovery codes remain',
      note: 'The passphrase is now the only way into these books, and nobody can reset it. Keep a backup.',
    })
  } else if (sources.recoveryCodesRemaining <= 2) {
    items.push({
      id: 'recovery-codes',
      tone: 'warning',
      title: `Only ${counted(sources.recoveryCodesRemaining, 'recovery code')} left`,
      note: 'Each one opens this company once. When they are gone, the passphrase is the only way in.',
    })
  }

  if (sources.draftCount.state === 'ready' && sources.draftCount.data > 0) {
    items.push(draftsItem(sources.draftCount.data, sources.newestDraft))
  }

  const rank = (tone: AttentionTone): number => ATTENTION_TONES.indexOf(tone)
  return items.sort((a, b) => rank(a.tone) - rank(b.tone))
}

/*
 * The drafts line. It names the newest one and opens it where the list answered and the
 * kind is one this build draws; otherwise it says what a draft is and goes nowhere, rather
 * than guessing which register the rest are in — drafts can be any of five kinds.
 */
function draftsItem(count: number, newestDraft: Panel<readonly DocumentListRow[]>): AttentionItem {
  const title = `${counted(count, 'draft')} not yet issued`
  const newest = newestDraft.state === 'ready' ? newestDraft.data[0] : undefined
  if (newest === undefined || !isDocumentKind(newest.kind)) {
    return {
      id: 'drafts',
      tone: 'info',
      title,
      note: 'A draft is in nobody’s books until it is issued.',
    }
  }
  return {
    id: 'drafts',
    tone: 'info',
    title,
    note: `The newest is a ${definitionOf(newest.kind).label.toLowerCase()} for ${newest.partyName}, dated ${formatDate(newest.date)}`,
    target: { screenId: documentEditorScreenId(newest.kind), params: { id: newest.id } },
    actionLabel: 'Open the newest',
  }
}

/** Whether every read behind the attention list answered, so "nothing" can be said. */
export function isAttentionComplete(sources: AttentionSources): boolean {
  return (
    sources.receivables.state === 'ready' &&
    sources.payables.state === 'ready' &&
    sources.draftCount.state === 'ready'
  )
}
