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
  Account,
  AccountingPeriod,
  AppInfo,
  BackupInput,
  BackupResult,
  ChangePassphraseInput,
  CloseFiscalYearInput,
  CompanySummary,
  CreateAccountInput,
  CreateCompanyInput,
  CreateJournalEntryInput,
  DateRangeInput,
  JournalEntry,
  ListAccountsInput,
  ListJournalEntriesInput,
  OpenCompanyInput,
  OpenCompanyResult,
  PassphraseStrength,
  PostOpeningBalancesInput,
  PostingResult,
  RecoverCompanyInput,
  RestoreInput,
  Result,
  ReverseEntryInput,
  SetAccountRoleInput,
  TitleBarOverlayColors,
  TrialBalance,
  UpdateAccountInput,
  YearEndCloseResult,
} from './dto'

export interface CofferApi {
  system: {
    getAppInfo(): Promise<Result<AppInfo>>
    /** Native directory picker. Returns null when the user cancels. */
    chooseDirectory(): Promise<Result<string | null>>
    /** Native file picker for a backup archive. Null when cancelled. */
    chooseBackupArchive(): Promise<Result<string | null>>
    /**
     * Native picker for an existing company database, filtered on the company file
     * extension. Null when cancelled.
     *
     * Without this there is no sanctioned way for the renderer to obtain the path
     * `companies.addExisting` requires — the method existed with no way to call it.
     */
    chooseCompanyFile(): Promise<Result<string | null>>
    /** Reveal a path in Explorer/Finder/the file manager. */
    revealInFileManager(path: string): Promise<Result<void>>
    /**
     * Repaint the OS-drawn window buttons to match the current theme.
     *
     * On Windows and Linux the buttons are drawn by the OS over our title bar, from
     * colours fixed at window creation — so without this they stay in light-mode
     * colours when the user switches to dark. A no-op on macOS, where the traffic
     * lights follow the system appearance on their own.
     */
    setTitleBarOverlay(colors: TitleBarOverlayColors): Promise<Result<void>>
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

  /**
   * The books of the open company.
   *
   * Every method here needs one, and fails with `NO_COMPANY_OPEN` when there is none —
   * there is no company id in any signature, because a company is a whole database file
   * rather than a tenant row (ARCHITECTURE §6.3).
   *
   * Read the five invariants at the top of src/main/domain/ledger/types.ts before adding
   * anything. In particular: there is no `updateEntry` and no `deleteEntry`, and there
   * never will be — a posted entry is corrected by `reverseEntry` and nothing else.
   */
  ledger: {
    listAccounts(input?: ListAccountsInput): Promise<Result<Account[]>>
    createAccount(input: CreateAccountInput): Promise<Result<Account>>
    /** No `type` field: an account's type may not change once it exists. */
    updateAccount(input: UpdateAccountInput): Promise<Result<Account>>
    /** Point a semantic slot at an account, replacing whatever filled it. */
    setAccountRole(input: SetAccountRoleInput): Promise<Result<void>>

    listPeriods(): Promise<Result<AccountingPeriod[]>>
    closePeriod(id: string): Promise<Result<AccountingPeriod>>
    reopenPeriod(id: string): Promise<Result<AccountingPeriod>>
    /** Final. A locked period never reopens — see `PeriodStatus`. */
    lockPeriod(id: string): Promise<Result<AccountingPeriod>>

    postEntry(input: CreateJournalEntryInput): Promise<Result<PostingResult>>
    /** The only way to correct a posted entry. Writes a new, mirrored one. */
    reverseEntry(input: ReverseEntryInput): Promise<Result<PostingResult>>
    listEntries(input?: ListJournalEntriesInput): Promise<Result<JournalEntry[]>>
    getEntry(id: string): Promise<Result<JournalEntry | null>>

    /** Summed from the lines every time. Nothing is cached — invariant 4. */
    trialBalance(input?: DateRangeInput): Promise<Result<TrialBalance>>
    postOpeningBalances(input: PostOpeningBalancesInput): Promise<Result<PostingResult>>
    closeFiscalYear(input: CloseFiscalYearInput): Promise<Result<YearEndCloseResult>>
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
