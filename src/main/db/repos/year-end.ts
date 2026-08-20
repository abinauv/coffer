/*
 * The year-end close.
 *
 * Income and expense are period accounts: they measure a year and then start the next
 * one at zero. Assets, liabilities and equity are permanent and carry forward. Closing
 * the year is the entry that moves the first group into the second — every income and
 * expense balance is written back to nothing, and the difference lands in retained
 * earnings as the year's profit or loss.
 *
 * `isPermanent` in domain/ledger is the definition this uses. There is no list of
 * account codes here and there could not be: a user may rename or renumber their whole
 * chart, and the close still has to find the right accounts.
 *
 * WHY THIS IS AN ORDINARY ENTRY. It posts through `postEntry` like everything else, so
 * it balances by the same trigger, gets a number from the same sequence, and can be
 * reversed if it was run too early. A close that wrote directly to the tables would be
 * a second posting path and would eventually disagree with the first.
 *
 * WHAT IT DOES NOT DO. It does not lock anything. Locking is final and irreversible, and
 * it is a decision about a filed return rather than about arithmetic — see
 * `lockPeriod`. Running the close leaves every period exactly as it found it.
 */

import { D, ZERO, toMoneyString, type Decimal } from '@main/domain/money'
import { isPermanent, type EntryLineDraft } from '@main/domain/ledger'
import { fiscalYearEndDate, fiscalYearStartDate, type FiscalYearRule } from '@main/domain/time'
import type { PostingResult, YearEndCloseResult } from '@shared/dto'

import type { CofferDb } from '../kysely'
import { RepoError } from './errors'
import { postEntry } from './journal'
import { trialBalance } from './balances'

export interface CloseFiscalYearOptions {
  /** From the tax regime, the same rule the periods were generated from. */
  rule: FiscalYearRule
  /** The calendar year the fiscal year starts in. */
  startYear: number
  /**
   * The date to post the closing entry on. Defaults to the fiscal year's last day,
   * which is where it belongs — a close dated into the next year would move the profit
   * into the wrong period.
   */
  date?: string
}

/**
 * Close a fiscal year.
 *
 * Refuses a year already closed, because running it twice would move the profit to
 * retained earnings again and double it — and the second run would look exactly as
 * successful as the first.
 */
export async function closeFiscalYear(
  db: CofferDb,
  options: CloseFiscalYearOptions,
): Promise<YearEndCloseResult> {
  const fiscalYearLabel = options.rule.label(options.startYear)
  const fromDate = fiscalYearStartDate(options.rule, options.startYear)
  const toDate = fiscalYearEndDate(options.rule, options.startYear)
  const date = options.date ?? toDate

  const already = await closingEntryId(db, fromDate, toDate)
  if (already !== null) {
    throw new RepoError(
      'ENTRY_IMMUTABLE',
      `${fiscalYearLabel} has already been closed. Reverse the closing entry first if it was run too early.`,
      { fiscalYearLabel, entryId: already },
    )
  }

  /*
   * The year's movement on every account, which for income and expense is their balance
   * — they started the year at zero, because the previous year's close is what put them
   * there. The first year Coffer runs, they started at zero because there was nothing.
   */
  const balances = await trialBalance(db, { fromDate, toDate })
  const temporary = balances.rows.filter((row) => !isPermanent(row.type))

  const lines: EntryLineDraft[] = []

  for (const row of temporary) {
    const movement = D(row.debit).minus(row.credit)
    if (movement.isZero()) {
      continue
    }

    /* Write the account back to nothing: whatever side it sits on, post the other. */
    lines.push({
      accountId: row.accountId,
      debit: movement.isNegative() ? movement.negated() : ZERO,
      credit: movement.isPositive() ? movement : ZERO,
      narration: `Closing ${fiscalYearLabel}`,
    })
  }

  if (lines.length === 0) {
    return { fiscalYearLabel, posting: null, netResult: '0.00', accountsClosed: 0 }
  }

  /*
   * The other side of every line above, in one figure — and, as it happens, the year's
   * profit. Each closing line contributes the negation of its account's movement, so
   * this sum is `credits - debits` across income and expense, which is income minus
   * expenses. Positive is a profit and lands as a credit to retained earnings, which is
   * the direction equity increases in.
   *
   * Taken from the lines rather than computed separately, so that the figure reported
   * and the figure posted cannot drift apart: it is arithmetically the amount that makes
   * the entry balance.
   */
  /* Counted here, before anything else joins the list. `lines.length - 1` at the end
   * was the same number by arithmetic only while the retained-earnings line was
   * unconditional, and it stopped being that the moment an even year skipped it. */
  const accountsClosed = lines.length

  const netResult = lines.reduce(
    (total, line) => total.plus(line.debit).minus(line.credit),
    ZERO as Decimal,
  )

  /*
   * A year that broke exactly even carries nothing to retained earnings, and must not
   * write a line saying it did.
   *
   * Measured, not assumed: `netResult.isPositive()` is TRUE for zero, because decimal.js
   * gives zero a positive sign. Without this guard the line came out as debit '0.00' and
   * credit '0.00' — a both-zero line, which invariant 5 refuses — and the close failed
   * with AMBIGUOUS_LINE, an error nothing on that screen could act on. The closing lines
   * above already balance among themselves when the net is zero, so the entry is complete
   * without this one.
   */
  if (!netResult.isZero()) {
    const retainedEarnings = await accountForRole(db, 'retained-earnings')
    lines.push({
      accountId: retainedEarnings,
      debit: netResult.isNegative() ? netResult.negated() : ZERO,
      credit: netResult.isPositive() ? netResult : ZERO,
      narration: `Profit or loss for ${fiscalYearLabel}`,
    })
  }

  const posting: PostingResult = await postEntry(db, {
    date,
    narration: `Year-end close, ${fiscalYearLabel}`,
    source: { type: 'year-end-close', id: null, number: fiscalYearLabel },
    lines,
  })

  return {
    fiscalYearLabel,
    posting,
    netResult: toMoneyString(netResult),
    accountsClosed,
  }
}

/**
 * The closing entry for a fiscal year, if one has been posted and not reversed.
 *
 * Found by source type and date range rather than by a flag on the period, because the
 * entry is the fact — a flag would be a second copy of it, and invariant 4's reasoning
 * applies to more than balances.
 */
export async function closingEntryId(
  db: CofferDb,
  fromDate: string,
  toDate: string,
): Promise<string | null> {
  const rows = await db
    .selectFrom('journal_entries')
    .select(['id'])
    .where('source_type', '=', 'year-end-close')
    .where('entry_date', '>=', fromDate)
    .where('entry_date', '<=', toDate)
    .where('reverses_entry_id', 'is', null)
    .execute()

  if (rows.length === 0) {
    return null
  }

  /* A closing entry that has been reversed does not count as closed — that is what
   * reversing it was for. */
  const reversed = await db
    .selectFrom('journal_entries')
    .select('reverses_entry_id')
    .where(
      'reverses_entry_id',
      'in',
      rows.map((row) => row.id),
    )
    .execute()
  const reversedIds = new Set(reversed.map((row) => row.reverses_entry_id))

  const live = rows.find((row) => !reversedIds.has(row.id))
  return live?.id ?? null
}

async function accountForRole(db: CofferDb, role: string): Promise<string> {
  const row = await db
    .selectFrom('account_roles')
    .select('account_id')
    .where('role', '=', role)
    .executeTakeFirst()
  if (row === undefined) {
    throw new RepoError(
      'ROLE_UNMAPPED',
      `No account is mapped to ${role}. Point one at it in the chart of accounts.`,
      { role },
    )
  }
  return row.account_id
}
