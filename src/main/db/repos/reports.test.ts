/*
 * The statements, against a real encrypted database with a real seeded chart.
 *
 * The one claim worth more than all the others: **the balance sheet balances**, and it
 * balances because the accounting equation closes rather than because anything here
 * forces it to. Every figure comes from summing `journal_lines`; nothing is stored, and
 * the two sides are computed from different subsets of the same lines. If they agree,
 * the ledger is sound. Several tests below post deliberately awkward things — a loss, an
 * overdrawn bank, a reversal, a year-end close — and check the same equality each time.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DATABASE_KEY_BYTES, closeDatabase, openDatabase, type SqliteDatabase } from '../connection'
import { createQueryBuilder, type CofferDb } from '../kysely'
import { runMigrations } from '../migrate'
import { MIGRATIONS } from '../migrations'
import { aprilToMarch } from '@main/domain/time'
import { D, type Decimal } from '@main/domain/money'
import { MANUAL_SOURCE, type EntryDraft } from '@main/domain/ledger'

import { createParty } from './parties'
import { seedChart } from './seed-chart'
import { createAccount, listAccounts, updateAccount } from './accounts'
import { generateFiscalYear } from './periods'
import { postEntry, reverseEntry } from './journal'
import { closeFiscalYear } from './year-end'
import {
  accountLedger,
  balanceSheet,
  dayBook,
  moneyAccounts,
  overviewFigures,
  profitAndLoss,
} from './reports'
import { isRepoError, type RepoErrorCode } from './errors'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x5e)

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase
let db: CofferDb
let account: Record<string, string>
/** Seeded parties, because a control-account line must name one (0005). */
let customer: string
let vendor: string

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-reports-'))
  directories.push(dir)
  connection = openDatabase({ filePath: join(dir, 'company.coffer'), key: KEY })
  handles.push(connection)
  runMigrations(connection, MIGRATIONS)
  db = createQueryBuilder(connection)

  await seedChart(db)
  await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })
  await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2027 })

  account = {}
  for (const row of await listAccounts(db)) {
    account[row.code] = row.id
  }

  /* Migration 0005 requires a party on any line posting to a control account — money on
   * the balance sheet owed by nobody is a control account that stops agreeing with the
   * parties beneath it. Which party is not what these tests are about; that there is one
   * is now part of what a receivable IS. */
  customer = (await createParty(db, { name: 'Test Customer', countryCode: 'in', isCustomer: true }))
    .id
  vendor = (await createParty(db, { name: 'Test Vendor', countryCode: 'in', isVendor: true })).id
})

