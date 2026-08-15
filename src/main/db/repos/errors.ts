/*
 * Repository-layer errors.
 *
 * The same contract as ../errors.ts: everything below the IPC boundary throws with a
 * stable code, and the boundary translates it into an `AppError` the renderer can
 * branch on (CONVENTIONS §5). `DbError` covers the file — opening it, keying it,
 * migrating it. `RepoError` covers what is written inside it.
 *
 * Codes are shared with `LedgerErrorCode` in domain/ledger where they mean the same
 * thing, so that "you cannot post to a group account" is one code whether the domain
 * or the repository noticed it.
 */

export type RepoErrorCode =
  // ---- Accounts ----
  /** No account with that id. */
  | 'ACCOUNT_NOT_FOUND'
  /** Another account already uses that code. Codes are unique, ignoring case. */
  | 'ACCOUNT_CODE_TAKEN'
  /** The named parent does not exist. */
  | 'ACCOUNT_PARENT_NOT_FOUND'
  /** The named parent is a leaf. Only a group may have children. */
  | 'ACCOUNT_PARENT_NOT_GROUP'
  /** A child must carry its parent's type. */
  | 'ACCOUNT_TYPE_MISMATCH'
  /** The move would make an account a descendant of itself. */
  | 'ACCOUNT_CYCLE'
  /** The account still has children. Move or remove them first. */
  | 'ACCOUNT_HAS_CHILDREN'
  /** A group holds no figures of its own, so it cannot take this. */
  | 'ACCOUNT_IS_GROUP'
  /** The account is archived and accepts nothing new. */
  | 'ACCOUNT_ARCHIVED'
  /** Something references the account — a role mapping, or a posting. */
  | 'ACCOUNT_IN_USE'
  // ---- Roles ----
  /** No account is mapped to that role. */
  | 'ROLE_UNMAPPED'
  // ---- Periods ----
  /** Not a 'YYYY-MM-DD' date. Distinct from `NO_PERIOD`, which is a real date the
   *  books do not reach — the two need different sentences in front of a user. */
  | 'INVALID_DATE'
  /** No period with that id. */
  | 'PERIOD_NOT_FOUND'
  /** No period covers that date. The books do not reach it. Shared with the domain. */
  | 'NO_PERIOD'
  /** The period covering that date is closed or locked. Shared with the domain. */
  | 'PERIOD_CLOSED'
  /** That fiscal year has already been generated. */
  | 'PERIOD_EXISTS'
  /** The span collides with a period the books already have. */
  | 'PERIOD_OVERLAP'
  /** These books are kept in months and the request was quarters, or the reverse. */
  | 'PERIOD_GRANULARITY_MISMATCH'
  /** A period's span never changes — only its status does. */
  | 'PERIOD_IMMUTABLE'
  /** The period is locked. Locked is final; correct it in the current open period. */
  | 'PERIOD_LOCKED'
  /** The transition is not available from the period's current status. */
  | 'PERIOD_STATUS_INVALID'
  /** An earlier period is still open. Periods close in order. */
  | 'PERIOD_EARLIER_OPEN'
  /** A later period is locked, so this one cannot reopen underneath it. */
  | 'PERIOD_LATER_LOCKED'

/** An error raised by a repository. Always carries a stable, machine-readable code. */
export class RepoError extends Error {
  readonly code: RepoErrorCode
  /** Structured context for the message the user eventually sees. Never a path. */
  readonly details: Record<string, unknown>

  constructor(
    code: RepoErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RepoError'
    this.code = code
    this.details = details
  }
}

export function isRepoError(value: unknown): value is RepoError {
  return value instanceof RepoError
}

/**
 * Translate a constraint a database trigger raised into the same error the repository
 * would have produced itself.
 *
 * The repository checks these before writing, so a trigger firing means something got
 * past that check — a concurrent write, or a code path that skipped it. Either way the
 * caller should see the rule that was broken rather than `SQLITE_CONSTRAINT_TRIGGER`.
 */
const TRIGGER_CODES: readonly RepoErrorCode[] = [
  'ACCOUNT_PARENT_NOT_GROUP',
  'ACCOUNT_TYPE_MISMATCH',
  'ACCOUNT_IS_GROUP',
  'PERIOD_OVERLAP',
  'PERIOD_IMMUTABLE',
  'PERIOD_LOCKED',
]

export function repoErrorFrom(error: unknown, fallback: RepoErrorCode): RepoError {
  if (isRepoError(error)) {
    return error
  }
  const message = error instanceof Error ? error.message : String(error)
  const matched = TRIGGER_CODES.find((code) => message.includes(code))
  if (matched !== undefined) {
    return new RepoError(matched, message, {}, { cause: error })
  }
  return new RepoError(fallback, message, {}, { cause: error })
}
