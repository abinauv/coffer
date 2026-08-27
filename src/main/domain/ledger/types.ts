/*
 * The ledger contract — the shapes and invariants every book in Coffer is written to.
 *
 * ARCHITECTURE §6.1 puts the ledger before any document screen, because a document that
 * cannot post is a document that will be reworked. This file is what "posts" means. It
 * is types and definitions only: no I/O, no ambient state, and nothing that knows a tax
 * regime exists.
 *
 * ---------------------------------------------------------------------------
 * THE FIVE INVARIANTS
 *
 * 1. EVERY ENTRY BALANCES. Total debits equal total credits, exactly, at full
 *    precision. Enforced here in `isBalanced`, again in the repository before commit,
 *    and again by the database itself (see the trigger note below). Three times,
 *    because an unbalanced entry is not a bug you find later — it is a set of books
 *    that never reconciles again and no way to tell when it stopped.
 *
 * 2. THE LEDGER HOLDS ONLY POSTED ENTRIES. There is no draft state and no status
 *    column. A draft invoice is a draft in the sales tables; it reaches the ledger the
 *    moment it is posted and not before. This is what lets a trial balance be
 *    `SELECT ... FROM journal_lines` with no filter — and a filter that someone forgets
 *    to write is exactly how a draft leaks into a filed return.
 *
 * 3. A POSTED ENTRY IS IMMUTABLE. Not edited, not deleted, not "just fixing the
 *    narration". Corrections are reversals: a new entry, dated when the correction was
 *    made, carrying the mirror of the original. This is the audit trail, and it is the
 *    difference between books and a spreadsheet.
 *
 * 4. NO STORED BALANCES (CONVENTIONS §1). An account's balance is a sum over lines,
 *    every time. A cached balance is a second source of truth that will disagree with
 *    the first one, silently, starting on a date nobody can identify.
 *
 * 5. A LINE IS A DEBIT OR A CREDIT, NEVER BOTH AND NEVER NEITHER. Both amounts are
 *    non-negative; exactly one is non-zero. A signed single amount would be smaller,
 *    and it would also make "which side is this on?" a question about a minus sign
 *    rather than a fact — see `signedEffect` for the conversion that stays in memory.
 *
 * ---------------------------------------------------------------------------
 * HOW THE DATABASE ENFORCES INVARIANT 1
 *
 * SQLite has no deferred triggers, so a trigger cannot check a running total midway
 * through inserting an entry's lines. The mechanism migration 0004 uses instead is to
 * INSERT THE LINES FIRST AND THE ENTRY LAST, with the lines' foreign key declared
 * `DEFERRABLE INITIALLY DEFERRED`. A `BEFORE INSERT` trigger on `journal_entries` then
 * sees the complete set of lines for `NEW.id` and aborts unless they balance and there
 * are at least two of them.
 *
 * The insert order is backwards from the obvious one, deliberately and permanently, and
 * THREE TRIGGERS RATHER THAN THE FOREIGN KEY ARE WHAT HOLD IT THERE. The deferred key
 * was originally expected to do it on its own. It does not, and this was measured
 * rather than assumed: writing the entry first and its lines afterwards commits
 * perfectly happily, because a deferred key only asks that the parent exist BY COMMIT,
 * not that it did not exist already. Worse, that order skips the balance check
 * altogether — the trigger runs when no line has been written yet, and the sum of no
 * lines is zero, which balances.
 *
 * So the order is enforced by:
 *
 *   1. `journal_entries_need_two_lines`, which refuses an entry that cannot see at
 *      least two lines already carrying its id. This is what an entry-first insert
 *      trips over.
 *   2. `journal_lines_before_entry`, which refuses a line whose parent entry already
 *      exists. This is what makes an entry closed the instant it is written, and it is
 *      the same rule as invariant 3 seen from the other side.
 *   3. `journal_entries_must_balance`, the sum itself.
 *
 * Read all three as one mechanism. Removing any of them reopens a path that writes an
 * unbalanced entry without any error at all, which is the failure this file exists to
 * make impossible.
 */

import type { Decimal } from '@main/domain/money'
import type { DateString } from '@shared/scalars'

// ---- Accounts -------------------------------------------------------------

