/*
 * Opening balances and the year-end close, against a real encrypted database.
 *
 * These are the two entries that a set of books cannot be correct without, and both are
 * arithmetic somebody would otherwise do by hand at the point they are most tired. The
 * tests that matter are the ones that check the books still tie afterwards, and that
 * income and expense really do start the next year at zero.
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

import { seedChart } from './seed-chart'
import { clearAccountRole, listAccounts } from './accounts'
import { generateFiscalYear } from './periods'
import { getEntry, postManualEntry, reverseEntry } from './journal'
import { accountBalance, trialBalance } from './balances'
import { openingBalanceEntryId, postOpeningBalances } from './opening-balances'
import { closeFiscalYear } from './year-end'
import { isRepoError, type RepoError, type RepoErrorCode } from './errors'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x7e)

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase
let db: CofferDb
let account: Record<string, string>

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-yearend-'))
  directories.push(dir)
  connection = openDatabase({ filePath: join(dir, 'company.coffer'), key: KEY })
  handles.push(connection)
  runMigrations(connection, MIGRATIONS)
  db = createQueryBuilder(connection)

  await seedChart(db)
  await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })

  account = {}
  for (const row of await listAccounts(db)) {
    account[row.code] = row.id
  }
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

async function failureOf(action: () => Promise<unknown>): Promise<RepoError> {
  try {
    await action()
  } catch (error) {
    if (isRepoError(error)) {
      return error
    }
    throw error
  }
  throw new Error('Expected the action to fail, and it did not.')
}

const balanceOf = async (code: string) => (await accountBalance(db, account[code]!)).balance

describe('opening balances', () => {
  it('takes one signed amount per account and works out the sides', async () => {
    await postOpeningBalances(db, {
      date: '2026-04-01',
      lines: [
        { accountId: account['1210']!, amount: '250000.00' },
        { accountId: account['1300']!, amount: '80000.00' },
        { accountId: account['2100']!, amount: '45000.00' },
        { accountId: account['2810']!, amount: '150000.00' },
      ],
    })

    /* Every one positive in its own direction: assets debit, liabilities credit. */
    expect(await balanceOf('1210')).toBe('250000.00')
    expect(await balanceOf('1300')).toBe('80000.00')
    expect(await balanceOf('2100')).toBe('45000.00')
    expect(await balanceOf('2810')).toBe('150000.00')
  })

  it('sends the difference to opening balance equity', async () => {
    await postOpeningBalances(db, {
      date: '2026-04-01',
      lines: [
        { accountId: account['1210']!, amount: '250000.00' },
        { accountId: account['2100']!, amount: '45000.00' },
      ],
    })

    /* 250,000 of assets against 45,000 owed leaves 205,000 of capital. */
    expect(await balanceOf('3400')).toBe('205000.00')
  })

  it('leaves the books tying', async () => {
    await postOpeningBalances(db, {
      date: '2026-04-01',
      lines: [
        { accountId: account['1210']!, amount: '250000.00' },
        { accountId: account['1400']!, amount: '61234.56' },
        { accountId: account['2100']!, amount: '45000.00' },
      ],
    })

    const tb = await trialBalance(db)
    expect(tb.balanced).toBe(true)
  })

  it('writes no opening balance equity line when the figures already balance', async () => {
    await postOpeningBalances(db, {
      date: '2026-04-01',
      lines: [
        { accountId: account['1210']!, amount: '100000.00' },
        { accountId: account['3100']!, amount: '100000.00' },
      ],
    })

    const entry = await getEntry(db, (await openingBalanceEntryId(db))!)
    expect(entry?.lines).toHaveLength(2)
    expect(await balanceOf('3400')).toBe('0.00')
  })

  it('keeps a negative amount as the other side — an overdrawn bank is an asset in credit', async () => {
    await postOpeningBalances(db, {
      date: '2026-04-01',
      lines: [
        { accountId: account['1210']!, amount: '-12000.00' },
        { accountId: account['1400']!, amount: '50000.00' },
      ],
    })

    expect(await balanceOf('1210')).toBe('-12000.00')
    const tb = await trialBalance(db)
    expect(tb.rows.find((row) => row.code === '1210')).toMatchObject({ creditBalance: '12000.00' })
    expect(tb.balanced).toBe(true)
  })

  it('skips a zero without writing a both-zero line', async () => {
    await postOpeningBalances(db, {
      date: '2026-04-01',
      lines: [
        { accountId: account['1210']!, amount: '100000.00' },
        { accountId: account['1100']!, amount: '0.00' },
      ],
    })

    const entry = await getEntry(db, (await openingBalanceEntryId(db))!)
    expect(entry?.lines.map((line) => line.accountCode)).toEqual(['1210', '3400'])
  })

  it('is findable afterwards, and is not a manual journal', async () => {
    await postOpeningBalances(db, {
      date: '2026-04-01',
      lines: [{ accountId: account['1210']!, amount: '100000.00' }],
    })

    const entry = await getEntry(db, (await openingBalanceEntryId(db))!)
    expect(entry?.sourceType).toBe('opening-balance')
    expect(entry?.narration).toBe('Opening balances')
  })

  it('refuses an account listed twice', async () => {
    expect(
      await codeOf(() =>
        postOpeningBalances(db, {
          date: '2026-04-01',
          lines: [
            { accountId: account['1210']!, amount: '100.00' },
            { accountId: account['1210']!, amount: '200.00' },
          ],
        }),
      ),
    ).toBe('AMBIGUOUS_LINE')
  })

  it('refuses an empty list, and one that is all zeros', async () => {
    expect(await codeOf(() => postOpeningBalances(db, { date: '2026-04-01', lines: [] }))).toBe(
      'INSUFFICIENT_LINES',
    )
    expect(
      await codeOf(() =>
        postOpeningBalances(db, {
          date: '2026-04-01',
          lines: [{ accountId: account['1210']!, amount: '0.00' }],
        }),
      ),
    ).toBe('INSUFFICIENT_LINES')
  })

  it('refuses an amount that is not a number', async () => {
    const failure = await failureOf(() =>
      postOpeningBalances(db, {
        date: '2026-04-01',
        lines: [{ accountId: account['1210']!, amount: 'a lot' }],
      }),
    )
    expect(failure.code).toBe('INVALID_AMOUNT')
    expect(failure.details).toMatchObject({ lineIndex: 0 })
  })

  it('says so when no account fills the opening balance equity role', async () => {
    await clearAccountRole(db, 'opening-balance-equity')

    const failure = await failureOf(() =>
      postOpeningBalances(db, {
        date: '2026-04-01',
        lines: [{ accountId: account['1210']!, amount: '100000.00' }],
      }),
    )
    expect(failure.code).toBe('ROLE_UNMAPPED')
    expect(failure.details).toMatchObject({ role: 'opening-balance-equity' })
  })

  it('refuses a group account', async () => {
    expect(
      await codeOf(() =>
        postOpeningBalances(db, {
          date: '2026-04-01',
          lines: [{ accountId: account['1000']!, amount: '100.00' }],
        }),
      ),
    ).toBe('ACCOUNT_IS_GROUP')
  })
})

