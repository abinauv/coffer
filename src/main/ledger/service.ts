/*
 * The ledger service — one method per method in the `ledger` group of src/shared/ipc.ts.
 *
 * The same shape as `CompanyService`: handlers should be a line each, and everything
 * this module offers beyond the contract is its own business. What it adds over calling
 * the repositories directly is the two things a repository has no business knowing —
 * which database is open, and which regime these books were set up under — and both of
 * those now live in `OpenBooks`, because parties, items and documents need them too.
 * Read ../books/open-books.ts for why that is one object rather than four copies.
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

import type { CofferDb } from '../db/kysely'
import { OpenBooks, type OpenCompanyHandle } from '../books/open-books'
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

export type { OpenCompanyHandle } from '../books/open-books'

export class LedgerService {
  private readonly books: OpenBooks

  constructor(companies: OpenCompanyHandle) {
    this.books = new OpenBooks(companies)
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
      rule: this.books.regime().fiscalYear,
      startYear: input.startYear,
    })
  }

  // ---- Internals ----------------------------------------------------------

  /** The open company's books. @throws CompanyError `NO_COMPANY_OPEN` */
  private db(): CofferDb {
    return this.books.db()
  }
}

export function createLedgerService(companies: OpenCompanyHandle): LedgerService {
  return new LedgerService(companies)
}