/**
 * The five fundamental account classifications. Everything else about an account —
 * its code, its place in the tree, what a screen calls it — is presentation. This is
 * the part that decides which side of the accounting equation a figure lands on, and
 * it is the one field on an account that may never change once anything has posted to
 * it.
 */
export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense'

export const ACCOUNT_TYPES: readonly AccountType[] = [
  'asset',
  'liability',
  'equity',
  'income',
  'expense',
] as const

/** Which side increases the account. */
export type NormalBalance = 'debit' | 'credit'

/**
 * The normal balance of each type. Not configurable, not a column, not an opinion —
 * this is the definition of double-entry bookkeeping and a build in which it differs is
 * a build producing wrong books.
 */
export const NORMAL_BALANCE: Readonly<Record<AccountType, NormalBalance>> = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  income: 'credit',
} as const

export function normalBalanceOf(type: AccountType): NormalBalance {
  return NORMAL_BALANCE[type]
}

/**
 * True for the types that appear on the balance sheet and carry forward across a year
 * end. Income and expense are period accounts: they close into retained earnings and
 * start the next year at zero.
 */
export function isPermanent(type: AccountType): boolean {
  return type === 'asset' || type === 'liability' || type === 'equity'
}

/**
 * A semantic slot a posting rule can ask for without naming an account code.
 *
 * This is what keeps `1100` out of the invoice posting rule. A user may renumber their
 * whole chart of accounts, or seed a different template entirely, and the rules keep
 * working because they never asked for `1100` — they asked for where receivables go.
 *
 * Roles are a mapping the company owns, not a property of the account, because one
 * account can serve several roles in a small business and the mapping changes without
 * the account changing. Tax accounts are deliberately absent: a regime has as many tax
 * accounts as it has components, and naming them here would put GST in `domain/`. Ask
 * `AccountResolver.forTaxComponent` instead.
 */
export type AccountRole =
  | 'accounts-receivable'
  | 'accounts-payable'
  | 'sales'
  | 'sales-returns'
  | 'purchases'
  | 'purchase-returns'
  | 'cash'
  | 'bank'
  | 'stock'
  | 'cost-of-goods-sold'
  | 'stock-adjustment'
  | 'discount-allowed'
  | 'discount-received'
  | 'freight-outward'
  | 'freight-inward'
  | 'round-off'
  | 'opening-balance-equity'
  | 'retained-earnings'
  | 'suspense'

export const ACCOUNT_ROLES: readonly AccountRole[] = [
  'accounts-receivable',
  'accounts-payable',
  'sales',
  'sales-returns',
  'purchases',
  'purchase-returns',
  'cash',
  'bank',
  'stock',
  'cost-of-goods-sold',
  'stock-adjustment',
  'discount-allowed',
  'discount-received',
  'freight-outward',
  'freight-inward',
  'round-off',
  'opening-balance-equity',
  'retained-earnings',
  'suspense',
] as const

/**
 * The minimum a posting rule needs to know about an account. Deliberately not the whole
 * account record — a rule has no business seeing a description or a parent link, and
 * accepting less makes it trivial to test with a literal.
 */
export interface AccountRef {
  id: string
  code: string
  name: string
  type: AccountType
}

// ---- Periods --------------------------------------------------------------

/**
 * Whether a period will accept postings.
 *
 * `closed` is the ordinary month end: a mistake found afterwards is either reopened or
 * corrected in the current period, and either is a decision someone gets to make.
 * `locked` is the one that does not reopen — a filed return or a signed audit. The
 * distinction exists because a single "closed" flag makes every close feel dangerous,
 * and a period nobody dares close is a period that stays open forever.
 */
export type PeriodStatus = 'open' | 'closed' | 'locked'

/**
 * A period as the ledger holds it: a span that has a status and can refuse a posting.
 *
 * Distinct from `FiscalPeriod` in `domain/time`, which is a pure calendar span derived
 * from a rule and exists for any year whether or not the books do. The time domain can
 * tell you the quarters of 2031-32; only this table can tell you whether you may post
 * into one.
 */
export interface AccountingPeriodRef {
  id: string
  /** The fiscal year's label, e.g. '2026-27'. */
  fiscalYearLabel: string
  /** Position within the fiscal year, 1-based. */
  index: number
  startDate: DateString
  /** Inclusive. */
  endDate: DateString
  status: PeriodStatus
}

