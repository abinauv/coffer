/*
 * Setting up a new company's books, against a real encrypted database.
 *
 * The test that matters most is the one nobody would think to write: that a failure
 * half way through leaves NOTHING. A company with a chart of accounts and no periods
 * looks completely finished and refuses every posting, and the two halves were
 * deliberately not wired together until both existed for exactly that reason.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DATABASE_KEY_BYTES, closeDatabase, openDatabase, type SqliteDatabase } from '../connection'
import { createQueryBuilder, type CofferDb } from '../kysely'
import { runMigrations } from '../migrate'
import { MIGRATIONS } from '../migrations'
import { aprilToMarch, fixedClock, januaryToDecember } from '@main/domain/time'

import { booksAreSetUp, setUpBooks } from './bootstrap'
import { listAccounts } from './accounts'
import { booksGranularity, listPeriods, periodForDate } from './periods'
import { postManualEntry } from './journal'
import { trialBalance } from './balances'
import { SMALL_BUSINESS_CHART } from './chart-template'
import { isRepoError, type RepoError, type RepoErrorCode } from './errors'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x11)

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase
let db: CofferDb

/** 14 August 2026, which is inside the April-to-March year 2026-27. */
const CLOCK = fixedClock('2026-08-14T09:00:00.000Z')

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-bootstrap-'))
  directories.push(dir)
  connection = openDatabase({ filePath: join(dir, 'company.coffer'), key: KEY })
  handles.push(connection)
  runMigrations(connection, MIGRATIONS)
  db = createQueryBuilder(connection)
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

const setUp = () => setUpBooks(db, { rule: aprilToMarch, clock: CLOCK })

