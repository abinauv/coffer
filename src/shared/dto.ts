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
