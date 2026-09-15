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
  ArchiveItemInput,
  AsAtDateInput,
  BalanceSheet,
  BackupInput,
  BackupResult,
  ChangePassphraseInput,
  CheckRegistrationInput,
  CloseFiscalYearInput,
  CompanyProfile,
  CompanySummary,
  CountDocumentsInput,
  CountReceiptsInput,
  CreateAccountInput,
  CreateCompanyInput,
  CreateDocumentInput,
  CreateItemInput,
  CreateJournalEntryInput,
  CreateNumberingSeriesInput,
  CreateUnitInput,
  DateRangeInput,
  DayBook,
  DecimalString,
  Document,
  DocumentListRow,
  CancelDocumentInput,
  IssueDocumentInput,
  Item,
  ItemSummary,
  ListDocumentsInput,
  ListItemsInput,
  ListNumberingSeriesInput,
  ListUnitsInput,
  NumberPreview,
  NumberingSeriesRecord,
  UnitOfMeasure,
  UpdateDocumentInput,
  UpdateItemInput,
  UpdateNumberingSeriesInput,
  UpdateUnitInput,
  JournalEntry,
  ArchivePartyInput,
  CreatePartyInput,
  ListAccountsInput,
  ListJournalEntriesInput,
  ListPartiesInput,
  OpenCompanyInput,
  OpenCompanyResult,
  OverviewFigures,
  PassphraseStrength,
  RegistrationCheck,
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

/*
 * THREE INPUT WRAPPERS THAT BELONG IN ./dto.ts AND ARE HERE INSTEAD.
 *
 * `dto.ts` was frozen at Gate 2.0 and other batches are building against it, so this
 * batch may not add to it — the same reason `API_SURFACE` sits under main/ipc rather
 * than beside `toChannelName` below. Move all three to ./dto.ts when it thaws; four
 * files import them from here (the units and numbering services, and their handlers)
 * and each import moves with them.
 *
 * THEY ARE RECORDS RATHER THAN LOOSE ARGUMENTS because a method taking two of the same
 * kind of thing is a method whose call sites can transpose them — which is what
 * `ArchiveItemInput` already says in ./dto.ts for an item.
 *
 * AND `ArchiveUnitInput` IS NOT A COPY OF IT, however identical the pair looks in a
 * diff. A unit is keyed by a CODE and every other master record by an id, and reusing
 * the item type would put the word `id` in front of the one aggregate that has none.
 */

/** Which unit, and which way. A unit is keyed by its code — there is no id. */
export interface ArchiveUnitInput {
  code: string
  archived: boolean
}

/** Which series, and which way. */
export interface ArchiveNumberingSeriesInput {
  id: string
  archived: boolean
}

/**
 * What to preview, and in which year.
 *
 * `fiscalYearLabel` is nullable rather than optional, because "this document is in no
 * fiscal year" is a real answer for a series that neither prints the year nor resets on
 * it — and a series that does either refuses a null with `FISCAL_YEAR_REQUIRED` rather
 * than guessing. An optional field would let a screen forget the year and get a preview
 * of a number that collides with last year's.
 */
