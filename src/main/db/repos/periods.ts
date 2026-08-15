/*
 * Accounting periods.
 *
 * The spans the books are divided into, generated from a fiscal-year rule the tax regime
 * supplies, plus the status each one carries. Nothing here knows which regime is loaded:
 * every function that needs a calendar takes a `FiscalYearRule` as an argument, the same
 * way `domain/time` does, which is what keeps April out of the general ledger.
 *
 * THE DIVISION OF LABOUR WITH domain/time. `periodsOf` knows what the months of a fiscal
 * year are — for any year, whether or not the books have reached it. This file is the
 * part that materialises them and says whether you may post into one. The dates are
 * copied in rather than recomputed on read, because a period's span must not change when
 * a rule does; see the immutability trigger in migration 0003.
 *
 * ONE GRANULARITY PER SET OF BOOKS. Apr 2026 overlaps Q1 2026-27, so a company keeping
 * months cannot also keep quarters — the overlap trigger would refuse it. That is the
 * intended behaviour and `generateFiscalYear` detects it first so the caller gets a
 * sentence rather than a constraint.
 *
 * WHAT IS DELIBERATELY NOT HERE. Opening balances and the year-end close are both
 * journal entries, and `journal_entries` does not exist until migration 0004. They
 * belong with the posting engine, not with the calendar.
 */

import { randomUUID } from 'node:crypto'

import {
  isDateString,
  periodsOf,
  type FiscalYearRule,
  type PeriodGranularity,
} from '@main/domain/time'
import type { AccountingPeriodRef } from '@main/domain/ledger'
import type { AccountingPeriod, DateString, PeriodStatus } from '@shared/dto'

import type { CofferDb } from '../kysely'
import type { AccountingPeriodsTable } from '../schema'
import { RepoError, repoErrorFrom } from './errors'

type PeriodRow = AccountingPeriodsTable

function toDto(row: PeriodRow): AccountingPeriod {
  return {
    id: row.id,
    fiscalYearLabel: row.fiscal_year_label,
    index: row.period_index,
    label: row.label,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    closedAt: row.closed_at,
  }
}

/** What a posting rule sees. Narrower than the DTO on purpose — see `AccountingPeriodRef`. */
function toRef(row: PeriodRow): AccountingPeriodRef {
  return {
    id: row.id,
    fiscalYearLabel: row.fiscal_year_label,
    index: row.period_index,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
  }
}

// ---- Reading ---------------------------------------------------------------

export interface ListPeriodsOptions {
  /** Restrict to one fiscal year, identified by the calendar year it starts in. */
  fiscalYearStartYear?: number
}

/** Every period, earliest first. Chronological because that is the only useful order. */
export async function listPeriods(
  db: CofferDb,
  options: ListPeriodsOptions = {},
): Promise<AccountingPeriod[]> {
  let query = db.selectFrom('accounting_periods').selectAll()
  if (options.fiscalYearStartYear !== undefined) {
    query = query.where('fiscal_year_start_year', '=', options.fiscalYearStartYear)
  }
  const rows = await query.orderBy('start_date').execute()
  return rows.map(toDto)
}

export async function getPeriod(db: CofferDb, id: string): Promise<AccountingPeriod | null> {
  const row = await rowById(db, id)
  return row === null ? null : toDto(row)
}

/**
 * The granularity these books are kept in, or null when no period exists yet.
 *
 * Derived rather than stored. A column would be a second source of truth about something
 * the rows already say unambiguously, and the two would eventually disagree.
 */
export async function booksGranularity(db: CofferDb): Promise<PeriodGranularity | null> {
  const row = await db.selectFrom('accounting_periods').select('granularity').executeTakeFirst()
  if (row === undefined) {
    return null
  }
  return row.granularity === 'quarter' ? 'quarter' : 'month'
}

/** The period covering a date, or null when the books do not reach it. */
export async function periodForDate(
  db: CofferDb,
  date: DateString,
): Promise<AccountingPeriod | null> {
  const row = await rowForDate(db, date)
  return row === null ? null : toDto(row)
}

/** The same lookup, in the shape `PostingContext` wants. Null is not an error here. */
export async function periodRefForDate(
  db: CofferDb,
  date: DateString,
): Promise<AccountingPeriodRef | null> {
  const row = await rowForDate(db, date)
  return row === null ? null : toRef(row)
}

