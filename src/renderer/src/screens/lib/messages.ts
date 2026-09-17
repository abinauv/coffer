/*
 * What Coffer says when something fails.
 *
 * Every code the main process can hand these screens has an entry here. That is the
 * point of the file: a screen never falls back to "Something went wrong", because the
 * fallback is only reached by a code nobody has written for yet — and even then it
 * shows the message main sent rather than an apology (docs/CONVENTIONS.md §5).
 *
 * WHY REWRITE MESSAGES MAIN ALREADY WROTE. The service messages are written for a
 * person, and they are good, but they are written once for every caller. On the unlock
 * screen "that passphrase did not work" needs to arrive with the sentence about recovery
 * codes and a button that goes there; in a backup dialog the same code means something
 * else entirely. So the code decides the copy, and `withDetail` marks the handful of
 * cases where main's own message carries something this file cannot know — a path.
 *
 * Nothing here interpolates anything the user typed. A message that quotes an input is a
 * message that can quote a passphrase.
 */

import type { AppError } from '@shared/dto'

/**
 * The one useful next step for a failure, if there is one. Each screen renders the
 * actions it can honour and ignores the rest — an unlock screen can offer recovery, a
 * backup dialog cannot.
 */
export type ErrorAction = 'recover' | 'add-existing' | 'restore' | 'refresh'

export interface Guidance {
  /** One line. What happened, in this screen's terms. */
  title: string
  /** What to do about it. Always says something the user can act on. */
  body: string
  action: ErrorAction | null
  /**
   * Show main's own message underneath as well. True only where it names the file or
   * folder the failure is about, which is exactly what makes it actionable.
   */
  withDetail: boolean
}

/** Which screen is asking. Only a few codes read differently from one to the next. */
export type FailureContext =
  | 'general'
  | 'list'
  | 'create'
  | 'unlock'
  | 'recover'
  | 'restore'
  | 'backup'
  | 'change-passphrase'
  | 'new-recovery-codes'
  /* The ledger screens. No overrides yet — `RepoError` messages are already written as
   * sentences for a user, so the generic path shows them unchanged. The context exists
   * so that adding guidance for, say, PERIOD_CLOSED is a table entry rather than a
   * refactor. */
  | 'ledger'

interface Entry {
  title: string
  body: string
  action?: ErrorAction
  withDetail?: boolean
}

/*
 * The table. Grouped by the module that raises the code:
 * src/main/security/errors.ts, src/main/db/errors.ts, src/main/companies/errors.ts,
 * src/main/ipc/errors.ts, and the two the renderer's own bridge produces.
 */