describe('the year-end close', () => {
  /** A year with 500,000 of sales, 300,000 of purchases and 60,000 of rent. */
  async function tradingYear(): Promise<void> {
    await postManualEntry(db, {
      date: '2026-04-10',
      narration: 'Sales',
      lines: [
        { accountId: account['1300']!, debit: '500000.00', credit: '0.00' },
        { accountId: account['4100']!, debit: '0.00', credit: '500000.00' },
      ],
    })
    await postManualEntry(db, {
      date: '2026-06-10',
      narration: 'Purchases',
      lines: [
        { accountId: account['5100']!, debit: '300000.00', credit: '0.00' },
        { accountId: account['2100']!, debit: '0.00', credit: '300000.00' },
      ],
    })
    await postManualEntry(db, {
      date: '2027-01-10',
      narration: 'Rent',
      lines: [
        { accountId: account['6200']!, debit: '60000.00', credit: '0.00' },
        { accountId: account['1210']!, debit: '0.00', credit: '60000.00' },
      ],
    })
  }

  it('moves the profit to retained earnings', async () => {
    await tradingYear()
    const result = await closeFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })

    expect(result.fiscalYearLabel).toBe('2026-27')
    expect(result.netResult).toBe('140000.00')
    expect(result.accountsClosed).toBe(3)
    expect(await balanceOf('3300')).toBe('140000.00')
  })

  it('leaves every income and expense account at zero', async () => {
    await tradingYear()
    await closeFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })

    for (const code of ['4100', '5100', '6200']) {
      expect(await balanceOf(code), code).toBe('0.00')
    }
  })

  it('leaves the balance sheet accounts alone', async () => {
    await tradingYear()
    const before = await balanceOf('1300')
    await closeFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })

    expect(await balanceOf('1300')).toBe(before)
  })

  it('still ties', async () => {
    await tradingYear()
    await closeFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })

    const tb = await trialBalance(db)
    expect(tb.balanced).toBe(true)
  })

  it('posts on the last day of the fiscal year', async () => {
    await tradingYear()
    const result = await closeFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })

    expect(result.posting?.date).toBe('2027-03-31')
  })

  it('handles a loss, moving it out of retained earnings', async () => {
    await postManualEntry(db, {
      date: '2026-04-10',
      narration: 'Sales',
      lines: [
        { accountId: account['1300']!, debit: '10000.00', credit: '0.00' },
        { accountId: account['4100']!, debit: '0.00', credit: '10000.00' },
      ],
    })
    await postManualEntry(db, {
      date: '2026-05-10',
      narration: 'Rent',
      lines: [
        { accountId: account['6200']!, debit: '25000.00', credit: '0.00' },
        { accountId: account['1210']!, debit: '0.00', credit: '25000.00' },
      ],
    })

    const result = await closeFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })
    expect(result.netResult).toBe('-15000.00')
    expect(await balanceOf('3300')).toBe('-15000.00')
  })

  it('starts the next year from zero on the profit and loss', async () => {
    await tradingYear()
    await closeFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })
    await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2027 })

    await postManualEntry(db, {
      date: '2027-04-05',
      narration: 'First sale of the new year',
      lines: [
        { accountId: account['1300']!, debit: '1000.00', credit: '0.00' },
        { accountId: account['4100']!, debit: '0.00', credit: '1000.00' },
      ],
    })

    const nextYear = await trialBalance(db, { fromDate: '2027-04-01', toDate: '2028-03-31' })
    expect(nextYear.rows.find((row) => row.code === '4100')?.creditBalance).toBe('1000.00')
    expect(nextYear.balanced).toBe(true)
  })

  it('does nothing when the year had no income or expense', async () => {
    await postOpeningBalances(db, {
      date: '2026-04-01',
      lines: [{ accountId: account['1210']!, amount: '100000.00' }],
    })

    const result = await closeFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })
    expect(result.posting).toBeNull()
    expect(result.netResult).toBe('0.00')
    expect(result.accountsClosed).toBe(0)
  })

  it('refuses to close the same year twice', async () => {
    await tradingYear()
    await closeFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })

    const failure = await failureOf(() =>
      closeFiscalYear(db, { rule: aprilToMarch, startYear: 2026 }),
    )
    expect(failure.code).toBe('ENTRY_IMMUTABLE')
    expect(failure.details).toMatchObject({ fiscalYearLabel: '2026-27' })
  })

  it('allows a re-close once the closing entry has been reversed', async () => {
    await tradingYear()
    const first = await closeFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })

    await reverseEntry(db, {
      entryId: first.posting!.entryId,
      date: '2027-03-31',
      narration: 'Closed too early',
    })
    expect(await balanceOf('3300')).toBe('0.00')

    const again = await closeFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })
    expect(again.netResult).toBe('140000.00')
    expect(await balanceOf('3300')).toBe('140000.00')
  })

  it('closes only the year it was asked for', async () => {
    await tradingYear()
    await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2027 })
    await postManualEntry(db, {
      date: '2027-05-10',
      narration: 'Next year sale',
      lines: [
        { accountId: account['1300']!, debit: '7000.00', credit: '0.00' },
        { accountId: account['4100']!, debit: '0.00', credit: '7000.00' },
      ],
    })

    const result = await closeFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })
    expect(result.netResult).toBe('140000.00')

    /* The next year's sale is untouched and still on the books. */
    const next = await trialBalance(db, { fromDate: '2027-04-01', toDate: '2028-03-31' })
    expect(next.rows.find((row) => row.code === '4100')?.creditBalance).toBe('7000.00')
  })

  /*
   * The consequence of the trial balance's lower bound, in the place it would actually
   * be noticed. If `fromDate` were ignored, closing 2027 would sweep in the 2026 income
   * that was never closed out — and the profit reported for 2027 would be both years'.
   */
  it('takes only its own year, even when the year before was never closed', async () => {
    await tradingYear()
    await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2027 })
    await postManualEntry(db, {
      date: '2027-07-01',
      narration: 'A sale in the second year',
      lines: [
        { accountId: account['1300']!, debit: '9000.00', credit: '0.00' },
        { accountId: account['4100']!, debit: '0.00', credit: '9000.00' },
      ],
    })

    const second = await closeFiscalYear(db, { rule: aprilToMarch, startYear: 2027 })
    expect(second.netResult).toBe('9000.00')
    expect(await balanceOf('3300')).toBe('9000.00')

    /* And the first year is still there to be closed on its own terms. */
    const first = await closeFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })
    expect(first.netResult).toBe('140000.00')
    expect((await trialBalance(db)).balanced).toBe(true)
  })

  it('says so when no account fills the retained earnings role', async () => {
    await tradingYear()
    await clearAccountRole(db, 'retained-earnings')

    const failure = await failureOf(() =>
      closeFiscalYear(db, { rule: aprilToMarch, startYear: 2026 }),
    )
    expect(failure.code).toBe('ROLE_UNMAPPED')
    expect(failure.details).toMatchObject({ role: 'retained-earnings' })
  })

  it('does not lock anything', async () => {
    await tradingYear()
    await closeFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })

    /* Still postable: closing is arithmetic, locking is a decision about a filing. */
    await expect(
      postManualEntry(db, {
        date: '2027-03-30',
        narration: 'A late invoice',
        lines: [
          { accountId: account['1300']!, debit: '100.00', credit: '0.00' },
          { accountId: account['4100']!, debit: '0.00', credit: '100.00' },
        ],
      }),
    ).resolves.toMatchObject({ total: '100.00' })
  })

  it('is an ordinary entry: numbered, reversible, and balanced by the same trigger', async () => {
    await tradingYear()
    const result = await closeFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })
    const entry = await getEntry(db, result.posting!.entryId)

    expect(entry?.entryNumber).toMatch(/^JV-2026-27-\d{4}$/)
    expect(entry?.sourceType).toBe('year-end-close')
    expect(entry?.sourceNumber).toBe('2026-27')

    /* Debits are the single 500,000 reversal of sales; the credits are purchases
     * 300,000, rent 60,000 and the 140,000 profit — so the entry totals 500,000, not the
     * 560,000 of gross movement it closes. */
    expect(entry?.total).toBe('500000.00')
    expect(entry?.lines).toHaveLength(4)
  })
})