afterEach(() => {
  for (const handle of handles.splice(0)) {
    try {
      closeDatabase(handle)
    } catch {
      /* a test may have closed it already */
    }
  }
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

async function codeOf(action: () => Promise<unknown>): Promise<RepoErrorCode | string> {
  try {
    await action()
  } catch (error) {
    return isRepoError(error) ? error.code : `not a RepoError: ${String(error)}`
  }
  return 'no error thrown'
}

/** A two-line entry: debit one account, credit another. */
function entry(
  debitCode: string,
  creditCode: string,
  amount: string,
  date = '2026-04-15',
  narration = 'Test entry',
): EntryDraft {
  return {
    date,
    narration,
    source: MANUAL_SOURCE,
    lines: [
      {
        accountId: account[debitCode]!,
        debit: D(amount),
        credit: D(0),
        partyId: partyFor(debitCode),
      },
      {
        accountId: account[creditCode]!,
        debit: D(0),
        credit: D(amount),
        partyId: partyFor(creditCode),
      },
    ],
  }
}

/**
 * The party a control-account line must name (0005).
 *
 * Keyed by code rather than by looking up the role, because these tests seed the default
 * chart and a hardcoded pair here would go stale silently if the template moved
 * receivables. `1300` and `2100` are the template's control accounts.
 */
function partyFor(code: string): string | null {
  if (code === '1300') return customer
  if (code === '2100') return vendor
  return null
}

const post = (draft: EntryDraft) => postEntry(db, draft)

/** The balance sheet's two sides, for the equality every test below cares about. */
async function sidesOf(asAt = '2027-03-31'): Promise<[string, string, boolean]> {
  const sheet = await balanceSheet(db, asAt)
  return [sheet.totalAssets, sheet.totalLiabilitiesAndEquity, sheet.balanced]
}

function amountAt(section: { lines: { code: string; amount: string }[] }, code: string): string {
  return section.lines.find((line) => line.code === code)?.amount ?? 'absent'
}

// ---- The balance sheet -----------------------------------------------------

describe('balanceSheet', () => {
  it('balances on an empty set of books', async () => {
    const sheet = await balanceSheet(db, '2026-04-30')

    expect(sheet.balanced).toBe(true)
    expect(sheet.totalAssets).toBe('0.00')
    expect(sheet.totalLiabilitiesAndEquity).toBe('0.00')
    expect(sheet.assets.lines).toEqual([])
  })

  it('balances after capital is introduced', async () => {
    await post(entry('1210', '3100', '500000.00', '2026-04-01'))

    const sheet = await balanceSheet(db, '2026-04-30')
    expect(sheet.totalAssets).toBe('500000.00')
    expect(sheet.totalLiabilitiesAndEquity).toBe('500000.00')
    expect(sheet.balanced).toBe(true)
  })

  /*
   * The reason `profitForPeriod` exists. Income and expense are not on a balance sheet,
   * but until a year-end close moves them they are the only thing making the equation
   * close — regrouping every balanced entry by type gives
   * `assets = liabilities + equity + (income - expenses)`.
   */
  it('carries unclosed profit into equity, or it would not balance', async () => {
    await post(entry('1210', '3100', '100000.00', '2026-04-01'))
    await post(entry('1210', '4100', '60000.00', '2026-04-10'))
    await post(entry('6200', '1210', '25000.00', '2026-04-20'))

    const sheet = await balanceSheet(db, '2026-04-30')

    expect(sheet.profitForPeriod).toBe('35000.00')
    expect(sheet.totalAssets).toBe('135000.00')
    expect(sheet.equity.total).toBe('100000.00')
    expect(sheet.totalLiabilitiesAndEquity).toBe('135000.00')
    expect(sheet.balanced).toBe(true)
  })

  it('carries an unclosed loss as a negative, and still balances', async () => {
    await post(entry('1210', '3100', '100000.00', '2026-04-01'))
    await post(entry('6200', '1210', '30000.00', '2026-04-20'))

    const sheet = await balanceSheet(db, '2026-04-30')

    expect(sheet.profitForPeriod).toBe('-30000.00')
    expect(sheet.totalAssets).toBe('70000.00')
    expect(sheet.totalLiabilitiesAndEquity).toBe('70000.00')
    expect(sheet.balanced).toBe(true)
  })

  it('balances with liabilities on the sheet', async () => {
    await post(entry('1210', '3100', '100000.00', '2026-04-01'))
    await post(entry('1400', '2100', '40000.00', '2026-04-05'))

    const sheet = await balanceSheet(db, '2026-04-30')
    expect(sheet.liabilities.total).toBe('40000.00')
    expect(sheet.totalAssets).toBe('140000.00')
    expect(sheet.balanced).toBe(true)
  })

  it('rolls a leaf up into its group', async () => {
    await post(entry('1210', '3100', '250000.00', '2026-04-01'))

    const sheet = await balanceSheet(db, '2026-04-30')
    /* 1210 Bank Account is inside 1200 Bank Accounts, inside 1000 Current Assets. */
    expect(amountAt(sheet.assets, '1210')).toBe('250000.00')
    expect(amountAt(sheet.assets, '1200')).toBe('250000.00')
    expect(amountAt(sheet.assets, '1000')).toBe('250000.00')
  })

  it('leaves out the accounts nothing has been posted to', async () => {
    await post(entry('1210', '3100', '250000.00', '2026-04-01'))

    const sheet = await balanceSheet(db, '2026-04-30')
    /* The seeded chart has thirty-odd accounts; four of them are involved. */
    expect(amountAt(sheet.assets, '1800')).toBe('absent')
    expect(amountAt(sheet.assets, '1100')).toBe('absent')
    expect(sheet.assets.lines.map((line) => line.code)).toEqual(['1000', '1200', '1210'])
  })

  it('is cumulative to the as-at date and excludes what comes after', async () => {
    await post(entry('1210', '3100', '100000.00', '2026-04-01'))
    await post(entry('1210', '4100', '50000.00', '2026-06-15'))

    expect((await balanceSheet(db, '2026-04-30')).totalAssets).toBe('100000.00')
    expect((await balanceSheet(db, '2026-06-30')).totalAssets).toBe('150000.00')
  })

  it('shows an overdrawn bank as a negative asset, not as a liability', async () => {
    await post(entry('1210', '3100', '10000.00', '2026-04-01'))
    await post(entry('6200', '1210', '25000.00', '2026-04-20'))

    const sheet = await balanceSheet(db, '2026-04-30')
    expect(amountAt(sheet.assets, '1210')).toBe('-15000.00')
    expect(sheet.liabilities.lines).toEqual([])
    expect(sheet.balanced).toBe(true)
  })

  it('still balances after an entry is reversed', async () => {
    await post(entry('1210', '3100', '100000.00', '2026-04-01'))
    const sale = await post(entry('1210', '4100', '60000.00', '2026-04-10'))
    await reverseEntry(db, { entryId: sale.entryId, date: '2026-04-11', narration: 'Wrong' })

    const sheet = await balanceSheet(db, '2026-04-30')
    expect(sheet.profitForPeriod).toBe('0.00')
    expect(sheet.totalAssets).toBe('100000.00')
    expect(sheet.balanced).toBe(true)
  })

  /* After the close, the profit is in retained earnings — equity — and not in the
   * `profitForPeriod` line. The sheet must balance identically either way. */
  it('still balances after the year-end close, with the profit moved into equity', async () => {
    await post(entry('1210', '3100', '100000.00', '2026-04-01'))
    await post(entry('1210', '4100', '60000.00', '2026-04-10'))
    await post(entry('6200', '1210', '25000.00', '2026-04-20'))

    const before = await balanceSheet(db, '2027-03-31')
    expect(before.profitForPeriod).toBe('35000.00')

    await closeFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })

    const after = await balanceSheet(db, '2027-03-31')
    expect(after.profitForPeriod).toBe('0.00')
    expect(after.equity.total).toBe('135000.00')
    expect(after.totalAssets).toBe('135000.00')
    expect(after.balanced).toBe(true)
    /* The same books, said two ways. */
    expect(after.totalAssets).toBe(before.totalAssets)
  })

  it('includes an archived account that still holds money', async () => {
    await post(entry('1210', '3100', '100000.00', '2026-04-01'))
    await post(entry('1100', '1210', '5000.00', '2026-04-02'))
    /* The seeded chart gives it a role, and an account the software posts through cannot be
     * archived until the role is let go (accounts.ts, `assertFillsNoRole`). */
    await db.deleteFrom('account_roles').where('account_id', '=', account['1100']!).execute()
    await updateAccount(db, { id: account['1100']!, isArchived: true })

    const sheet = await balanceSheet(db, '2026-04-30')
    /* Archiving hides an account from pickers. It does not remove the money in it, and
     * a sheet that left it out would be short by exactly that. */
    expect(amountAt(sheet.assets, '1100')).toBe('5000.00')
    expect(sheet.balanced).toBe(true)
  })

  /*
   * The one test that can tell `balanced` from a hardcoded `true`.
   *
   * Nothing posted through this application can unbalance the books — three layers
   * refuse it — so every other test here asserts `balanced === true` and would go on
   * passing if the field were a literal. Mutation testing found exactly that. The flag
   * exists for the case where the file has been damaged by something that is not this
   * application, so that is what is staged: the trigger is dropped, a deliberately
   * lopsided entry is written underneath it, and the sheet has to notice.
   *
   * A report that cannot report damage is worse than no report, because it is believed.
   */
  it('says the sheet does not balance when the books have been damaged', async () => {
    await post(entry('1210', '3100', '100000.00', '2026-04-01'))

    const period = await db
      .selectFrom('accounting_periods')
      .select('id')
      .where('start_date', '<=', '2026-04-10')
      .where('end_date', '>=', '2026-04-10')
      .executeTakeFirstOrThrow()

    /*
     * Straight past the repository and past the rule that would refuse this. The
     * BEGIN/COMMIT is load-bearing: the lines reference an entry that does not exist
     * yet, and outside an explicit transaction the deferred foreign key is checked at
     * the end of each statement rather than at commit — the measured finding behind the
     * insert order in migration 0004.
     */
    connection.exec(`DROP TRIGGER journal_entries_must_balance`)
    connection.exec(`
      BEGIN;
      INSERT INTO journal_lines (id, entry_id, line_number, account_id, debit, credit)
      VALUES ('bad-1', 'bad', 1, '${account['1210']}', '5000.00', '0.00'),
             ('bad-2', 'bad', 2, '${account['3100']}', '0.00', '4000.00');
      INSERT INTO journal_entries
        (id, entry_number, entry_date, narration, source_type, period_id, posted_at)
      VALUES ('bad', 'DAMAGED-1', '2026-04-10', 'Damaged', 'manual', '${period.id}',
              '2026-04-10T00:00:00.000Z');
      COMMIT;
    `)

    const sheet = await balanceSheet(db, '2026-04-30')

    expect(sheet.balanced).toBe(false)
    expect(sheet.totalAssets).toBe('105000.00')
    expect(sheet.totalLiabilitiesAndEquity).toBe('104000.00')
    /* And it says so from the figures rather than from a flag someone set. */
    expect(sheet.totalAssets).not.toBe(sheet.totalLiabilitiesAndEquity)
  })

  it('balances across a deep chart with many accounts moving', async () => {
    await post(entry('1210', '3100', '900000.00', '2026-04-01'))
    await post(entry('1400', '2100', '120000.00', '2026-04-02'))
    await post(entry('1300', '4100', '333333.33', '2026-04-03'))
    await post(entry('5100', '2100', '77777.77', '2026-04-04'))
    await post(entry('6200', '1210', '45000.45', '2026-04-05'))
    await post(entry('1810', '2820', '250000.00', '2026-04-06'))
    await post(entry('6100', '2300', '88888.88', '2026-04-07'))

    const [assets, other, balanced] = await sidesOf('2026-04-30')
    expect(balanced).toBe(true)
    expect(assets).toBe(other)
  })
})