/**
 * The period a document dated `date` may post into, or a refusal saying why not.
 *
 * The posting engine's entry point into this file. `NO_PERIOD` and `PERIOD_CLOSED` are
 * separate codes because they need different offers in front of a user: one is "generate
 * the year", the other is "reopen it, or post the correction in the current period".
 */
export async function requirePostablePeriod(
  db: CofferDb,
  date: DateString,
): Promise<AccountingPeriodRef> {
  const row = await rowForDate(db, date)
  if (row === null) {
    throw new RepoError('NO_PERIOD', `The books have no period covering ${date}.`, { date })
  }
  if (row.status !== 'open') {
    throw new RepoError('PERIOD_CLOSED', `${row.label} is ${row.status}.`, {
      date,
      periodId: row.id,
      label: row.label,
      status: row.status,
    })
  }
  return toRef(row)
}

// ---- Generating ------------------------------------------------------------

export interface GenerateFiscalYearOptions {
  /** From the tax regime. `domain/time` derives everything else from it. */
  rule: FiscalYearRule
  /** The calendar year the fiscal year starts in — its identity, not its label. */
  startYear: number
  /**
   * Months or quarters. Defaults to whatever these books already use, and to months for
   * the first year, because a monthly return is the common case and quarters can be
   * totalled from months while months cannot be recovered from quarters.
   */
  granularity?: PeriodGranularity
}

/**
 * Materialise one fiscal year's periods, in a single transaction.
 *
 * All twelve or none: a half-generated year has holes that swallow postings, and the
 * dates either side of a hole would look perfectly ordinary in a list.
 */
export async function generateFiscalYear(
  db: CofferDb,
  options: GenerateFiscalYearOptions,
): Promise<AccountingPeriod[]> {
  const granularity = await resolveGranularity(db, options.granularity)

  /* Named by the label the books already carry, not by the one the requested rule would
   * produce. Under a changed fiscal-year rule those differ — the books say '2027' and
   * the caller asked for '2027-28' — and naming the caller's would describe a year that
   * is not there. */
  const clash = await db
    .selectFrom('accounting_periods')
    .select('fiscal_year_label')
    .where('fiscal_year_start_year', '=', options.startYear)
    .executeTakeFirst()
  if (clash !== undefined) {
    throw new RepoError('PERIOD_EXISTS', `The books already cover ${clash.fiscal_year_label}.`, {
      startYear: options.startYear,
      granularity,
      existingLabel: clash.fiscal_year_label,
    })
  }

  const periods = periodsOf(options.rule, options.startYear, granularity)
  await assertSpansFree(db, periods)

  const now = new Date().toISOString()
  const rows: PeriodRow[] = periods.map((period) => ({
    id: randomUUID(),
    fiscal_year_label: period.fiscalYearLabel,
    fiscal_year_start_year: options.startYear,
    period_index: period.index,
    granularity: period.granularity,
    label: period.label,
    start_date: period.startDate,
    end_date: period.endDate,
    status: 'open' as const,
    closed_at: null,
    created_at: now,
  }))

  try {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('accounting_periods').values(rows).execute()
    })
  } catch (error) {
    throw repoErrorFrom(error, 'PERIOD_OVERLAP')
  }

  return rows.map(toDto)
}

/**
 * The fiscal year's periods, generating them if the books have not reached it yet.
 *
 * What company creation and "post into next year" both call. Returning the existing
 * periods rather than refusing is the point: the caller wants the year to exist, and
 * whether it already did is not information it can act on.
 */
export async function ensureFiscalYear(
  db: CofferDb,
  options: GenerateFiscalYearOptions,
): Promise<AccountingPeriod[]> {
  const existing = await listPeriods(db, { fiscalYearStartYear: options.startYear })
  if (existing.length > 0) {
    return existing
  }
  return generateFiscalYear(db, options)
}

/**
 * Remove a fiscal year the books have not used.
 *
 * For the case that actually happens: a company generated with the wrong fiscal-year
 * rule, or in quarters when it wanted months, noticed before anything was posted. Every
 * period must still be open — a closed one is somebody's decision that the period was
 * finished, and a locked one the database refuses outright.
 *
 * Once migration 0004 lands, `journal_entries.period_id` restricts the delete as well,
 * so a year that has been posted to cannot be removed even while open.
 */
