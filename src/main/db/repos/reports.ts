/*
 * The statements: balance sheet, profit and loss, an account's ledger, and the day book.
 *
 * This file fetches and assembles. Every decision about the shape of a statement lives
 * in `domain/reports`, and every figure is summed from `journal_lines` at the moment it
 * is asked for — nothing here reads a stored total, because there are none (invariant 4).
 *
 * ---------------------------------------------------------------------------
 * ONE QUERY FOR THE SUMS, NOT ONE PER ACCOUNT
 *
 * `subtreeBalance` answers for a single root and re-reads the whole chart to do it. A
 * balance sheet wants a total against every group at once, so these load the sums for
 * every account once and roll them up in memory. On a forty-account chart the difference
 * is not performance, it is that the alternative walks the ledger once per group and the
 * totals could be computed from different snapshots.
 *
 * ---------------------------------------------------------------------------
 * ARCHIVED ACCOUNTS ARE IN EVERY REPORT
 *
 * Archiving hides an account from pickers so nobody posts to it again. It says nothing
 * about the money already in it. An archived account carrying a balance appears on the
 * balance sheet, because a statement that left it out would not add up — and the figure
 * it omitted would be the one the user had already stopped thinking about.
 */

import { D, ZERO, toMoneyString, type Decimal } from '@main/domain/money'
import { normalBalanceOf, signedEffect, type AccountType } from '@main/domain/ledger'
import {
  buildReportTree,
  contraLabel,
  profitInEquity,
  runningLedger,
  type LedgerMovement,
  type ReportAccount,
  type ReportLine as DomainReportLine,
  type ReportTree,
} from '@main/domain/reports'

import type {
  AccountLedger,
  AccountLedgerInput,
  BalanceSheet,
  DateString,
  DayBook,
  DayBookDay,
  ProfitAndLoss,
  ReportSection,
} from '@shared/dto'

import type { CofferDb } from '../kysely'
import { fromPaise, paiseSum } from './balances'
import { RepoError } from './errors'
import { listEntries, type ListEntriesOptions } from './journal'

/** Paise as exact integers. Never `REAL` — the reasoning is at the top of balances.ts. */
const PAISE_DEBIT = paiseSum('journal_lines.debit')
const PAISE_CREDIT = paiseSum('journal_lines.credit')

export interface ReportRangeOptions {
  fromDate?: DateString
  toDate?: DateString
}

// ---- The balance sheet -----------------------------------------------------

/**
 * Assets, liabilities and equity as at a date, with the unclosed profit inside equity.
 *
 * Cumulative from inception — there is no `fromDate`, and offering one would invite a
 * balance sheet "for April", which is not a thing. What a business owns on 30 April is
 * everything it ever acquired less everything it ever disposed of.
 */
export async function balanceSheet(db: CofferDb, asAtDate: DateString): Promise<BalanceSheet> {
  const [accounts, balances] = await Promise.all([
    reportAccounts(db),
    signedBalances(db, { toDate: asAtDate }),
  ])

  const assets = section(accounts, balances, 'asset')
  const liabilities = section(accounts, balances, 'liability')
  const equity = section(accounts, balances, 'equity')

  const income = buildReportTree(accounts, balances, { types: ['income'] }).total
  const expenses = buildReportTree(accounts, balances, { types: ['expense'] }).total
  const profit = profitInEquity(income, expenses)

  const totalAssets = assets.total
  const totalOther = liabilities.total.plus(equity.total).plus(profit)

  return {
    asAtDate,
    assets: toSection('asset', assets),
    liabilities: toSection('liability', liabilities),
    equity: toSection('equity', equity),
    profitForPeriod: toMoneyString(profit),
    totalAssets: toMoneyString(totalAssets),
    totalLiabilitiesAndEquity: toMoneyString(totalOther),
    balanced: totalAssets.equals(totalOther),
  }
}

// ---- The profit and loss ---------------------------------------------------

/**
 * Income and expenses over a range, and what is left.
 *
 * Unlike the balance sheet this one is genuinely a period report, so the range is the
 * point rather than a convenience. With no range it covers the books from inception,
 * which after a year-end close means the current year — the closed years have been moved
 * out of these accounts and into retained earnings.
 */
export async function profitAndLoss(
  db: CofferDb,
  options: ReportRangeOptions = {},
): Promise<ProfitAndLoss> {
  const [accounts, balances] = await Promise.all([reportAccounts(db), signedBalances(db, options)])

  const income = section(accounts, balances, 'income')
  const expenses = section(accounts, balances, 'expense')

  return {
    fromDate: options.fromDate ?? null,
    toDate: options.toDate ?? null,
    income: toSection('income', income),
    expenses: toSection('expense', expenses),
    totalIncome: toMoneyString(income.total),
    totalExpenses: toMoneyString(expenses.total),
    netProfit: toMoneyString(profitInEquity(income.total, expenses.total)),
  }
}

// ---- One account's ledger --------------------------------------------------