// ---- The profit and loss ---------------------------------------------------

describe('profitAndLoss', () => {
  it('is empty for books that have not traded', async () => {
    const statement = await profitAndLoss(db)

    expect(statement.income.lines).toEqual([])
    expect(statement.expenses.lines).toEqual([])
    expect(statement.netProfit).toBe('0.00')
  })

  it('is income less expenses', async () => {
    await post(entry('1210', '4100', '100000.00', '2026-04-10'))
    await post(entry('6200', '1210', '30000.00', '2026-04-20'))
    await post(entry('6100', '1210', '25000.50', '2026-04-25'))

    const statement = await profitAndLoss(db)
    expect(statement.totalIncome).toBe('100000.00')
    expect(statement.totalExpenses).toBe('55000.50')
    expect(statement.netProfit).toBe('44999.50')
  })

  it('reports a loss as a negative figure rather than relabelling it', async () => {
    await post(entry('1210', '4100', '10000.00', '2026-04-10'))
    await post(entry('6200', '1210', '25000.00', '2026-04-20'))

    expect((await profitAndLoss(db)).netProfit).toBe('-15000.00')
  })

  it('covers only the range it was given', async () => {
    await post(entry('1210', '4100', '10000.00', '2026-04-10'))
    await post(entry('1210', '4100', '20000.00', '2026-05-10'))
    await post(entry('1210', '4100', '40000.00', '2026-06-10'))

    const may = await profitAndLoss(db, { fromDate: '2026-05-01', toDate: '2026-05-31' })
    expect(may.totalIncome).toBe('20000.00')
    expect(may.netProfit).toBe('20000.00')
  })

  it('applies each end of the range', async () => {
    await post(entry('1210', '4100', '10000.00', '2026-04-10'))
    await post(entry('1210', '4100', '20000.00', '2026-05-10'))

    expect((await profitAndLoss(db, { fromDate: '2026-05-01' })).totalIncome).toBe('20000.00')
    expect((await profitAndLoss(db, { toDate: '2026-04-30' })).totalIncome).toBe('10000.00')
  })

  it('includes both boundary dates', async () => {
    await post(entry('1210', '4100', '10000.00', '2026-04-01'))
    await post(entry('1210', '4100', '20000.00', '2026-04-30'))

    const april = await profitAndLoss(db, { fromDate: '2026-04-01', toDate: '2026-04-30' })
    expect(april.totalIncome).toBe('30000.00')
  })

  it('rolls expenses up into their groups', async () => {
    await post(entry('6200', '1210', '30000.00', '2026-04-20'))
    await post(entry('6100', '1210', '20000.00', '2026-04-21'))

    const statement = await profitAndLoss(db)
    expect(amountAt(statement.expenses, '6000')).toBe('50000.00')
    expect(amountAt(statement.expenses, '6200')).toBe('30000.00')
  })

  it('reports the range it covered', async () => {
    const statement = await profitAndLoss(db, { fromDate: '2026-04-01', toDate: '2027-03-31' })
    expect(statement.fromDate).toBe('2026-04-01')
    expect(statement.toDate).toBe('2027-03-31')

    const everything = await profitAndLoss(db)
    expect(everything.fromDate).toBeNull()
    expect(everything.toDate).toBeNull()
  })

  /* The two statements are drawn from the same lines and must not disagree. */
  it('agrees with the balance sheet about the profit', async () => {
    await post(entry('1210', '3100', '100000.00', '2026-04-01'))
    await post(entry('1210', '4100', '60000.00', '2026-04-10'))
    await post(entry('6200', '1210', '25000.00', '2026-04-20'))

    const statement = await profitAndLoss(db, { toDate: '2026-04-30' })
    const sheet = await balanceSheet(db, '2026-04-30')
    expect(statement.netProfit).toBe(sheet.profitForPeriod)
  })

  it('reads zero for the year after a close swept it', async () => {
    await post(entry('1210', '4100', '60000.00', '2026-04-10'))
    await closeFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })

    const after = await profitAndLoss(db, { fromDate: '2027-04-01', toDate: '2028-03-31' })
    expect(after.netProfit).toBe('0.00')
  })
})