export async function removeFiscalYear(db: CofferDb, startYear: number): Promise<number> {
  const rows = await db
    .selectFrom('accounting_periods')
    .selectAll()
    .where('fiscal_year_start_year', '=', startYear)
    .orderBy('start_date')
    .execute()

  if (rows.length === 0) {
    throw new RepoError('PERIOD_NOT_FOUND', `The books have no year starting ${startYear}.`, {
      startYear,
    })
  }

  const settled = rows.find((row) => row.status !== 'open')
  if (settled !== undefined) {
    throw new RepoError(
      settled.status === 'locked' ? 'PERIOD_LOCKED' : 'PERIOD_STATUS_INVALID',
      `${settled.label} is ${settled.status}, so this year cannot be removed.`,
      { startYear, periodId: settled.id, label: settled.label, status: settled.status },
    )
  }

  try {
    await db
      .deleteFrom('accounting_periods')
      .where('fiscal_year_start_year', '=', startYear)
      .execute()
  } catch (error) {
    throw repoErrorFrom(error, 'PERIOD_STATUS_INVALID')
  }
  return rows.length
}

// ---- Status ----------------------------------------------------------------

/**
 * Close a period: the ordinary month end.
 *
 * Reversible. `closed` says "I have finished with this month", and reopening it is a
 * decision someone is allowed to make — which is the whole reason it is not `locked`.
 */
export async function closePeriod(db: CofferDb, id: string): Promise<AccountingPeriod> {
  const row = await requireRow(db, id)
  if (row.status === 'locked') {
    throw lockedError(row)
  }
  if (row.status === 'closed') {
    throw new RepoError('PERIOD_STATUS_INVALID', `${row.label} is already closed.`, {
      periodId: id,
      status: row.status,
    })
  }
  await assertEarlierPeriodsSettled(db, row)
  return setStatus(db, row, 'closed')
}

/**
 * Lock a period: a filed return, or a signed audit.
 *
 * Final. There is no unlock, here or in the database, and that is deliberate — an error
 * found after filing is corrected in the current open period, which is what an amended
 * return already expects. A lock that could be undone would be a close with a sterner
 * name, and the two states would stop meaning anything different.
 */
export async function lockPeriod(db: CofferDb, id: string): Promise<AccountingPeriod> {
  const row = await requireRow(db, id)
  if (row.status === 'locked') {
    throw new RepoError('PERIOD_STATUS_INVALID', `${row.label} is already locked.`, {
      periodId: id,
      status: row.status,
    })
  }
  await assertEarlierPeriodsSettled(db, row)
  return setStatus(db, row, 'locked')
}

/**
 * Reopen a closed period.
 *
 * Refused when any later period is locked. A lock is a statement that everything up to
 * that point is final, and letting an earlier period reopen underneath one would move
 * figures that have already been filed against.
 */
export async function reopenPeriod(db: CofferDb, id: string): Promise<AccountingPeriod> {
  const row = await requireRow(db, id)
  if (row.status === 'locked') {
    throw lockedError(row)
  }
  if (row.status === 'open') {
    throw new RepoError('PERIOD_STATUS_INVALID', `${row.label} is already open.`, {
      periodId: id,
      status: row.status,
    })
  }

  const laterLocked = await db
    .selectFrom('accounting_periods')
    .select(['id', 'label'])
    .where('start_date', '>', row.start_date)
    .where('status', '=', 'locked')
    .orderBy('start_date')
    .executeTakeFirst()
  if (laterLocked !== undefined) {
    throw new RepoError(
      'PERIOD_LATER_LOCKED',
      `${laterLocked.label} is locked, so ${row.label} cannot be reopened underneath it. ` +
        'Post the correction in the current open period instead.',
      { periodId: id, label: row.label, lockedPeriodLabel: laterLocked.label },
    )
  }

  return setStatus(db, row, 'open')
}

// ---- Guards ----------------------------------------------------------------

async function rowById(db: CofferDb, id: string): Promise<PeriodRow | null> {
  const row = await db
    .selectFrom('accounting_periods')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  return row ?? null
}

async function requireRow(db: CofferDb, id: string): Promise<PeriodRow> {
  const row = await rowById(db, id)
  if (row === null) {
    throw new RepoError('PERIOD_NOT_FOUND', 'These books have no such period.', { periodId: id })
  }
  return row
}

