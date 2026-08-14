/*
 * The error boundary's translation table.
 *
 * Two rules govern everything here.
 *
 * 1. AN UNEXPECTED EXCEPTION TELLS THE RENDERER NOTHING. Not its message, not its
 *    stack, not the path it was reading, not the SQL it was running. It becomes one
 *    fixed, generic `AppError` and the detail goes to the log. Anything else is an
 *    information leak dressed up as helpfulness, and the renderer is untrusted
 *    (docs/ARCHITECTURE.md §4).
 *
 * 2. AN EXPECTED FAILURE KEEPS ITS CODE. `src/main/security/errors.ts` and
 *    `src/main/db/errors.ts` both raise errors carrying a stable code union, and the UI
 *    needs to branch on them — "wrong passphrase" is a different screen from "this file
 *    was written by a newer Coffer". Mapping those codes across the boundary is the
 *    entire reason this module exists.
 *
 * Messages follow docs/CONVENTIONS.md §5: say what went wrong and what to do. No stack
 * traces, no apologies, no 'Something went wrong'.
 */

import type { AppError } from '../../shared/dto'
import { type DbErrorCode, isDbError } from '../db/errors'
import { isSecurityError } from '../security/errors'

/** Failures raised by the IPC layer itself, before or instead of reaching a service. */
export type IpcErrorCode =
  /** An argument from the renderer was missing, of the wrong type, or out of range. */
  | 'INVALID_ARGUMENT'
  /** A path was syntactically fine but is not one Coffer is willing to act on. */
  | 'PATH_NOT_ALLOWED'
  /** A path Coffer would act on is not there any more. */
  | 'PATH_NOT_FOUND'

/**
 * An expected, actionable failure raised by a handler.
 *
 * Its message crosses to the renderer verbatim, so construct it from fixed strings.
 * Never interpolate a caller-supplied *value* — name the field instead. An argument
 * that failed validation may well be a passphrase.
 */
export class IpcError extends Error {
  readonly code: IpcErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: IpcErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'IpcError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/** The one thing the renderer learns about an exception nobody planned for. */
export const INTERNAL_ERROR_CODE = 'INTERNAL_ERROR'

export const INTERNAL_ERROR_MESSAGE =
  'Coffer could not complete that action. The details were written to the log — please ' +
  'report this if it keeps happening.'

/**
 * User-facing text for each database failure.
 *
 * The messages on `DbError` itself are written for a developer reading a log and
 * interpolate file paths, migration ids and build versions into their text. None of
 * that belongs in the renderer, so the code crosses and the message is rewritten here.
 * (`SecurityError` is the opposite case — see `toAppError`.)
 */
const DB_MESSAGES: Record<DbErrorCode, string> = {
  DB_KEY_INVALID:
    'The key for this company could not be used. Restore from a backup that includes ' +
    'the vault file.',
  DB_WRONG_KEY:
    'That passphrase does not open this company. Check it and try again, or use a ' +
    'recovery code.',
  DB_CORRUPT:
    'This company file is damaged and cannot be read. Restore from your most recent backup.',
  DB_OPEN_FAILED:
    'Coffer could not open this company file. Check that the drive is connected and ' +
    'that the file has not been moved or renamed.',
  DB_MIGRATION_FAILED:
    'Coffer could not bring this company file up to date. Nothing was changed. Restore ' +
    'from your most recent backup and try again.',
  DB_SCHEMA_TOO_NEW:
    'This company file was created by a newer version of Coffer. Update Coffer to open it.',
  DB_SCHEMA_UNKNOWN:
    'This company file was not written by a version of Coffer this build recognises. ' +
    'Open it with the version that created it.',
  DB_MIGRATION_REGISTRY_INVALID:
    'This installation of Coffer is damaged and cannot update company files. Reinstall Coffer.',
  DB_MIGRATION_IRREVERSIBLE: 'That change cannot be undone on this company file.',
}

/**
 * Claims an error the IPC layer cannot recognise on its own, or returns null.
 *
 * The extension point for modules the IPC layer must not import. `src/main/companies`
 * raises `CompanyError` with a code union of its own, and the UI needs those codes — but
 * nothing under src/main/ipc may reach into that module, so the composition root
 * supplies the knowledge instead. See `IpcDependencies.errorMappers`.
 */
export type ErrorMapper = (cause: unknown) => AppError | null

/** The error types this layer recognises unaided. Null for anything else. */
export function mapKnownError(cause: unknown): AppError | null {
  if (cause instanceof IpcError) {
    return cause.details === undefined
      ? { code: cause.code, message: cause.message }
      : { code: cause.code, message: cause.message, details: cause.details }
  }

  /* security/errors.ts guarantees fixed messages with no interpolated caller input, and
   * documents that a handler may pass them straight through. Taken at its word. */
  if (isSecurityError(cause)) {
    return { code: cause.code, message: cause.message }
  }

  if (isDbError(cause)) {
    return { code: cause.code, message: DB_MESSAGES[cause.code] ?? INTERNAL_ERROR_MESSAGE }
  }

  return null
}

function isAppError(value: unknown): value is AppError {
  if (typeof value !== 'object' || value === null) return false
  const { code, message } = value as { code?: unknown; message?: unknown }
  return typeof code === 'string' && typeof message === 'string'
}

/**
 * Recognise `cause`, or return null if nobody can.
 *
 * The built-in mappings run first and cannot be overridden — a supplied mapper can add
 * codes this layer does not know, never weaken a guarantee it does. A mapper that
 * returns something that is not an `AppError` is ignored rather than trusted.
 */
export function mapError(cause: unknown, mappers: readonly ErrorMapper[] = []): AppError | null {
  const known = mapKnownError(cause)
  if (known !== null) return known

  for (const mapper of mappers) {
    const mapped = mapper(cause)
    if (isAppError(mapped)) return mapped
  }

  return null
}

/** As `mapError`, but falling back to the generic internal error rather than to null. */
export function toAppError(cause: unknown, mappers: readonly ErrorMapper[] = []): AppError {
  return mapError(cause, mappers) ?? { code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE }
}
