/*
 * Data transfer objects — the shapes that cross the IPC boundary.
 *
 * Imported by main, preload and renderer. Everything here must be structured-clone
 * safe: plain objects, arrays and primitives only. No class instances, no Decimal, no
 * Date, no functions.
 *
 * MONEY CROSSES AS A DECIMAL STRING. Never a number, at any layer, for any reason.
 * See docs/CONVENTIONS.md §1 and §3.
 */

// ---- Scalars --------------------------------------------------------------

/* Declared once in ./scalars and re-exported here so DTO consumers get them from the
 * contract they already import. */
import type { DateString, DecimalString, Timestamp } from './scalars'
export type { DateString, DecimalString, Timestamp }

// ---- Result envelope ------------------------------------------------------

/*
 * Every IPC method returns a Result. Expected, actionable failures come back as
 * `ok: false` with a code the renderer can branch on; unexpected failures throw in the
 * handler and are logged at the boundary. See docs/CONVENTIONS.md §5.
 */

export interface AppError {
  /** Stable, machine-readable. e.g. 'PERIOD_CLOSED', 'UNBALANCED_ENTRY'. */
  code: string
  /** Shown to the user. Says what went wrong and what to do about it. */
  message: string
  /** Optional structured context for the UI. Never a stack trace. */
  details?: Record<string, unknown>
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError }

// ---- System ---------------------------------------------------------------

/* `shared` is imported by the renderer, which has no Node types. Platform is expressed
 * as a union here rather than as NodeJS.Platform for that reason. */
export type Platform = 'win32' | 'darwin' | 'linux'

export interface AppInfo {
  name: string
  version: string
  platform: Platform
  /** True when running from a dev server rather than a packaged build. */
  isDevelopment: boolean
}

/**
 * Colours for the OS-drawn window buttons on Windows and Linux. Supplied by the
 * renderer, which is the only side that knows which theme is actually showing.
 * Values are hex strings taken from the design tokens.
 */
export interface TitleBarOverlayColors {
  /** Background behind the buttons — the `--chrome` token. */
  color: string
  /** The glyphs themselves — the `--ink-muted` token. */
  symbolColor: string
}

// ---- Companies ------------------------------------------------------------

/*
 * A company is an encrypted SQLite database plus a sidecar vault holding its wrapped
 * keys. The registry lists them; it never holds their contents or their keys. There is
 * deliberately no `companyId` on any other DTO — see docs/ARCHITECTURE.md §6.3.
 */

/** Why a company cannot be opened. `ok` means it can. */
export type CompanyAvailability =
  | 'ok'
  /** The database file is gone or unreadable — moved, deleted, or on an absent drive. */
  | 'database-missing'
  /** The database is there but its vault is not. Restore from a backup holding both. */
  | 'vault-missing'

export interface CompanySummary {
  /** Registry-local identifier. Not a tenant key; nothing else is scoped by it. */
  id: string
  displayName: string
  /** Absolute path to the encrypted database file. */
  filePath: string
  /** Absolute path to the sidecar vault. Derived from filePath, stored for clarity. */
  vaultPath: string
  lastOpenedAt: Timestamp | null
  createdAt: Timestamp
  availability: CompanyAvailability
}

// ---- Passphrase strength --------------------------------------------------

/*
 * Strength is advisory, never blocking. SECURITY.md treats allowing a weak passphrase
 * *without warning* as a vulnerability — but with no key escrow (ARCHITECTURE §6.3.1),
 * refusing a user their own passphrase leaves them no fallback at all.
 */

export interface PassphraseStrength {
  /** 0 (trivial) to 4 (strong). */
  score: 0 | 1 | 2 | 3 | 4
  /** Short verdict for the meter, e.g. 'Weak'. */
  label: string
  /** The single most useful thing this passphrase could do better. Null when strong. */
  suggestion: string | null
  /** True below the advisory threshold — show the warning, still allow it through. */
  isWeak: boolean
}

// ---- Company operations ---------------------------------------------------

export interface CreateCompanyInput {
  displayName: string
  /** Directory to create the database in. The file name derives from displayName. */
  directoryPath: string
  passphrase: string
  /**
   * Which tax regime these books follow, e.g. 'in'. Defaults to the only one installed.
   *
   * It decides the fiscal-year rule the opening periods are generated from, so it is
   * fixed at creation rather than changed later: the periods on disk were built from it.
   */
  regimeId?: string
}

