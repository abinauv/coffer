/*
 * Kysely table typings — the cumulative shape of the database after every migration.
 *
 * CONVENTIONS (docs/CONVENTIONS.md §3), which this file exists to enforce at the type
 * level so that a violation is a compile error rather than a rounding bug:
 *
 *   - Money, quantity and rate columns are DECIMAL STRINGS (TEXT), parsed with
 *     decimal.js. Never REAL, never a JS number. Storage scale: money 2dp,
 *     quantity 3dp, rate 2dp.
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

/** An exact decimal persisted as text. Never a float. */
export type DecimalString = string

/** ISO-8601 UTC timestamp string. */
export type Timestamp = string

/** 'YYYY-MM-DD'. */
export type DateString = string

/** Boolean persisted as SQLite INTEGER 0/1. */
export type SqlBool = number

/**
 * The database shape. Empty until the first migration lands.
 *
 * Table interfaces are added here as migrations introduce them, keyed by the exact
 * SQL table name in snake_case.
 */
export interface Database {
  /* Populated by migrations. See src/main/db/migrations/. */
  [table: string]: unknown
}

export type { Generated }