describe('setUpBooks', () => {
  it('writes the chart and the periods together', async () => {
    const result = await setUp()

    expect(result.accountsCreated).toBe(SMALL_BUSINESS_CHART.accounts.length)
    expect(result.rolesMapped).toBeGreaterThan(0)
    expect(result.fiscalYears).toEqual([2026, 2027])
    expect(result.periodsCreated).toBe(24)

    expect(await listAccounts(db)).toHaveLength(SMALL_BUSINESS_CHART.accounts.length)
    expect(await listPeriods(db)).toHaveLength(24)
  })

  it('picks the fiscal year containing today, not the calendar year', async () => {
    /* 14 August 2026 is in 2026-27 under April-to-March, and in 2026 under
     * January-to-December. The rule decides, and nothing here assumes April. */
    await setUpBooks(db, { rule: aprilToMarch, clock: CLOCK })
    expect((await listPeriods(db))[0]?.fiscalYearLabel).toBe('2026-27')
  })

  /*
   * Deliberately a year the real clock cannot be in. Every other test here used a fixed
   * clock set near today, so ignoring the clock entirely produced the same answer and
   * survived the mutation — the injection was untested even though it was used.
   */
  it('takes the year from the clock it was given, not from the wall clock', async () => {
    await setUpBooks(db, { rule: aprilToMarch, clock: fixedClock('2031-06-01T00:00:00.000Z') })

    const periods = await listPeriods(db)
    expect(periods[0]?.fiscalYearLabel).toBe('2031-32')
    expect(periods[0]?.startDate).toBe('2031-04-01')
    expect(periods[23]?.endDate).toBe('2033-03-31')
  })

  it('follows whatever fiscal-year rule the regime supplies', async () => {
    await setUpBooks(db, { rule: januaryToDecember, clock: CLOCK })

    const periods = await listPeriods(db)
    expect(periods[0]?.fiscalYearLabel).toBe('2026')
    expect(periods[0]?.startDate).toBe('2026-01-01')
    expect(periods[23]?.endDate).toBe('2027-12-31')
  })

  /*
   * A company created in the last month of a fiscal year would otherwise be unable to
   * date anything into the year starting weeks later — which is the single most likely
   * thing a user does in their first session in March.
   */
  it('reaches into the next fiscal year, so a March company can date into April', async () => {
    await setUpBooks(db, { rule: aprilToMarch, clock: fixedClock('2027-03-20T09:00:00.000Z') })

    expect(await periodForDate(db, '2027-03-25')).not.toBeNull()
    expect(await periodForDate(db, '2027-04-05')).not.toBeNull()
    expect((await periodForDate(db, '2027-04-05'))?.fiscalYearLabel).toBe('2027-28')
  })

  it('defaults to months', async () => {
    await setUp()
    expect(await booksGranularity(db)).toBe('month')
  })

  it('takes quarters when asked', async () => {
    const result = await setUpBooks(db, {
      rule: aprilToMarch,
      clock: CLOCK,
      granularity: 'quarter',
    })

    expect(result.periodsCreated).toBe(8)
    expect(await booksGranularity(db)).toBe('quarter')
  })

  it('generates as many years as asked for', async () => {
    const result = await setUpBooks(db, { rule: aprilToMarch, clock: CLOCK, years: 1 })

    expect(result.fiscalYears).toEqual([2026])
    expect(await listPeriods(db)).toHaveLength(12)
  })

  it('leaves a company that can post immediately', async () => {
    await setUp()
    const accounts = await listAccounts(db)
    const idOf = (code: string) => accounts.find((account) => account.code === code)!.id

    await postManualEntry(db, {
      date: '2026-08-14',
      narration: 'Owner introduces capital',
      lines: [
        { accountId: idOf('1210'), debit: '100000.00', credit: '0.00' },
        { accountId: idOf('3100'), debit: '0.00', credit: '100000.00' },
      ],
    })

    expect((await trialBalance(db)).balanced).toBe(true)
  })

  /*
   * On `details`, not the code. Without the guard the seed simply tries to create '1000'
   * again and the unique index refuses it with the SAME code — so asserting the code
   * alone passed against a `seedChart` that had stopped checking. Only the guard names
   * the template.
   */
  it('refuses a company that already has a chart', async () => {
    await setUp()

    let failure: unknown
    try {
      await setUp()
    } catch (error) {
      failure = error
    }

    expect(isRepoError(failure)).toBe(true)
    const repoError = failure as RepoError
    expect(repoError.code).toBe('ACCOUNT_CODE_TAKEN')
    expect(repoError.details).toMatchObject({ templateId: 'small-business' })
    expect(repoError.message).toContain('already has a chart of accounts')
  })

  /*
   * THE ONE THAT MATTERS. If the periods fail, the accounts must not survive — a
   * company with a chart and no periods refuses every posting while looking finished,
   * and nothing afterwards would detect it.
   */
  it('writes nothing at all when the periods cannot be generated', async () => {
    /* A period already occupying part of 2026-27, so generating that year collides. */
    connection
      .prepare(
        `INSERT INTO accounting_periods
           (id, fiscal_year_label, fiscal_year_start_year, period_index, granularity,
            label, start_date, end_date, status, closed_at, created_at)
         VALUES ('squatter', 'odd', 9999, 1, 'month', 'Squatter',
                 '2026-08-01', '2026-08-31', 'open', NULL, '2026-08-01T00:00:00.000Z')`,
      )
      .run()

    expect(await codeOf(setUp)).toBe('PERIOD_OVERLAP')

    expect(await listAccounts(db)).toHaveLength(0)
    expect(await listPeriods(db)).toHaveLength(1)
    expect(await booksAreSetUp(db)).toBe(false)
  })

  /*
   * And the same in the other direction: the SECOND year failing must take the first
   * year and the whole chart with it. A loop that committed as it went would leave
   * twelve periods and a chart behind.
   */
  it('rolls back the first year when the second one fails', async () => {
    connection
      .prepare(
        `INSERT INTO accounting_periods
           (id, fiscal_year_label, fiscal_year_start_year, period_index, granularity,
            label, start_date, end_date, status, closed_at, created_at)
         VALUES ('squatter', 'odd', 9999, 1, 'month', 'Squatter',
                 '2027-09-01', '2027-09-30', 'open', NULL, '2027-09-01T00:00:00.000Z')`,
      )
      .run()

    expect(await codeOf(setUp)).toBe('PERIOD_OVERLAP')

    expect(await listAccounts(db)).toHaveLength(0)
    expect(await listPeriods(db)).toHaveLength(1)
  })
})

describe('booksAreSetUp', () => {
  it('is false before and true after', async () => {
    expect(await booksAreSetUp(db)).toBe(false)
    await setUp()
    expect(await booksAreSetUp(db)).toBe(true)
  })
})