/** A period accepts postings only while open. */
export function acceptsPostings(period: AccountingPeriodRef): boolean {
  return period.status === 'open'
}

// ---- Source documents -----------------------------------------------------

/**
 * What produced an entry. `manual` is a journal someone typed; everything else is a
 * document that posted itself and can be drilled back to.
 *
 * Extended as each phase lands its documents. The union is closed on purpose: an
 * unknown source type in a company file means the file was written by a newer build,
 * and the ledger should say so rather than render a drill-through that goes nowhere.
 */
export type SourceDocumentType =
  | 'manual'
  | 'opening-balance'
  | 'sales-invoice'
  | 'credit-note'
  | 'purchase-bill'
  | 'debit-note'
  | 'receipt'
  | 'payment'
  | 'refund'
  | 'refund-received'
  | 'stock-adjustment'
  | 'year-end-close'

/** The document an entry came from, enough to find it and to name it on screen. */
export interface SourceDocument {
  type: SourceDocumentType
  /** Primary key in that document's own table. Null for `manual`. */
  id: string | null
  /** The number a human would quote, e.g. 'INV-2026-27-0042'. Null for `manual`. */
  number: string | null
}

/** A manual journal has no document behind it. */
export const MANUAL_SOURCE: SourceDocument = {
  type: 'manual',
  id: null,
  number: null,
} as const

// ---- Entry drafts ---------------------------------------------------------

/*
 * A draft is what a posting rule produces and the repository consumes. Amounts are
 * `Decimal` — full precision, in memory, never rounded on the way through. They become
 * decimal strings once, at the storage boundary.
 *
 * "Draft" here means "not yet written", not a saved status. See invariant 2.
 */

export interface EntryLineDraft {
  accountId: string
  /** Non-negative. Zero when this is a credit line. */
  debit: Decimal
  /** Non-negative. Zero when this is a debit line. */
  credit: Decimal
  /** Line-level note. The entry's narration covers the whole entry. */
  narration?: string
  /**
   * Whose money this line is. Required on a line posting to a party control account.
   *
   * This is what makes a receivables ledger a grouping of the same lines the balance
   * sheet reads, rather than a second set of books that has to be reconciled with it. A
   * party is an opaque id here, and deliberately: the domain has no business knowing
   * what a customer record contains, only that a figure belongs to one.
   *
   * Permitted on any line and required on few — an advance received from a customer is
   * that customer's money and is not a receivable. Which accounts require it is a
   * question about the company's role mapping, which lives in `db/` and is enforced
   * there.
   */
  partyId?: string | null
}

export interface EntryDraft {
  /** The date the entry is posted as of. Decides the period, and it is not "now". */
  date: DateString
  narration: string
  source: SourceDocument
  lines: readonly EntryLineDraft[]
}

// ---- Balance ---------------------------------------------------------------

export interface EntryTotals {
  debit: Decimal
  credit: Decimal
  /** `debit - credit`. Zero exactly when the entry balances. */
  difference: Decimal
}

/**
 * The effect of a line on its account's own balance, positive in the account's normal
 * direction.
 *
 * A 100 credit to a liability is +100 to what the business owes; a 100 credit to an
 * asset is -100 of what it holds. Reports read this way round because that is how the
 * figures are spoken about, and it is the only place a debit or credit is allowed to
 * become a signed number.
 */
export function signedEffect(type: AccountType, debit: Decimal, credit: Decimal): Decimal {
  return normalBalanceOf(type) === 'debit' ? debit.minus(credit) : credit.minus(debit)
}

// ---- Posting ---------------------------------------------------------------

/**
 * Resolves the accounts a posting rule asks for.
 *
 * Every method is a pure lookup over data the caller has already fetched. A rule runs
 * in `domain/` and must not reach a database, so the repository loads the chart of
 * accounts and the role map first and hands over a resolver closed over them.
 *
 * A lookup that finds nothing returns null rather than throwing, and the rule decides
 * whether that is fatal. A missing round-off account is a nuisance; a missing
 * receivables account means the invoice cannot post at all, and only the rule knows
 * which of those it is looking at.
 */