export interface OpenCompanyInput {
  id: string
  passphrase: string
}

/** Opening with a recovery code instead of the passphrase. The code is then spent. */
export interface RecoverCompanyInput {
  id: string
  recoveryCode: string
  /** The passphrase to set once the code is accepted. Recovery always re-establishes one. */
  newPassphrase: string
}

export interface OpenCompanyResult {
  company: CompanySummary
  /**
   * Recovery codes, returned exactly once — at creation, or when recovery consumes one
   * and a fresh set is issued. Never retrievable afterwards.
   */
  recoveryCodes?: string[]
  /** How many single-use recovery codes remain unspent. */
  recoveryCodesRemaining: number
}

export interface ChangePassphraseInput {
  currentPassphrase: string
  newPassphrase: string
}

// ---- Backup and restore ---------------------------------------------------

/*
 * Backup is a first-class action, not a file copy: the database is useless without its
 * vault, so an archive carrying both is the only artefact we call a backup.
 */

export interface BackupInput {
  /** Directory to write the archive into. */
  directoryPath: string
}

export interface BackupResult {
  /** Absolute path to the archive that was written. */
  archivePath: string
  sizeBytes: number
  createdAt: Timestamp
}

export interface RestoreInput {
  archivePath: string
  /** Directory to restore the company into. */
  directoryPath: string
}

// ---- The ledger -----------------------------------------------------------

/*
 * The transport side of src/main/domain/ledger/types.ts. Read the five invariants at
 * the top of that file — they are why there is no `status` on an entry, no `balance` on
 * an account, and no way to edit either.
 *
 * Every amount here is a decimal string at money scale. The renderer displays them and
 * never computes with them (CONVENTIONS §1).
 */

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense'

export type NormalBalance = 'debit' | 'credit'

export interface Account {
  id: string
  code: string
  name: string
  type: AccountType
  /** Which side increases it. Derived from `type`, sent so the renderer need not. */
  normalBalance: NormalBalance
  parentId: string | null
  /** A group totals its children and accepts no postings of its own. */
  isGroup: boolean
  isArchived: boolean
  description: string | null
  /** Depth in the tree, 0 at the root. For indenting a flattened list. */
  depth: number
  /** Semantic slots this account fills, e.g. 'accounts-receivable'. Usually empty. */
  roles: string[]
}

export interface CreateAccountInput {
  code: string
  name: string
  type: AccountType
  parentId: string | null
  isGroup: boolean
  description?: string | null
}

/**
 * `type` is absent on purpose: an account's type may not change once anything has
 * posted to it, because every figure already in the books was classified by it. Create
 * the account you meant and move the balance across with a journal.
 */
export interface UpdateAccountInput {
  id: string
  code?: string
  name?: string
  parentId?: string | null
  description?: string | null
  isArchived?: boolean
}

// ---- Periods --------------------------------------------------------------

export type PeriodStatus = 'open' | 'closed' | 'locked'

export interface AccountingPeriod {
  id: string
  fiscalYearLabel: string
  /** Position within the fiscal year, 1-based. */
  index: number
  /** e.g. 'Apr 2026'. */
  label: string
  startDate: DateString
  /** Inclusive. */
  endDate: DateString
  status: PeriodStatus
  closedAt: Timestamp | null
}

// ---- Journal entries ------------------------------------------------------

export interface JournalLine {
  id: string
  lineNumber: number
  accountId: string
  /** Denormalised for display, so a journal renders without a join per line. */
  accountCode: string
  accountName: string
  /** Money, 2dp. '0.00' when this is a credit line. */
  debit: DecimalString
  /** Money, 2dp. '0.00' when this is a debit line. */
  credit: DecimalString
  narration: string | null
}

export interface JournalEntry {
  id: string
  entryNumber: string
  date: DateString
  narration: string
  /** A `SourceDocumentType`. 'manual' for a typed journal. */
  sourceType: string
  sourceId: string | null
  sourceNumber: string | null
  periodId: string
  /** The entry this one reverses, when it is a reversal. */
  reversesEntryId: string | null
  /** The entry that reversed this one. Derived, not stored — see invariant 3. */
  reversedByEntryId: string | null
  lines: JournalLine[]
  /** Debits, which equal credits. */
  total: DecimalString
  postedAt: Timestamp
}

