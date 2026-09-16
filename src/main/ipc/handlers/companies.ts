/*
 * The `companies` group.
 *
 * These handlers own the boundary, not the behaviour. They validate what the renderer
 * sent, call a `CompanyService`, wrap the answer in a `Result`, and record any path the
 * user is now entitled to reveal. Everything else — the registry file, the vault, the
 * SQLCipher key, the backup archive — lives in src/main/companies and is reached only
 * through the interface below.
 *
 * THE SERVICE THROWS; IT DOES NOT RETURN A RESULT. `SecurityError` and `DbError` already
 * carry the stable codes the UI branches on, and the boundary in ../registry.ts maps
 * them. A service that built envelopes itself would be duplicating that translation and
 * would have to be trusted to keep internal detail out of the message.
 *
 * The concrete implementation is injected in ../index.ts — see `IpcDependencies`.
 */

import type {
  BackupInput,
  BackupResult,
  ChangePassphraseInput,
  CheckRegistrationInput,
  CompanySummary,
  CreateCompanyInput,
  OpenCompanyInput,
  OpenCompanyResult,
  PassphraseStrength,
  RecoverCompanyInput,
  RegistrationCheck,
  RestoreInput,
  SetBackupReminderInput,
} from '../../../shared/dto'
import type { PathAllowlist } from '../path-access'
import type { GroupHandlers } from '../registry'
import { ok } from '../surface'
import {
  expectAbsolutePath,
  expectBoolean,
  expectBoundedString,
  expectNonEmptyString,
  expectRecord,
  expectString,
  noArgs,
} from '../validate'

/**
 * What the IPC layer needs from src/main/companies.
 *
 * Deliberately the smallest surface that satisfies the `companies` group in
 * `CofferApi` — one method per contract method, same names, same DTOs, no envelope.
 * Anything else that module offers is its own business.
 */
export interface CompanyService {
  list(): Promise<CompanySummary[]>
  create(input: CreateCompanyInput): Promise<OpenCompanyResult>
  open(input: OpenCompanyInput): Promise<OpenCompanyResult>
  /** Spends the recovery code and establishes `newPassphrase`. */
  recover(input: RecoverCompanyInput): Promise<OpenCompanyResult>
  close(): Promise<void>
  changePassphrase(input: ChangePassphraseInput): Promise<void>
  backup(input: BackupInput): Promise<BackupResult>
  setBackupReminder(input: SetBackupReminderInput): Promise<CompanySummary>
  restore(input: RestoreInput): Promise<CompanySummary>
  addExisting(filePath: string): Promise<CompanySummary>
  /** Registry only. Never touches the user's files. */
  forget(id: string): Promise<void>
  rename(id: string, displayName: string): Promise<CompanySummary>
  /**
   * Advisory only. Never blocks — see docs/ARCHITECTURE.md §6.3.1.
   *
   * Scoring a passphrase needs no I/O, so an implementation is free to be synchronous.
   */
  checkPassphrase(passphrase: string): PassphraseStrength | Promise<PassphraseStrength>
  /** Advisory, like `checkPassphrase`, and needs no I/O either. */
  checkRegistration(input: CheckRegistrationInput): RegistrationCheck | Promise<RegistrationCheck>
}

/*
 * A passphrase is validated as text, not as text-with-content. An empty one is a real
 * condition with a code of its own — SecurityError 'PASSPHRASE_EMPTY' — and the UI can
 * say something useful about it. Rejecting it here as INVALID_ARGUMENT would throw that
 * distinction away.
 */
function parseCreateInput(value: unknown): CreateCompanyInput {
  const input = expectRecord(value, 'input')
  return {
    displayName: expectNonEmptyString(input['displayName'], 'displayName'),
    directoryPath: expectAbsolutePath(input['directoryPath'], 'directoryPath'),
    passphrase: expectString(input['passphrase'], 'passphrase'),
  }
}

/*
 * Bounded, because it arrives on every keystroke in a box meant for fifteen characters. A
 * blank one is legal: it is the regime's label, with nothing to check, that comes back.
 */
function parseCheckRegistrationInput(value: unknown): CheckRegistrationInput {
  const input = expectRecord(value, 'input')
  const regimeId = input['regimeId']
  return {
    registrationNumber: expectBoundedString(input['registrationNumber'], 'registrationNumber', 64),
    ...(regimeId === undefined ? {} : { regimeId: expectNonEmptyString(regimeId, 'regimeId') }),
  }
}

function parseOpenInput(value: unknown): OpenCompanyInput {
  const input = expectRecord(value, 'input')
  return {
    id: expectNonEmptyString(input['id'], 'id'),
    passphrase: expectString(input['passphrase'], 'passphrase'),
  }
}

function parseRecoverInput(value: unknown): RecoverCompanyInput {
  const input = expectRecord(value, 'input')
  return {
    id: expectNonEmptyString(input['id'], 'id'),
    recoveryCode: expectNonEmptyString(input['recoveryCode'], 'recoveryCode'),
    newPassphrase: expectString(input['newPassphrase'], 'newPassphrase'),
  }
}

