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

/** A monetary or quantity value, as an exact decimal string. Never a float. */
export type DecimalString = string

/** ISO-8601 UTC timestamp, e.g. '2026-08-13T09:30:00.000Z'. */
export type Timestamp = string

/** Calendar date, 'YYYY-MM-DD'. No time, no zone. */
export type DateString = string

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

// ---- Companies ------------------------------------------------------------

/*
 * A company is one encrypted SQLite file. The registry lists them; it never holds
 * their contents or their keys. There is deliberately no `companyId` on any other
 * DTO — see docs/ARCHITECTURE.md §6.3.
 */

export interface CompanySummary {
  /** Registry-local identifier. Not a tenant key; nothing else is scoped by it. */
  id: string
  displayName: string
  /** Absolute path to the encrypted database file. */
  filePath: string
  lastOpenedAt: Timestamp | null
  createdAt: Timestamp
  /** False when the file is missing or unreadable — a moved or deleted database. */
  isAvailable: boolean
}

export interface CreateCompanyInput {
  displayName: string
  /** Directory to create the database in. The file name derives from displayName. */
  directoryPath: string
  passphrase: string
}

export interface OpenCompanyInput {
  id: string
  passphrase: string
}

export interface OpenCompanyResult {
  company: CompanySummary
  /** Recovery codes, returned exactly once at creation and never retrievable again. */
  recoveryCodes?: string[]
}