/** One line of a journal being written. Exactly one of the amounts is non-zero. */
export interface JournalLineInput {
  accountId: string
  debit: DecimalString
  credit: DecimalString
  narration?: string | null
}

export interface CreateJournalEntryInput {
  date: DateString
  narration: string
  lines: JournalLineInput[]
}

export interface ReverseEntryInput {
  entryId: string
  /** The date the reversal is posted as of — not the original's date. */
  date: DateString
  narration: string
}

/**
 * What came back from writing an entry. Enough to confirm it and to navigate to it,
 * without shipping the whole entry to a caller that only wanted to know it worked.
 */
export interface PostingResult {
  entryId: string
  entryNumber: string
  date: DateString
  /** Debits, which equal credits. */
  total: DecimalString
  lineCount: number
  postedAt: Timestamp
}

// ---- Opening balances and the year end ------------------------------------

/** One account's balance as it stood when the books began. */
export interface OpeningBalanceLine {
  accountId: string
  /**
   * Positive in the account's normal direction — a bank account with 50,000 in it is
   * '50000.00', and so is a loan of 50,000 owed. Asking for a debit or a credit here
   * would make somebody translate their old trial balance twice.
   */
  amount: DecimalString
}

export interface PostOpeningBalancesInput {
  /** Usually the first day the books cover. Must fall in an open period. */
  date: DateString
  lines: OpeningBalanceLine[]
}

export interface CloseFiscalYearInput {
  /** The calendar year the fiscal year starts in. */
  startYear: number
}

/** What a year-end close did, or why it had nothing to do. */
export interface YearEndCloseResult {
  fiscalYearLabel: string
  /** Null when the year had no income or expense to close. */
  posting: PostingResult | null
  /** The profit (positive) or loss (negative) moved to retained earnings. */
  netResult: DecimalString
  accountsClosed: number
}

// ---- Query inputs ---------------------------------------------------------

export interface ListAccountsInput {
  /** Include archived accounts. Off by default — a picker should not offer them. */
  includeArchived?: boolean
}

/** Inclusive on both ends. An omitted bound means "as far as the books go". */
export interface DateRangeInput {
  fromDate?: DateString
  toDate?: DateString
}

export interface ListJournalEntriesInput extends DateRangeInput {
  periodId?: string
  sourceType?: string
  /** Only entries touching this account. */
  accountId?: string
  limit?: number
  offset?: number
}

export interface SetAccountRoleInput {
  role: string
  accountId: string
}

// ---- Balances -------------------------------------------------------------

/*
 * Every figure below is summed from `journal_lines` when asked. Nothing is stored and
 * nothing is cached — invariant 4. A balance that disagrees with the lines it came from
 * is the failure mode this rules out, and it is the one nobody notices for months.
 */

export interface TrialBalanceRow {
  accountId: string
  code: string
  name: string
  type: AccountType
  /** Total debits posted in the range. */
  debit: DecimalString
  /** Total credits posted in the range. */
  credit: DecimalString
  /** `debit - credit` when that is positive, else '0.00'. The left-hand column. */
  debitBalance: DecimalString
  /** `credit - debit` when that is positive, else '0.00'. The right-hand column. */
  creditBalance: DecimalString
}

export interface TrialBalance {
  /** Inclusive. Null means from the first entry in the books. */
  fromDate: DateString | null
  /** Inclusive. */
  toDate: DateString | null
  /** Accounts with movement in the range, in code order. Groups never appear. */
  rows: TrialBalanceRow[]
  totalDebit: DecimalString
  totalCredit: DecimalString
  /**
   * Whether the two totals agree. Always true for books written through this
   * application — it is reported rather than assumed so that a report can say so, and
   * so that a test asserting it is testing something.
   */
  balanced: boolean
}

export interface AccountBalance {
  accountId: string
  code: string
  name: string
  type: AccountType
  normalBalance: NormalBalance
  debit: DecimalString
  credit: DecimalString
  /** Positive in the account's normal direction. Negative means it is the other way. */
  balance: DecimalString
}
