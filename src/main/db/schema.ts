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
 * tables when they exist, because the reference project put all of it in one row and
 * every screen wrote to it (CONVENTIONS §9). Read the migration before adding a column.
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
}

export type { Generated }
