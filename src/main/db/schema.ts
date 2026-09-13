/*
 * Kysely table typings — the cumulative shape of the database after every migration.
 *
 * CONVENTIONS (docs/CONVENTIONS.md §3), which this file exists to enforce at the type
 * level so that a violation is a compile error rather than a rounding bug:
 *
 *   - Money, quantity and rate columns are DECIMAL STRINGS (TEXT), parsed with
 *     decimal.js. Never REAL, never a JS number. Storage scale: money 2dp,
 *     quantity 3dp, rate 3dp.
 *   - Timestamps are ISO-8601 UTC strings. Date-only columns are 'YYYY-MM-DD'.
 *   - Booleans are INTEGER 0/1, typed `SqlBool` here; repos convert at the boundary.
 *   - `Generated<T>` marks autoincrement primary keys and any column the database
 *     fills in by default, so callers may omit them on insert.
 *
 * There is deliberately no `company_id` column anywhere. A company is a separate
 * database file — see docs/ARCHITECTURE.md §6.3.
 *
 * Each migration that adds a table adds its interface here and registers it on
 * `Database` below.
 */

import type { Generated } from 'kysely'

/* Declared once in @shared/scalars — the same representations cross IPC, so a second
 * definition here would be a second source of truth waiting to drift. */
import type { DateString, DecimalString, Timestamp } from '@shared/scalars'
export type { DateString, DecimalString, Timestamp }

/** Boolean persisted as SQLite INTEGER 0/1. */
export type SqlBool = number

// ---- app_metadata (0001) --------------------------------------------------

/** File-level facts about the artefact. Never business data — see the migration. */
export interface AppMetadataTable {
  key: string
  value: string
  updated_at: Timestamp
}

// ---- The ledger (0002-0004) -----------------------------------------------

/*
 * Five tables and one contract: src/main/domain/ledger/types.ts. Read the five
 * invariants at the top of it before changing anything below — in particular that a
 * posted entry is immutable, that the ledger holds no drafts, and that no balance is
 * ever stored.
 */

/** `AccountType` in domain/ledger. Persisted with a CHECK constraint. */
export type AccountTypeValue = 'asset' | 'liability' | 'equity' | 'income' | 'expense'

/** `PeriodStatus` in domain/ledger. */
export type PeriodStatusValue = 'open' | 'closed' | 'locked'