const ENTRIES: Record<string, Entry> = {
  // ---- Passphrases and recovery codes (SecurityError) ----------------------

  PASSPHRASE_INVALID: {
    title: 'That passphrase does not open this company.',
    body:
      'Passphrases are case sensitive, and this one is stored nowhere — Coffer can only ' +
      'tell you that it did not fit, never what the right one was. If you cannot ' +
      'remember it, unlock with one of your recovery codes instead.',
    action: 'recover',
  },
  PASSPHRASE_EMPTY: {
    title: 'Enter your passphrase.',
    body: 'The passphrase field was empty. Nothing was tried, and nothing was changed.',
  },
  PASSPHRASE_HASH_MALFORMED: {
    title: 'The vault beside this company is damaged.',
    body:
      'Coffer cannot read the passphrase settings stored in the vault file, so it cannot ' +
      'check a passphrase against them. Restore from a backup — a backup always carries ' +
      'the database and its vault together.',
    action: 'restore',
  },
  RECOVERY_CODE_MALFORMED: {
    title: 'That is not a recovery code.',
    body:
      'A code is 20 characters in four groups of five, like A1B2C-3D4E5-F6G7H-8J9K0. ' +
      'Hyphens, spaces and lower case are all fine. Check the sheet and type it again.',
  },
  RECOVERY_CODE_INVALID: {
    title: 'That code does not belong to this company.',
    body:
      'Three things do this. The sheet belongs to another company; the sheet was replaced ' +
      'by a newer set, which killed every code on it; or a character was misread — 0 and ' +
      'O, 1 and I are easy to swap when copying by hand. Read it again before looking ' +
      'further.',
  },
  RECOVERY_CODE_ALREADY_USED: {
    title: 'That recovery code has already been used.',
    body:
      'Each code works exactly once, and using one does not affect the others. Take the ' +
      'next unused code from your sheet and try that.',
  },
  KDF_PARAMS_INVALID: {
    title: 'This vault asks for key settings Coffer will not use.',
    body:
      'The vault records key-derivation settings outside the range this build accepts, ' +
      'so it is either damaged or written by a different program. Restore from a backup, ' +
      'which carries a vault Coffer wrote itself.',
    action: 'restore',
  },
  KEY_MATERIAL_INVALID: {
    title: 'The key material in this vault is the wrong shape.',
    body:
      'The vault beside this database is damaged. Restore from a backup — it holds both ' +
      'files, and the database on its own cannot be decrypted by anyone.',
    action: 'restore',
  },
  VAULT_MALFORMED: {
    title: 'That vault file cannot be read.',
    body:
      'The file beside this database is not a Coffer vault, or it has lost fields Coffer ' +
      'needs. Restore from a backup, which holds a matching database and vault.',
    action: 'restore',
  },
  VAULT_TAMPERED: {
    title: 'This vault has been altered since Coffer wrote it.',
    body:
      'It no longer matches its own signature, which means it was edited, only partly ' +
      'written, or damaged in copying. Do not keep using it: restore from a backup ' +
      'instead, and keep this copy until you have checked the restored books.',
    action: 'restore',
  },
  VAULT_UNSUPPORTED_VERSION: {
    title: 'This vault was written by a newer version of Coffer.',
    body:
      'Update Coffer to open this company. An older build will not guess at a newer vault ' +
      'format — guessing wrong there costs the keys.',
  },
  VAULT_IO_FAILED: {
    title: 'Coffer could not read the vault file.',
    body:
      'Check that the drive is connected and that the folder is not read-only or in use ' +
      'by another program, then try again.',
    action: 'refresh',
  },
  SEALED_BOX_INVALID_KEY: {
    title: 'That support key cannot be used.',
    body: 'The key in that request is not a valid one. Generate the request again.',
  },
  SEALED_BOX_OPEN_FAILED: {
    title: 'That support reply could not be opened.',
    body:
      'It was sealed for a different key, or it was altered on the way back. Ask for a ' +
      'fresh reply to the request you generated.',
  },
  SEALED_REQUEST_MALFORMED: {
    title: 'That support request file could not be read.',
    body: 'The file is damaged or incomplete. Generate the request again.',
  },

  // ---- The database file (DbError) ----------------------------------------

  DB_WRONG_KEY: {
    title: 'The key from the vault does not open this database.',
    body:
      'The vault opened, so the passphrase was right — but the database file beside it ' +
      'belongs to different books. Put the matching pair back in one folder, or restore a ' +
      'backup, which always holds a pair that fits.',
    action: 'restore',
  },
  DB_KEY_INVALID: {
    title: 'The key for this company could not be used.',
    body:
      'The vault produced a key of the wrong size, which means the vault file is damaged. ' +
      'Restore from a backup that includes it.',
    action: 'restore',
  },
  DB_CORRUPT: {
    title: 'This company file is damaged.',
    body:
      'It decrypts, but the database inside it is structurally damaged and cannot be ' +
      'read. Trying again will not repair it. Restore your most recent backup, and keep ' +
      'this file until you have checked what the backup contains.',
    action: 'restore',
  },
  DB_OPEN_FAILED: {
    title: 'Coffer could not open this company file.',
    body:
      'Check that the drive is connected, that the file has not been moved or renamed, ' +
      'and that no other copy of Coffer has it open.',
    action: 'refresh',
  },
  DB_MIGRATION_FAILED: {
    title: 'Coffer could not bring this company file up to date.',
    body:
      'Nothing was changed — the update runs in a transaction and it was rolled back. ' +
      'Restore your most recent backup and try again. If it fails the same way, report it ' +
      'rather than retrying.',
    action: 'restore',
  },
  DB_SCHEMA_TOO_NEW: {
    title: 'This company was created by a newer version of Coffer.',
    body:
      'Update Coffer to open it. This build will not write to a file whose format it does ' +
      'not fully understand.',
  },
  DB_SCHEMA_UNKNOWN: {
    title: 'This file carries changes this build has never seen.',
    body:
      'Open it with the version of Coffer that created it. Coffer will not modify a file ' +
      'whose history it cannot read.',
  },
  DB_MIGRATION_REGISTRY_INVALID: {
    title: 'This installation of Coffer is damaged.',
    body:
      'Its list of database updates is not valid, so it cannot safely open company files. ' +
      'Reinstall Coffer. Your books are not affected — nothing was opened.',
  },
  DB_MIGRATION_IRREVERSIBLE: {
    title: 'That change cannot be undone on this company file.',
    body: 'The update that made it declares no way back. Restore from a backup taken before it.',
    action: 'restore',
  },

  // ---- Companies (CompanyError) -------------------------------------------

  COMPANY_NOT_FOUND: {
    title: 'That company is no longer in the list.',
    body:
      'Nothing was deleted — the list is only a list. Add the file again with "Add an ' +
      'existing company" and it comes back exactly as it was.',
    action: 'add-existing',
  },
  COMPANY_DATABASE_MISSING: {
    title: "Coffer cannot find this company's file.",
    body:
      'If it lives on a drive or a network share that is not connected, connect it and ' +
      'refresh. If the file was moved or renamed, point Coffer at it again with "Add an ' +
      'existing company".',
    action: 'add-existing',
    withDetail: true,
  },
  COMPANY_VAULT_MISSING: {
    title: "This company's keys are missing.",
    body:
      'The database is here, but the .vault file that belongs beside it is not — and the ' +
      'keys live in the vault. Without it these books cannot be decrypted by anyone, ' +
      'including Coffer. Restore from a backup: a backup holds both files.',
    action: 'restore',
    withDetail: true,
  },
  COMPANY_KEYS_MISMATCHED: {
    title: 'The vault beside this database belongs to another company.',
    body:
      'The vault opened, but its key does not fit these books, so the two files were ' +
      'separated at some point. Put the matching pair back in one folder, or restore a ' +
      'backup — every backup holds a pair that fits.',
    action: 'restore',
    withDetail: true,
  },
  COMPANY_FILE_EXISTS: {
    title: 'There is already a company file with that name in that folder.',
    body:
      'Choose a different name, or a different folder. Coffer never writes over a company ' +
      'file: doing so would destroy the books already there.',
    withDetail: true,
  },
  COMPANY_NAME_REQUIRED: {
    title: 'Give this company a name.',
    body:
      'The name is yours to choose. It becomes the file name, and you can rename it later ' +
      'without touching the file.',
  },
  COMPANY_DIRECTORY_REQUIRED: {
    title: 'Choose a folder.',
    body: "Coffer needs somewhere to keep this company's two files.",
  },
  PASSPHRASE_REQUIRED: {
    title: 'Enter a passphrase.',
    body: 'The passphrase is what encrypts these books. There is no company without one.',
  },
  NO_COMPANY_OPEN: {
    title: 'No company is open.',
    body: 'Open a company first, then try this again.',
  },
  BACKUP_ARCHIVE_INVALID: {
    title: 'That file is not a Coffer backup, or it is damaged.',
    body:
      'Choose the .coffer-backup.zip file Coffer wrote. Nothing was written to disk, so ' +
      'nothing has to be undone.',
    withDetail: true,
  },
  BACKUP_ARCHIVE_UNSUPPORTED: {
    title: 'This backup uses a feature this build cannot read.',
    body: 'Update Coffer and restore it again. Nothing was written to disk.',
  },
  REGISTRY_IO_FAILED: {
    title: 'Coffer could not update its list of companies.',
    body:
      "The list lives in Coffer's own application-data folder. Check that the disk is not " +
      'full or read-only, then try again. Your company files are not affected.',
  },
  COMPANY_IO_FAILED: {
    title: 'Coffer could not finish writing to disk.',
    body:
      'Check that the drive is connected, has free space, and is not read-only, then try ' +
      'again.',
    withDetail: true,
  },
  COMPANY_OPERATION_FAILED: {
    title: 'Coffer could not finish that action.',
    body:
      'The details are in the application log. Try again; if it happens twice, report it ' +
      'with what you were doing at the time.',
  },

  // ---- The IPC boundary (IpcError) ----------------------------------------

  INVALID_ARGUMENT: {
    title: 'Coffer could not use one of those values.',
    body: 'Check the fields and try again. Nothing was changed.',
    withDetail: true,
  },
  PATH_NOT_ALLOWED: {
    title: 'Coffer only shows files it manages.',
    body: 'Choose the file or folder first, then ask Coffer to show it.',
  },
  PATH_NOT_FOUND: {
    title: 'That file is not where Coffer expected it.',
    body:
      'It has been moved, renamed or deleted since the list was read. Refresh the list, or ' +
      'add the company again from wherever it is now.',
    action: 'refresh',
  },
  INTERNAL_ERROR: {
    title: 'Coffer could not complete that action.',
    body:
      'The details were written to the application log. Try again; if it keeps happening, ' +
      'report it with what you were doing.',
  },

  // ---- The renderer's own bridge (lib/api.ts) ------------------------------

  BRIDGE_UNAVAILABLE: {
    title: 'Coffer cannot reach its own core.',
    body: 'Close this window and start Coffer again. Nothing was changed.',
  },
  IPC_FAILED: {
    title: 'That action did not complete.',
    body: 'Try it again. If it keeps failing, restart Coffer — nothing was changed.',
  },
}

