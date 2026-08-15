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
}

/**
 * The database shape — the cumulative result of every migration in MIGRATIONS.
 *
 * Table interfaces are added here as migrations introduce them, keyed by the exact
 * SQL table name in snake_case.
 */
export interface Database {
  app_metadata: AppMetadataTable
  accounts: AccountsTable
  account_roles: AccountRolesTable
  accounting_periods: AccountingPeriodsTable
  journal_entries: JournalEntriesTable
  journal_lines: JournalLinesTable
}

export type { Generated }
