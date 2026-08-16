/*
 * The ledger service — one method per method in the `ledger` group of src/shared/ipc.ts.
 *
 * The same shape as `CompanyService`: handlers should be a line each, and everything
 * this module offers beyond the contract is its own business. What it adds over calling
 * the repositories directly is the two things a repository has no business knowing:
 *
 *   WHICH DATABASE. Repositories take a `CofferDb`. Exactly one company is open at a
 *   time and it is `CompanyService` that knows which, so this asks for the handle on
 *   every call rather than holding one — a cached handle would outlive a `close()` and
 *   write into a company the user believes they have shut.
 *
 *   WHICH REGIME. The year-end close needs a fiscal-year rule, and the rule belongs to
 *   the regime the company was set up under. That id is in `app_metadata`, written at
 *   creation, so it is read from the file rather than assumed — a build with a different
 *   default must not close a year on the wrong dates.
 *
 * The Kysely wrapper is memoised per connection, not per call. It is a type layer over
 * the handle rather than a second connection (see db/kysely.ts), so rebuilding it every
 * call would be waste; keying the cache on the handle is what makes it correct across a
 * close and reopen.
 */

import type {
  Account,
  AccountLedger,
  AccountLedgerInput,
  AccountingPeriod,
  AsAtDateInput,
  BalanceSheet,
  CloseFiscalYearInput,
  CreateAccountInput,
  CreateJournalEntryInput,
  DateRangeInput,
  DayBook,
  JournalEntry,
  ListAccountsInput,
  ListJournalEntriesInput,
  PostOpeningBalancesInput,
  PostingResult,
  ProfitAndLoss,
  ReverseEntryInput,
  SetAccountRoleInput,
  TrialBalance,
  UpdateAccountInput,
  YearEndCloseResult,
} from '@shared/dto'

import type { SqliteDatabase } from '../db/connection'
import { createQueryBuilder, type CofferDb } from '../db/kysely'
import {
  clearAccountRole,
  createAccount,
  listAccounts,
  setAccountRole,
  updateAccount,
} from '../db/repos/accounts'
import { trialBalance } from '../db/repos/balances'
import { accountLedger, balanceSheet, dayBook, profitAndLoss } from '../db/repos/reports'
import { getEntry, listEntries, postManualEntry, reverseEntry } from '../db/repos/journal'
import { postOpeningBalances } from '../db/repos/opening-balances'
import { closePeriod, listPeriods, lockPeriod, reopenPeriod } from '../db/repos/periods'
import { closeFiscalYear } from '../db/repos/year-end'
import { METADATA_KEYS, readMetadata } from '../companies/metadata'
import { CompanyError } from '../companies/errors'
import { DEFAULT_REGIME_ID, findRegime, type TaxRegime } from '../regimes'

/**
 * What the ledger service needs from the companies module.
 *
 * Deliberately two methods rather than the whole `CompanyService`: the ledger has no
 * business opening, closing or backing up anything.
 */
export interface OpenCompanyHandle {
  /** The open company's database handle, or null when none is open. */
  currentDatabase(): SqliteDatabase | null
}

export class LedgerService {
  private readonly companies: OpenCompanyHandle

  /** Keyed on the handle, so a close and reopen gets a fresh builder. */
  private cached: { connection: SqliteDatabase; db: CofferDb } | null = null

  constructor(companies: OpenCompanyHandle) {
    this.companies = companies
  }

  // ---- Accounts -----------------------------------------------------------

  async listAccounts(input: ListAccountsInput = {}): Promise<Account[]> {
    return listAccounts(this.db(), { includeArchived: input.includeArchived })
  }

  async createAccount(input: CreateAccountInput): Promise<Account> {
    return createAccount(this.db(), input)
  }

  async updateAccount(input: UpdateAccountInput): Promise<Account> {
    return updateAccount(this.db(), input)
  }

  /** An empty account id clears the slot rather than pointing it at nothing. */
  async setAccountRole(input: SetAccountRoleInput): Promise<void> {
    if (input.accountId === '') {
      return clearAccountRole(this.db(), input.role)
    }
    return setAccountRole(this.db(), input.role, input.accountId)
  }

  // ---- Periods ------------------------------------------------------------