/*
 * The few codes that read differently depending on which screen is asking. A context
 * with no entry for a code falls through to the table above.
 */
const OVERRIDES: Partial<Record<FailureContext, Record<string, Entry>>> = {
  unlock: {
    PASSPHRASE_REQUIRED: {
      title: 'Enter your passphrase.',
      body:
        'Type the passphrase for this company. It is stored nowhere, so Coffer cannot ' +
        'fill it in or check it before you press Unlock.',
    },
  },
  recover: {
    PASSPHRASE_REQUIRED: {
      title: 'Choose the passphrase you will use from now on.',
      body: 'Recovery always sets a new passphrase — the old one is not recoverable either.',
    },
  },
  'change-passphrase': {
    PASSPHRASE_INVALID: {
      title: 'That is not the current passphrase for this company.',
      body:
        'Nothing was changed; the passphrase you already have still works. Check it and ' +
        'try again.',
    },
  },
  /* Issuing needs the passphrase for a reason the generic wording cannot carry: the
   * refusal is the feature working, not an obstacle. */
  'new-recovery-codes': {
    PASSPHRASE_INVALID: {
      title: 'That is not the passphrase for this company.',
      body:
        'No codes were issued, and the ones you have now still work exactly as they did. ' +
        'This check is why an unlocked machine on a desk cannot mint new ways into your books.',
    },
    PASSPHRASE_REQUIRED: {
      title: 'Enter your passphrase to issue new codes.',
      body:
        'It is stored nowhere, so Coffer cannot fill it in. Nothing has changed yet — your ' +
        'current codes still work.',
    },
  },
  create: {
    COMPANY_FILE_EXISTS: {
      title: 'A company file with that name is already in that folder.',
      body:
        'Give this company a different name, or choose another folder. Coffer will not ' +
        'write over a company file — the books in it would be gone.',
      withDetail: true,
    },
  },
}