// ---- One account's ledger --------------------------------------------------

describe('accountLedger', () => {
  it('lists the movements with a running balance', async () => {
    await post(entry('1210', '3100', '100000.00', '2026-04-01'))
    await post(entry('1210', '4100', '25000.00', '2026-04-10'))
    await post(entry('6200', '1210', '30000.00', '2026-04-20'))

    const ledger = await accountLedger(db, { accountId: account['1210']! })

    expect(ledger.rows.map((row) => row.balance)).toEqual(['100000.00', '125000.00', '95000.00'])
    expect(ledger.closingBalance).toBe('95000.00')
    expect(ledger.totalDebit).toBe('125000.00')
    expect(ledger.totalCredit).toBe('30000.00')
  })

  it('names the account on the other side', async () => {
    await post(entry('1210', '3100', '100000.00', '2026-04-01'))

    const ledger = await accountLedger(db, { accountId: account['1210']! })
    expect(ledger.rows[0]?.contra).toBe('Owner’s Capital')
  })

  it('says Split when the entry touched more than two accounts', async () => {
    await postEntry(db, {
      date: '2026-04-10',
      narration: 'Sale with tax',
      source: MANUAL_SOURCE,
      lines: [
        { accountId: account['1210']!, debit: D('11800.00'), credit: D(0) },
        { accountId: account['4100']!, debit: D(0), credit: D('10000.00') },
        { accountId: account['2400']!, debit: D(0), credit: D('1800.00') },
      ],
    })

    const ledger = await accountLedger(db, { accountId: account['1210']! })
    expect(ledger.rows[0]?.contra).toBe('Split')
  })

  /*
   * Without this the closing balance is the range's movement wearing the closing
   * balance's name — which is the single most misleading thing an account ledger can do.
   */
  it('opens with what the account held before the range', async () => {
    await post(entry('1210', '3100', '100000.00', '2026-04-01'))
    await post(entry('1210', '4100', '25000.00', '2026-05-10'))

    const may = await accountLedger(db, {
      accountId: account['1210']!,
      fromDate: '2026-05-01',
      toDate: '2026-05-31',
    })

    expect(may.openingBalance).toBe('100000.00')
    expect(may.rows).toHaveLength(1)
    expect(may.closingBalance).toBe('125000.00')
  })

  it('stops at the end of the range', async () => {
    /* Without an entry beyond `toDate` this passes with the upper bound dropped
     * entirely — the opening-balance test above did, until mutation testing said so. */
    await post(entry('1210', '3100', '100000.00', '2026-04-01'))
    await post(entry('1210', '4100', '25000.00', '2026-05-10'))
    await post(entry('1210', '4100', '99999.00', '2026-06-10'))

    const may = await accountLedger(db, {
      accountId: account['1210']!,
      fromDate: '2026-05-01',
      toDate: '2026-05-31',
    })

    expect(may.rows).toHaveLength(1)
    expect(may.rows[0]?.date).toBe('2026-05-10')
    expect(may.closingBalance).toBe('125000.00')
  })

  it('opens at zero when the range is open at the start', async () => {
    await post(entry('1210', '3100', '100000.00', '2026-04-01'))

    const ledger = await accountLedger(db, { accountId: account['1210']!, toDate: '2026-04-30' })
    expect(ledger.openingBalance).toBe('0.00')
  })

  /* A `<=` here would count the first day into the opening figure and again as a row,
   * putting the ledger out by exactly that day from its first line onward. */
  it('does not count the first day of the range into the opening balance', async () => {
    await post(entry('1210', '3100', '100000.00', '2026-05-01'))

    const may = await accountLedger(db, { accountId: account['1210']!, fromDate: '2026-05-01' })
    expect(may.openingBalance).toBe('0.00')
    expect(may.rows).toHaveLength(1)
    expect(may.closingBalance).toBe('100000.00')
  })

  it('runs the balance in the account own direction for a liability', async () => {
    await post(entry('1400', '2100', '40000.00', '2026-04-05'))
    await post(entry('2100', '1210', '15000.00', '2026-04-25'))

    const ledger = await accountLedger(db, { accountId: account['2100']! })
    /* A credit increases what is owed; the payment reduces it. */
    expect(ledger.rows.map((row) => row.balance)).toEqual(['40000.00', '25000.00'])
  })

  it('is empty, and says so with a zero close, for an account nothing has touched', async () => {
    const ledger = await accountLedger(db, { accountId: account['1100']! })

    expect(ledger.rows).toEqual([])
    expect(ledger.openingBalance).toBe('0.00')
    expect(ledger.closingBalance).toBe('0.00')
  })

  it('carries the account it is for', async () => {
    const ledger = await accountLedger(db, { accountId: account['2100']! })

    expect(ledger.code).toBe('2100')
    expect(ledger.name).toBe('Accounts Payable')
    expect(ledger.type).toBe('liability')
    expect(ledger.normalBalance).toBe('credit')
  })

  it('orders by date, then by entry number', async () => {
    await post(entry('1210', '3100', '10.00', '2026-06-01'))
    await post(entry('1210', '3100', '20.00', '2026-04-01'))
    await post(entry('1210', '3100', '30.00', '2026-05-01'))

    const ledger = await accountLedger(db, { accountId: account['1210']! })
    expect(ledger.rows.map((row) => row.date)).toEqual(['2026-04-01', '2026-05-01', '2026-06-01'])
  })

  it('prefers the line narration over the entry', async () => {
    await postEntry(db, {
      date: '2026-04-10',
      narration: 'Entry narration',
      source: MANUAL_SOURCE,
      lines: [
        { accountId: account['1210']!, debit: D('10.00'), credit: D(0), narration: 'Cheque 41' },
        { accountId: account['4100']!, debit: D(0), credit: D('10.00') },
      ],
    })

    const ledger = await accountLedger(db, { accountId: account['1210']! })
    expect(ledger.rows[0]?.narration).toBe('Cheque 41')
  })

  it('falls back to the entry narration when the line has none', async () => {
    await post(entry('1210', '4100', '10.00', '2026-04-10', 'April sale'))

    const ledger = await accountLedger(db, { accountId: account['1210']! })
    expect(ledger.rows[0]?.narration).toBe('April sale')
  })

  it('refuses a group, which holds no figures of its own', async () => {
    expect(await codeOf(() => accountLedger(db, { accountId: account['1000']! }))).toBe(
      'ACCOUNT_IS_GROUP',
    )
  })

  it('refuses an account that is not in this chart', async () => {
    expect(await codeOf(() => accountLedger(db, { accountId: 'nope' }))).toBe('ACCOUNT_NOT_FOUND')
  })

  it('closes on the same figure the trial balance reports', async () => {
    await post(entry('1210', '3100', '100000.00', '2026-04-01'))
    await post(entry('6200', '1210', '30000.50', '2026-04-20'))

    const ledger = await accountLedger(db, { accountId: account['1210']! })
    const sheet = await balanceSheet(db, '2027-03-31')
    expect(ledger.closingBalance).toBe(amountAt(sheet.assets, '1210'))
  })
})

