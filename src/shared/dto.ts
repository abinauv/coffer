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
  /** Whose money this line is. Null on most lines — see `JournalLineInput.partyId`. */
  partyId: string | null
  /** Denormalised for display, for the same reason `accountName` is. Null with the id. */
  partyName: string | null
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
  /**
   * Whose money this line is.
   *
   * Required on a line posting to the account mapped to `accounts-receivable` or
   * `accounts-payable`, and refused there when absent — money on the balance sheet owed
   * by nobody makes the control account stop agreeing with the parties beneath it, with
   * nothing to say when it started. Permitted elsewhere: an advance from a customer is
   * that customer's money and is not a receivable.
   */
  partyId?: string | null
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
  /**
   * Whose money, for an opening balance on a control account.
   *
   * Receivables and payables are the one place a single opening figure is not enough. A
   * business adopting Coffer has 4,50,000 outstanding *from somebody*, and a control
   * account carrying that as one lump cannot produce an aged report, cannot be allocated
   * against, and disagrees with every party statement from day one. So an opening
   * receivable is entered one customer at a time — which is also why `accountId` may
   * repeat across lines when, and only when, the party differs.
   */
  partyId?: string | null
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

// ---- Units and items ------------------------------------------------------

/*
 * What goes on a document line, and the units quantities are counted in.
 *
 * Every field on an item is a DEFAULT for a line, never a lookup the line performs
 * later — a document line stores its own description, price and rate, so repricing an
 * item cannot rewrite an invoice already issued.
 */

/** Goods or a service. Decides which classification scheme applies, and prints. */
export type ItemKind = 'goods' | 'service'

export interface UnitOfMeasure {
  /** Short and upper case: 'NOS', 'KGS'. The identity — there is no separate id. */
  code: string
  name: string
  /**
   * Decimal places a quantity in this unit may carry, 0 to 3.
   *
   * Narrower than the 3dp storage scale, and about the unit rather than the column: half
   * a box is not a quantity, and an invoice line for one cannot be picked.
   */
  decimalPlaces: number
  /** What it reports as in a return, where the regime fixes a list. Null until mapped. */
  regimeCode: string | null
  isArchived: boolean
}

export interface CreateUnitInput {
  code: string
  name: string
  decimalPlaces?: number
  regimeCode?: string | null
}

export interface UpdateUnitInput {
  /** The unit being changed. A code is identity and is not editable. */
  code: string
  name?: string
  decimalPlaces?: number
  regimeCode?: string | null
  isArchived?: boolean
}

export interface ListUnitsInput {
  includeArchived?: boolean
}

/** Enough of an item for a list or a picker. */
export interface ItemSummary {
  id: string
  /** The business's own SKU. Null when they do not use one. */
  code: string | null
  name: string
  kind: ItemKind
  unitCode: string | null
  /** HSN or SAC in India. Null where none applies. */
  classificationCode: string | null
  /** Rate, 3dp decimal string. Null when the item has no standard rate. */
  taxRatePct: DecimalString | null
  /** Money, 2dp. Null when nothing standard has been agreed. */
  salePrice: DecimalString | null
  isSold: boolean
  isPurchased: boolean
  /** Freight, packing, insurance — taxable, but not sales revenue. */
  isCharge: boolean
  isArchived: boolean
}

