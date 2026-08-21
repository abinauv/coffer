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
  AccountLedger,
  AccountLedgerInput,
  AccountingPeriod,
  AppInfo,
  AsAtDateInput,
  BalanceSheet,
  BackupInput,
  BackupResult,
  ChangePassphraseInput,
  CloseFiscalYearInput,
  CompanyProfile,
  CompanySummary,
  CreateAccountInput,
  CreateCompanyInput,
  CreateJournalEntryInput,
  DateRangeInput,
  DayBook,
  JournalEntry,
  ArchivePartyInput,
  CreatePartyInput,
  ListAccountsInput,
  ListJournalEntriesInput,
  ListPartiesInput,
  OpenCompanyInput,
  OpenCompanyResult,
  PassphraseStrength,
  Party,
  PartySummary,
  PostOpeningBalancesInput,
  PostingResult,
  ProfitAndLoss,
  RecoverCompanyInput,
  RestoreInput,
  Result,
  SaveCompanyProfileInput,
  ReverseEntryInput,
  SetAccountRoleInput,
  TitleBarOverlayColors,
  TrialBalance,
  UpdateAccountInput,
  UpdatePartyInput,
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

  /**
   * Customers and vendors, of the open company's books.
   *
   * One group, because they are one table: in a small business the firm you sell to is
   * very often the firm you buy transport from, and `PartyRole` filters a list rather
   * than naming a second kind of record.
   *
   * A party has no balance here, and will not. What they owe is a sum over the journal
   * lines carrying their id, and it belongs with the reports it will be aged alongside —
   * a figure on this group would invite somebody to store it (invariant 4).
   */
  parties: {
    list(input?: ListPartiesInput): Promise<Result<PartySummary[]>>
    get(id: string): Promise<Result<Party | null>>
    /**
     * The registration number is checked against the regime, and where it encodes a
     * jurisdiction that jurisdiction is filled in — a GSTIN's first two digits are the
     * state, and a party's state decides the place of supply.
     */
    create(input: CreatePartyInput): Promise<Result<Party>>
    /** Absent means "leave it"; `null` means "clear it". See `UpdatePartyInput`. */
    update(input: UpdatePartyInput): Promise<Result<Party>>
    /** Archived parties take nothing new. Reversible, unlike `delete`. */
    archive(input: ArchivePartyInput): Promise<Result<Party>>
    /** Refused once anything has been posted against them. Archive instead. */
    delete(id: string): Promise<Result<void>>
  }

  /**
   * Who the open company's books belong to.
   *
   * One profile, because a company is one file — so `get` takes no id and `save` takes no
   * id, and there is nothing to list. `get` answers null until somebody has filled it in,
   * which is a legal state: books with no profile still keep a chart, periods, parties,
   * drafts and a ledger (migration 0011).
   *
   * It is not part of `companies`. That group is the registry — which files exist, where
   * they are, how they are keyed and backed up. This is business data inside one of them.
   */
  companyProfile: {
    get(): Promise<Result<CompanyProfile | null>>
    /**
     * The whole profile. A field left out is a field cleared, unlike `parties.update`.
     *
     * The registration number is checked against the regime and, where it encodes a
     * jurisdiction, that jurisdiction is filled in. A number and a jurisdiction that
     * disagree are refused rather than reconciled: the company's own jurisdiction decides
     * CGST+SGST against IGST on EVERY invoice these books raise, in both directions, and
     * nothing about the documents would look wrong afterwards.
     */
    save(input: SaveCompanyProfileInput): Promise<Result<CompanyProfile>>
  }

  /**
   * The statements, of the open company's books.
   *
   * A separate group from `ledger` because these only ever read. Nothing here can change
   * a figure, and a group whose every method is a question is worth being able to say
   * that about — a `reports:` channel appearing in a log is provably not what altered
   * anyone's books.
   *
   * Every figure arrives as a decimal string, already totalled. The renderer does not do
   * money arithmetic (CONVENTIONS §1.7), so subtotals, group rollups and the running
   * balance are all computed here rather than in the screen that draws them.
   */
  reports: {
    /** Cumulative to the date. There is no `fromDate` — a balance sheet is always as-at. */
    balanceSheet(input: AsAtDateInput): Promise<Result<BalanceSheet>>
    profitAndLoss(input?: DateRangeInput): Promise<Result<ProfitAndLoss>>
    /** One account's movements with a running balance. Refuses a group. */
    accountLedger(input: AccountLedgerInput): Promise<Result<AccountLedger>>
    /** Entries in the range, grouped by day, with each day's total. */
    dayBook(input?: DateRangeInput): Promise<Result<DayBook>>
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
