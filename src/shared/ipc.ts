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
  AgedReport,
  AgedReportInput,
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
  CreateDocumentInput,
  CreateJournalEntryInput,
  DateRangeInput,
  DayBook,
  Document,
  DocumentSummary,
  CancelDocumentInput,
  IssueDocumentInput,
  ListDocumentsInput,
  UpdateDocumentInput,
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
  RegimeDescription,
  AllocateReceiptInput,
  CancelReceiptInput,
  CreateReceiptInput,
  DocumentSettlement,
  ListReceiptsInput,
  OpenDocument,
  OpenDocumentsInput,
  Receipt,
  ReceiptSummary,
  ReverseEntryInput,
  SetOffsetsInput,
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
   * Trade documents of the open company's books — quotations, invoices, credit notes,
   * purchase bills, debit notes. One group, because they are one table with a `kind`.
   *
   * WHAT A LINE CARRIES, AND WHAT IT MUST NOT. A line is what the user typed: quantity,
   * price, discount, the rate slab they chose. It carries no taxable amount and no tax
   * components, because the renderer never computes money (CONVENTIONS §1.7) and which
   * components a supply attracts is the regime's answer. The service asks, once, with the
   * company profile as the supplier and the party as the customer — so a document cannot
   * be created until the company profile exists (`COMPANY_PROFILE_MISSING`).
   *
   * `create` and `update` reach only a draft. `issue` is the one call that allocates the
   * number and posts the entry, in one transaction; `cancel` reverses what was posted and
   * keeps the number. `delete` is for a draft nobody meant to start, and never for an
   * issued document — see the four rules in src/main/domain/documents/types.ts.
   */
  documents: {
    list(input?: ListDocumentsInput): Promise<Result<DocumentSummary[]>>
    get(id: string): Promise<Result<Document | null>>
    /** Place of supply absent means "whatever the regime says". Supplying it overrides. */
    create(input: CreateDocumentInput): Promise<Result<Document>>
    /**
     * A change to a draft. Absent means "leave it"; `lines` replaces the whole set.
     *
     * Changing the party, the date or the place of supply re-asks the regime for EVERY
     * line, not only the ones that arrived — moving an invoice to a customer in another
     * state turns CGST+SGST into IGST without a line being edited.
     */
    update(input: UpdateDocumentInput): Promise<Result<Document>>
    /** A draft only. An issued document is cancelled, never removed. */
    delete(id: string): Promise<Result<void>>
    /** Allocates the number and posts the entry. One transaction, or none of it. */
    issue(input: IssueDocumentInput): Promise<Result<Document>>
    /** Reverses what it posted, keeps the number, keeps the lines. */
    cancel(input: CancelDocumentInput): Promise<Result<Document>>
    /**
     * What has settled one document, from both sources, and what is left.
     *
     * IT WAS `receipts.settlement` UNTIL 0016 AND HAD OUTGROWN THE GROUP. It takes a
     * document id, answers about a document, and half of what it now returns — the
     * offsets — has no receipt anywhere near it. It lived there because receipts were the
     * only thing that settled anything, which stopped being true the moment a credit note
     * could be set against an invoice.
     */
    settlement(documentId: string): Promise<Result<DocumentSettlement>>
    /**
     * Replace what one refund document settles. The whole set; an empty list clears it.
     *
     * Set from the CREDIT NOTE and never from the invoice — see `SetOffsetsInput` for why
     * one end has to own the set. Nothing about this posts, so it is allowed in a closed
     * period: saying in July which invoice an April note settled changes no figure in
     * April.
     */
    offset(input: SetOffsetsInput): Promise<Result<DocumentSettlement>>
    /** The charge documents this refund document may be set against, oldest first. */
    openForOffset(documentId: string): Promise<Result<OpenDocument[]>>
  }

  /**
   * Money received from a customer, money paid to a vendor, and what it settles.
   *
   * THERE IS NO `issue` AND NO `delete`, and both absences are the contract rather than
   * an oversight. A receipt records money that has ALREADY MOVED, so it posts the moment
   * it is created — there is no draft to issue — and a number handed out is never
   * released, so there is nothing to delete either. `cancel` reverses the entry and keeps
   * the number, exactly as it does for an issued invoice.
   *
   * `allocate` IS THE ONE THING ABOUT A POSTED RECEIPT THAT MAY STILL CHANGE, and that is
   * consistent rather than a hole in the freeze: an allocation moves no money and writes
   * no entry. It says which invoices this money pays, and a business changes its mind
   * about that without anything in the ledger being wrong.
   *
   * It replaces the WHOLE set. An empty list un-allocates everything, which is how money
   * goes back on account.
   */
  receipts: {
    list(input?: ListReceiptsInput): Promise<Result<ReceiptSummary[]>>
    get(id: string): Promise<Result<Receipt | null>>
    /** Numbers it, posts it and stores it, in one transaction or none of it. */
    create(input: CreateReceiptInput): Promise<Result<Receipt>>
    /** Replaces what it settles. An empty list puts the money back on account. */
    allocate(input: AllocateReceiptInput): Promise<Result<Receipt>>
    /** Reverses the entry, drops what it settled, keeps the number. */
    cancel(input: CancelReceiptInput): Promise<Result<Receipt>>
    /**
     * A party's documents with something still against them, oldest first.
     *
     * It stays here where `settlement` moved to `documents`, and the difference is what
     * the argument is: this one takes a `ReceiptKind` and answers "what may THIS VOUCHER
     * settle", which is a question about the voucher being written. The offset picker is
     * `documents.openForOffset`, because there the thing doing the settling is a document.
     */
    open(input: OpenDocumentsInput): Promise<Result<OpenDocument[]>>
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
   * What rules these books run under — the tax regime, as data.
   *
   * ONE METHOD, AND IT IS A NOUN. `describe` rather than `get` because what comes back is
   * not the regime: `TaxRegime` has `computeTax` and `placeOfSupply` on it, and neither
   * crosses this boundary — a description cannot be asked a question. That is what keeps
   * CONVENTIONS §1.6 true with the renderer now knowing which rates exist and which
   * jurisdictions there are. It has the lists; it still has no way to work out a tax, and
   * src/main/documents/service.ts remains the only caller of `computeTax` anywhere.
   *
   * The answer is fixed for as long as the company is open — the regime is read off the
   * file when it opens and cannot change under it — so a screen fetches this once and
   * holds it, rather than calling it per row. See `RegimeDescription` in ./dto.ts for
   * what is in it, what is deliberately not, and why a number format arriving here is
   * not a licence to do arithmetic.
   */
  regime: {
    describe(): Promise<Result<RegimeDescription>>
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
    /**
     * What a control account is made of as at a date, by party and by age.
     *
     * AS AT, in the ledger's sense: entries dated after the day are not in it, so a
     * report run for the end of last month is what last month looked like rather than
     * today's rows wearing last month's heading.
     *
     * It carries the money sitting ON ACCOUNT as well as the charges — unallocated
     * receipts and credit notes — because without them the page would disagree with the
     * balance sheet by exactly the amount a customer has already sent. `ties` says
     * whether it does agree, and `controlBalance` is the figure it is agreeing with.
     */
    aged(input: AgedReportInput): Promise<Result<AgedReport>>
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