/** The whole record, for an editor. */
export interface Item extends ItemSummary {
  description: string | null
  purchasePrice: DecimalString | null
  /** Overrides the account the document kind implies. Null for the usual case. */
  salesAccountId: string | null
  purchaseAccountId: string | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface CreateItemInput {
  name: string
  kind: ItemKind
  code?: string | null
  description?: string | null
  unitCode?: string | null
  classificationCode?: string | null
  taxRatePct?: DecimalString | null
  salePrice?: DecimalString | null
  purchasePrice?: DecimalString | null
  isSold?: boolean
  isPurchased?: boolean
  isCharge?: boolean
  salesAccountId?: string | null
  purchaseAccountId?: string | null
}

/** Absent means "leave it"; `null` means "clear it". As `UpdatePartyInput`. */
export interface UpdateItemInput extends Partial<CreateItemInput> {
  id: string
}

/** Which side an item list is for. */
export type ItemSide = 'sold' | 'purchased'

export interface ListItemsInput {
  includeArchived?: boolean
  /** Only what is sold, or only what is bought. Both when absent. */
  side?: ItemSide
  kind?: ItemKind
  /** Matches the name, the code or the classification code, ignoring case. */
  search?: string
}

export interface ArchiveItemInput {
  id: string
  archived: boolean
}

// ---- Documents ------------------------------------------------------------

/*
 * A trade document as it crosses the boundary.
 *
 * Every figure is a decimal string, already totalled. Nothing derivable is stored (rule
 * 4), so the totals below are computed on the way out — the renderer does no money
 * arithmetic (CONVENTIONS §1.7) and there is no stored total for them to disagree with.
 */

export type DocumentStatusDto = 'draft' | 'issued' | 'cancelled'

/** What the regime answered for one line, per component. Stored as given. */
export interface DocumentLineTaxDto {
  code: string
  /** What prints, e.g. 'CGST @ 9%'. The wording is the regime's. */
  label: string
  ratePct: DecimalString
  amount: DecimalString
}

export interface DocumentLineDto {
  id: string
  lineNumber: number
  itemId: string | null
  description: string
  /** Quantity, 3dp. May be negative on a document that returns something. */
  quantity: DecimalString
  unitCode: string | null
  unitPrice: DecimalString
  discount: DecimalString
  /** `quantity x unitPrice - discount`. What tax was charged on. */
  taxableAmount: DecimalString
  ratePct: DecimalString
  classificationCode: string | null
  isCharge: boolean
  accountId: string | null
  taxes: readonly DocumentLineTaxDto[]
}

/** Everything on the foot of a document. Derived, never stored. */
export interface DocumentTotalsDto {
  taxableValue: DecimalString
  totalDiscount: DecimalString
  totalTax: DecimalString
  netTotal: DecimalString
  /** What rounding added, signed. Zero when the policy is `none`. */
  roundOff: DecimalString
  grandTotal: DecimalString
  /** One row per component AND rate — an invoice may print CGST twice. */
  taxSummary: readonly DocumentLineTaxDto[]
}

/** Enough of a document for a register or a list. */
export interface DocumentSummary {
  id: string
  kind: string
  status: DocumentStatusDto
  /** Null while draft. Kept through cancellation. */
  number: string | null
  date: DateString
  partyId: string
  /** Denormalised for display, as `JournalLine.partyName` is. */
  partyName: string
  /** Derived on the way out, like every other figure. */
  grandTotal: DecimalString
}

export interface Document extends DocumentSummary {
  seriesId: string | null
  partyReference: string | null
  placeOfSupplyJurisdiction: string | null
  placeOfSupplyCountry: string
  roundingPolicy: 'whole-unit' | 'none'
  narration: string
  /** The entry it posted as. Null while draft — there is no state between (rule 3). */
  entryId: string | null
  lines: readonly DocumentLineDto[]
  totals: DocumentTotalsDto
  createdAt: Timestamp
  updatedAt: Timestamp
  issuedAt: Timestamp | null
  cancelledAt: Timestamp | null
}

/*
 * ---------------------------------------------------------------------------
 * TWO SHAPES FOR A DOCUMENT ON THE WAY IN, AND THE DIFFERENCE IS THE TAX
 *
 * `CreateDocumentInput` is what a SCREEN sends: what the user typed, and no tax. It is
 * the shape in the IPC contract, and the one the renderer knows.
 *
 * `CreateTaxedDocumentInput` is what the REPOSITORY takes: the same document with the
 * regime's answer already on it, line by line. The service in src/main/documents is what
 * turns the first into the second, and it is the only thing that may — `db/` must not
 * name a regime (CONVENTIONS §1.6) and the renderer must not compute money (§1.7), so the
 * conversion has exactly one legal home and this pair of names is what keeps it there.
 *
 * A screen wired straight to the repository would have to invent a `taxableAmount` and a
 * set of components. The name is what stops that being a plausible-looking thing to do.
 */

/**
 * A line as the repository takes it: priced AND taxed.
 *
 * `taxableAmount` and the taxes are supplied rather than computed here, because they are
 * the regime's answer as of the document's date and the caller is what has just asked the
 * regime. The repository checks that the amount agrees with the line's own figures rather
 * than trusting it — a mismatch is a caller bug, and one that would put a figure in the
 * books the invoice does not show.
 */
export interface TaxedLineInput {
  itemId?: string | null
  description: string
  quantity: DecimalString
  unitCode?: string | null
  unitPrice: DecimalString
  discount?: DecimalString
  taxableAmount: DecimalString
  ratePct?: DecimalString
  classificationCode?: string | null
  isCharge?: boolean
  accountId?: string | null
  taxes?: readonly DocumentLineTaxDto[]
}

/** A document as the repository takes it. Every line already carries its tax. */
export interface CreateTaxedDocumentInput {
  kind: string
  date: DateString
  partyId: string
  partyReference?: string | null
  placeOfSupplyJurisdiction?: string | null
  placeOfSupplyCountry: string
  roundingPolicy?: 'whole-unit' | 'none'
  narration?: string
  lines?: readonly TaxedLineInput[]
}

/**
 * A change to a draft, as the repository takes it.
 *
 * `lines`, when present, REPLACES every line. A draft's lines are edited as a set — the
 * grid the user is looking at is the whole document — and a per-line patch protocol would
 * be a second way to say the same thing, with its own ordering bugs.
 */
export interface UpdateTaxedDocumentInput {
  id: string
  date?: DateString
  partyId?: string
  partyReference?: string | null
  placeOfSupplyJurisdiction?: string | null
  placeOfSupplyCountry?: string
  roundingPolicy?: 'whole-unit' | 'none'
  narration?: string
  lines?: readonly TaxedLineInput[]
}

/**
 * A line as a SCREEN has it: priced by the user, not yet taxed.
 *
 * No `taxableAmount`, because `quantity x unitPrice - discount` is money and the renderer
 * never computes money (CONVENTIONS §1.7). No `taxes`, because which components apply is
 * the regime's answer and a screen may not ask it — the service does, once, with both
 * sides of the supply in hand.
 *
 * `ratePct` IS here, and is not the same kind of thing. It is the slab the user chose for
 * this line — 18, 5, 0 — which is an input to the tax rather than the tax. What that slab
 * breaks into, and whether it becomes CGST+SGST or IGST, is not for a screen to know.
 */
export interface DocumentLineInput {
  itemId?: string | null
  description: string
  quantity: DecimalString
  unitCode?: string | null
  unitPrice: DecimalString
  discount?: DecimalString
  /** The full rate for the line, e.g. '18'. Absent is nil-rated, not "work it out". */
  ratePct?: DecimalString
  /** HSN or SAC in India. Null where none applies. */
  classificationCode?: string | null
  /** Freight, packing, insurance. Taxable by default — see `TaxableLine.isCharge`. */
  isCharge?: boolean
  accountId?: string | null
}

/**
 * A new document, as a screen sends it.
 *
 * `placeOfSupplyCountry` and `placeOfSupplyJurisdiction` are OPTIONAL here and required
 * on the repository's shape, which is the one asymmetry worth reading twice. Absent means
 * "whatever the regime says", and the regime is asked with the company profile as the
 * supplier and the party as the customer. Supplying them is an override, for the invoice
 * where the place of supply is not where the customer is registered — a hotel room, goods
 * delivered to a third state — and it is a decision only a person can make.
 */
export interface CreateDocumentInput {
  kind: string
  date: DateString
  partyId: string
  partyReference?: string | null
  /** Overrides what the regime would decide. Absent is the ordinary case. */
  placeOfSupplyJurisdiction?: string | null
  /** Overrides what the regime would decide. Absent is the ordinary case. */
  placeOfSupplyCountry?: string
  roundingPolicy?: 'whole-unit' | 'none'
  narration?: string
  lines?: readonly DocumentLineInput[]
}

/**
 * A change to a draft, as a screen sends it.
 *
 * Absent means "leave it". `lines`, when present, replaces the whole set — and replacing
 * them re-asks the regime, because a line that changed rate or a party that changed state
 * changes the tax on every other line of the document.
 */
export interface UpdateDocumentInput {
  id: string
  date?: DateString
  partyId?: string
  partyReference?: string | null
  placeOfSupplyJurisdiction?: string | null
  placeOfSupplyCountry?: string
  roundingPolicy?: 'whole-unit' | 'none'
  narration?: string
  lines?: readonly DocumentLineInput[]
}

/**
 * Issuing a draft: the one call that allocates the number and posts the entry.
 *
 * Nothing about the document itself is on it. Issuing does not edit — the draft is
 * already exactly what it will be — so an input carrying a date or a line would be a
 * second way to change a document, arriving at the moment it stops being changeable.
 */
export interface IssueDocumentInput {
  id: string
  /**
   * Which series to draw the number from. Absent takes the kind's default.
   *
   * A choice rather than a setting, because a business with an export series and a
   * domestic one picks per invoice, and the pick has to be made before the number is
   * spent rather than corrected afterwards — there is no correcting it.
   */
  seriesId?: string
}

/**
 * Cancelling an issued document: reverse what it posted, keep what it was.
 *
 * The number stays (rule 2), the lines stay, and the entry it posted stays — what
 * changes is that a second entry now cancels the first. Deleting is a different
 * operation and only reaches a draft.
 */
export interface CancelDocumentInput {
  id: string
  /**
   * The date the reversal posts as of. Absent uses the document's own date.
   *
   * Its own date is right when nothing has been filed: the invoice leaves the month it
   * was in, as if it had not been raised. Once that period is closed the reversal has to
   * land somewhere open, and saying so is the caller's decision rather than a silent
   * shift to today.
   */
  date?: DateString
  /** What the day book says about the reversal. Defaulted from the document's number. */
  narration?: string
}

export interface ListDocumentsInput {
  kind?: string
  status?: DocumentStatusDto
  partyId?: string
  fromDate?: DateString
  toDate?: DateString
  /** Matches the number, the party name or the narration, ignoring case. */
  search?: string
  limit?: number
  offset?: number
}

// ---- Numbering ------------------------------------------------------------

/*
 * How a document's number is built. Every part of the shape is data, because the shape
 * is the business's own choice and matching the series they already use is the first
 * thing anyone leaving another system asks for.
 */

/** Where a counter restarts. Mirrors `NumberingReset` in main/domain/documents. */
export type NumberingReset = 'fiscal-year' | 'never'

export interface NumberingSeriesRecord {
  id: string
  /** A document kind: 'sales-invoice', 'credit-note', and so on. */
  kind: string
  label: string
  prefix: string
  suffix: string
  separator: string
  includeFiscalYear: boolean
  /** Zero-padded width: 4 gives '0001'. A sequence that outgrows it gets longer. */
  width: number
  resetOn: NumberingReset
  /** The series a new document of this kind takes. At most one per kind. */
  isDefault: boolean
  isArchived: boolean
  /** True once it has handed out a number — after which its shape is fixed. */
  hasIssued: boolean
}

export interface CreateNumberingSeriesInput {
  kind: string
  label: string
  prefix?: string
  suffix?: string
  separator?: string
  includeFiscalYear?: boolean
  width?: number
  resetOn?: NumberingReset
  isDefault?: boolean
}

/**
 * A change to a series.
 *
 * `kind` is absent by design: moving a series to another kind would renumber documents
 * already issued under it. The shape fields are refused once it has issued anything —
 * see 0007.
 */
export interface UpdateNumberingSeriesInput {
  id: string
  label?: string
  prefix?: string
  suffix?: string
  separator?: string
  includeFiscalYear?: boolean
  width?: number
  resetOn?: NumberingReset
  isDefault?: boolean
  isArchived?: boolean
}

export interface ListNumberingSeriesInput {
  includeArchived?: boolean
  kind?: string
}

/** What a series would produce next, without spending it. */
export interface NumberPreview {
  seriesId: string
  /** The fiscal year label the number would carry. Null for a series that never resets. */
  fiscalYearLabel: string | null
  nextSequence: number
  /** The whole number as it would print. */
  preview: string
}

// ---- Parties --------------------------------------------------------------

/*
 * A customer, a vendor, or both. One record with two flags rather than two tables,
 * because in a small business the same firm is very often both — see migration 0005.
 *
 * A party is not an account. Their balance is a sum over the journal lines carrying their
 * id, which is what stops an aged receivables report and the balance sheet disagreeing.
 */

/** Which side of the trade a list is for. */
export type PartyRole = 'customer' | 'vendor'

/** Enough of a party for a list or a picker. */
export interface PartySummary {
  id: string
  name: string
  /** GSTIN in India. Null when the party is not registered. */
  registrationNumber: string | null
  /** Sub-national code — the Indian state code. Decides the place of supply. */
  jurisdictionCode: string | null
  /** ISO 3166-1 alpha-2, lower case. */
  countryCode: string
  isCustomer: boolean
  isVendor: boolean
  /** On the summary because it is what tells two similarly named firms apart. */
  city: string | null
  isArchived: boolean
}

/** The whole record, for an editor. */
export interface Party extends PartySummary {
  legalName: string | null
  addressLine1: string | null
  addressLine2: string | null
  postalCode: string | null
  email: string | null
  phone: string | null
  /** Days from invoice date to due date. Null when nothing has been agreed. */
  paymentTermsDays: number | null
  /**
   * Money, 2dp. Null for no limit.
   *
   * Null and '0.00' are different answers: no limit at all, versus a limit of nothing,
   * which is how a business says "this one pays up front".
   */
  creditLimit: DecimalString | null
  notes: string | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface CreatePartyInput {
  name: string
  countryCode: string
  isCustomer?: boolean
  isVendor?: boolean
  legalName?: string | null
  registrationNumber?: string | null
  jurisdictionCode?: string | null
  addressLine1?: string | null
  addressLine2?: string | null
  city?: string | null
  postalCode?: string | null
  email?: string | null
  phone?: string | null
  paymentTermsDays?: number | null
  creditLimit?: DecimalString | null
  notes?: string | null
}

/**
 * A change to a party. Absent means "leave it"; `null` means "clear it".
 *
 * The distinction is the point: a screen that edits one field sends one field, and cannot
 * blank the six it never showed.
 */
export interface UpdatePartyInput extends Partial<CreatePartyInput> {
  id: string
}

export interface ListPartiesInput {
  /** Include archived parties. Off by default — a picker should not offer them. */
  includeArchived?: boolean
  /** Only customers, or only vendors. Both when absent. */
  role?: PartyRole
  /** Matches the name, the registration number or the city, ignoring case. */
  search?: string
}

export interface ArchivePartyInput {
  id: string
  archived: boolean
}

// ---- The company profile --------------------------------------------------

/*
 * Who these books belong to. One profile per company, because a company is one file.
 *
 * The same shape as a party where the meaning is the same — a regime sees the supplier
 * and the customer as one type, `TaxParty`, and half of what decides whether an invoice
 * carries CGST+SGST or IGST is whether these two jurisdictions match.
 *
 * There is no `id` here. There is exactly one profile, so an id crossing IPC would be a
 * value the caller could get wrong and nothing could do anything useful with.
 */

/** The profile, as read. Null from `companyProfile.get` until somebody has entered one. */
export interface CompanyProfile {
  /** As it appears on the registration. What prints on a tax invoice. */
  legalName: string
  /** The name it trades under, when that differs. */
  tradeName: string | null
  /** GSTIN in India. Null for a business below the registration threshold. */
  registrationNumber: string | null
  /** Sub-national code — the Indian state code. */
  jurisdictionCode: string | null
  /** ISO 3166-1 alpha-2, lower case. */
  countryCode: string
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  postalCode: string | null
  email: string | null
  phone: string | null
  /** When the profile was first entered, not when the company file was made. */
  createdAt: Timestamp
  updatedAt: Timestamp
}

/**
 * The whole profile, as written.
 *
 * A REPLACE, NOT A PATCH, and deliberately unlike `UpdatePartyInput`. A field left out
 * is a field cleared. There is one profile and one screen that owns all of it, so the
 * form always holds every field and always sends every field; a patch would give two
 * ways to say "no e-mail address" — absent and null — and make what ends up stored
 * depend on which of them the caller happened to choose.
 */
export interface SaveCompanyProfileInput {
  legalName: string
  countryCode: string
  tradeName?: string | null
  registrationNumber?: string | null
  jurisdictionCode?: string | null
  addressLine1?: string | null
  addressLine2?: string | null
  city?: string | null
  postalCode?: string | null
  email?: string | null
  phone?: string | null
}

// ---- The regime, described --------------------------------------------------

/*
 * WHAT THE OPEN COMPANY'S TAX REGIME LOOKS LIKE — AS DATA, NEVER AS THE ADAPTER.
 *
 * `TaxRegime` is an interface with methods on it: `computeTax`, `placeOfSupply`,
 * `validateRegistrationNumber`. None of them is here and none of them ever will be. What
 * crosses is a description — the lists a screen needs to build a picker, and the rules
 * it needs to lay a figure out — and a description cannot be asked a question. So
 * CONVENTIONS §1.6 still holds after this: tax logic lives in `regimes/`, the renderer
 * has no way to compute a tax, and there is exactly one caller of `computeTax` (see
 * src/main/documents/service.ts).
 *
 * A NUMBER FORMAT CROSSING IS NOT A LICENCE TO COMPUTE MONEY. §1.7 says the renderer
 * never computes with money, and that rule is about arithmetic — it is why every amount
 * arrives as an exact decimal string that main has already worked out. Choosing where
 * the separators go is presentation, the renderer already does it, and it does it today
 * by hard-coding the lakh/crore convention. Taking the grouping from here does not let
 * the renderer do anything new; it makes the thing it already does correct in a
 * jurisdiction that is not India. `screens/lib/ledger-format.ts` still never parses.
 *
 * ONE METHOD RATHER THAN ONE PER LIST. All of it is fixed for as long as a company is
 * open — the regime is read off the file at open and cannot change under it — so the
 * renderer fetches this once and holds it. Five methods would be five round trips for
 * five constants, and every list added later would be another channel.
 *
 * WHAT IS DELIBERATELY NOT HERE: the classification CODES. India's bundled pack carries
 * a few thousand HSN and SAC entries, and a type-ahead over them is a search with a term
 * rather than a list to hold in memory. When the item master needs one it gets its own
 * method that takes what the user typed. The scheme itself is here, because a field has
 * to know it is called 'HSN / SAC' and how many digits to expect.
 */

/** How this regime writes a number. Presentation only — see the note above. */
export interface NumberFormat {
  /**
   * Digit grouping from the right: `[3, 2]` gives the Indian 12,34,567 and `[3]` gives
   * 1,234,567. The last size repeats once the list runs out.
   */
  groupSizes: number[]
  decimalSeparator: string
  groupSeparator: string
  /** ISO 4217, e.g. 'INR'. */
  currencyCode: string
  /** e.g. '₹'. What a column heading shows. */
  currencySymbol: string
}

/** A sub-national jurisdiction, for a place-of-supply picker. */
export interface JurisdictionOption {
  /** The Indian state code, e.g. '33'. What `jurisdictionCode` fields carry. */
  code: string
  name: string
}

/**
 * A rate the regime's schedules contain.
 *
 * ADVISORY. Nothing refuses a rate that is not in this list, because rates change by
 * notification and a stale bundled list must not stand between a user and an invoice.
 * A picker offers these and the field still accepts anything typed.
 */
export interface TaxRateOption {
  ratePct: DecimalString
  /** 'Nil', '18%'. */
  label: string
  /** Why the slab exists. A hint under the option, never a rule. */
  note: string
}

/** A tax the regime can levy. The codes that come back on a line's `taxes`. */
export interface TaxComponentOption {
  /** 'CGST', 'SGST', 'IGST'. */
  code: string
  label: string
  levy: 'output' | 'input' | 'both'
}

/** How the regime says what a thing is. India: HSN for goods, SAC for services. */
export interface ClassificationSchemeInfo {
  /** 'HSN'. Null where the regime classifies nothing, and then the field is hidden. */
  code: string | null
  /** What the field is labelled. India presents the pair as 'HSN / SAC'. */
  label: string
  /** Digit counts a code may have. Empty when unconstrained. */
  validLengths: number[]
}

/** Everything a screen needs to know about the open company's regime. */
export interface RegimeDescription {
  /** 'in'. The same string `CompanySummary.regimeId` carries. */
  id: string
  /** 'India — GST'. For the "which rules am I running?" line. */
  label: string
  numberFormat: NumberFormat
  jurisdictions: JurisdictionOption[]
  taxRates: TaxRateOption[]
  taxComponents: TaxComponentOption[]
  classification: ClassificationSchemeInfo
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

// ---- Reports --------------------------------------------------------------

/*
 * The statements. Every figure below is computed in main and crosses as a decimal
 * string — CONVENTIONS §1.7: the renderer displays money and never computes it, not even
 * to total a column it can already see.
 */

/** One line of a statement. Groups carry their subtree's total and nothing of their own. */
export interface ReportLine {
  accountId: string
  code: string
  name: string
  /** 0 at the top of its section. Indent by this; the tree is already flattened. */
  depth: number
  isGroup: boolean
  /** Positive in the account's own normal direction. */
  amount: DecimalString
}

export interface ReportSection {
  type: AccountType
  lines: ReportLine[]
  total: DecimalString
}

export interface BalanceSheet {
  /** Everything up to and including this date. A balance sheet is always cumulative. */
  asAtDate: DateString
  assets: ReportSection
  liabilities: ReportSection
  equity: ReportSection
  /**
   * Income less expenses that no year-end close has moved into retained earnings yet.
   *
   * Shown on the face of the sheet inside equity. Without it the equation does not
   * close: regrouping every balanced entry by account type gives
   * `assets = liabilities + equity + (income - expenses)`, and the last bracket is this.
   */
  profitForPeriod: DecimalString
  totalAssets: DecimalString
  /** Liabilities plus equity plus `profitForPeriod`. */
  totalLiabilitiesAndEquity: DecimalString
  /** Whether the two sides agree. Reported rather than assumed, so it can be asserted. */
  balanced: boolean
}

export interface ProfitAndLoss {
  /** Inclusive. Null means from the first entry in the books. */
  fromDate: DateString | null
  /** Inclusive. */
  toDate: DateString | null
  income: ReportSection
  expenses: ReportSection
  totalIncome: DecimalString
  totalExpenses: DecimalString
  /** Income less expenses. Negative is a loss, and is not relabelled. */
  netProfit: DecimalString
}

/** One movement against an account, carrying the balance as it stood after it. */
export interface AccountLedgerRow {
  entryId: string
  entryNumber: string
  date: DateString
  narration: string
  /** The other side: one account's name, or 'Split' when the entry touched several. */
  contra: string
  debit: DecimalString
  credit: DecimalString
  /** After this row, in the account's normal direction. */
  balance: DecimalString
}

export interface AccountLedger {
  accountId: string
  code: string
  name: string
  type: AccountType
  normalBalance: NormalBalance
  fromDate: DateString | null
  toDate: DateString | null
  /**
   * What the account held immediately before `fromDate`.
   *
   * Zero when the range is open at the start. Without it a month's ledger would close on
   * that month's movement wearing the closing balance's name.
   */
  openingBalance: DecimalString
  rows: AccountLedgerRow[]
  totalDebit: DecimalString
  totalCredit: DecimalString
  /** The last row's balance, not a separate sum — they could not then disagree. */
  closingBalance: DecimalString
}

/** A day's entries in the day book, with the day's total. */
export interface DayBookDay {
  date: DateString
  entries: JournalEntry[]
  /** The day's debits, which equal its credits. */
  total: DecimalString
}

export interface DayBook {
  fromDate: DateString | null
  toDate: DateString | null
  days: DayBookDay[]
  entryCount: number
  total: DecimalString
}

export interface AsAtDateInput {
  asAtDate: DateString
}

export interface AccountLedgerInput {
  accountId: string
  fromDate?: DateString
  toDate?: DateString
}

// ---- Receipts and allocations (0012) ---------------------------------------

/*
 * Money received from a customer, money paid to a vendor, and which documents it
 * settles. Read the three rules at the top of src/main/domain/receipts/types.ts; two of
 * them are visible in the shapes below and worth pointing at.
 *
 * THERE IS NO `draft`. `ReceiptStatusDto` has two members, because a receipt records
 * money that has already moved and there is no stage in its life before it has posted.
 * A mistake is corrected by cancelling, exactly as an issued invoice is.
 *
 * `allocated` AND `unallocated` ARE DERIVED AND CROSS ANYWAY. They are sums over the
 * allocation rows, computed on the way out and stored nowhere — the same treatment
 * `DocumentTotalsDto` gets, and for the same reason (§1.7): a screen may not do money
 * arithmetic, so the figures it displays have to arrive already added up.
 */

/** Two states, not three. See rule 1. */
export type ReceiptStatusDto = 'posted' | 'cancelled'

/**
 * How much of one receipt settles one document.
 *
 * The document's number and date ride along because every screen that shows an
 * allocation shows them, and a list of ten allocations would otherwise be ten lookups.
 * Denormalised on the way out only — nothing stores them.
 */
export interface ReceiptAllocationDto {
  id: string
  documentId: string
  documentKind: string
  /** Never null: only an issued document may be allocated to, and those have numbers. */
  documentNumber: string
  documentDate: DateString
  amount: DecimalString
}

/** A receipt as a register lists it. */
export interface ReceiptSummary {
  id: string
  /** A `ReceiptKind` — 'receipt' or 'payment'. */
  kind: string
  status: ReceiptStatusDto
  /** Never null. A receipt has no state in which it lacks one (rule 1). */
  number: string
  date: DateString
  partyId: string
  /** Denormalised for display, as `DocumentSummary.partyName` is. */
  partyName: string
  amount: DecimalString
  /** Summed from the allocations. Never stored. */
  allocated: DecimalString
  /** `amount - allocated`. Money on account, which is an ordinary thing to have. */
  unallocated: DecimalString
}

export interface Receipt extends ReceiptSummary {
  seriesId: string
  /** The bank or cash account the money moved through. */
  accountId: string
  /** Denormalised for display. */
  accountName: string
  /** A cheque number, a UTR — whatever identifies this money on a statement. */
  reference: string
  narration: string
  /** The entry it posted as. Never null, which is rule 1 as a type. */
  entryId: string
  allocations: readonly ReceiptAllocationDto[]
  createdAt: Timestamp
  updatedAt: Timestamp
  cancelledAt: Timestamp | null
}

/**
 * One line of "these are the documents this money pays".
 *
 * A document and an amount, and nothing else: an allocation is a matching record, so it
 * has no date of its own and no narration. Giving it either would invite somebody to
 * report on it as though the money moved when the matching was done.
 */
export interface AllocationInput {
  documentId: string
  amount: DecimalString
}

/**
 * A receipt as it is recorded. Posting is not a separate step (rule 1).
 *
 * `allocations` is optional and an empty list is an ordinary answer — a payment arriving
 * before anybody has decided what it settles is money on account, not an unfinished job.
 */
export interface CreateReceiptInput {
  /** A `ReceiptKind`. */
  kind: string
  date: DateString
  partyId: string
  /** Money, 2dp, strictly positive. The direction is `kind`, never the sign. */
  amount: DecimalString
  accountId: string
  reference?: string
  narration?: string
  /** The default series for the kind when absent, exactly as issuing does. */
  seriesId?: string
  allocations?: readonly AllocationInput[]
}

/**
 * Replace what a receipt settles.
 *
 * THE WHOLE SET, not a patch, and an empty list is how everything is un-allocated. A
 * matching record is a statement about which invoices this money pays, and a partial
 * update of that statement is not a thing anybody means: a screen holds the whole list
 * in front of the user, and sending back half of it would leave rows they had removed.
 * Compare `updateDocument`, which is a patch because a document has fields.
 */
export interface AllocateReceiptInput {
  id: string
  allocations: readonly AllocationInput[]
}

export interface CancelReceiptInput {
  id: string
  /**
   * The date the reversal posts as of. The receipt's own date when absent.
   *
   * The same rule cancelling a document follows: a receipt cancelled before anything is
   * filed should leave the month it was recorded in as if it had not been, and once that
   * period is closed it cannot — which `PERIOD_CLOSED` says rather than the reversal
   * silently landing in a later month.
   */
  date?: DateString
  narration?: string
}

export interface ListReceiptsInput {
  kind?: string
  status?: ReceiptStatusDto
  partyId?: string
  fromDate?: DateString
  toDate?: DateString
  /** Matches the number, the party name, the reference or the narration, ignoring case. */
  search?: string
  limit?: number
  offset?: number
}

/*
 * ---------------------------------------------------------------------------
 * WHAT IS OUTSTANDING, ON ITS WAY TO A SCREEN
 *
 * Neither figure below is a column and neither ever will be (rule 3). They are folds over
 * the ledger and the allocation rows, computed on the way out — which is also why they
 * cross as decimal strings already added up: the renderer never does money arithmetic
 * (CONVENTIONS §1.7), so a screen showing "680.00 outstanding" has to be handed 680.00.
 */

/** One receipt's part in settling one document. */
export interface SettlementReceiptDto {
  receiptId: string
  number: string
  /** When the money arrived — not when somebody matched it, which nothing records. */
  date: DateString
  /** How much of that receipt went to this document, not the receipt's own total. */
  amount: DecimalString
}

/** What has been paid against one document, and what is left. */
export interface DocumentSettlement {
  documentId: string
  /**
   * What the document put on the party's control account, in its own direction.
   *
   * Not the same as its grand total once it has been cancelled: the reversal nets it to
   * nothing, which is how a cancelled invoice stops being owed with no code written to
   * make it so.
   */
  movement: DecimalString
  allocated: DecimalString
  /** `movement - allocated`. Negative would mean more was matched than was ever owed. */
  outstanding: DecimalString
  receipts: readonly SettlementReceiptDto[]
}

/** A document with something still against it, as a picker lists one. */
export interface OpenDocument {
  id: string
  kind: string
  /** Never null: only an issued document can be open, and those all have numbers. */
  number: string
  date: DateString
  /** What it put on the party's account. */
  grandTotal: DecimalString
  outstanding: DecimalString
}

export interface OpenDocumentsInput {
  partyId: string
  /** A `ReceiptKind`. A receipt settles sales documents; a payment settles purchases. */
  kind: string
  /**
   * Treat this receipt's own allocations as available again.
   *
   * The editor needs it: opening a receipt that already settles INV/0007 in full must
   * show INV/0007 with that money back on it, or the invoice the screen is displaying a
   * line for is simply missing from the list it offers.
   */
  exceptReceiptId?: string
}
