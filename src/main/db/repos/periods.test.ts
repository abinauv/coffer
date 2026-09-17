/*
 * Against a real encrypted database, not a mock.
 *
 * Half of what is being tested is a SQL trigger, and the half a mock would exercise is
 * the half a future caller can bypass. Every test opens a SQLCipher file, migrates it,
 * and puts the rule to the database.
 *
 * The tests that matter most here are the ones that assert WHICH LAYER refused. Overlap,
 * immutability and the finality of a lock are each enforced twice, and a test that only
 * checks the error code passes just as happily against a repository that has stopped
 * checking — that is exactly what happened in batch 1.1A. `failureOf` exists so a test
 * can tell the two apart: only the repository populates `details`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DATABASE_KEY_BYTES, closeDatabase, openDatabase, type SqliteDatabase } from '../connection'
import { createQueryBuilder, type CofferDb } from '../kysely'
import { runMigrations, rollbackMigrations } from '../migrate'
import { MIGRATIONS } from '../migrations'
import { aprilToMarch, januaryToDecember, createFiscalYearRule } from '@main/domain/time'

import {
  booksGranularity,
  closePeriod,
  ensureFiscalYear,
  generateFiscalYear,
  getPeriod,
  listPeriods,
  lockPeriod,
  periodForDate,
  periodRefForDate,
  removeFiscalYear,
  reopenPeriod,
  requirePostablePeriod,
} from './periods'
import { isRepoError, type RepoError, type RepoErrorCode } from './errors'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x5a)

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase
let db: CofferDb

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-periods-'))
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

/** Run something expected to fail, and return the repo error code it failed with. */
async function codeOf(action: () => Promise<unknown>): Promise<RepoErrorCode | string> {
  try {
    await action()
  } catch (error) {
    return isRepoError(error) ? error.code : `not a RepoError: ${String(error)}`
  }
  return 'no error thrown'
}

/**
 * The whole error, for the tests that need to know which layer refused.
 *
 * `details` is populated by the repository and empty when `repoErrorFrom` translated a
 * trigger message. A test asserting on it fails when the repository check is removed,
 * even though the database still refuses the write and the code is unchanged.
 */
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

const april2026 = () => generateFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })

/** The period covering a date, or a failed expectation. Saves a null check per test. */
async function periodOn(date: string) {
  const period = await periodForDate(db, date)
  expect(period, `expected a period covering ${date}`).not.toBeNull()
  return period!
}