  async listPeriods(): Promise<AccountingPeriod[]> {
    return listPeriods(this.db())
  }

  async closePeriod(id: string): Promise<AccountingPeriod> {
    return closePeriod(this.db(), id)
  }

  async reopenPeriod(id: string): Promise<AccountingPeriod> {
    return reopenPeriod(this.db(), id)
  }

  async lockPeriod(id: string): Promise<AccountingPeriod> {
    return lockPeriod(this.db(), id)
  }

  // ---- The journal --------------------------------------------------------

  async postEntry(input: CreateJournalEntryInput): Promise<PostingResult> {
    return postManualEntry(this.db(), input)
  }

  async reverseEntry(input: ReverseEntryInput): Promise<PostingResult> {
    return reverseEntry(this.db(), input)
  }

  async listEntries(input: ListJournalEntriesInput = {}): Promise<JournalEntry[]> {
    return listEntries(this.db(), input)
  }

  async getEntry(id: string): Promise<JournalEntry | null> {
    return getEntry(this.db(), id)
  }

  // ---- Balances and closing -----------------------------------------------

  async trialBalance(input: DateRangeInput = {}): Promise<TrialBalance> {
    return trialBalance(this.db(), input)
  }

  async postOpeningBalances(input: PostOpeningBalancesInput): Promise<PostingResult> {
    return postOpeningBalances(this.db(), input)
  }

  // ---- The statements -------------------------------------------------------

  /*
   * The `reports` IPC group is served from here rather than from a service of its own.
   * The only thing a report service would add is the `db()` seam below — the same
   * fifteen lines, asking the same question of the same `CompanyService` — and two
   * copies of "which company is open" is exactly the kind of duplication that ends with
   * one of them holding a stale handle. The groups stay separate in the contract, where
   * the read-only distinction is worth stating; the plumbing does not.
   */

  async balanceSheet(input: AsAtDateInput): Promise<BalanceSheet> {
    return balanceSheet(this.db(), input.asAtDate)
  }

  async profitAndLoss(input: DateRangeInput = {}): Promise<ProfitAndLoss> {
    return profitAndLoss(this.db(), input)
  }

  async accountLedger(input: AccountLedgerInput): Promise<AccountLedger> {
    return accountLedger(this.db(), input)
  }

  async dayBook(input: DateRangeInput = {}): Promise<DayBook> {
    return dayBook(this.db(), input)
  }

  async closeFiscalYear(input: CloseFiscalYearInput): Promise<YearEndCloseResult> {
    return closeFiscalYear(this.db(), {
      rule: this.regime().fiscalYear,
      startYear: input.startYear,
    })
  }

  // ---- Internals ----------------------------------------------------------

  /**
   * The open company's books.
   *
   * @throws CompanyError `NO_COMPANY_OPEN`
   */
  private db(): CofferDb {
    const connection = this.companies.currentDatabase()
    if (connection === null) {
      throw new CompanyError('NO_COMPANY_OPEN', 'Open a company first.')
    }
    if (this.cached?.connection !== connection) {
      this.cached = { connection, db: createQueryBuilder(connection) }
    }
    return this.cached.db
  }

  /**
   * The regime the open company's books were set up under.
   *
   * Read from the file, not from the default. The fiscal periods on disk were generated
   * from this rule; closing a year under a different one would use the wrong dates and
   * produce a plausible, wrong figure.
   */
  private regime(): TaxRegime {
    const connection = this.companies.currentDatabase()
    if (connection === null) {
      throw new CompanyError('NO_COMPANY_OPEN', 'Open a company first.')
    }

    /* Companies created before the regime was recorded fall back to the default, which
     * is what they were necessarily created under — it was the only one. */
    const id = readMetadata(connection, METADATA_KEYS.regimeId) ?? DEFAULT_REGIME_ID
    const regime = findRegime(id)
    if (regime === undefined) {
      throw new CompanyError(
        'COMPANY_REGIME_UNKNOWN',
        `These books were set up under a tax regime called ${JSON.stringify(id)}, which this ` +
          'build does not have. A newer version of Coffer will open them.',
      )
    }
    return regime
  }
}

export function createLedgerService(companies: OpenCompanyHandle): LedgerService {
  return new LedgerService(companies)
}