/** Every code this file has copy for. The test walks it; nothing else should need it. */
export const KNOWN_ERROR_CODES: readonly string[] = Object.keys(ENTRIES)

/** Shown when a code arrives that nobody has written copy for and main sent no message. */
const UNWRITTEN: Guidance = {
  title: 'Coffer could not finish that action.',
  body:
    'Nothing was changed. Try it again, and if it happens twice, report it with what you ' +
    'were doing — the details are in the application log.',
  action: null,
  withDetail: false,
}

/**
 * The copy for a failure.
 *
 * An unrecognised code is not a dead end: main's own message is already written for a
 * person, so it becomes the body rather than being swallowed.
 */
export function describeFailure(error: AppError, context: FailureContext = 'general'): Guidance {
  const entry = OVERRIDES[context]?.[error.code] ?? ENTRIES[error.code]
  if (entry === undefined) {
    const message = error.message.trim()
    return message === '' ? UNWRITTEN : { ...UNWRITTEN, body: message }
  }
  return {
    title: entry.title,
    body: entry.body,
    action: entry.action ?? null,
    withDetail: entry.withDetail === true,
  }
}

/**
 * The detail line to print under the guidance, or null.
 *
 * Only for codes whose message names a file or folder — the one thing this module
 * cannot say for itself, and the thing that makes "put them back together" possible.
 */
export function failureDetail(error: AppError, context: FailureContext = 'general'): string | null {
  const guidance = describeFailure(error, context)
  if (!guidance.withDetail) return null
  const message = error.message.trim()
  return message === '' || message === guidance.body ? null : message
}

/** One line for a toast, where there is no room for the body. */
export function failureTitle(error: AppError, context: FailureContext = 'general'): string {
  return describeFailure(error, context).title
}