export interface AccountsTable {
  id: string
  /** User-visible account code, unique. Sorting a chart of accounts sorts by this. */
  code: string
  name: string
  type: AccountTypeValue
  /** Parent in the account tree. Null at the root. */
  parent_id: string | null
  /** A group holds no postings of its own; it exists to total its children. */
  is_group: SqlBool
  /** Archived accounts keep their history and accept nothing new. */
  is_archived: SqlBool
  description: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

/**
 * Which account fills a semantic slot, so posting rules never name a code.
 *
 * Keyed by role, so a role maps to exactly one account while one account may serve
 * several — which is what a small business actually does with, say, sales and sales
 * returns. Tax component accounts are deliberately not roles; see `AccountResolver`.
 */
export interface AccountRolesTable {
  /** An `AccountRole` from domain/ledger. Primary key. */
  role: string
  account_id: string
  updated_at: Timestamp
}

export interface AccountingPeriodsTable {
  id: string
  /** e.g. '2026-27'. */
  fiscal_year_label: string
  /** Calendar year the fiscal year starts in — the year's identity, not its label. */
  fiscal_year_start_year: number
  /** Position within the fiscal year, 1-based. Not `index`, which reads as SQL. */
  period_index: number
  /** 'month' or 'quarter', matching `PeriodGranularity` in domain/time. */
  granularity: string
  /** e.g. 'Apr 2026'. */
  label: string
  start_date: DateString
  /** Inclusive. */
  end_date: DateString
  status: PeriodStatusValue
  /** When it was last closed or locked. Null while open. */
  closed_at: Timestamp | null
  created_at: Timestamp
}

/**
 * One posted journal entry. There is no status column and no draft — invariant 2.
 *
 * Rows are append-only: migration 0004 installs triggers that abort any UPDATE or
 * DELETE on this table and on `journal_lines`. A correction is a reversing entry
 * pointing back through `reverses_entry_id`.
 */
export interface JournalEntriesTable {
  id: string
  /** Sequential and unique, e.g. 'JV-2026-27-0001'. What a person quotes. */
  entry_number: string
  /** The date posted as of. Decides the period, and it is not the wall clock. */
  entry_date: DateString
  narration: string
  /** A `SourceDocumentType`. 'manual' for a typed journal. */
  source_type: string
  /** Primary key in the source document's own table. Null when manual. */
  source_id: string | null
  /** The source document's human-visible number, denormalised for the drill-through
   * list so that showing a hundred entries does not mean a hundred lookups. */
  source_number: string | null
  period_id: string
  /**
   * The entry this one reverses. UNIQUE, which is what makes an entry reversible at
   * most once — `ALREADY_REVERSED` is a constraint, not a check someone remembered.
   */
  reverses_entry_id: string | null
  posted_at: Timestamp
}

/**
 * One line of an entry. Exactly one of `debit` and `credit` is non-zero, both are
 * non-negative, and CHECK constraints say so — invariant 5.
 *
 * Written BEFORE the parent entry row, with the entry foreign key deferred. That is
 * how a trigger gets to see a complete entry and refuse an unbalanced one; the
 * ordering is explained at the top of domain/ledger/types.ts and it is not optional.
 */
export interface JournalLinesTable {
  id: string
  entry_id: string
  /** Position within the entry, 1-based. Preserves the order it was written in. */
  line_number: number
  account_id: string
  /** Money, 2dp decimal string. '0.00' when this is a credit line. */
  debit: DecimalString
  /** Money, 2dp decimal string. '0.00' when this is a debit line. */
  credit: DecimalString
  narration: string | null
  /**
   * Whose money this line is (0005). Null on most lines.
   *
   * Required by trigger on any line posting to the accounts mapped to
   * `accounts-receivable` or `accounts-payable`, which is what makes a party's balance a
   * sum over lines rather than a second set of books. Permitted, not required, elsewhere
   * — an advance from a customer is that customer's money and is not a receivable.
   */
  party_id: string | null
}

// ---- Parties (0005) -------------------------------------------------------

/**
 * A customer, a vendor, or both — one table with two flags rather than two tables.
 *
 * In a small business the same firm is very often both, and two tables would mean two
 * records, two outstanding figures and a set-off nobody reconciles. A party is
 * deliberately not an account: see the migration for why a chart of accounts does not
 * hold four hundred customers.
 */
export interface PartiesTable {
  id: string
  /** Unique ignoring case, so two identical rows cannot sit in a picker. */
  name: string
  /** As it appears on the registration, when that differs from the trading name. */
  legal_name: string | null
  /** GSTIN in India. Unique ignoring case among the parties that have one. */
  registration_number: string | null
  /** Sub-national code — Indian state code, US state. Decides the place of supply. */
  jurisdiction_code: string | null
  /** ISO 3166-1 alpha-2, lower case. */
  country_code: string
  is_customer: SqlBool
  is_vendor: SqlBool
  address_line1: string | null
  address_line2: string | null
  city: string | null
  postal_code: string | null
  email: string | null
  phone: string | null
  /** Days from invoice date to due date. Null when nothing has been agreed. */
  payment_terms_days: number | null
  /** Money, 2dp decimal string. Null for no limit — never '0.00', which is a limit. */
  credit_limit: DecimalString | null
  notes: string | null
  /** Archived parties keep their history and take nothing new. */
  is_archived: SqlBool
  created_at: Timestamp
  updated_at: Timestamp
}

/**
 * The database shape — the cumulative result of every migration in MIGRATIONS.
 *
 * Table interfaces are added here as migrations introduce them, keyed by the exact
 * SQL table name in snake_case.
 */
// ---- units_of_measure, items (0006) ---------------------------------------

/**
 * A unit a quantity is counted in.
 *
 * Keyed by its own code rather than a surrogate id, because the code is what a user
 * types, what prints on the invoice, and what an item refers to. A table of ids would
 * mean a join to answer "what does this line say".
 */
export interface UnitsOfMeasureTable {
  /** Short and upper case: 'NOS', 'KGS', 'MTR'. The primary key. */
  code: string
  /** What it is called in full, e.g. 'Kilograms'. */
  name: string
  /**
   * How many decimal places a quantity in this unit may carry, 0 to 3.
   *
   * Storage scale is 3dp throughout (CONVENTIONS §3); this is narrower, and it is about
   * the unit rather than the column. Half a box is not a quantity, and a screen that
   * accepts one produces an invoice line nobody can pick.
   */
  decimal_places: number
  /**
   * The code this unit reports as in a return, where the regime fixes a list.
   *
   * India's UQC is a closed set and a business's own units are not, so the two are
   * separate columns rather than one constrained one — a company that measures in
   * `BAGS` must keep saying `BAGS` on its own paperwork while filing `BAG`. Null until
   * the filing layer maps it; nothing in Phase 2 reads it.
   */
  regime_code: string | null
  is_archived: SqlBool
  created_at: Timestamp
  updated_at: Timestamp
}

/** Goods or a service. Decides which classification scheme applies, and prints. */
export type ItemKind = 'goods' | 'service'

/**
 * Something that goes on a document line.
 *
 * Every field here is a DEFAULT for a line, never a lookup the line performs later. A
 * document line stores its own description, price and rate (see domain/documents), so
 * renaming an item or changing its price cannot rewrite an invoice already issued.
 */
export interface ItemsTable {
  id: string
  /** The business's own SKU. Unique ignoring case among the items that have one. */
  code: string | null
  /** Unique ignoring case. Two identical rows in a picker is the failure this prevents. */
  name: string
  description: string | null
  kind: ItemKind
  /** References units_of_measure(code). Null for a service with no countable quantity. */
  unit_code: string | null
  /** HSN or SAC in India. Validated by the regime above `db/`, never here. */
  classification_code: string | null
  /** Rate, 3dp decimal string — 0.125 is half of India's 0.25% slab (CONVENTIONS §3). */
  tax_rate_pct: DecimalString | null
  /** Money, 2dp. Null when nothing standard has been agreed. */
  sale_price: DecimalString | null
  purchase_price: DecimalString | null
  /**
   * A charge — freight, packing, insurance — rather than goods or a service supplied.
   *
   * Taxable like anything else. What differs is where it posts: a charge is not sales
   * revenue, and putting it there overstates turnover in every report and in the return.
   */
  is_charge: SqlBool
  /** What this item may appear on. At least one, like a party's two flags. */
  is_sold: SqlBool
  is_purchased: SqlBool
  /**
   * Where this item's value posts, overriding the role the document kind implies.
   *
   * An id and not a role, because it is a choice about this item while a role is a
   * company-wide mapping. Null means "whatever the kind says", which is the usual case.
   */
  sales_account_id: string | null
  purchase_account_id: string | null
  /**
   * Whether this item keeps a quantity balance (0017).
   *
   * ORTHOGONAL TO `kind`, which classifies for filing. Plenty of goods are not stocked —
   * consumables, and anything raised as a charge — and a service never can be, which is a
   * CHECK rather than a repository rule because a service carrying stock puts a figure on
   * the valuation report that the general ledger never received. See the migration.
   *
   * OPTIONAL ON INSERT, because the column defaults to 0: every item in every file that
   * predates 0017 keeps no balance, and a caller inserting an item may leave it out.
   *
   * `Generated<SqlBool>` says both halves at once: it is `NOT NULL DEFAULT 0`, so no row
   * ever holds nothing and every INSERT may leave it out. It was spelled
   * `SqlBool | undefined` while `repos/items.ts` typed its row as the identity map
   * `{ [K in keyof ItemsTable]: ItemsTable[K] }` — that map holds only while no column is
   * a Kysely `ColumnType`, so a `Generated` here stopped a file that batch did not own
   * from compiling. That row is `Selectable<ItemsTable>` now and the shim is gone.
   */
  is_stock_tracked: Generated<SqlBool>
  /**
   * Quantity, 3dp. When what is on hand falls below it, Phase 4.2's report says so.
   *
   * Null is the ordinary case, and it is refused outright on an item that keeps no
   * balance — such an item has nothing on hand, so it would sit below every level ever
   * set, forever.
   */
  reorder_level: DecimalString | null
  is_archived: SqlBool
  created_at: Timestamp
  updated_at: Timestamp
}

// ---- numbering_series, numbering_counters (0007) --------------------------

/** Where a counter restarts. Mirrors `NumberingReset` in domain/documents. */
export type NumberingResetColumn = 'fiscal-year' | 'never'

/**
 * How one kind of document is numbered.
 *
 * Every part of the shape is data, because the shape is the business's own choice and
 * matching the series they already use is the first thing anyone leaving another system
 * asks for. The domain's `NumberingSeries` is the same shape without the row's
 * bookkeeping — see domain/documents/types.ts, and `formatDocumentNumber` beside it.
 */
export interface NumberingSeriesTable {
  id: string
  /** A `DocumentKind`. Constrained by a CHECK naming the five, as data. */
  kind: string
  label: string
  prefix: string
  suffix: string
  separator: string
  /** Whether the fiscal year's label sits between the prefix and the sequence. */
  include_fiscal_year: SqlBool
  /** Zero-padded width: 4 gives '0001'. A sequence that outgrows it gets longer. */
  width: number
  reset_on: NumberingResetColumn
  /** The series a new document of this kind takes. At most one per kind. */
  is_default: SqlBool
  is_archived: SqlBool
  created_at: Timestamp
  updated_at: Timestamp
}

/**
 * What one series has reached, in one scope.
 *
 * `fiscal_year_label` IS NOT NULLABLE, and that is load-bearing. The domain models the
 * never-resetting scope as `null`, but a NULL in a unique index does not collide — so a
 * nullable key column would let a second counter row exist for the same series, and the
 * two would hand out the same number to two invoices. The scope is therefore the empty
 * string for a series that never resets, and the repository maps `'' <-> null` at its
 * boundary. Same trap as 0005's registration index, reached from the other side.
 */
export interface NumberingCountersTable {
  series_id: string
  /** The fiscal year's label, e.g. '2026-27'. Empty string when the series never resets. */
  fiscal_year_label: string
  /** The next sequence to hand out. Starts at 1 and only ever goes up. */
  next_sequence: number
  updated_at: Timestamp
}

// ---- documents, document_lines, document_line_taxes (0008) ----------------

/**
 * A trade document. One table for all five kinds — see domain/documents/types.ts.
 *
 * The columns that are NOT here are as much of the design as the ones that are. There is
 * no `grand_total`, no `taxable_value` and no `total_tax`: every figure on the foot of a
 * document is a fold over its lines, computed when asked (rule 4). A stored total is a
 * second answer to the same question, and the two disagree silently from the day
 * somebody edits a line without going through the code that maintains both.
 */
export interface DocumentsTable {
  id: string
  /** A `DocumentKind`. Constrained by a CHECK naming the five, as data. */
  kind: string
  /** 'draft' | 'issued' | 'cancelled'. */
  status: string
  /**
   * Null while draft, allocated at issue, kept through cancellation (rule 2).
   *
   * A cancelled document keeps its number rather than returning it: rule 46(b) wants a
   * consecutive series, and a number handed back leaves a gap somebody has to explain.
   */
  number: string | null
  /** Which series the number came from. Null while draft, and null for a kind with none. */
  series_id: string | null
  /** The date the document bears, which is also the date it posts as of. */
  document_date: DateString
  party_id: string
  /** The other party's own reference — their PO number. Never Coffer's. */
  party_reference: string | null
  /** Sub-national code where the regime has one; null where the concept does not apply. */
  place_of_supply_jurisdiction: string | null
  /** ISO 3166-1 alpha-2, lower case. */
  place_of_supply_country: string
  /** 'whole-unit' | 'none'. Frozen on the document, never read from settings later. */
  rounding_policy: string
  narration: string
  /**
   * The entry this document posted as. Null while draft, required once issued.
   *
   * The whole of rule 3 in one column: there is no "issued but not yet posted" state to
   * represent, because the CHECK below does not permit one.
   */
  entry_id: string | null
  /**
   * The document this one corrects, where it names one (0013).
   *
   * Only a credit note or a debit note may carry it, and only pointing at an issued
   * charge document of the same party on the same side — a trigger proves all of that.
   * Nothing in the ledger reads it: a credit note that names its invoice and one that
   * does not post identically. It is here for GSTR-1 table 9B and for the person reading
   * the paper, and it is NULLABLE because one credit note against several invoices has
   * been legal since 2019 and has no single original to name.
   */
  original_document_id: string | null
  /**
   * When it falls due, stamped at issue from the party's terms (0014).
   *
   * Filled exactly where an obligation exists — a sales invoice or a purchase bill that
   * has left draft — and null everywhere else, which a trigger proves as a biconditional
   * rather than as two rules. Stamped rather than derived at read time so that changing a
   * party's terms tomorrow cannot re-age an invoice issued last year: see 0014's header,
   * which is the whole argument for the column existing.
   */
  due_date: DateString | null
  /**
   * Whether a zero-rated supply left with tax paid on it, or under an undertaking (0020).
   *
   * An `ExportTaxPayment`, NULL on a domestic supply. NOT A REPORTING FLAG: a supply
   * under an undertaking carries its RATE and NO TAX, and the only other way to produce a
   * nil figure is to set the line's rate to zero — which makes it a nil-rated supply
   * instead, reverses the credit position on its inputs, and leaves every total adding up.
   * `computeTax` reads it, and only where the place of supply is an export.
   *
   * No constraint ties it to the place of supply, and 0020's header argues why: the
   * company's own country is a mutable single row that can be empty, and hardcoding one
   * would put a regime in `db/`.
   */
  export_tax_payment: string | null
  /**
   * Whether the BUYER discharges the tax rather than this business (0020).
   *
   * `NOT NULL DEFAULT 0` — every document either is under reverse charge or is not, and
   * forward charge is the honest default, because a document wrongly marked reverse
   * charge invents a cash liability that no credit may discharge. Not confined by kind:
   * an outward supply under it carries a value and no liability, and an inward one makes
   * this business liable for the output tax AND entitled to the input credit.
   */
  is_reverse_charge: SqlBool
  created_at: Timestamp
  updated_at: Timestamp
  /** When it was issued, and when it was cancelled. Null until each happens. */
  issued_at: Timestamp | null
  cancelled_at: Timestamp | null
}

/**
 * One line of a document.
 *
 * `description`, `unit_price` and `rate_pct` are STORED rather than looked up from the
 * item, and that is the point: renaming an item or repricing it must not rewrite an
 * invoice already issued. The item id is kept for reporting, not for reading values back.
 */
export interface DocumentLinesTable {
  id: string
  document_id: string
  /** 1-based, and the order the user put them in. */
  line_number: number
  /** Null for a free-text line, which every business needs occasionally. */
  item_id: string | null
  description: string
  /** Quantity, 3dp decimal string. */
  quantity: DecimalString
  /** The unit as text, copied from the item. Null for a line with no real quantity. */
  unit_code: string | null
  /** Money, 2dp. */
  unit_price: DecimalString
  /** Money, 2dp. Reduction agreed at supply, already out of `taxable_amount`. */
  discount: DecimalString
  /**
   * `quantity x unit_price - discount`, at money scale. What tax was charged on.
   *
   * Stored, and the one deliberate exception to rule 4: it is the number handed to the
   * regime, and the multiplication that produced it rounds. Recomputing it later from a
   * price with more places than the line shows would give a figure the tax was never
   * calculated from.
   */
  taxable_amount: DecimalString
  /** Rate, 3dp. The full rate, before it splits into components. */
  rate_pct: DecimalString
  /** HSN or SAC in India. Null where none applies. */
  classification_code: string | null
  /** Freight, packing, insurance — taxable, but not turnover. */
  is_charge: SqlBool
  /** Overrides the account the kind implies. Null for the usual case. */
  account_id: string | null
  /**
   * Whether credit may be taken on this line, and if not, why not (0021).
   *
   * An `ItcEligibility`, NULL where nothing has been recorded. ON THE LINE BECAUSE ONE
   * BILL CAN CARRY A LAPTOP AND A STAFF CAR — and because the posting rule needs it here:
   * an ineligible line's tax is not recoverable, so it is not an asset, and it posts to
   * the line's own value account rather than to the input tax account.
   *
   * NULL is a fourth state and not one of the three. A return resolves it to `eligible`
   * and counts the resolution as an issue; 0021 declines to backfill it for exactly that
   * reason — a backfilled assumption is indistinguishable from a decision.
   */
  itc_eligibility: string | null
}

/**
 * What the regime answered for one line, per component.
 *
 * Stored rather than recomputed, and this is rule 4's other exception, argued in
 * domain/documents/types.ts: it is the regime's answer as of the document's own date. An
 * invoice must reprint years later exactly as it was taxed and exactly as it was filed,
 * and rates change.
 */
export interface DocumentLineTaxesTable {
  document_line_id: string
  /** The regime's own code, e.g. 'CGST'. Part of the key. */
  code: string
  /** What prints, e.g. 'CGST @ 9%'. Stored because the wording is the regime's. */
  label: string
  /** Rate, 3dp — 0.125 is half of India's 0.25% slab. */
  rate_pct: DecimalString
  /** Money, 2dp. */
  amount: DecimalString
}

// ---- The company profile (0011) -------------------------------------------

/**
 * Who these books belong to — at most one row, pinned by `CHECK (id = 'company')`.
 *
 * Identity, not preferences: the name a tax authority knows, the registration it holds,
 * where it is, and how to reach it. Invoice defaults and mail settings get their own
 * tables when they exist, because one row holding all of it is a table every screen
 * writes to (CONVENTIONS §9). Read the migration before adding a column.
 *
 * The table can legitimately be empty. A migration cannot invent a company's legal name,
 * so a profile exists once somebody has entered one, and until then every read answers
 * null.
 */
export interface CompanyProfileTable {
  /** Always `'company'`. Not a surrogate key — a company is a file, not a row. */
  id: string
  /** As it appears on the registration. What prints on a tax invoice. */
  legal_name: string
  /** The name it trades under, when that differs. Null when it does not. */
  trade_name: string | null
  /** GSTIN in India. Null for a business below the registration threshold. */
  registration_number: string | null
  /** Sub-national code — the Indian state code. Half of what decides the tax. */
  jurisdiction_code: string | null
  /** ISO 3166-1 alpha-2, lower case. */
  country_code: string
  address_line1: string | null
  address_line2: string | null
  city: string | null
  postal_code: string | null
  email: string | null
  phone: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

// ---- Receipts and allocations (0012) --------------------------------------

/**
 * Money received from a customer, or paid to a vendor.
 *
 * `number` and `entry_id` are BOTH NOT NULL, where a document's are both nullable, and
 * that difference is the whole of rule 1 in src/main/domain/receipts/types.ts: a receipt
 * has no draft stage, because it records money that has already moved. The state 0008
 * needs a CHECK to forbid is one this table cannot represent.
 */
export interface ReceiptsTable {
  id: string
  /** A `ReceiptKind` — 'receipt' or 'payment'. Constrained by a CHECK. */
  kind: string
  /** 'posted' | 'cancelled'. Two states, not three: there is no draft. */
  status: string
  /** Allocated when the row is written, and never released. Rule 1. */
  number: string
  series_id: string
  /** The date the money moved, which is also the date it posts as of. */
  receipt_date: DateString
  party_id: string
  /** Money, 2dp, and strictly positive. The direction is `kind`, never the sign. */
  amount: DecimalString
  /** The bank or cash account the money moved through. Chosen, never derived. */
  account_id: string
  /** Whatever identifies this money on a statement — a cheque number, a UTR. */
  reference: string
  narration: string
  /** The entry it posted as. Required, because a receipt exists only as one. */
  entry_id: string
  created_at: Timestamp
  updated_at: Timestamp
  cancelled_at: Timestamp | null
}

/**
 * How much of one receipt settles one document.
 *
 * A MATCHING RECORD AND NOT A POSTING (rule 2). Both the invoice's debit and the
 * receipt's credit already carry the party's id, so the control account is right the
 * instant the receipt posts — whether or not anybody has said which invoice it pays.
 * Which is why these rows may be rewritten while a posted entry may not.
 *
 * No date and no narration on purpose: it is not an event that happened, it is a
 * statement about two events that already did.
 */
export interface ReceiptAllocationsTable {
  id: string
  receipt_id: string
  document_id: string
  /** Money, 2dp, strictly positive. An allocation of nothing is not a statement. */
  amount: DecimalString
  created_at: Timestamp
}

// ---- Offsets (0016) --------------------------------------------------------

/**
 * How much of one refund document settles one charge document.
 *
 * THE SAME KIND OF ROW `receipt_allocations` IS, with money at neither end. A receipt
 * settles an invoice because the two move the control account opposite ways; a credit
 * note moves it the same way a receipt does, so it settles an invoice for the same
 * reason and by the same arithmetic. Nothing here posts, nothing here has a date, and
 * nothing here changes a balance — see rule 2 in domain/receipts/types.ts, which this
 * table is the second instance of.
 *
 * THE COLUMNS ARE NAMED FOR THE RULE rather than `document_a`/`document_b`. Which end is
 * which is not an ordering convention: the charge end is the one that put money on the
 * party's account and the refund end is the one that took it off, and a row with them
 * swapped is a different (and impossible) statement. 0016's kind trigger is that
 * sentence, and the names are what make it readable.
 */
export interface DocumentOffsetsTable {
  id: string
  /** The sales invoice or purchase bill being settled. */
  charge_document_id: string
  /** The credit note or debit note settling it. */
  refund_document_id: string
  /** Money, 2dp, strictly positive. It reduces what is unsettled at BOTH ends. */
  amount: DecimalString
  created_at: Timestamp
}

// ---- Warehouses (0018) ----------------------------------------------------

/**
 * Where stock is kept.
 *
 * A SURROGATE ID, where `units_of_measure` has none. A unit's code is its identity
 * because it prints on an invoice line; a warehouse's code is an internal handle that
 * nothing prints, so it is a label and it may be changed. Both `code` and `name` are
 * unique ignoring case — a repository comparing either one case-sensitively against those
 * indexes finds nothing and then trips the index instead, which is a bug this project has
 * already shipped.
 */
export interface WarehousesTable {
  id: string
  /** An internal handle: 'MAIN', 'WH-2'. Unique ignoring case, and changeable. */
  code: string
  /** What the people who work there call it. Unique ignoring case. */
  name: string
  /** Free text, or null. Never '' — the migration refuses a blank one. */
  description: string | null
  /** An archived warehouse keeps its history and takes nothing new. */
  is_archived: SqlBool
  created_at: Timestamp
  updated_at: Timestamp
}

// ---- The stock ledger (0019) ----------------------------------------------

/**
 * One stock movement: what moved, when, of what, and where.
 *
 * THE COLUMNS THAT ARE NOT HERE ARE THE DESIGN. There is no `balance_quantity` and no
 * `balance_value`, and no derived cost on an outward row. This table holds a
 * `StockMovement` from domain/inventory and nothing a valuation produces, so the running
 * figures on a stock card are `runStockCard`'s output every time it is asked for
 * (invariant 7). Migration 0019's header is the argument, and the part of it that settles
 * the question is that `checkMovement` REFUSES an outward movement carrying a cost — a
 * column holding one could not be read back into the shape the strategy takes.
 *
 * Rows are append-only: 0019 installs triggers that abort any UPDATE or DELETE. A
 * correction is another movement, the way a correction to the journal is a reversing
 * entry — and here the reason is sharper, because editing a movement changes what every
 * later movement cost while the entries those costs posted as cannot be edited to match.
 */
export interface StockLedgerTable {
  id: string
  /** References items(id). A trigger refuses an item that keeps no balance. */
  item_id: string
  warehouse_id: string
  /** A `StockMovementKind`. Constrained by a CHECK naming the seven, as data. */
  kind: string
  /** The date the movement is valued as of. Decides its place in the card, not "now". */
  movement_date: DateString
  /**
   * Position in this (item, warehouse) register, unique within it.
   *
   * The tiebreak WITHIN a date, never the order itself: a back-dated movement gets the
   * highest sequence and the earliest date. A duplicate makes `runStockCard` refuse the
   * whole set rather than reorder two rows, which is why it is a unique index.
   */
  sequence: number
  /** Quantity, 3dp. Non-negative — the direction is on the kind (invariant 3). */
  quantity: DecimalString
  /**
   * Money, 2dp. Required on an inward movement and NULL on an outward one — invariant 4,
   * enforced as a biconditional CHECK.
   *
   * An inward movement STATES what the goods cost, because a purchase bill line already
   * fixed that figure and there is nowhere else for it to come from. An outward movement
   * is VALUED by the strategy; letting it carry a cost would let a caller price a sale at
   * whatever it liked.
   */
  cost: DecimalString | null
  /**
   * A `SourceDocumentType` — `journal_entries`'s column, meaning the same thing.
   *
   * NOT DERIVABLE FROM `kind` AND NOT DERIVING IT. One `stock-adjustment` document raises
   * both `adjustment-in` and `adjustment-out`; one `credit-note` raises `sales-return`
   * here and something else in the ledger. Two facts, two columns, no rule between them.
   */
  source_type: string
  /** Primary key in the source document's own table. Null for an opening entry. */
  source_id: string | null
  /** The number a human would quote, denormalised so a card is not a lookup per row. */
  source_number: string | null
  narration: string | null
  created_at: Timestamp
  /**
   * The journal entry this movement posted as (0022).
   *
   * ARCHITECTURE §6.4's other half: every movement writes here AND posts, in one
   * transaction, so inventory on the balance sheet always reconciles with the register.
   * `stock_ledger_posted` refuses a row that names none.
   *
   * NOT A CACHED FIGURE, and the distinction is 0019's own. That migration refuses to
   * store a running balance because a back-dated movement CHANGES it; an entry id is the
   * identity of an immutable row and cannot drift. Nullable only because SQLite requires
   * an added `REFERENCES` column to default to NULL, and because rows written before 0022
   * have none — a set that is empty in every file that exists.
   */
  entry_id: string | null
}

export interface Database {
  app_metadata: AppMetadataTable
  accounts: AccountsTable
  account_roles: AccountRolesTable
  accounting_periods: AccountingPeriodsTable
  journal_entries: JournalEntriesTable
  journal_lines: JournalLinesTable
  parties: PartiesTable
  units_of_measure: UnitsOfMeasureTable
  items: ItemsTable
  numbering_series: NumberingSeriesTable
  numbering_counters: NumberingCountersTable
  documents: DocumentsTable
  document_lines: DocumentLinesTable
  document_line_taxes: DocumentLineTaxesTable
  company_profile: CompanyProfileTable
  receipts: ReceiptsTable
  receipt_allocations: ReceiptAllocationsTable
  document_offsets: DocumentOffsetsTable
  warehouses: WarehousesTable
  stock_ledger: StockLedgerTable
}

export type { Generated }
