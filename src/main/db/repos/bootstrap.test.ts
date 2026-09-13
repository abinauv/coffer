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
import { createSeries, defaultSeriesFor, previewNumber } from './numbering'
import { createUnit, listUnits } from './units'
import {
  DEFAULT_WAREHOUSE_CODE,
  createWarehouse,
  defaultWarehouseId,
  listWarehouses,
} from './stock'
import { NUMBERED_KINDS } from '@main/domain/documents'

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
  /*
   * THE BUG THIS CLOSED. Nothing ever created a numbering series: `setUpBooks` seeded a
   * chart and periods and stopped, there is no numbering IPC group and no settings
   * screen, so `defaultSeriesFor` answered null for every kind and issuing ANY document
   * from the app failed with `SERIES_NOT_CONFIGURED`. Found by building a company file
   * the way the app builds one and asking it — every test passed throughout, because a
   * test that issues something creates its own series first.
   */
  it('leaves a company that can number a document, which is not the same as posting one', async () => {
    await setUpBooks(db, { rule: aprilToMarch })

    for (const definition of NUMBERED_KINDS) {
      const series = await defaultSeriesFor(db, definition.kind)
      expect(series, `no default series for ${definition.kind}`).not.toBeNull()
      expect(series?.isDefault).toBe(true)
    }
  })

  it('gives the invoice series the shape a small Indian business already uses', async () => {
    await setUpBooks(db, { rule: aprilToMarch })

    const invoiceSeries = (await defaultSeriesFor(db, 'sales-invoice'))!
    expect((await previewNumber(db, invoiceSeries.id, '2026-27')).preview).toBe('INV/2026-27/0001')

    /* A quotation runs on instead, because nothing has been supplied when one is sent. */
    const quotationSeries = (await defaultSeriesFor(db, 'quotation'))!
    expect((await previewNumber(db, quotationSeries.id, '2026-27')).preview).toBe('QTN/0001')
  })

  it('leaves a series somebody has already configured alone', async () => {
    await createSeries(db, { kind: 'sales-invoice', label: 'Export', prefix: 'EXP' })
    const result = await setUpBooks(db, { rule: aprilToMarch })

    /* Six, not seven: the kind that already had one is skipped rather than given a
     * second series beside it, which would have been a decision taken back. */
    expect(result.seriesCreated).toBe(NUMBERED_KINDS.length - 1)
    expect((await defaultSeriesFor(db, 'sales-invoice'))?.label).toBe('Export')
  })

  /*
   * THE SAME BUG AS THE SERIES, ONE TABLE OVER. `stock_ledger.warehouse_id` is NOT NULL,
   * so a company file with no warehouse can record no stock movement at all —
   * `seedDefaultWarehouse` existed, idempotent and correct, and nothing called it. This
   * asserts the seeding; `companies/service.test.ts` asserts that a file the application
   * created can actually move stock, which is the assertion that would have caught it.
   */
  it('leaves a company somewhere to keep stock', async () => {
    const result = await setUpBooks(db, { rule: aprilToMarch })

    expect(result.warehousesCreated).toBe(1)
    expect((await listWarehouses(db)).map((warehouse) => warehouse.code)).toEqual([
      DEFAULT_WAREHOUSE_CODE,
    ])

    /* Through the resolver a movement actually uses, not through the list: `recordMovement`
     * asks `defaultWarehouseId` when a caller names none, and it is that call which
     * answered `WAREHOUSE_NOT_CONFIGURED` on every file the application had ever made. */
    await expect(defaultWarehouseId(db)).resolves.toBe((await listWarehouses(db))[0]?.id)
  })

  it('leaves a warehouse somebody has already created alone', async () => {
    await createWarehouse(db, { code: 'KOCHI', name: 'Kochi godown' })
    const result = await setUpBooks(db, { rule: aprilToMarch })

    /* Nought, and no `Main store` beside theirs. A single-location business that named
     * its one location has said where stock goes, and a seed is not a decision to retake. */
    expect(result.warehousesCreated).toBe(0)
    expect((await listWarehouses(db)).map((warehouse) => warehouse.code)).toEqual(['KOCHI'])
  })

  /*
   * AND EMPTIER STILL BEFORE THIS: nothing had ever written a unit, so the first invoice
   * line in a new company had nothing to be measured in. `units/service.test.ts` pinned
   * the absence deliberately.
   */
  it('seeds the units a quantity is counted in', async () => {
    const result = await setUpBooks(db, { rule: aprilToMarch })

    const units = await listUnits(db)
    expect(result.unitsCreated).toBe(units.length)
    expect(units.map((unit) => unit.code)).toEqual([
      'BOX',
      'KGS',
      'LTR',
      'MTR',
      'NOS',
      'PCS',
      'PRS',
      'SET',
    ])
  })

  /*
   * BY VALUE, PER UNIT, because the two fields are the whole judgement in the seed and a
   * length assertion cannot see either of them. `decimalPlaces` of nought is what refuses
   * half a box; `regimeCode` is India's UQC, and `LTR` carries null on purpose — the
   * volume codes this build can vouch for are KLR and MLT, and a wrong UQC fails at the
   * portal weeks later under a code somebody will believe was checked.
   */
  it('gives each seeded unit its own scale and its UQC, or admits it has none', async () => {
    await setUpBooks(db, { rule: aprilToMarch })
    const units = await listUnits(db)
    const by = (code: string) => units.find((unit) => unit.code === code)

    expect(by('NOS')).toMatchObject({ name: 'Numbers', decimalPlaces: 0, regimeCode: 'NOS' })
    expect(by('BOX')).toMatchObject({ decimalPlaces: 0, regimeCode: 'BOX' })
    expect(by('PRS')).toMatchObject({ decimalPlaces: 0, regimeCode: 'PRS' })
    expect(by('KGS')).toMatchObject({ decimalPlaces: 3, regimeCode: 'KGS' })
    expect(by('MTR')).toMatchObject({ decimalPlaces: 3, regimeCode: 'MTR' })
    expect(by('LTR')).toMatchObject({ decimalPlaces: 3, regimeCode: null })
  })

  it('leaves a unit code somebody has already taken alone', async () => {
    await createUnit(db, { code: 'KGS', name: 'Kilos', decimalPlaces: 2 })
    const result = await setUpBooks(db, { rule: aprilToMarch })

    /* Seven, not eight, and the surviving row is theirs — including the scale they
     * chose, which a seed that overwrote would have silently widened. */
    expect(result.unitsCreated).toBe(7)
    expect(await listUnits(db)).toHaveLength(8)
    expect((await listUnits(db)).find((unit) => unit.code === 'KGS')).toMatchObject({
      name: 'Kilos',
      decimalPlaces: 2,
    })
  })

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
