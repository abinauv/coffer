/*
 * The typed IPC contract. Single source of truth for every method the renderer may call.
 *
 * HOW TO ADD AN ENDPOINT (docs/CONVENTIONS.md §4):
 *   1. Add the method to its group in `CofferApi` below.
 *   2. Add any DTOs to ./dto.ts.
 *   3. Register a handler in src/main/ipc/handlers/<group>.ts under 'group:method'.
 *
 * That is the whole procedure. The renderer proxy is generated from this interface, so
 * `api.companies.list()` becomes callable and fully typed with no further wiring, and
 * no `ipcRenderer.invoke` call belongs anywhere else in the codebase.
 *
 * Channel names are `${group}:${method}`, derived automatically.
 */

import type {
  AppInfo,
  BackupInput,
  BackupResult,
  ChangePassphraseInput,
  CompanySummary,
  CreateCompanyInput,
  OpenCompanyInput,
  OpenCompanyResult,
  PassphraseStrength,
  RecoverCompanyInput,
  RestoreInput,
  Result,
} from './dto'

export interface CofferApi {
  system: {
    getAppInfo(): Promise<Result<AppInfo>>
    /** Native directory picker. Returns null when the user cancels. */
    chooseDirectory(): Promise<Result<string | null>>
    /** Native file picker for a backup archive. Null when cancelled. */
    chooseBackupArchive(): Promise<Result<string | null>>
    /** Reveal a path in Explorer/Finder/the file manager. */
    revealInFileManager(path: string): Promise<Result<void>>
  }

  companies: {
    list(): Promise<Result<CompanySummary[]>>
    create(input: CreateCompanyInput): Promise<Result<OpenCompanyResult>>
    open(input: OpenCompanyInput): Promise<Result<OpenCompanyResult>>
    /** Unlock with a recovery code. Spends the code and sets a new passphrase. */
    recover(input: RecoverCompanyInput): Promise<Result<OpenCompanyResult>>
    close(): Promise<Result<void>>
    changePassphrase(input: ChangePassphraseInput): Promise<Result<void>>

    /** Writes one archive holding the database and its vault. */
    backup(input: BackupInput): Promise<Result<BackupResult>>
    restore(input: RestoreInput): Promise<Result<CompanySummary>>

    /** Adds an existing company file to the registry. */
    addExisting(filePath: string): Promise<Result<CompanySummary>>
    /** Removes from the registry only. Never deletes the user's files. */
    forget(id: string): Promise<Result<void>>
    rename(id: string, displayName: string): Promise<Result<CompanySummary>>

    /**
     * Advisory strength check for the passphrase UI. Never gates anything — see
     * ARCHITECTURE §6.3.1 for why refusing a passphrase is not an option here.
     */
    checkPassphrase(passphrase: string): Promise<Result<PassphraseStrength>>
  }
}

/** Every group name in the API. Used by the main-process handler registry. */
export type ApiGroup = keyof CofferApi

/** A channel name, e.g. 'companies:open'. */
export type ChannelName = string

export function toChannelName(group: string, method: string): ChannelName {
  return `${group}:${method}`
}

/**
 * Build a renderer-side proxy over `invoke`, so that a call to `api.companies.list()`
 * is dispatched to the channel 'companies:list'.
 *
 * Two levels of Proxy: the outer resolves the group, the inner resolves the method and
 * returns the calling function. Nothing is enumerated ahead of time, so adding a method
 * to `CofferApi` is genuinely the only change required.
 */
export function createApiProxy(
  invoke: (channel: ChannelName, ...args: unknown[]) => Promise<unknown>,
): CofferApi {
  return new Proxy({} as CofferApi, {
    get(_target, group: string) {
      return new Proxy(
        {},
        {
          get(_inner, method: string) {
            return (...args: unknown[]) => invoke(toChannelName(group, method), ...args)
          },
        },
      )
    },
  })
}