function parseChangePassphraseInput(value: unknown): ChangePassphraseInput {
  const input = expectRecord(value, 'input')
  return {
    currentPassphrase: expectString(input['currentPassphrase'], 'currentPassphrase'),
    newPassphrase: expectString(input['newPassphrase'], 'newPassphrase'),
  }
}

function parseBackupInput(value: unknown): BackupInput {
  const input = expectRecord(value, 'input')
  return { directoryPath: expectAbsolutePath(input['directoryPath'], 'directoryPath') }
}

function parseBackupReminderInput(value: unknown): SetBackupReminderInput {
  const input = expectRecord(value, 'input')
  return {
    id: expectNonEmptyString(input['id'], 'id'),
    isOn: expectBoolean(input['isOn'], 'isOn'),
  }
}

function parseRestoreInput(value: unknown): RestoreInput {
  const input = expectRecord(value, 'input')
  return {
    archivePath: expectAbsolutePath(input['archivePath'], 'archivePath'),
    directoryPath: expectAbsolutePath(input['directoryPath'], 'directoryPath'),
  }
}

/**
 * A company the user can see is a company the user may reveal. Both files are granted:
 * the database is what they will look for, and the vault beside it is what a support
 * conversation will ask them to check for.
 */
function grantReveal(allowlist: PathAllowlist, company: CompanySummary): CompanySummary {
  allowlist.allow(company.filePath)
  allowlist.allow(company.vaultPath)
  return company
}

export function createCompaniesHandlers(
  service: CompanyService,
  allowlist: PathAllowlist,
): GroupHandlers<'companies'> {
  return {
    list: {
      parseArgs: noArgs,
      handle: async () => {
        const companies = await service.list()
        for (const company of companies) grantReveal(allowlist, company)
        return ok(companies)
      },
    },

    create: {
      parseArgs: (raw): [CreateCompanyInput] => [parseCreateInput(raw[0])],
      handle: async (input) => {
        const result = await service.create(input)
        grantReveal(allowlist, result.company)
        return ok(result)
      },
    },

    open: {
      parseArgs: (raw): [OpenCompanyInput] => [parseOpenInput(raw[0])],
      handle: async (input) => {
        const result = await service.open(input)
        grantReveal(allowlist, result.company)
        return ok(result)
      },
    },

    recover: {
      parseArgs: (raw): [RecoverCompanyInput] => [parseRecoverInput(raw[0])],
      handle: async (input) => {
        const result = await service.recover(input)
        grantReveal(allowlist, result.company)
        return ok(result)
      },
    },

    close: {
      parseArgs: noArgs,
      handle: async () => {
        await service.close()
        return ok(undefined)
      },
    },

    changePassphrase: {
      parseArgs: (raw): [ChangePassphraseInput] => [parseChangePassphraseInput(raw[0])],
      handle: async (input) => {
        await service.changePassphrase(input)
        return ok(undefined)
      },
    },

    backup: {
      parseArgs: (raw): [BackupInput] => [parseBackupInput(raw[0])],
      handle: async (input) => {
        const result = await service.backup(input)
        /* The archive is the one artefact the user is told to copy somewhere safe, so
         * "show me where it went" is the next thing they will ask for. */
        allowlist.allow(result.archivePath)
        /* The company travels back with the archive, and a screen may offer to reveal
         * its files as any other answer carrying one does. */
        grantReveal(allowlist, result.company)
        return ok(result)
      },
    },

    setBackupReminder: {
      parseArgs: (raw): [SetBackupReminderInput] => [parseBackupReminderInput(raw[0])],
      handle: async (input) => ok(grantReveal(allowlist, await service.setBackupReminder(input))),
    },

    restore: {
      parseArgs: (raw): [RestoreInput] => [parseRestoreInput(raw[0])],
      handle: async (input) => ok(grantReveal(allowlist, await service.restore(input))),
    },

    addExisting: {
      parseArgs: (raw): [string] => [expectAbsolutePath(raw[0], 'filePath')],
      handle: async (filePath) => ok(grantReveal(allowlist, await service.addExisting(filePath))),
    },

    forget: {
      parseArgs: (raw): [string] => [expectNonEmptyString(raw[0], 'id')],
      handle: async (id) => {
        await service.forget(id)
        return ok(undefined)
      },
    },

    rename: {
      parseArgs: (raw): [string, string] => [
        expectNonEmptyString(raw[0], 'id'),
        expectNonEmptyString(raw[1], 'displayName'),
      ],
      handle: async (id, displayName) =>
        ok(grantReveal(allowlist, await service.rename(id, displayName))),
    },

    checkPassphrase: {
      parseArgs: (raw): [string] => [expectString(raw[0], 'passphrase')],
      handle: async (passphrase) => ok(await service.checkPassphrase(passphrase)),
    },

    checkRegistration: {
      parseArgs: (raw): [CheckRegistrationInput] => [parseCheckRegistrationInput(raw[0])],
      handle: async (input) => ok(await service.checkRegistration(input)),
    },
  }
}