/**
 * Every movement against one account in a range, with the balance after each.
 *
 * Refuses a group for the same reason `accountBalance` does: a group holds no figures of
 * its own, so its ledger would be empty while its children's was not — which reads as
 * "nothing happened here" rather than as "you asked the wrong account".
 */
export async function accountLedger(
  db: CofferDb,
  input: AccountLedgerInput,
): Promise<AccountLedger> {
  const account = await db
    .selectFrom('accounts')
    .select(['id', 'code', 'name', 'type', 'is_group'])
    .where('id', '=', input.accountId)
    .executeTakeFirst()

  if (account === undefined) {
    throw new RepoError('ACCOUNT_NOT_FOUND', 'That account is not in this chart of accounts.', {
      accountId: input.accountId,
    })
  }
  if (account.is_group === 1) {
    throw new RepoError(
      'ACCOUNT_IS_GROUP',
      'A group holds no figures of its own. Open one of the accounts inside it.',
      { accountId: account.id, code: account.code },
    )
  }

  const type = account.type as AccountType
  const opening =
    input.fromDate === undefined ? ZERO : await balanceBefore(db, account.id, type, input.fromDate)

  const movements = await movementsOf(db, account.id, input)
  const ledger = runningLedger(type, opening, movements)

  return {
    accountId: account.id,
    code: account.code,
    name: account.name,
    type,
    normalBalance: normalBalanceOf(type),
    fromDate: input.fromDate ?? null,
    toDate: input.toDate ?? null,
    openingBalance: toMoneyString(ledger.openingBalance),
    rows: ledger.rows.map((row) => ({
      entryId: row.entryId,
      entryNumber: row.entryNumber,
      date: row.date,
      narration: row.narration,
      contra: contraLabel(row.contraAccounts),
      debit: toMoneyString(row.debit),
      credit: toMoneyString(row.credit),
      balance: toMoneyString(row.balance),
    })),
    totalDebit: toMoneyString(ledger.totalDebit),
    totalCredit: toMoneyString(ledger.totalCredit),
    closingBalance: toMoneyString(ledger.closingBalance),
  }
}

// ---- The day book ----------------------------------------------------------

/**
 * Every entry in a range, grouped by the day it belongs to.
 *
 * The daily total is computed here rather than in the renderer, because the renderer
 * does not do money arithmetic (CONVENTIONS §1.7) — and a column of figures totalled by
 * whoever happened to be drawing it is how two parts of one screen come to disagree.
 */
export async function dayBook(db: CofferDb, options: ReportRangeOptions = {}): Promise<DayBook> {
  const listOptions: ListEntriesOptions = {}
  if (options.fromDate !== undefined) listOptions.fromDate = options.fromDate
  if (options.toDate !== undefined) listOptions.toDate = options.toDate

  const entries = await listEntries(db, listOptions)

  const days: DayBookDay[] = []
  let total: Decimal = ZERO

  for (const entry of entries) {
    const amount = D(entry.total)
    total = total.plus(amount)

    /* `listEntries` returns date order, so a new date always starts a new day and the
     * last one is always the day being filled. */
    const current = days.at(-1)
    if (current !== undefined && current.date === entry.date) {
      current.entries.push(entry)
      current.total = toMoneyString(D(current.total).plus(amount))
    } else {
      days.push({ date: entry.date, entries: [entry], total: toMoneyString(amount) })
    }
  }

  return {
    fromDate: options.fromDate ?? null,
    toDate: options.toDate ?? null,
    days,
    entryCount: entries.length,
    total: toMoneyString(total),
  }
}

// ---- Shared plumbing -------------------------------------------------------

function section(
  accounts: readonly ReportAccount[],
  balances: ReadonlyMap<string, Decimal>,
  type: AccountType,
): ReportTree {
  return buildReportTree(accounts, balances, { types: [type] })
}

function toSection(type: AccountType, tree: ReportTree): ReportSection {
  return {
    type,
    lines: tree.lines.map(toReportLine),
    total: toMoneyString(tree.total),
  }
}

function toReportLine(line: DomainReportLine): ReportSection['lines'][number] {
  return {
    accountId: line.accountId,
    code: line.code,
    name: line.name,
    depth: line.depth,
    isGroup: line.isGroup,
    amount: toMoneyString(line.amount),
  }
}

/** The whole chart, archived accounts included — see the note at the top. */
async function reportAccounts(db: CofferDb): Promise<ReportAccount[]> {
  const rows = await db
    .selectFrom('accounts')
    .select(['id', 'code', 'name', 'type', 'parent_id', 'is_group'])
    .execute()

  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type as AccountType,
    parentId: row.parent_id,
    isGroup: row.is_group === 1,
  }))
}

