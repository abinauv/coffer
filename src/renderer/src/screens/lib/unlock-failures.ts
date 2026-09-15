/*
 * The four ways opening a company fails, each as its own cause, fix and actions.
 *
 * FOUR, NOT ONE "WRONG PASSPHRASE" (design system §05). A person whose file has moved will
 * spend an hour retyping a passphrase that was right all along, and may decide their books
 * are gone. So each failure names its own cause in the user's terms, says what would fix
 * it, and offers only the actions that could:
 *
 *   passphrase       the passphrase did not fit. A recovery code is the way round it.
 *   file-missing     nothing is at the remembered path. The books are not lost; the path is.
 *   vault-missing    the database is there and its key file is not. Both are needed.
 *   keys-mismatched  the key file opened and belongs to other books: two halves of two
 *                    different companies, usually from a copy that did not finish.
 *
 * The first and last come from an attempt (the error `companies.open` answered); the middle
 * two are known before anyone types, from the list's own check (`CompanyAvailability`). A
 * failure that is none of these is left to FailureNotice and the general messages.
 */

import type { AppError, CompanySummary } from '@shared/dto'

export type UnlockFailureKind = 'passphrase' | 'file-missing' | 'vault-missing' | 'keys-mismatched'

export type UnlockAction = 'recover' | 'refresh' | 'find-file' | 'restore' | 'forget'

export interface UnlockFailure {
  title: string
  cause: string
  fix: string
  /** In the order the buttons are drawn, the most likely fix first. */
  actions: readonly UnlockAction[]
  /** Whether trying the passphrase again could help. Only when the passphrase was the problem. */
  canRetry: boolean
}

/** What each action is called on its button. */
export const UNLOCK_ACTION_LABELS: Readonly<Record<UnlockAction, string>> = {
  recover: 'Use a recovery code',
  refresh: 'Check again',
  'find-file': 'Find the file',
  restore: 'Restore from a backup',
  forget: 'Remove from this list',
}

const BY_ERROR_CODE: Readonly<Record<string, UnlockFailureKind>> = {
  PASSPHRASE_INVALID: 'passphrase',
  COMPANY_DATABASE_MISSING: 'file-missing',
  COMPANY_VAULT_MISSING: 'vault-missing',
  COMPANY_KEYS_MISMATCHED: 'keys-mismatched',
}

/**
 * Which failure this is, or null for none of the four.
 *
 * The attempt's answer wins over the list's check: a file that was there when the list was
 * read and gone by the time Unlock was pressed has gone.
 */
export function unlockFailureKind(
  company: Pick<CompanySummary, 'availability'>,
  error: Pick<AppError, 'code'> | null,
): UnlockFailureKind | null {
  if (error !== null) return BY_ERROR_CODE[error.code] ?? null
  switch (company.availability) {
    case 'ok':
      return null
    case 'database-missing':
      return 'file-missing'
    case 'vault-missing':
      return 'vault-missing'
  }
}

/** The words and the actions for one failure, with this company's own paths in them. */
export function describeUnlockFailure(
  kind: UnlockFailureKind,
  company: Pick<CompanySummary, 'displayName' | 'filePath' | 'vaultPath'>,
): UnlockFailure {
  switch (kind) {
    case 'passphrase':
      return {
        title: 'The passphrase does not fit',
        cause: `It did not open ${company.displayName}. Passphrases are case sensitive, and this one is stored nowhere, so Coffer can only say that it did not fit — never what the right one was.`,
        fix: 'Try it again below. If it will not come back to you, a recovery code opens the books once and sets a new passphrase.',
        actions: ['recover'],
        canRetry: true,
      }
    case 'file-missing':
      return {
        title: 'The file is not where it was',
        cause: `There is nothing at ${company.filePath}. The books are not lost — the path is.`,
        fix: 'Connect the drive or share it lives on and check again, or find the file where it was moved to. Removing it from this list deletes nothing.',
        actions: ['refresh', 'find-file', 'forget'],
        canRetry: false,
      }
    case 'vault-missing':
      return {
        title: 'The vault beside it is missing',
        cause: `A company is a database and a small key file kept beside it, and both are needed. The database is at ${company.filePath}, and there is no ${company.vaultPath}.`,
        fix: 'Put the vault back beside the database and check again, or restore a backup, which holds both.',
        actions: ['refresh', 'restore'],
        canRetry: false,
      }
    case 'keys-mismatched':
      return {
        title: 'These keys belong to another file',
        cause: `The vault beside ${company.filePath} opened, but its key does not fit these books. The two halves came from different companies — usually a copy between folders that did not finish.`,
        fix: 'Put the matching pair back in one folder and open that, or restore a backup: every backup holds a pair that fits.',
        actions: ['find-file', 'restore'],
        canRetry: false,
      }
  }
}
