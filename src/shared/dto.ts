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

/**
 * A registration number put to a regime before any company exists — the GSTIN box on the
 * create screen.
 *
 * Advisory in the way `PassphraseStrength` is: it refuses nothing. What is saved goes
 * through `companyProfile.save`, which checks the number again and is the only check that
 * decides anything.
 */
export interface CheckRegistrationInput {
  registrationNumber: string
  /** The regime the company will be created under. The default one, like `create`. */
  regimeId?: string
}

export interface RegistrationCheck {
  /** What the regime calls the number: 'GSTIN / UIN'. Answered for a blank one too. */
  label: string
  /** Blank is its own answer: a business below the threshold has no number, correctly. */
  status: 'blank' | 'valid' | 'invalid'
  /** The regime's spelling of a valid number. Null otherwise. */
  normalised: string | null
  /** The jurisdiction a valid number encodes, where the format encodes one. */
  jurisdictionCode: string | null
  jurisdictionName: string | null
  /** Why an invalid number is invalid, for the user. Null otherwise. */
  message: string | null
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
  /**
   * Money, 2dp. Null when nothing standard has been agreed.
   *
   * ON THE SUMMARY AND NOT ONLY ON THE RECORD, because a picker is where a purchase line
   * is priced. A screen holding a list of items and no purchase price has to fetch each
   * item singly to fill in a bill, or leave the user to type a price they already agreed.
   */
  purchasePrice: DecimalString | null
  /**
   * Where this item's value posts, overriding the account its document kind implies.
   *
   * ON THE SUMMARY FOR THE SAME REASON, AND IT IS WHAT MAKES EXPENSE ENTRY ORDINARY. An
   * item called "Courier charges" that already knows its account means a user picks the
   * item and is done — the per-line account override exists for the exception, and a
   * screen that cannot see this field has to make everybody use the exception.
   *
   * Null is not "unknown": it means "whatever the kind implies", which is the usual case.
   */
  salesAccountId: string | null
  purchaseAccountId: string | null
  isSold: boolean
  isPurchased: boolean
  /** Freight, packing, insurance — taxable, but not sales revenue. */
  isCharge: boolean
  isArchived: boolean
}