// ---- The day book ----------------------------------------------------------

describe('dayBook', () => {
  it('is empty for books with no entries', async () => {
    const book = await dayBook(db)

    expect(book.days).toEqual([])
    expect(book.entryCount).toBe(0)
    expect(book.total).toBe('0.00')
  })

  it('groups the entries by day', async () => {
    await post(entry('1210', '3100', '100.00', '2026-04-01'))
    await post(entry('1210', '4100', '200.00', '2026-04-01'))
    await post(entry('1210', '4100', '300.00', '2026-04-02'))

    const book = await dayBook(db)
    expect(book.days.map((day) => day.date)).toEqual(['2026-04-01', '2026-04-02'])
    expect(book.days[0]?.entries).toHaveLength(2)
    expect(book.days[1]?.entries).toHaveLength(1)
  })

  it('totals each day and the whole book', async () => {
    await post(entry('1210', '3100', '100.50', '2026-04-01'))
    await post(entry('1210', '4100', '200.25', '2026-04-01'))
    await post(entry('1210', '4100', '300.00', '2026-04-02'))

    const book = await dayBook(db)
    expect(book.days[0]?.total).toBe('300.75')
    expect(book.days[1]?.total).toBe('300.00')
    expect(book.total).toBe('600.75')
    expect(book.entryCount).toBe(3)
  })

  it('is in date order even when the entries were posted out of order', async () => {
    await post(entry('1210', '3100', '100.00', '2026-06-01'))
    await post(entry('1210', '3100', '200.00', '2026-04-01'))

    const book = await dayBook(db)
    expect(book.days.map((day) => day.date)).toEqual(['2026-04-01', '2026-06-01'])
  })

  it('covers only the range it was given', async () => {
    await post(entry('1210', '3100', '100.00', '2026-04-01'))
    await post(entry('1210', '3100', '200.00', '2026-05-01'))
    await post(entry('1210', '3100', '400.00', '2026-06-01'))

    const may = await dayBook(db, { fromDate: '2026-05-01', toDate: '2026-05-31' })
    expect(may.entryCount).toBe(1)
    expect(may.total).toBe('200.00')
    expect(may.fromDate).toBe('2026-05-01')
  })

  it('applies each end of the range', async () => {
    await post(entry('1210', '3100', '100.00', '2026-04-01'))
    await post(entry('1210', '3100', '200.00', '2026-06-01'))

    expect((await dayBook(db, { fromDate: '2026-05-01' })).total).toBe('200.00')
    expect((await dayBook(db, { toDate: '2026-05-01' })).total).toBe('100.00')
  })

  it('carries the whole entry, so the day book can be read without a second query', async () => {
    await post(entry('1210', '4100', '100.00', '2026-04-01', 'A sale'))

    const posted = (await dayBook(db)).days[0]?.entries[0]
    expect(posted?.narration).toBe('A sale')
    expect(posted?.lines).toHaveLength(2)
    expect(posted?.total).toBe('100.00')
  })

  it('adds exactly across many days, where a float would drift', async () => {
    for (let index = 0; index < 10; index += 1) {
      const day = String(index + 1).padStart(2, '0')
      await post(entry('1210', '3100', '0.10', `2026-04-${day}`))
    }

    const book = await dayBook(db)
    expect(book.total).toBe('1.00')
    expect(book.days).toHaveLength(10)
  })
})