describe('migration 0003', () => {
  it('creates the table and rolls back cleanly', () => {
    const tableNames = () =>
      connection
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
        )
        .all()
        .map((row) => row.name)

    expect(tableNames()).toContain('accounting_periods')
    rollbackMigrations(connection, MIGRATIONS, { to: '0002' })
    expect(tableNames()).not.toContain('accounting_periods')
  })

  it('rejects a status the contract does not have', () => {
    expect(() =>
      connection
        .prepare(
          `INSERT INTO accounting_periods
             (id, fiscal_year_label, fiscal_year_start_year, period_index, granularity,
              label, start_date, end_date, status, closed_at, created_at)
           VALUES ('p', '2026-27', 2026, 1, 'month', 'Apr 2026',
                   '2026-04-01', '2026-04-30', 'archived', NULL, '2026-04-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK/i)
  })

  it('rejects a granularity the contract does not have', () => {
    expect(() =>
      connection
        .prepare(
          `INSERT INTO accounting_periods
             (id, fiscal_year_label, fiscal_year_start_year, period_index, granularity,
              label, start_date, end_date, status, closed_at, created_at)
           VALUES ('p', '2026', 2026, 1, 'fortnight', 'Apr 2026',
                   '2026-04-01', '2026-04-14', 'open', NULL, '2026-04-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK/i)
  })

  it('rejects an end date before its start date', () => {
    expect(() =>
      connection
        .prepare(
          `INSERT INTO accounting_periods
             (id, fiscal_year_label, fiscal_year_start_year, period_index, granularity,
              label, start_date, end_date, status, closed_at, created_at)
           VALUES ('p', '2026-27', 2026, 1, 'month', 'Apr 2026',
                   '2026-04-30', '2026-04-01', 'open', NULL, '2026-04-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK/i)
  })

  it('rejects a date that is not YYYY-MM-DD, because the overlap check compares text', () => {
    expect(() =>
      connection
        .prepare(
          `INSERT INTO accounting_periods
             (id, fiscal_year_label, fiscal_year_start_year, period_index, granularity,
              label, start_date, end_date, status, closed_at, created_at)
           VALUES ('p', '2026-27', 2026, 1, 'month', 'Apr 2026',
                   '2026-4-1', '2026-04-30', 'open', NULL, '2026-04-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK/i)
  })

  it('rejects an open period carrying a closing timestamp', () => {
    expect(() =>
      connection
        .prepare(
          `INSERT INTO accounting_periods
             (id, fiscal_year_label, fiscal_year_start_year, period_index, granularity,
              label, start_date, end_date, status, closed_at, created_at)
           VALUES ('p', '2026-27', 2026, 1, 'month', 'Apr 2026',
                   '2026-04-01', '2026-04-30', 'open', '2026-05-01T00:00:00.000Z',
                   '2026-04-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK/i)
  })

  it('rejects a closed period with no closing timestamp', () => {
    expect(() =>
      connection
        .prepare(
          `INSERT INTO accounting_periods
             (id, fiscal_year_label, fiscal_year_start_year, period_index, granularity,
              label, start_date, end_date, status, closed_at, created_at)
           VALUES ('p', '2026-27', 2026, 1, 'month', 'Apr 2026',
                   '2026-04-01', '2026-04-30', 'closed', NULL, '2026-04-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK/i)
  })
})

describe('generating a fiscal year', () => {
  it('produces twelve months for an April-to-March year', async () => {
    const periods = await april2026()

    expect(periods).toHaveLength(12)
    expect(periods[0]?.label).toBe('Apr 2026')
    expect(periods[0]?.startDate).toBe('2026-04-01')
    expect(periods[11]?.label).toBe('Mar 2027')
    expect(periods[11]?.endDate).toBe('2027-03-31')
    expect(periods.every((period) => period.fiscalYearLabel === '2026-27')).toBe(true)
    expect(periods.every((period) => period.status === 'open')).toBe(true)
    expect(periods.every((period) => period.closedAt === null)).toBe(true)
  })

  it('produces four quarters when asked for them', async () => {
    const periods = await generateFiscalYear(db, {
      rule: aprilToMarch,
      startYear: 2026,
      granularity: 'quarter',
    })

    expect(periods.map((period) => period.label)).toEqual([
      'Q1 2026-27',
      'Q2 2026-27',
      'Q3 2026-27',
      'Q4 2026-27',
    ])
    expect(periods[3]?.endDate).toBe('2027-03-31')
  })

  it('defaults to months', async () => {
    await april2026()
    expect(await booksGranularity(db)).toBe('month')
  })

  it('leaves no gap between one period and the next', async () => {
    const periods = await april2026()

    for (let i = 1; i < periods.length; i += 1) {
      const previousEnd = new Date(`${periods[i - 1]!.endDate}T00:00:00Z`)
      const thisStart = new Date(`${periods[i]!.startDate}T00:00:00Z`)
      const gapDays = (thisStart.getTime() - previousEnd.getTime()) / 86_400_000
      expect(gapDays, `${periods[i - 1]!.label} to ${periods[i]!.label}`).toBe(1)
    }
  })

  it('ends February on the 29th in a leap year, without being told about leap years', async () => {
    const periods = await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2027 })
    const february = periods.find((period) => period.label === 'Feb 2028')
    expect(february?.endDate).toBe('2028-02-29')
  })

  it('handles a year that does not start on the 1st', async () => {
    const sixthOfApril = createFiscalYearRule({ id: 'uk', startMonth: 4, startDay: 6 })
    const periods = await generateFiscalYear(db, { rule: sixthOfApril, startYear: 2026 })

    expect(periods[0]?.startDate).toBe('2026-04-06')
    expect(periods[0]?.endDate).toBe('2026-05-05')
    expect(periods[11]?.endDate).toBe('2027-04-05')
  })

  it('refuses to generate the same year twice', async () => {
    await april2026()
    expect(await codeOf(april2026)).toBe('PERIOD_EXISTS')
  })

  it('generates consecutive years that meet exactly', async () => {
    await april2026()
    const next = await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2027 })

    expect(next[0]?.startDate).toBe('2027-04-01')
    expect(await listPeriods(db)).toHaveLength(24)
  })

  it('generates a year before the first one', async () => {
    await april2026()
    await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2025 })

    const all = await listPeriods(db)
    expect(all).toHaveLength(24)
    expect(all[0]?.label).toBe('Apr 2025')
  })

  it('refuses a granularity these books do not use', async () => {
    await april2026()
    expect(
      await codeOf(() =>
        generateFiscalYear(db, { rule: aprilToMarch, startYear: 2027, granularity: 'quarter' }),
      ),
    ).toBe('PERIOD_GRANULARITY_MISMATCH')
  })

  it('inherits the granularity already in use when none is asked for', async () => {
    await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2026, granularity: 'quarter' })
    const next = await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2027 })

    expect(next).toHaveLength(4)
    expect(next[0]?.label).toBe('Q1 2027-28')
  })

  /*
   * The fiscal-year rule changing under books that already exist. Two failures, and
   * which one you get depends on whether the requested year collides by identity or
   * only by span — 2027 under both rules is the same start year, while April 2026 to
   * March 2027 merely overlaps the January-to-December 2027 that is already there.
   */
  it('reports the start year as taken even when the rule has changed under it', async () => {
    await generateFiscalYear(db, { rule: januaryToDecember, startYear: 2027 })
    const failure = await failureOf(() =>
      generateFiscalYear(db, { rule: aprilToMarch, startYear: 2027 }),
    )

    expect(failure.code).toBe('PERIOD_EXISTS')
    /* The label the books hold, not the one the requested rule would have produced. */
    expect(failure.message).toContain('2027')
    expect(failure.message).not.toContain('2027-28')
    expect(failure.details).toMatchObject({ existingLabel: '2027' })
  })

  it('names both periods when spans collide — the repository catches it, not the trigger', async () => {
    await generateFiscalYear(db, { rule: januaryToDecember, startYear: 2027 })
    const failure = await failureOf(() =>
      generateFiscalYear(db, { rule: aprilToMarch, startYear: 2026 }),
    )

    expect(failure.code).toBe('PERIOD_OVERLAP')
    expect(failure.details).toMatchObject({ label: 'Jan 2027', existingLabel: 'Jan 2027' })
    expect(failure.message).toContain('already have')
  })

  it('leaves the books exactly as they were when it refuses', async () => {
    await generateFiscalYear(db, { rule: januaryToDecember, startYear: 2027 })
    const before = await listPeriods(db)

    /* April 2026 to March 2027 clears the existing books for nine months and only then
     * runs into January 2027 — so a generation that wrote as it went, or that checked
     * each span as it reached it, would leave nine periods behind before failing. */
    await codeOf(() => generateFiscalYear(db, { rule: aprilToMarch, startYear: 2026 }))

    expect(await listPeriods(db)).toEqual(before)
  })

  it('refuses an overlapping span at the database as well', () => {
    connection
      .prepare(
        `INSERT INTO accounting_periods
           (id, fiscal_year_label, fiscal_year_start_year, period_index, granularity,
            label, start_date, end_date, status, closed_at, created_at)
         VALUES ('a', '2026-27', 2026, 1, 'month', 'Apr 2026',
                 '2026-04-01', '2026-04-30', 'open', NULL, '2026-04-01T00:00:00.000Z')`,
      )
      .run()

    expect(() =>
      connection
        .prepare(
          `INSERT INTO accounting_periods
             (id, fiscal_year_label, fiscal_year_start_year, period_index, granularity,
              label, start_date, end_date, status, closed_at, created_at)
           VALUES ('b', '2026-27', 2026, 2, 'month', 'Overlapping',
                   '2026-04-15', '2026-05-14', 'open', NULL, '2026-04-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/PERIOD_OVERLAP/)
  })

  it('refuses a period that swallows an existing one', () => {
    connection
      .prepare(
        `INSERT INTO accounting_periods
           (id, fiscal_year_label, fiscal_year_start_year, period_index, granularity,
            label, start_date, end_date, status, closed_at, created_at)
         VALUES ('a', '2026-27', 2026, 1, 'month', 'Apr 2026',
                 '2026-04-01', '2026-04-30', 'open', NULL, '2026-04-01T00:00:00.000Z')`,
      )
      .run()

    expect(() =>
      connection
        .prepare(
          `INSERT INTO accounting_periods
             (id, fiscal_year_label, fiscal_year_start_year, period_index, granularity,
              label, start_date, end_date, status, closed_at, created_at)
           VALUES ('b', '2026-27', 2026, 2, 'quarter', 'Q1 2026-27',
                   '2026-04-01', '2026-06-30', 'open', NULL, '2026-04-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/PERIOD_OVERLAP/)
  })

  it('allows a period that starts the day after another ends', () => {
    connection
      .prepare(
        `INSERT INTO accounting_periods
           (id, fiscal_year_label, fiscal_year_start_year, period_index, granularity,
            label, start_date, end_date, status, closed_at, created_at)
         VALUES ('a', '2026-27', 2026, 1, 'month', 'Apr 2026',
                 '2026-04-01', '2026-04-30', 'open', NULL, '2026-04-01T00:00:00.000Z')`,
      )
      .run()

    expect(() =>
      connection
        .prepare(
          `INSERT INTO accounting_periods
             (id, fiscal_year_label, fiscal_year_start_year, period_index, granularity,
              label, start_date, end_date, status, closed_at, created_at)
           VALUES ('b', '2026-27', 2026, 2, 'month', 'May 2026',
                   '2026-05-01', '2026-05-31', 'open', NULL, '2026-04-01T00:00:00.000Z')`,
        )
        .run(),
    ).not.toThrow()
  })

  it('refuses a second period in the same slot', () => {
    connection
      .prepare(
        `INSERT INTO accounting_periods
           (id, fiscal_year_label, fiscal_year_start_year, period_index, granularity,
            label, start_date, end_date, status, closed_at, created_at)
         VALUES ('a', '2026-27', 2026, 1, 'month', 'Apr 2026',
                 '2026-04-01', '2026-04-30', 'open', NULL, '2026-04-01T00:00:00.000Z')`,
      )
      .run()

    expect(() =>
      connection
        .prepare(
          `INSERT INTO accounting_periods
             (id, fiscal_year_label, fiscal_year_start_year, period_index, granularity,
              label, start_date, end_date, status, closed_at, created_at)
           VALUES ('b', '2026-27', 2026, 1, 'month', 'Apr 2026 again',
                   '2030-04-01', '2030-04-30', 'open', NULL, '2026-04-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/UNIQUE/i)
  })
})

describe('ensureFiscalYear', () => {
  it('generates a year the books do not have', async () => {
    const periods = await ensureFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })
    expect(periods).toHaveLength(12)
  })

  it('returns the existing periods rather than refusing', async () => {
    const first = await april2026()
    const second = await ensureFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })

    expect(second.map((period) => period.id)).toEqual(first.map((period) => period.id))
    expect(await listPeriods(db)).toHaveLength(12)
  })

  it('keeps a closed period closed', async () => {
    const periods = await april2026()
    await closePeriod(db, periods[0]!.id)

    const again = await ensureFiscalYear(db, { rule: aprilToMarch, startYear: 2026 })
    expect(again[0]?.status).toBe('closed')
  })
})

describe('finding the period for a date', () => {
  beforeEach(async () => {
    await april2026()
  })

  it('finds the period covering a date', async () => {
    expect((await periodOn('2026-04-15')).label).toBe('Apr 2026')
    expect((await periodOn('2027-03-31')).label).toBe('Mar 2027')
  })

  it('includes both boundary days', async () => {
    expect((await periodOn('2026-05-01')).label).toBe('May 2026')
    expect((await periodOn('2026-05-31')).label).toBe('May 2026')
  })

  it('returns null for a date the books do not reach', async () => {
    expect(await periodForDate(db, '2025-12-31')).toBeNull()
    expect(await periodForDate(db, '2027-04-01')).toBeNull()
  })

  it('refuses a date that is not a date', async () => {
    expect(await codeOf(() => periodForDate(db, '15/04/2026'))).toBe('INVALID_DATE')
    expect(await codeOf(() => periodForDate(db, '2026-4-15'))).toBe('INVALID_DATE')
  })

  it('gives the domain a ref, not the DTO', async () => {
    const ref = await periodRefForDate(db, '2026-04-15')
    expect(ref).toMatchObject({ fiscalYearLabel: '2026-27', index: 1, status: 'open' })
    expect(ref).not.toHaveProperty('closedAt')
    expect(ref).not.toHaveProperty('label')
  })

  it('returns null from the ref lookup too, rather than throwing', async () => {
    expect(await periodRefForDate(db, '2030-01-01')).toBeNull()
  })
})

describe('requirePostablePeriod', () => {
  beforeEach(async () => {
    await april2026()
  })

  it('returns the period when it is open', async () => {
    const ref = await requirePostablePeriod(db, '2026-04-15')
    expect(ref.fiscalYearLabel).toBe('2026-27')
  })

  it('separates "no period" from "period closed"', async () => {
    expect(await codeOf(() => requirePostablePeriod(db, '2030-01-01'))).toBe('NO_PERIOD')

    const april = await periodOn('2026-04-15')
    await closePeriod(db, april.id)
    expect(await codeOf(() => requirePostablePeriod(db, '2026-04-15'))).toBe('PERIOD_CLOSED')
  })

  it('refuses a locked period as well', async () => {
    const april = await periodOn('2026-04-15')
    await lockPeriod(db, april.id)
    const failure = await failureOf(() => requirePostablePeriod(db, '2026-04-15'))

    expect(failure.code).toBe('PERIOD_CLOSED')
    expect(failure.details).toMatchObject({ status: 'locked', label: 'Apr 2026' })
  })

  /* These reach the screen unchanged, so they are sentences for a person: the date the way
   * every screen writes it, and the one thing to do next. */
  it('says what to do, with the date written the way the screens write it', async () => {
    const none = await failureOf(() => requirePostablePeriod(db, '2030-01-01'))
    expect(none.message).toContain('no period covering 1 Jan 2030')
    expect(none.message).not.toContain('2030-01-01')
    expect(none.message).toMatch(/Choose a date inside/)

    const april = await periodOn('2026-04-15')
    await closePeriod(db, april.id)
    const closed = await failureOf(() => requirePostablePeriod(db, '2026-04-15'))
    expect(closed.message).toMatch(/Apr 2026 is closed, so nothing more can be posted in it/)
  })
})

describe('closing and reopening', () => {
  let periods: Awaited<ReturnType<typeof april2026>>

  beforeEach(async () => {
    periods = await april2026()
  })

  const at = (index: number) => periods[index]!

  it('closes a period and stamps when', async () => {
    const closed = await closePeriod(db, at(0).id)

    expect(closed.status).toBe('closed')
    expect(closed.closedAt).not.toBeNull()
    expect((await getPeriod(db, at(0).id))?.status).toBe('closed')
  })

  it('reopens a closed period and clears the stamp', async () => {
    await closePeriod(db, at(0).id)
    const reopened = await reopenPeriod(db, at(0).id)

    expect(reopened.status).toBe('open')
    expect(reopened.closedAt).toBeNull()
    expect((await getPeriod(db, at(0).id))?.closedAt).toBeNull()
  })

  it('closes periods in order', async () => {
    for (const period of periods) {
      await closePeriod(db, period.id)
    }
    const all = await listPeriods(db)
    expect(all.every((period) => period.status === 'closed')).toBe(true)
  })

  it('refuses to close a period while an earlier one is open', async () => {
    const failure = await failureOf(() => closePeriod(db, at(1).id))

    expect(failure.code).toBe('PERIOD_EARLIER_OPEN')
    expect(failure.details).toMatchObject({ earlierPeriodLabel: 'Apr 2026', label: 'May 2026' })
  })

  it('applies the ordering rule across fiscal years, not just within one', async () => {
    await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2027 })
    const next = await listPeriods(db, { fiscalYearStartYear: 2027 })

    expect(await codeOf(() => closePeriod(db, next[0]!.id))).toBe('PERIOD_EARLIER_OPEN')
  })

  it('refuses to close a period twice', async () => {
    await closePeriod(db, at(0).id)
    expect(await codeOf(() => closePeriod(db, at(0).id))).toBe('PERIOD_STATUS_INVALID')
  })

  it('refuses to reopen a period that is already open', async () => {
    expect(await codeOf(() => reopenPeriod(db, at(0).id))).toBe('PERIOD_STATUS_INVALID')
  })

  it('refuses a period id these books do not have', async () => {
    expect(await codeOf(() => closePeriod(db, 'not-an-id'))).toBe('PERIOD_NOT_FOUND')
    expect(await codeOf(() => reopenPeriod(db, 'not-an-id'))).toBe('PERIOD_NOT_FOUND')
    expect(await codeOf(() => lockPeriod(db, 'not-an-id'))).toBe('PERIOD_NOT_FOUND')
    expect(await getPeriod(db, 'not-an-id')).toBeNull()
  })

  it('lets a reopened period take postings again', async () => {
    await closePeriod(db, at(0).id)
    expect(await codeOf(() => requirePostablePeriod(db, '2026-04-15'))).toBe('PERIOD_CLOSED')

    await reopenPeriod(db, at(0).id)
    expect((await requirePostablePeriod(db, '2026-04-15')).id).toBe(at(0).id)
  })
})

describe('locking', () => {
  let periods: Awaited<ReturnType<typeof april2026>>

  beforeEach(async () => {
    periods = await april2026()
  })

  const at = (index: number) => periods[index]!

  it('locks an open period directly', async () => {
    const locked = await lockPeriod(db, at(0).id)
    expect(locked.status).toBe('locked')
    expect(locked.closedAt).not.toBeNull()
  })

  it('locks a closed period', async () => {
    await closePeriod(db, at(0).id)
    expect((await lockPeriod(db, at(0).id)).status).toBe('locked')
  })

  it('never reopens', async () => {
    await lockPeriod(db, at(0).id)
    const failure = await failureOf(() => reopenPeriod(db, at(0).id))

    expect(failure.code).toBe('PERIOD_LOCKED')
    expect(failure.details).toMatchObject({ label: 'Apr 2026' })
    expect(failure.message).toContain('current open period')
  })

  it('never reopens at the database either, whatever the repository does', () => {
    connection
      .prepare(
        `INSERT INTO accounting_periods
           (id, fiscal_year_label, fiscal_year_start_year, period_index, granularity,
            label, start_date, end_date, status, closed_at, created_at)
         VALUES ('locked', '2030-31', 2030, 1, 'month', 'Apr 2030',
                 '2030-04-01', '2030-04-30', 'locked', '2030-05-01T00:00:00.000Z',
                 '2030-04-01T00:00:00.000Z')`,
      )
      .run()

    expect(() =>
      connection
        .prepare(
          `UPDATE accounting_periods SET status = 'open', closed_at = NULL WHERE id = 'locked'`,
        )
        .run(),
    ).toThrow(/PERIOD_LOCKED/)
  })

  it('cannot be unlocked by deleting the row and writing it again', () => {
    connection
      .prepare(
        `INSERT INTO accounting_periods
           (id, fiscal_year_label, fiscal_year_start_year, period_index, granularity,
            label, start_date, end_date, status, closed_at, created_at)
         VALUES ('locked', '2030-31', 2030, 1, 'month', 'Apr 2030',
                 '2030-04-01', '2030-04-30', 'locked', '2030-05-01T00:00:00.000Z',
                 '2030-04-01T00:00:00.000Z')`,
      )
      .run()

    expect(() =>
      connection.prepare(`DELETE FROM accounting_periods WHERE id = 'locked'`).run(),
    ).toThrow(/PERIOD_LOCKED/)
  })

  it('refuses to lock twice', async () => {
    await lockPeriod(db, at(0).id)
    expect(await codeOf(() => lockPeriod(db, at(0).id))).toBe('PERIOD_STATUS_INVALID')
  })

  /*
   * Asserted on `details` rather than on the code alone. `locked -> closed` is also a
   * status change away from locked, so the trigger refuses it with the same code and a
   * test checking only the code passed against a repository that had stopped looking.
   */
  it('refuses to close a locked period', async () => {
    await lockPeriod(db, at(0).id)
    const failure = await failureOf(() => closePeriod(db, at(0).id))

    expect(failure.code).toBe('PERIOD_LOCKED')
    expect(failure.details).toMatchObject({ periodId: at(0).id, label: 'Apr 2026' })
    expect(failure.message).toContain('do not reopen')
  })

  it('refuses to lock while an earlier period is open', async () => {
    expect(await codeOf(() => lockPeriod(db, at(1).id))).toBe('PERIOD_EARLIER_OPEN')
  })

  it('refuses to reopen an earlier period once a later one is locked', async () => {
    await closePeriod(db, at(0).id)
    await lockPeriod(db, at(1).id)

    const failure = await failureOf(() => reopenPeriod(db, at(0).id))
    expect(failure.code).toBe('PERIOD_LATER_LOCKED')
    expect(failure.details).toMatchObject({ label: 'Apr 2026', lockedPeriodLabel: 'May 2026' })
  })

  it('still reopens when the later periods are only closed', async () => {
    await closePeriod(db, at(0).id)
    await closePeriod(db, at(1).id)

    expect((await reopenPeriod(db, at(0).id)).status).toBe('open')
  })
})

describe('a period’s span never changes', () => {
  it('refuses an update naming any column but status and closed_at', async () => {
    const periods = await april2026()
    const id = periods[0]!.id

    expect(() =>
      connection
        .prepare(`UPDATE accounting_periods SET end_date = '2026-05-15' WHERE id = ?`)
        .run(id),
    ).toThrow(/PERIOD_IMMUTABLE/)

    expect(() =>
      connection.prepare(`UPDATE accounting_periods SET label = 'April' WHERE id = ?`).run(id),
    ).toThrow(/PERIOD_IMMUTABLE/)
  })

  it('refuses even an update that writes the same value back', async () => {
    const periods = await april2026()

    expect(() =>
      connection
        .prepare(`UPDATE accounting_periods SET start_date = '2026-04-01' WHERE id = ?`)
        .run(periods[0]!.id),
    ).toThrow(/PERIOD_IMMUTABLE/)
  })

  it('still allows the status change', async () => {
    const periods = await april2026()
    await expect(closePeriod(db, periods[0]!.id)).resolves.toMatchObject({ status: 'closed' })
  })
})

describe('removing a fiscal year', () => {
  it('removes a year nothing has touched', async () => {
    await april2026()
    expect(await removeFiscalYear(db, 2026)).toBe(12)
    expect(await listPeriods(db)).toHaveLength(0)
  })

  it('leaves other years alone', async () => {
    await april2026()
    await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2027 })

    await removeFiscalYear(db, 2026)
    const remaining = await listPeriods(db)
    expect(remaining).toHaveLength(12)
    expect(remaining[0]?.fiscalYearLabel).toBe('2027-28')
  })

  it('lets the books be regenerated at a different granularity afterwards', async () => {
    await april2026()
    await removeFiscalYear(db, 2026)

    const quarters = await generateFiscalYear(db, {
      rule: aprilToMarch,
      startYear: 2026,
      granularity: 'quarter',
    })
    expect(quarters).toHaveLength(4)
  })

  it('refuses a year with a closed period in it', async () => {
    const periods = await april2026()
    await closePeriod(db, periods[0]!.id)

    const failure = await failureOf(() => removeFiscalYear(db, 2026))
    expect(failure.code).toBe('PERIOD_STATUS_INVALID')
    expect(failure.details).toMatchObject({ label: 'Apr 2026', status: 'closed' })
    expect(await listPeriods(db)).toHaveLength(12)
  })

  /* On `details` again: the DELETE trigger refuses a locked row with the same code, so
   * narrowing the repository's check to closed-only left this passing. */
  it('refuses a year with a locked period in it', async () => {
    const periods = await april2026()
    await lockPeriod(db, periods[0]!.id)

    const failure = await failureOf(() => removeFiscalYear(db, 2026))
    expect(failure.code).toBe('PERIOD_LOCKED')
    expect(failure.details).toMatchObject({ startYear: 2026, label: 'Apr 2026', status: 'locked' })
    expect(await listPeriods(db)).toHaveLength(12)
  })

  it('refuses a year the books do not have', async () => {
    expect(await codeOf(() => removeFiscalYear(db, 2026))).toBe('PERIOD_NOT_FOUND')
  })
})

describe('listing', () => {
  it('returns nothing for empty books', async () => {
    expect(await listPeriods(db)).toEqual([])
    expect(await booksGranularity(db)).toBeNull()
  })

  it('orders by date across fiscal years', async () => {
    await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2027 })
    await april2026()

    const labels = (await listPeriods(db)).map((period) => period.label)
    expect(labels[0]).toBe('Apr 2026')
    expect(labels[11]).toBe('Mar 2027')
    expect(labels[12]).toBe('Apr 2027')
  })

  it('filters to one fiscal year', async () => {
    await april2026()
    await generateFiscalYear(db, { rule: aprilToMarch, startYear: 2027 })

    const only = await listPeriods(db, { fiscalYearStartYear: 2027 })
    expect(only).toHaveLength(12)
    expect(only.every((period) => period.fiscalYearLabel === '2027-28')).toBe(true)
  })
})