/** The whole record, for an editor. */
export interface Item extends ItemSummary {
  description: string | null
  /**
   * Whether this item keeps a quantity balance.
   *
   * ORTHOGONAL TO `kind` (migration 0017): plenty of goods are not stocked — consumables,
   * and anything raised as a charge — and a service never can be. The stock batch
   * withheld this from the DTO deliberately, on the grounds that a field no repository
   * writes looks as though it works; `createItem` and `updateItem` write it now, through
   * the same `setItemStockTracking` a stock screen calls, so there is one set of rules
   * and not two.
   */
  isStockTracked: boolean
  /**
   * Quantity, 3dp. When what is on hand falls to it, the re-order report says so.
   *
   * Null on anything that keeps no balance, and CLEARED rather than kept when a register
   * is switched off — an item with nothing on hand is below every level ever set, so it
   * would sit on the re-order report forever telling somebody to buy something they do
   * not count. 0017's CHECK is the floor under that.
   */
  reorderLevel: DecimalString | null
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
  /** Whether it keeps a quantity balance. Goods only — a service holds none (0017). */
  isStockTracked?: boolean
  /** Quantity, 3dp. Cleared, not stored, on an item that keeps no balance. */
  reorderLevel?: DecimalString | null
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

/*
 * ---------------------------------------------------------------------------
 * THREE FACTS ABOUT HOW A SUPPLY IS TAXED, WHICH ARE NOT THE TAX
 *
 * The tax itself is `DocumentLineTaxDto` — what the regime answered. These three are
 * INPUTS to that answer and to the return that reports it, they are decisions a person
 * makes about the supply, and no regime can derive any of them from the figures.
 *
 * They live in `shared/` rather than in a regime because the shapes are not India's.
 * "Did this leave the country with tax paid or under an undertaking", "does the buyer
 * discharge the tax instead of the seller", and "may credit be taken on this line" are
 * questions every value-added tax asks; only the paperwork differs. Naming them here is
 * what lets `TaxComputationInput`, the stored document and the GST return all speak of
 * one fact rather than three that agree by inspection (CONVENTIONS §1.6 draws the line
 * at a regime's vocabulary — `LUT`, `section 17(5)` and `GSTR-3B` are on the far side of
 * it and appear nowhere below).
 */

/**
 * Whether a zero-rated supply left with tax paid on it, or under an undertaking.
 *
 * NOT A REPORTING FLAG. A supply under an undertaking carries its RATE and NO TAX, which
 * is a different thing from a nil-rated supply carrying a rate of zero — the first is
 * zero-rated and its input credit is refundable, the second is exempt and it is not.
 * There is no way to represent the first without this field: setting the line rate to
 * zero produces the second, and the two file into different boxes.
 *
 * Null on a domestic supply, where the question does not arise.
 */
export type ExportTaxPayment = 'with-payment' | 'without-payment'

/**
 * Whether credit may be taken on an inward line, and if not, why not.
 *
 * ON THE LINE, NOT THE DOCUMENT. One bill can carry a laptop and a staff car, and the
 * credit is available on one and blocked on the other. A document-level field would make
 * a user split the bill in two to record a fact about one line of it.
 *
 * The two ineligible members are kept apart because a return reports them in different
 * places: credit blocked by the statute's own list, and credit not taken for any other
 * reason. Collapsing them would lose which of the two a figure is.
 */
export type ItcEligibility = 'eligible' | 'ineligible-17-5' | 'ineligible-other'

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
  /**
   * Whether credit may be taken on this line. Null means nothing was recorded.
   *
   * OPTIONAL ON THE WAY OUT AND REQUIRED IN THE DOMAIN, which is deliberate rather than
   * lax: `DocumentLine` in `main/domain/documents` takes it as `ItcEligibility | null`
   * with no `?`, so the posting rule cannot forget it and the repository resolves the
   * absence exactly once, at the boundary. A `?` here is what lets a caller written
   * before migration 0021 still compile.
   */
  itcEligibility?: ItcEligibility | null
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
  /**
   * When it falls due, stamped at issue from the party's terms.
   *
   * Null while draft and null for ever on a kind that charges nobody — `chargesOnTerms`
   * says which, and a screen asks that rather than testing the kind itself. Kept through
   * cancellation, like the number, and not recomputed: a party moved to shorter terms
   * today does not make last year's invoice late (migration 0014).
   */
  dueDate: DateString | null
  partyId: string
  /** Denormalised for display, as `JournalLine.partyName` is. */
  partyName: string
  /** Derived on the way out, like every other figure. */
  grandTotal: DecimalString
}

/**
 * How much of an issued document's money has come in (or gone out, for a refund).
 *
 *   open      nothing has been settled against it yet
 *   part      some has, and some is still outstanding
 *   settled   none is outstanding — paid, refunded, or offset in full
 *
 * DERIVED, NEVER STORED, from the same movement-less-allocations-less-offsets figure every
 * aged report reads (db/repos/outstanding.ts), so a register's "Paid" and the aged report
 * cannot disagree. Main works it out; a screen only names it.
 *
 * Not DocumentSettlement, which is the editor's whole breakdown of one document — the
 * movement, every allocation and every offset. This is only which of three states it is in.
 */
export type SettlementState = 'open' | 'part' | 'settled'

/**
 * One row of a document register: the summary, plus where its settlement stands.
 *
 * A row type of its own rather than a field on `DocumentSummary`, because only the list
 * reads the allocation and offset tables for it. `Document` extends the summary and is
 * returned by every write, and none of those needs the extra queries.
 */
