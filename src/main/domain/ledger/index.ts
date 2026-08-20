/*
 * The ledger domain. Import from here, not from the individual files.
 *
 * Pure by construction and by lint rule: no Node built-in, no `electron`, nothing from
 * `db/`, `services/` or `ipc/`, and no tax regime. What is in here is double-entry
 * bookkeeping, which is the same in every country that has books.
 *
 * Start at types.ts — the five invariants at the top of it are the contract.
 */

export {
  ACCOUNT_ROLES,
  ACCOUNT_TYPES,
  MANUAL_SOURCE,
  NORMAL_BALANCE,
  acceptsPostings,
  isPermanent,
  normalBalanceOf,
  signedEffect,
  type AccountRef,
  type AccountResolver,
  type AccountRole,
  type AccountType,
  type AccountingPeriodRef,
  type EntryDraft,
  type EntryLineDraft,
  type EntryTotals,
  PostingError,
  isPostingError,
  type LedgerErrorCode,
  type NormalBalance,
  type PeriodStatus,
  type PostingContext,
  type PostingRule,
  type SourceDocument,
  type SourceDocumentType,
} from './types'

export {
  checkDraft,
  checkLine,
  isBalanced,
  reverseLines,
  totalsOf,
  type DraftProblem,
} from './balance'