// ---- A new account added by the user ---------------------------------------

describe('a chart the user has changed', () => {
  it('reports an account created after the chart was seeded', async () => {
    const petty = await createAccount(db, {
      code: '1150',
      name: 'Petty Cash',
      type: 'asset',
      parentId: account['1000']!,
      isGroup: false,
    })
    await postEntry(db, {
      date: '2026-04-05',
      narration: 'Float',
      source: MANUAL_SOURCE,
      lines: [
        { accountId: petty.id, debit: D('2000.00'), credit: D(0) },
        { accountId: account['1210']!, debit: D(0), credit: D('2000.00') },
      ],
    })

    const sheet = await balanceSheet(db, '2026-04-30')
    expect(amountAt(sheet.assets, '1150')).toBe('2000.00')
    expect(sheet.balanced).toBe(true)
  })
})

// ---- The Overview's own figures -----------------------------------------------

describe('overviewFigures', () => {
  it('counts the cash and bank accounts, and a second bank filed beside the first', async () => {
    const second = await createAccount(db, {
      code: '1220',
      name: 'Second Bank',
      type: 'asset',
      parentId: account['1200']!,
      isGroup: false,
    })
    account['1220'] = second.id
    await post(entry('1210', '3100', '100000.00', '2026-04-01'))
    await post(entry('1100', '3100', '5000.00', '2026-04-02'))
    await post(entry('1220', '3100', '2500.00', '2026-04-03'))
    /* Receivables and advances are money of a kind, and not cash: they sit in Current Assets
     * beside the cash account, and that group is not swept in. */
    await post(entry('1300', '4100', '7000.00', '2026-04-04'))
    await post(entry('1600', '3100', '900.00', '2026-04-04'))

    const figures = await overviewFigures(db, '2026-04-30')

    expect(figures.cashAndBank.total).toBe('107500.00')
    expect(figures.cashAndBank.accounts.map((row) => row.code)).toEqual(['1100', '1210', '1220'])
    expect(figures.cashAndBank.accounts[1]).toMatchObject({
      name: 'Bank Account',
      balance: '100000.00',
    })
  })

  /* An overdrawn bank is a negative figure on the card, not a missing one. */
  it('keeps an overdrawn bank negative', async () => {
    await post(entry('1100', '3100', '1000.00', '2026-04-01'))
    await post(entry('6200', '1210', '3000.00', '2026-04-02'))

    const figures = await overviewFigures(db, '2026-04-30')

    expect(figures.cashAndBank.total).toBe('-2000.00')
  })

  it('reads the balances as at the date, and not what came after', async () => {
    await post(entry('1210', '3100', '100.00', '2026-04-01'))
    await post(entry('1210', '3100', '900.00', '2026-05-01'))

    expect((await overviewFigures(db, '2026-04-30')).cashAndBank.total).toBe('100.00')
  })

  it('takes the month so far from the first of the date’s month', async () => {
    await post(entry('1210', '4100', '9999.00', '2026-08-31'))
    await post(entry('1210', '4100', '25000.00', '2026-09-01'))
    await post(entry('6200', '1210', '30000.00', '2026-09-10'))
    await post(entry('1210', '4100', '500.00', '2026-09-16'))

    const figures = await overviewFigures(db, '2026-09-15')

    expect(figures.monthToDate).toEqual({
      fromDate: '2026-09-01',
      toDate: '2026-09-15',
      netProfit: '-5000.00',
    })
  })
})