export interface DocumentListRow extends DocumentSummary {
  /**
   * Null wherever the question does not apply: a draft (it has posted nothing), a
   * cancelled document (its entry is reversed), a kind that never posts (a quotation), and
   * a document whose value on the party's account is zero, which has nothing to settle.
   */
  settlement: SettlementState | null
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
  /**
   * The document this one corrects, where it names one.
   *
   * Only a credit note or a debit note carries it, pointing at an issued charge document
   * of the same party on the same side — 0013's trigger proves that and nothing above it
   * repeats the rule. Nullable because one credit note against several invoices has been
   * legal since 2019, so there is not always a single original to name.
   */
  originalDocumentId: string | null
  /**
   * That document's number and date, denormalised as `partyName` is.
   *
   * A GST CREDIT NOTE IS REQUIRED TO REFERENCE THE INVOICE IT CORRECTS — section 34 read
   * with rule 53, and the reference is the original's number and date, not its id. Until
   * these fields existed only the id crossed the wire, so the print model's
   * `PrintCorrectedDocument` could be filled by nobody: the field was on the model, the
   * template rendered it correctly, and the mapper could only ever supply `undefined`.
   *
   * NULL IN THREE DIFFERENT SENSES, and the reader does not have to tell them apart:
   * nothing is corrected, the original is still a draft and so has no number yet, or the
   * link was cleared. A screen that has one shows it and one that has none does not.
   *
   * DENORMALISED AND NOT STORED (CONVENTIONS §1.3). The repository joins the original row
   * on the way out; nothing writes a copy of a number that the original may still change
   * while it is a draft.
   */
  originalDocumentNumber: string | null
  originalDocumentDate: DateString | null
  /**
   * Whether a zero-rated supply went out with tax paid or under an undertaking.
   *
   * Null on a domestic supply, and refused on one — the question only arises where the
   * supply leaves the country, and which supplies do is the regime's answer rather than
   * this layer's (see `DocumentsService`).
   */
  exportTaxPayment?: ExportTaxPayment | null
  /**
   * Whether the buyer discharges the tax on this supply rather than the seller.
   *
   * Always known once migration 0020 has run — the column is `NOT NULL DEFAULT 0`. The
   * `?` is for a caller written before it, exactly as on `DocumentLineDto`.
   */
  isReverseCharge?: boolean
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
  /** Whether credit may be taken on this line. Absent records nothing. */
  itcEligibility?: ItcEligibility | null
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
  /** The document this one corrects. Only a credit note or a debit note may carry it. */
  originalDocumentId?: string | null
  /** Whether a zero-rated supply went out with tax paid or under an undertaking. */
  exportTaxPayment?: ExportTaxPayment | null
  /** Whether the buyer discharges the tax. Absent is forward charge. */
  isReverseCharge?: boolean
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
  /** The document this one corrects. Only a credit note or a debit note may carry it. */
  originalDocumentId?: string | null
  /** Whether a zero-rated supply went out with tax paid or under an undertaking. */
  exportTaxPayment?: ExportTaxPayment | null
  /** Whether the buyer discharges the tax. Absent is forward charge. */
  isReverseCharge?: boolean
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
  /**
   * Whether credit may be taken on this line, where the user has said.
   *
   * A DECISION AND NOT A FIGURE, which is why a screen may send it while it may not send
   * a tax amount: whether a staff car is a staff car is not something the regime can
   * work out from the money.
   */
  itcEligibility?: ItcEligibility | null
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
  /** The document this one corrects. Only a credit note or a debit note may carry it. */
  originalDocumentId?: string | null
  /**
   * Whether a zero-rated supply went out with tax paid or under an undertaking.
   *
   * REFUSED ON A DOMESTIC SUPPLY rather than ignored. Whether a supply leaves the country
   * is the regime's answer, so the service is what refuses it — and it refuses rather
   * than clearing it, because a value silently dropped is a decision silently lost.
   */
  exportTaxPayment?: ExportTaxPayment | null
  /** Whether the buyer discharges the tax rather than this business. */
  isReverseCharge?: boolean
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
  /** The document this one corrects. Only a credit note or a debit note may carry it. */
  originalDocumentId?: string | null
  /**
   * Whether a zero-rated supply went out with tax paid or under an undertaking.
   *
   * REFUSED ON A DOMESTIC SUPPLY rather than ignored. Whether a supply leaves the country
   * is the regime's answer, so the service is what refuses it — and it refuses rather
   * than clearing it, because a value silently dropped is a decision silently lost.
   */
  exportTaxPayment?: ExportTaxPayment | null
  /** Whether the buyer discharges the tax rather than this business. */
  isReverseCharge?: boolean
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
  /**
   * What a registration number is called here: 'GSTIN / UIN' in India.
   *
   * The same shape as `classification.label` and on the description for the same reason.
   * A screen and a printed invoice both have to put a word above the number, and neither
   * may choose it: writing 'GSTIN' outside `regimes/in-gst/` breaks CONVENTIONS §1.6, and
   * a neutral 'Registration no.' is what the PDF mapper printed for want of this field —
   * correct for nobody in particular and wrong for the only regime that ships.
   */
  registrationLabel: string
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

/*
 * The aged report — what a control account is made of, oldest first.
 *
 * ONE CONTROL ACCOUNT, DECOMPOSED, and the DTO says so out loud: `accountCode` and
 * `controlBalance` are on the report because the page's claim is that its total IS that
 * account. A list of unpaid invoices needs neither and cannot be checked against
 * anything, which is the version this deliberately is not.
 *
 * `ties` is the same field, and the same argument, as `balanced` on a balance sheet: the
 * identity is reported rather than assumed, so a screen can show it and a test can assert
 * it. See db/repos/ageing.ts for what would make it false.
 */

/** One column of an aged report. Both ends inclusive; null is an open end. */
export interface AgedBucket {
  label: string
  fromDays: number | null
  toDays: number | null
}

/**
 * What put an amount on the control account.
 *
 * 'journal' covers an opening balance and a manual entry alike — anything reaching the
 * account without a document or a voucher behind it. It is not an error: opening balances
 * are how an existing business starts, and they are party-tagged for exactly this report.
 */
export type AgedItemSource = 'document' | 'receipt' | 'journal'

/** One thing standing against a party, with its age worked out. */
export interface AgedItem {
  source: AgedItemSource
  /** The document, receipt or journal entry it came from. */
  sourceId: string
  /**
   * A `DocumentKind` where `source` is 'document', a `ReceiptKind` where it is 'receipt'.
   *
   * Null only for a journal entry, which has no kind to name. It is here so a screen can
   * open the row: `domain/receipts/types.ts` states on purpose that a voucher's control
   * account is not derived from its side, so a reader of this report cannot infer that a
   * voucher on the receivable account is a receipt rather than a refund.
   */
  kind: string | null
  /** What it is known by: a document number, a voucher number, an entry number. */
  number: string
  date: DateString
  /**
   * What it falls due on.
   *
   * The stamped due date on an invoice. Everything else falls due the day it was raised,
   * which is the rule 0014 wrote for a party on no terms — see domain/reports/ageing.ts.
   */
  dueDate: DateString
  /** The report's date less `dueDate`. Nought or below is not yet due. */
  daysOverdue: number
  /** An index into the report's `buckets`, or null where it stands to the party's credit. */
  bucket: number | null
  /** Positive: the party owes it. Negative: it stands to their credit. */
  amount: DecimalString
}

export interface AgedPartyRow {
  /** Null where a line on the control account names no party. See `partyName`. */
  partyId: string | null
  /** The party's name, or a sentence saying the line names nobody. */
  partyName: string
  /** One figure per column, in the report's own `buckets` order. */
  buckets: DecimalString[]
  onAccount: DecimalString
  /** The columns less what is on account. What this party owes. */
  total: DecimalString
  /** Oldest due date first. Every item behind the figures above, and nothing else. */
  items: AgedItem[]
}

export interface AgedReportTotals {
  buckets: DecimalString[]
  onAccount: DecimalString
  /**
   * Everything past due — the figure a dashboard leads with.
   *
   * ON THE REPORT BECAUSE THE RENDERER MAY NOT ADD IT UP. "Every bucket but the first" is
   * one addition away in a screen and it is still money arithmetic (CONVENTIONS §1.7),
   * and the dashboard refused to do it, correctly. Main sums it from the party rows
   * against the same test `isOverdue` makes of a single item — a positive amount more
   * than nought days past its due date — so the total and the badges agree by
   * construction rather than by inspection.
   *
   * It is NOT `total` less the not-yet-due column: `total` has what stands to the party's
   * credit taken off it, and a credit is not an early payment of a late invoice.
   */
  overdue: DecimalString
  total: DecimalString
}

export interface AgedReport {
  /** A `TradeSide` — 'sales' is what customers owe, 'purchase' what is owed to vendors. */
  side: string
  asAtDate: DateString
  /** The control account this decomposes, resolved from the side's account role. */
  accountId: string
  accountCode: string
  accountName: string
  buckets: AgedBucket[]
  /** Largest debt first. A party with nothing outstanding is not here at all. */
  parties: AgedPartyRow[]
  totals: AgedReportTotals
  /**
   * The account's balance as at the date, summed straight from the lines.
   *
   * Reached by a different route from `totals.total` — no grouping, no allocations — so
   * the two agreeing is a statement and not a tautology.
   */
  controlBalance: DecimalString
  /** Whether `totals.total` equals `controlBalance`. Reported, so it can be asserted. */
  ties: boolean
}

export interface AgedReportInput {
  /** A `TradeSide`. Refused if it is anything else. */
  side: string
  asAtDate: DateString
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

/**
 * One offset's part in settling one document, described by the OTHER end.
 *
 * The document named here is never the one that was asked about: an invoice's panel lists
 * the credit notes set against it, and a credit note's lists the invoices it settles. One
 * row read from two directions, which is what `document_offsets` is.
 */
export interface DocumentOffsetDto {
  offsetId: string
  /** The document at the other end of the match. */
  documentId: string
  documentKind: string
  /** Never null: 0016 refuses an offset unless both ends are issued. */
  documentNumber: string
  documentDate: DateString
  amount: DecimalString
}

/** What has settled one document, from both sources, and what is left. */
export interface DocumentSettlement {
  documentId: string
  /**
   * What the document put on the party's control account, in THE DOCUMENT's own facing.
   *
   * Positive for all four posting kinds, which is what "its own facing" buys: a credit
   * note's movement on the account is a credit, so read raw it would arrive negative and
   * every rupee refunded against it would take the figure further from zero. What a
   * reader wants beside the word "outstanding" is how much of it is still to give back.
   *
   * Not the same as its grand total once it has been cancelled: the reversal nets it to
   * nothing, which is how a cancelled invoice stops being owed with no code written to
   * make it so.
   */
  movement: DecimalString
  /** What money has settled: the sum of the vouchers below. */
  allocated: DecimalString
  /**
   * What DOCUMENTS have settled: the sum of the offsets below.
   *
   * A separate figure rather than folded into `allocated`, because the two are two lists
   * on the screen and a user asking "who paid this" is asking a different question from
   * "what did we credit against it". They subtract identically, which is the arithmetic
   * saying they are the same kind of thing; they are shown apart, which is the screen
   * saying they are not the same event.
   */
  offset: DecimalString
  /**
   * `movement - allocated - offset`, in the same facing.
   *
   * Negative would mean more was matched than the document ever put on the account —
   * which is one meaning for all four kinds, and would not have been if the sign came
   * off the account instead.
   */
  outstanding: DecimalString
  receipts: readonly SettlementReceiptDto[]
  offsets: readonly DocumentOffsetDto[]
}

/** A document with something still against it, as a picker lists one. */
export interface OpenDocument {
  id: string
  kind: string
  /** Never null: only an issued document can be open, and those all have numbers. */
  number: string
  date: DateString
  /** What it put on the party's account, in the document's own facing — see
   * `DocumentSettlement.movement`. Positive whichever way the document points. */
  grandTotal: DecimalString
  outstanding: DecimalString
}

/**
 * One line of "these are the charges this credit note settles".
 *
 * `AllocationInput` with a document where the receipt was, and no amount of money moving
 * at either end. See `SetOffsetsInput` for why the refund end is not on this row.
 */
export interface OffsetInput {
  /** The sales invoice or purchase bill being settled. */
  chargeDocumentId: string
  amount: DecimalString
}

/**
 * Replace what one refund document settles.
 *
 * THE WHOLE SET, not a patch, exactly as `AllocateReceiptInput` is — and for the same
 * reason: a matching record is a statement about which charges this credit settles, and
 * half a statement is not a smaller version of it. An empty list takes every offset off
 * and puts the credit back on account.
 *
 * IT IS SET FROM THE REFUND END, which is a decision rather than a symmetry that happened
 * to fall out. A credit note is a pool of money drawn down by refunds and offsets — the
 * same shape a receipt has — so the panel that edits the set belongs on it, and the
 * invoice's own screen shows the result rather than editing it. Letting either end own
 * the set would mean two screens replacing overlapping sets, and the last one saved would
 * silently drop the other's rows.
 */
export interface SetOffsetsInput {
  /** The credit note or debit note whose set this is. */
  refundDocumentId: string
  offsets: readonly OffsetInput[]
}

export interface OpenDocumentsInput {
  partyId: string
  /**
   * A `ReceiptKind`, and it decides WHICH DOCUMENTS come back rather than merely which
   * side they are on.
   *
   * A receipt settles sales invoices and a refund settles credit notes; both are
   * sales-side, so a side is no longer an answer. `settles()` in `@shared/receipts` is
   * the one place that decides, and migration 0015 holds the same mapping as a trigger.
   */
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

// ---- Warehouses and the stock ledger (0017-0019) ---------------------------

/*
 * Phase 4.1's shapes. Every figure is a decimal string, as everywhere else: quantity 3dp,
 * money 2dp, and a unit cost at SIX places, which is neither.
 *
 * A UNIT COST IS NOT MONEY AND IS NEVER AN INPUT. It is `value / quantity`, computed for
 * a column and fed back into nothing — see domain/inventory/cost.ts, which measures what
 * happens when it is held as state instead. It travels here so a screen can print it, and
 * a screen that multiplied by it would get an answer out by a paisa on the sort of
 * figures a stock card carries.
 *
 * NOTHING HERE CARRIES A STORED RUNNING BALANCE OFF THE DATABASE. `StockCardRow.balance`
 * is the fold's answer, recomputed when the card is asked for; migration 0019 has no
 * column behind it.
 *
 * A KIND CROSSES AS A STRING, as a document's does. `StockMovementKind` lives in
 * `main/domain/inventory` and the renderer cannot import `@main/*`; a second copy of the
 * union here is the shape this codebase has deleted four times, and the answer when
 * screens need the table is a shared module like `shared/documents.ts`, not a duplicate.
 */

/** Where stock is kept. */
export interface Warehouse {
  id: string
  /** An internal handle: 'MAIN', 'WH-2'. Unique ignoring case. */
  code: string
  name: string
  description: string | null
  isArchived: boolean
}

export interface CreateWarehouseInput {
  code: string
  name: string
  description?: string | null
}

/** Absent means "leave it"; `null` clears a nullable field. As `UpdateItemInput`. */
export interface UpdateWarehouseInput {
  id: string
  /** A warehouse's code is a label, not its identity, so unlike a unit's it may change. */
  code?: string
  name?: string
  description?: string | null
  isArchived?: boolean
}

export interface ListWarehousesInput {
  includeArchived?: boolean
}

/**
 * Turn an item's stock register on or off.
 *
 * Separate from `UpdateItemInput` rather than folded into it, and that is a batch
 * boundary rather than a design claim: `repos/items.ts` belongs to another phase, and a
 * field on `UpdateItemInput` that no repository wrote would look as though it worked.
 */
export interface SetItemStockTrackingInput {
  itemId: string
  isStockTracked: boolean
  /** Quantity, 3dp. Refused on an item that keeps no balance. Null clears it. */
  reorderLevel?: DecimalString | null
}

/** An item's stock settings. */
export interface ItemStockSettings {
  itemId: string
  isStockTracked: boolean
  reorderLevel: DecimalString | null
}

/** What a register holds at one moment: the pair of record, and the column derived from it. */
export interface StockBalance {
  /** Quantity, 3dp. */
  quantity: DecimalString
  /** Money, 2dp — the carrying value, and what the balance sheet reconciles against. */
  value: DecimalString
  /**
   * Money per unit, at six places. A REPORTED COLUMN and never an input.
   *
   * Zero when nothing is on hand: an item that has run down to nothing has no average
   * cost, and the next receipt sets a fresh one rather than carrying the stale one.
   */
  unitCost: DecimalString
}

/**
 * One movement, as a caller states it.
 *
 * `cost` is required on an inward kind and refused on an outward one — the register
 * values what leaves, and a caller that could price a sale would be pricing it against
 * nothing. `kind` says which way stock went; the quantity is always non-negative.
 */
export interface RecordStockMovementInput {
  itemId: string
  /** Absent means the only warehouse there is. Refused when there is more than one. */
  warehouseId?: string
  /** A `StockMovementKind`: 'receipt', 'issue', 'adjustment-in', … */
  kind: string
  /** The date it is valued as of, which is not "now". */
  date: DateString
  /** Quantity, 3dp, non-negative. Zero is legal — freight carries a cost and no goods. */
  quantity: DecimalString
  /** Money, 2dp. Required on an inward movement, refused on an outward one. */
  cost?: DecimalString | null
  /** A `SourceDocumentType`. Not derivable from `kind`, and not deriving it. */
  sourceType: string
  sourceId?: string | null
  sourceNumber?: string | null
  narration?: string | null
}

/**
 * What a back-dated movement did to entries that were already posted.
 *
 * A receipt dated into last week re-averages the pool, so every issue after it in card
 * order cost something different from what its own entry says — and that entry is
 * immutable (ledger invariant 3). The difference is posted as a NEW entry per affected
 * date, and this is what those entries were.
 *
 * Empty in the ordinary case, which is every movement recorded in date order.
 */
export interface StockRevaluation {
  /** The entry that restated the cost of movements already in the books. */
  entryId: string
  /** The date it posted as of — the date of the movements it restates, not today. */
  date: DateString
  /**
   * Money, 2dp, SIGNED TO ADD to the stock account. Negative when the re-average made
   * what had already gone out cost more, which is the ordinary direction for a
   * back-dated receipt at a higher price.
   */
  stockAmount: DecimalString
  /** How many already-posted movements changed cost on that date. */
  movements: number
}

/** What recording a movement did. */
export interface RecordedStockMovement {
  movementId: string
  itemId: string
  warehouseId: string
  kind: string
  date: DateString
  sequence: number
  /**
   * The journal entry this movement posted as, or null when it moved no money.
   *
   * ARCHITECTURE §6.4 in one field: a movement writes to the stock register AND to the
   * general ledger, in one transaction. NULL is not a gap in that — it is a movement that
   * moved nothing to post, which is an ordinary fact (a free sample taken in at nil, or
   * an issue out of a pool worth nothing). Ledger invariant 5 refuses an entry of two
   * zero lines, so there is no entry for such a movement to name and nothing for the
   * balance sheet to be missing.
   */
  entryId: string | null
  /** What this movement moved, as money at 2dp. Non-negative; the direction is the kind. */
  cost: DecimalString
  /**
   * The register immediately after this movement IN CARD ORDER.
   *
   * Not the same as `closing` once something has been back-dated, and the difference is
   * the point rather than an artefact: a movement dated into last month is followed by
   * every movement of this one, so what it left behind and what the item holds now are
   * two different figures. A posting rule needs the first; a screen saying "on hand"
   * needs the second.
   */
  after: StockBalance
  /** The register after every movement it holds, whatever their dates. */
  closing: StockBalance
  /**
   * What this movement did to costs already posted, one entry per affected date.
   *
   * Empty unless the movement was back-dated. `after` and `closing` differing is the
   * SYMPTOM a screen can show; this is the list of corrections that were actually made,
   * and a caller that wants to tell a user "your March cost of sales has moved" reads it
   * rather than inferring it from the two balances.
   */
  revaluations: readonly StockRevaluation[]
}

/** One line of a stock card. */
export interface StockCardRow {
  movementId: string
  sequence: number
  date: DateString
  /** A `StockMovementKind`. */
  kind: string
  /** What a stock card calls the kind, e.g. 'Purchase return'. */
  label: string
  /** Which way it went: 'in' or 'out'. Read off the kind, never off a sign. */
  direction: string
  /** Quantity, 3dp, non-negative. */
  quantity: DecimalString
  /** The cost an inward movement STATED. Null on an outward movement, which states none. */
  statedCost: DecimalString | null
  /**
   * What the movement moved in money, at 2dp — stated for an inward movement, worked out
   * by the strategy for an outward one.
   *
   * For an outward movement this is what posts to cost of goods sold, and it is reported
   * separately from anything on the document that raised it: a purchase return credits
   * the supplier at the price paid and takes the stock out at the average, and the
   * difference between the two is a price variance.
   */
  cost: DecimalString
  /** What the register held after this row. Recomputed, never read from a column. */
  balance: StockBalance
  /**
   * The entry this movement posted as, for the drill-through.
   *
   * Null ONLY for a row written before migration 0022, which added the column and the
   * trigger that refuses a movement with no entry. No shipped build wrote one — 0019 and
   * 0022 are the same phase — so this is nullable for the shape of the column rather than
   * for a state anybody has.
   */
  entryId: string | null
  sourceType: string
  sourceId: string | null
  sourceNumber: string | null
  narration: string | null
}

/**
 * An item's movements in one warehouse, in date-then-sequence order, each carrying what
 * the register looked like after it.
 *
 * FOLDED EVERY TIME. A back-dated receipt re-averages the pool, so it changes what every
 * issue after it cost — a stored running average would be wrong from the moment a
 * delivery note arrived a week late, and the row nobody rewrote is the one nobody
 * notices.
 */
export interface StockCard {
  itemId: string
  warehouseId: string
  /** A `ValuationMethod` — 'moving-average' in this build. */
  method: string
  /** The window asked for. Null at either end means "from the beginning" / "to the end". */
  from: DateString | null
  to: DateString | null
  /**
   * What the register held before the first row.
   *
   * For a card drawn from a date this is the state as at the day before it — folded from
   * every earlier movement, never an empty state. "As at a date" is a filter on the
   * register, not on the rows that happen to be shown (CONVENTIONS §1.8).
   */
  opening: StockBalance
  rows: readonly StockCardRow[]
  /** The last row's state, never a second sum over the rows. */
  closing: StockBalance
  quantityIn: DecimalString
  quantityOut: DecimalString
  costIn: DecimalString
  costOut: DecimalString
  /**
   * The first movement the card could not value, and why. Null when it is complete.
   *
   * `rows` then holds everything before it, so a reader sees exactly how far the register
   * got — which is what they need in order to find the movement that is missing. A card
   * carrying one of these still ties at its own foot, and that is precisely why it says
   * so rather than leaving a reader to notice.
   */
  problem: AppError | null
}

export interface StockCardInput {
  itemId: string
  /** Absent means the only warehouse there is. */
  warehouseId?: string
  /** Inclusive. The card still opens with everything before it. */
  from?: DateString
  /** Inclusive. */
  to?: DateString
}

/** What one item holds, in one place or in total. */
export interface StockOnHandRow {
  itemId: string
  itemName: string
  itemCode: string | null
  unitCode: string | null
  /** Null on the roll-up across every warehouse. */
  warehouseId: string | null
  warehouseCode: string | null
  warehouseName: string | null
  quantity: DecimalString
  value: DecimalString
  unitCost: DecimalString
  /** Quantity, 3dp. Null when none is set. */
  reorderLevel: DecimalString | null
  /** Whether what is on hand has fallen to or below the level. False when none is set. */
  isBelowReorderLevel: boolean
  /**
   * Why this figure is not the whole story, where the register could not be folded in
   * full. Null in the ordinary case.
   *
   * A row carrying one is stock as at the last movement that could be valued, not stock
   * as at the date asked for — which a total would never reveal on its own.
   */
  problem: AppError | null
}

export interface StockOnHandInput {
  itemId?: string
  warehouseId?: string
  /** Counts movements dated on or before it. A filter on the register (CONVENTIONS §1.8). */
  asAt?: DateString
  /** Include items and places holding nothing. Off by default. */
  includeEmpty?: boolean
}