describe('a full year, end to end', () => {
  it('opens, trades, closes, and ties at every step', async () => {
    await postOpeningBalances(db, {
      date: '2026-04-01',
      lines: [
        { accountId: account['1210']!, amount: '200000.00' },
        { accountId: account['1400']!, amount: '75000.00' },
        { accountId: account['2100']!, amount: '30000.00' },
      ],
    })
    expect((await trialBalance(db)).balanced).toBe(true)

    await postManualEntry(db, {
      date: '2026-08-20',
      narration: 'Sale',
      lines: [
        { accountId: account['1300']!, debit: '123456.78', credit: '0.00' },
        { accountId: account['4100']!, debit: '0.00', credit: '123456.78' },
      ],
    })
    expect((await trialBalance(db)).balanced).toBe(true)

    const closed = await closeFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })
    expect(closed.netResult).toBe('123456.78')

    const final = await trialBalance(db)
    expect(final.balanced).toBe(true)

    /* Assets less liabilities equals equity, which is what a balance sheet is. */
    const totalFor = (types: string[]) =>
      final.rows
        .filter((row) => types.includes(row.type))
        .reduce(
          (sum, row) =>
            sum + Number(row.debit.replace('.', '')) - Number(row.credit.replace('.', '')),
          0,
        )
    expect(totalFor(['asset'])).toBe(-totalFor(['liability', 'equity']))
  })
})
