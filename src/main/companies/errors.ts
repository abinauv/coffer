/*
 * Errors raised by the companies module.
 *
 * The three layers below this one already raise errors with stable codes and messages
 * written for a human: `SecurityError` for anything to do with keys, `DbError` for
 * anything to do with the file. Those are passed through untouched — re-wrapping "that
 * passphrase did not unlock this company" in a company-level code would only add a
 * translation table that can drift.
 *
 * `CompanyError` covers what only this layer knows: which company, where its files are,
 * whether one is open, and whether a backup archive is what it claims to be.
 *
 * ONE RULE INHERITED FROM security/errors.ts: no message here ever contains a
 * passphrase, a recovery code or key material. Paths and display names are fine — the
 * user gave them to us and needs them back to act on the message.
 */

import type { AppError } from '@shared/dto'
import { isDbError } from '../db/errors'
import { isRepoError } from '../db/repos/errors'
import { isSecurityError } from '../security'

export type CompanyErrorCode =
  /** No company in the registry has that id. */
  | 'COMPANY_NOT_FOUND'
  /** The company's database file is gone — moved, deleted, or on a drive that is not mounted. */
  | 'COMPANY_DATABASE_MISSING'
  /** The database is there, its vault is not. Only a backup holding both can fix this. */
  | 'COMPANY_VAULT_MISSING'
  /** The vault opened, and its key does not decrypt the database beside it. A mismatched pair. */
  | 'COMPANY_KEYS_MISMATCHED'
  /** Creating or restoring would overwrite a file that already exists. Never do that. */
  | 'COMPANY_FILE_EXISTS'
  /** A display name was empty or whitespace. */
  | 'COMPANY_NAME_REQUIRED'
  /** A directory argument was empty or not usable as a path. */
  | 'COMPANY_DIRECTORY_REQUIRED'
  /** A passphrase argument was empty. Strength is advisory; presence is not. */
  | 'PASSPHRASE_REQUIRED'
  /** The operation needs an open company and none is open. */
  | 'NO_COMPANY_OPEN'
  /** A backup archive is not a Coffer backup, or is damaged. */
  | 'BACKUP_ARCHIVE_INVALID'
  /** A backup archive uses a feature this build cannot read (zip64, encryption). */
  | 'BACKUP_ARCHIVE_UNSUPPORTED'
  /** The registry file could not be read, written, or moved aside. */
  | 'REGISTRY_IO_FAILED'
  /** Reading or writing a company file failed for a reason the OS reported. */
  | 'COMPANY_IO_FAILED'
  /** The named tax regime is not installed in this build. */
  | 'COMPANY_REGIME_UNKNOWN'

/** An error raised by `src/main/companies`. Always carries a stable, machine-readable code. */
export class CompanyError extends Error {
  readonly code: CompanyErrorCode

  constructor(code: CompanyErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CompanyError'
    this.code = code
  }
}

export function isCompanyError(value: unknown): value is CompanyError {
  return value instanceof CompanyError
}

/**
 * Translate anything thrown by this module into the `AppError` envelope.
 *
 * Offered for the IPC boundary, which has to produce one of these anyway
 * (CONVENTIONS §5). Company, security, database and repository errors already carry a
 * message written for the user, so they pass through with their code intact. Anything
 * else is a bug rather than an expected outcome: its message may name internals, so it
 * is replaced rather than shown, and the handler logs the original.
 *
 * `RepoError` is in that list because creating a company now writes a chart of accounts
 * and a set of fiscal periods, and "this company already has a chart of accounts" is an
 * expected, actionable failure rather than an internal one.
 */
export function describeError(error: unknown): AppError {
  if (isCompanyError(error) || isSecurityError(error) || isDbError(error) || isRepoError(error)) {
    return { code: error.code, message: error.message }
  }
  return {
    code: 'COMPANY_OPERATION_FAILED',
    message: 'Coffer could not finish that action. The details are in the application log.',
  }
}