/** Every account's balance in the range, signed in its own normal direction. */
async function signedBalances(
  db: CofferDb,
  options: ReportRangeOptions,
): Promise<Map<string, Decimal>> {
  let query = db
    .selectFrom('journal_lines')
    .innerJoin('journal_entries', 'journal_entries.id', 'journal_lines.entry_id')
    .innerJoin('accounts', 'accounts.id', 'journal_lines.account_id')
    .select([
      'accounts.id as id',
      'accounts.type as type',
      PAISE_DEBIT.as('debitPaise'),
      PAISE_CREDIT.as('creditPaise'),
    ])
    .groupBy(['accounts.id', 'accounts.type'])

  if (options.fromDate !== undefined) {
    query = query.where('journal_entries.entry_date', '>=', options.fromDate)
  }
  if (options.toDate !== undefined) {
    query = query.where('journal_entries.entry_date', '<=', options.toDate)
  }

  const rows = await query.execute()
  const balances = new Map<string, Decimal>()
  for (const row of rows) {
    balances.set(
      row.id,
      signedEffect(row.type as AccountType, fromPaise(row.debitPaise), fromPaise(row.creditPaise)),
    )
  }
  return balances
}

/**
 * What one account held immediately before a date.
 *
 * A strict `<`, which is what makes the opening balance and the first row's date not
 * overlap. `<=` would count the range's first day twice — once into the opening figure
 * and again as a row — and the ledger would be out by exactly that day from its first
 * line onwards.
 */
async function balanceBefore(
  db: CofferDb,
  accountId: string,
  type: AccountType,
  date: DateString,
): Promise<Decimal> {
  const row = await db
    .selectFrom('journal_lines')
    .innerJoin('journal_entries', 'journal_entries.id', 'journal_lines.entry_id')
    .select([PAISE_DEBIT.as('debitPaise'), PAISE_CREDIT.as('creditPaise')])
    .where('journal_lines.account_id', '=', accountId)
    .where('journal_entries.entry_date', '<', date)
    .executeTakeFirst()

  return signedEffect(type, fromPaise(row?.debitPaise ?? 0), fromPaise(row?.creditPaise ?? 0))
}

/**
 * The account's own lines in the range, each with the names of the accounts opposite.
 *
 * Two queries rather than one join returning a row per pair: an entry with six lines
 * would otherwise multiply out, and the amounts would be summed from the duplicated rows
 * by anything that trusted them.
 */
async function movementsOf(
  db: CofferDb,
  accountId: string,
  input: AccountLedgerInput,
): Promise<LedgerMovement[]> {
  let query = db
    .selectFrom('journal_lines')
    .innerJoin('journal_entries', 'journal_entries.id', 'journal_lines.entry_id')
    .select([
      'journal_entries.id as entryId',
      'journal_entries.entry_number as entryNumber',
      'journal_entries.entry_date as date',
      'journal_entries.narration as entryNarration',
      'journal_lines.narration as lineNarration',
      'journal_lines.debit as debit',
      'journal_lines.credit as credit',
    ])
    .where('journal_lines.account_id', '=', accountId)

  if (input.fromDate !== undefined) {
    query = query.where('journal_entries.entry_date', '>=', input.fromDate)
  }
  if (input.toDate !== undefined) {
    query = query.where('journal_entries.entry_date', '<=', input.toDate)
  }

  const rows = await query
    .orderBy('journal_entries.entry_date')
    .orderBy('journal_entries.entry_number')
    .orderBy('journal_lines.line_number')
    .execute()

  if (rows.length === 0) return []

  const contra = await contraAccountsOf(db, accountId, [...new Set(rows.map((row) => row.entryId))])

  return rows.map((row) => ({
    entryId: row.entryId,
    entryNumber: row.entryNumber,
    date: row.date,
    /* The line's own narration when it has one: it is the more specific of the two, and
     * the entry's narration is already on the entry the row links to. */
    narration: row.lineNarration ?? row.entryNarration,
    debit: D(row.debit),
    credit: D(row.credit),
    contraAccounts: contra.get(row.entryId) ?? [],
  }))
}

/** The names of the other accounts in each entry, in one query for all of them. */
async function contraAccountsOf(
  db: CofferDb,
  accountId: string,
  entryIds: readonly string[],
): Promise<Map<string, string[]>> {
  const rows = await db
    .selectFrom('journal_lines')
    .innerJoin('accounts', 'accounts.id', 'journal_lines.account_id')
    .select([
      'journal_lines.entry_id as entryId',
      'accounts.name as name',
      'journal_lines.line_number as lineNumber',
    ])
    .where('journal_lines.entry_id', 'in', [...entryIds])
    .where('journal_lines.account_id', '!=', accountId)
    .orderBy('journal_lines.line_number')
    .execute()

  const byEntry = new Map<string, string[]>()
  for (const row of rows) {
    const names = byEntry.get(row.entryId)
    /* Distinct: an entry may touch one account on several lines, and "Bank, Bank" in the
     * particulars column names one thing twice and reads as two. */
    if (names === undefined) byEntry.set(row.entryId, [row.name])
    else if (!names.includes(row.name)) names.push(row.name)
  }
  return byEntry
}