export interface AccountResolver {
  byId(id: string): AccountRef | null
  byCode(code: string): AccountRef | null
  /** The account mapped to a semantic slot. */
  forRole(role: AccountRole): AccountRef | null
  /**
   * The account collecting one tax component, keyed by the regime's own component code
   * ('CGST', 'IGST', 'VAT'), and by direction — output tax is a liability, input tax is
   * an asset, and they are never the same account.
   */
  forTaxComponent(componentCode: string, direction: 'output' | 'input'): AccountRef | null
}

/**
 * Everything a posting rule may consult. If a rule needs something that is not here,
 * the answer is to add it here — never to import a repository into `domain/`.
 */
export interface PostingContext {
  accounts: AccountResolver
  /** The period the document's date falls in. Null when no period covers it. */
  period: AccountingPeriodRef | null
  /** The company's own jurisdiction, for rules that branch on it. */
  homeJurisdictionCode: string | null
}

/**
 * How one kind of document becomes a journal entry.
 *
 * Pure: same document and same context, same entry, every time. No clock, no database,
 * no randomness — which is what makes a posting rule testable by writing down a
 * document and the entry it should produce, and what makes those tests the thing that
 * catches a change in accounting treatment.
 */
export interface PostingRule<TDocument> {
  readonly source: SourceDocumentType
  /** What this posts, for error messages and the audit trail. */
  readonly label: string
  toEntry(document: TDocument, context: PostingContext): EntryDraft
}

// ---- Failures --------------------------------------------------------------

/*
 * What a posting *produces* — `PostingResult` — is a transport shape and lives in
 * `shared/dto.ts` with the rest of them. The domain builds an `EntryDraft`; the
 * repository writes it and reports what it wrote. Keeping the result out of here is
 * what stops `domain/` acquiring a dependency on the IPC contract.
 */

/**
 * Why a posting was refused. Every one of these is an expected, actionable failure that
 * crosses IPC as an `AppError` code, not an exception — see CONVENTIONS §5.
 */
export type LedgerErrorCode =
  /** Debits did not equal credits. */
  | 'UNBALANCED_ENTRY'
  /** Fewer than two lines, or no lines at all. */
  | 'INSUFFICIENT_LINES'
  /** A line had both a debit and a credit, or neither. */
  | 'AMBIGUOUS_LINE'
  /** A negative debit or credit. Move it to the other side instead. */
  | 'NEGATIVE_AMOUNT'
  /** The entry's date falls in a period that is closed or locked. */
  | 'PERIOD_CLOSED'
  /** The entry's date falls outside every period the books have. */
  | 'NO_PERIOD'
  /** A line names an account that does not exist. */
  | 'ACCOUNT_NOT_FOUND'
  /** A line posts to a group account, which holds no figures of its own. */
  | 'ACCOUNT_IS_GROUP'
  /** A line posts to an archived account. */
  | 'ACCOUNT_ARCHIVED'
  /** A posting rule asked for a role no account is mapped to. */
  | 'ROLE_UNMAPPED'
  /** An attempt to modify or delete a posted entry. See invariant 3. */
  | 'ENTRY_IMMUTABLE'
  /** The entry has already been reversed; it cannot be reversed twice. */
  | 'ALREADY_REVERSED'
  /** A reversal was asked for against an entry that is not in the books. */
  | 'ENTRY_NOT_FOUND'

/**
 * A posting that cannot be built, raised by a posting rule.
 *
 * `checkDraft` beside this file RETURNS its problems, because a user who typed a journal
 * wants every bad line at once. A posting rule cannot: it returns an `EntryDraft`, and
 * there is no half-built entry to hand back. So the one shape of failure it has — the
 * books are missing an account this document needs — is thrown, carrying the same
 * `LedgerErrorCode` vocabulary everything else reports, so the repository has nothing to
 * translate and the user reads one sentence rather than two.
 *
 * It stays in `domain/` and stays free of any dependency: this is the only error class
 * the pure layer owns, and it exists because `toEntry` has no other way to say no.
 */
export class PostingError extends Error {
  readonly code: LedgerErrorCode
  /** Structured context for the message the user eventually sees. Never a path. */
  readonly details: Record<string, unknown>

  constructor(
    code: LedgerErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'PostingError'
    this.code = code
    this.details = details
  }
}

export function isPostingError(value: unknown): value is PostingError {
  return value instanceof PostingError
}