export interface PreviewNumberInput {
  seriesId: string
  fiscalYearLabel: string | null
}

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

    /**
     * A registration number put to the regime a new company would follow, for the hint
     * under the create screen's GSTIN box. Needs no open company and refuses nothing; the
     * number is checked again, and decided, when the profile is saved.
     */
    checkRegistration(input: CheckRegistrationInput): Promise<Result<RegistrationCheck>>
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
   * What goes on a document line — products, services and the charges beside them.
   *
   * EVERY FIELD ON AN ITEM IS A DEFAULT FOR A LINE, NEVER A LOOKUP THE LINE PERFORMS
   * LATER. A line stores its own description, price, unit and rate, so repricing an item
   * here, renaming it or archiving it cannot rewrite an invoice already issued — which
   * is why there is no method on this group that touches a document, and why archiving
   * an item is safe on books full of history.
   *
   * `classificationCode` IS PUT TO THE REGIME, on the way in, exactly as a party's
   * registration number is. What a valid HSN or SAC looks like — how many digits, whether
   * a code starting 99 may be four of them — is the regime's business and `db/` may not
   * import one (CONVENTIONS §1.6), so the items service asks before calling and refuses
   * with `ITEM_CLASSIFICATION_INVALID`. What is stored is the code the regime spells back,
   * not the one that was typed: `8471.30` and `8471 30` are the same tariff item, and a
   * code stored with its separators in would never match the schedule again.
   *
   * There is no `price` method and no `stock` method. A valuation is a sum over the stock
   * ledger and belongs with the reports, for the reason a party has no balance here.
   */
  items: {
    list(input?: ListItemsInput): Promise<Result<ItemSummary[]>>
    get(id: string): Promise<Result<Item | null>>
    /** The classification code is checked against the regime and stored as it spells it. */
    create(input: CreateItemInput): Promise<Result<Item>>
    /** Absent means "leave it"; `null` means "clear it". See `UpdateItemInput`. */
    update(input: UpdateItemInput): Promise<Result<Item>>
    /** Archived items reach no picker and no new line. Reversible, unlike `delete`. */
    archive(input: ArchiveItemInput): Promise<Result<Item>>
    /** Refused once it appears on a document. Archive instead. */
    delete(id: string): Promise<Result<void>>
  }

  /**
   * What a quantity is counted in.
   *
   * A GROUP OF ITS OWN RATHER THAN METHODS ON `items`, and the key is the reason: a unit
   * has no surrogate id — its CODE is its identity, so `get`, `archive` and `delete` all
   * take a code where every other master record takes an id, and one service per group
   * (ARCHITECTURE §5) is what keeps that difference visible instead of buried in an
   * argument name. `companyProfile` is the precedent that a small group is a fine thing.
   *
   * THE CODE IS NORMALISED — trimmed and upper-cased — before it touches the database, on
   * the way in AND on the way to a lookup, so `kg` typed into a picker finds `KG`. SQLite's
   * TEXT primary key is case-sensitive and so is the foreign key from an item, so this is
   * not tidying: without it an item saved against `kg` cannot be attached to `KG` at all.
   *
   * `update` TAKES NO NEW CODE. It is the identity, it is what every item referring to the
   * unit stores, and it is printed on every document already issued. A business that meant
   * `KG` instead of `KGS` creates the second one and moves its items across, which is a
   * decision somebody makes rather than a rename that rewrites what old paperwork said.
   *
   * NOTHING HERE RESTRICTS A BUSINESS TO A KNOWN LIST. `BUNDLE` and `TIN` are as real as
   * `KGS`. Silently rewriting anything outside a short list to `Nos` is a design this
   * codebase refuses (CONVENTIONS §9).
   */
  units: {
    list(input?: ListUnitsInput): Promise<Result<UnitOfMeasure[]>>
    /** By code, normalised first — `kg` finds `KG`. Null when there is no such unit. */
    get(code: string): Promise<Result<UnitOfMeasure | null>>
    create(input: CreateUnitInput): Promise<Result<UnitOfMeasure>>
    /** No `code` to change: it is the identity. See the note above. */
    update(input: UpdateUnitInput): Promise<Result<UnitOfMeasure>>
    /** Archived units reach no picker. Reversible, unlike `delete`. */
    archive(input: ArchiveUnitInput): Promise<Result<UnitOfMeasure>>
    /** Refused once an item is measured in it. Archive instead. */
    delete(code: string): Promise<Result<void>>
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
    list(input?: ListDocumentsInput): Promise<Result<DocumentListRow[]>>
    /** How many the same filters match, for a register's "of 184". Built from the same query. */
    count(input?: CountDocumentsInput): Promise<Result<number>>
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
    /** How many the same filters match. See `documents.count`. */
    count(input?: CountReceiptsInput): Promise<Result<number>>
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
   * How a document's number is built, and which series a new one takes.
   *
   * EVERY PART OF THE SHAPE IS DATA — prefix, separator, whether the fiscal year sits in
   * the middle, how wide the sequence is padded, whether it restarts in April — because
   * the shape is the business's own and matching the series they already use is the first
   * thing anybody leaving another system asks for.
   *
   * THERE IS NO `allocate` AND THERE WILL NOT BE. A number is spent by issuing a document
   * (`documents.issue`) or by recording a receipt, inside the same transaction that posts
   * the entry, and it is never released: a released number is a gap in a series that rule
   * 46(b) requires to be consecutive, and the cost of it is a conversation with an officer
   * about an invoice nobody can produce. `preview` is the read-only half — it says what
   * the series would produce next and spends nothing.
   *
   * A SERIES THAT HAS NUMBERED SOMETHING DOES NOT CHANGE SHAPE. `update` still takes the
   * shape fields, because a settings screen posts the whole record back and re-sending the
   * prefix a series already has is not a change to it; changing one is refused with
   * `SERIES_IN_USE`. What stays editable is the label, the default flag and the archive
   * flag, which is what the business actually needs after it has started issuing.
   *
   * `seedDefaults` IS A REPAIR, AND IT EXISTS BECAUSE OF A DATE. The nine default series
   * are written by `setUpBooks`, which runs once, when a company file is created — so a
   * file made before migration 0012 has NO series at all and cannot issue anything, and a
   * file made before 0015 is missing the `refund` and `refund-received` series and cannot
   * record either. Neither had any in-app repair. This is it, and it has nothing to decide:
   * the seed table is total over the numbered kinds and skips every kind that already has a
   * series, so running it on books somebody has already configured adds nothing, takes
   * nothing away, and moves no counter.
   */
  numbering: {
    list(input?: ListNumberingSeriesInput): Promise<Result<NumberingSeriesRecord[]>>
    get(id: string): Promise<Result<NumberingSeriesRecord | null>>
    /** The first series a kind gets is its default, unless the caller says otherwise. */
    create(input: CreateNumberingSeriesInput): Promise<Result<NumberingSeriesRecord>>
    /** No `kind`: moving a series would renumber what it has already issued. */
    update(input: UpdateNumberingSeriesInput): Promise<Result<NumberingSeriesRecord>>
    /** An archived series numbers nothing new and holds no default. Reversible. */
    archive(input: ArchiveNumberingSeriesInput): Promise<Result<NumberingSeriesRecord>>
    /** Refused once it has handed out a number. Archive instead. */
    delete(id: string): Promise<Result<void>>
    /** What the series would produce next. Spends nothing and moves no counter. */
    preview(input: PreviewNumberInput): Promise<Result<NumberPreview>>
    /**
     * Give every numbered kind a series it does not already have.
     *
     * Answers HOW MANY were created, so a settings screen can say what it did rather than
     * claiming success over a no-op. Zero is the ordinary answer on books that are already
     * complete, and it is not a failure.
     */
    seedDefaults(): Promise<Result<number>>
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
    /**
     * A figure in the regime's own words: 'Rupees One Lakh Fifty Three Thousand Four Hundred
     * Only'. It spells an amount main already computed and decides nothing about it.
     */
    amountInWords(amount: DecimalString): Promise<Result<string>>
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
    /**
     * Cash and bank as at a date, and the month so far — the Overview's two figures that
     * are not an aged report's. Main decides which accounts count as cash and bank and says
     * which it counted.
     */
    overviewFigures(input: AsAtDateInput): Promise<Result<OverviewFigures>>
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