describe('moneyAccounts', () => {
  const asset = (id: string, code: string, parentId: string | null, isGroup = false) => ({
    id,
    code,
    name: code,
    type: 'asset' as const,
    parentId,
    isGroup,
  })

  /* A bank filed straight into Current Assets beside receivables sweeps nothing in with it:
   * the group holds another role, so only the role accounts themselves count. */
  it('does not sweep in a group that holds another role', () => {
    const chart = [
      asset('ca', '1000', null, true),
      asset('cash', '1100', 'ca'),
      asset('bank', '1110', 'ca'),
      asset('ar', '1300', 'ca'),
      asset('deposit', '1600', 'ca'),
    ]
    const roles = [
      { role: 'cash', account_id: 'cash' },
      { role: 'bank', account_id: 'bank' },
      { role: 'accounts-receivable', account_id: 'ar' },
    ]

    expect(moneyAccounts(chart, roles).map((row) => row.code)).toEqual(['1100', '1110'])
  })

  it('counts nothing where no account fills either role', () => {
    expect(moneyAccounts([asset('cash', '1100', null)], [])).toEqual([])
  })

  it('reaches a bank in a group nested inside the bank group', () => {
    const chart = [
      asset('banks', '1200', null, true),
      asset('bank', '1210', 'banks'),
      asset('current', '1230', 'banks', true),
      asset('hdfc', '1231', 'current'),
    ]

    expect(
      moneyAccounts(chart, [{ role: 'bank', account_id: 'bank' }]).map((row) => row.code),
    ).toEqual(['1210', '1231'])
  })
})

/** Kept so the money helper is used, and to document that Decimal never crosses out. */
describe('what crosses the boundary', () => {
  it('is a decimal string everywhere, never a number', async () => {
    await post(entry('1210', '3100', '100000.00', '2026-04-01'))
    const sheet = await balanceSheet(db, '2026-04-30')

    const figures: unknown[] = [
      sheet.totalAssets,
      sheet.profitForPeriod,
      ...sheet.assets.lines.map((line) => line.amount),
    ]
    for (const figure of figures) {
      expect(typeof figure).toBe('string')
      expect(figure).toMatch(/^-?\d+\.\d{2}$/)
    }

    const asDecimal: Decimal = D(sheet.totalAssets)
    expect(asDecimal.toString()).toBe('100000')
  })
})