async function rowForDate(db: CofferDb, date: DateString): Promise<PeriodRow | null> {
  if (!isDateString(date)) {
    throw new RepoError('INVALID_DATE', `${date} is not a date in YYYY-MM-DD form.`, { date })
  }
  /* Text comparison, which is correct only because the dates are 'YYYY-MM-DD' — the
   * same reason migration 0003 CHECKs their length. */
  const row = await db
    .selectFrom('accounting_periods')
    .selectAll()
    .where('start_date', '<=', date)
    .where('end_date', '>=', date)
    .executeTakeFirst()
  return row ?? null
}

/**
 * Write the new status, and only the new status.
 *
 * `status` and `closed_at` are the only two columns this table permits an UPDATE to
 * name — migration 0003 aborts an update that mentions any other, including one that
 * writes the same value back. So this sets exactly those two and nothing else.
 *
 * `closed_at` is cleared on reopening rather than kept as "when it was last closed".
 * The column is what makes the CHECK enforceable, and a period that is open while
 * carrying a closing timestamp is a row that contradicts itself.
 */
async function setStatus(
  db: CofferDb,
  row: PeriodRow,
  status: PeriodStatus,
): Promise<AccountingPeriod> {
  const closedAt = status === 'open' ? null : new Date().toISOString()
  try {
    await db
      .updateTable('accounting_periods')
      .set({ status, closed_at: closedAt })
      .where('id', '=', row.id)
      .execute()
  } catch (error) {
    throw repoErrorFrom(error, 'PERIOD_STATUS_INVALID')
  }
  return { ...toDto(row), status, closedAt }
}

function lockedError(row: PeriodRow): RepoError {
  return new RepoError(
    'PERIOD_LOCKED',
    `${row.label} is locked. Locked periods do not reopen — post the correction in the ` +
      'current open period.',
    { periodId: row.id, label: row.label },
  )
}

/**
 * Periods close in order.
 *
 * Closing March while January is still open leaves a year that is half finished, and the
 * year-end close would then compute retained earnings over it without anything reporting
 * that it had. The rule is stated in terms of dates rather than indexes so it holds
 * across fiscal years as well as within one.
 */
async function assertEarlierPeriodsSettled(db: CofferDb, row: PeriodRow): Promise<void> {
  const earlier = await db
    .selectFrom('accounting_periods')
    .select(['id', 'label'])
    .where('start_date', '<', row.start_date)
    .where('status', '=', 'open')
    .orderBy('start_date')
    .executeTakeFirst()
  if (earlier !== undefined) {
    throw new RepoError(
      'PERIOD_EARLIER_OPEN',
      `${earlier.label} is still open, so ${row.label} cannot be closed yet. ` +
        'Periods are closed in order.',
      { periodId: row.id, label: row.label, earlierPeriodLabel: earlier.label },
    )
  }
}

/**
 * Refuse spans that collide with periods the books already have.
 *
 * Also the trigger's job, and checked here first so the message names the two periods
 * that clashed. This is what a fiscal-year rule change looks like from the inside: the
 * new year's April lands in the middle of the old year's January-to-December, and
 * "PERIOD_OVERLAP" alone would not tell anyone that was what happened.
 */
async function assertSpansFree(
  db: CofferDb,
  periods: readonly { label: string; startDate: DateString; endDate: DateString }[],
): Promise<void> {
  const existing = await db
    .selectFrom('accounting_periods')
    .select(['label', 'start_date', 'end_date'])
    .execute()

  for (const period of periods) {
    const clash = existing.find(
      (row) => period.startDate <= row.end_date && period.endDate >= row.start_date,
    )
    if (clash !== undefined) {
      throw new RepoError(
        'PERIOD_OVERLAP',
        `${period.label} overlaps ${clash.label}, which the books already have.`,
        { label: period.label, existingLabel: clash.label },
      )
    }
  }
}

/** Months or quarters, and never both — see the note at the top of this file. */
async function resolveGranularity(
  db: CofferDb,
  requested: PeriodGranularity | undefined,
): Promise<PeriodGranularity> {
  const inUse = await booksGranularity(db)
  if (inUse === null) {
    return requested ?? 'month'
  }
  if (requested !== undefined && requested !== inUse) {
    throw new RepoError(
      'PERIOD_GRANULARITY_MISMATCH',
      `These books are kept in ${inUse}s. A set of books uses one period length ` +
        'throughout, because a month and a quarter covering the same day would put the ' +
        'same figure in two reports.',
      { requested, inUse },
    )
  }
  return inUse
}
