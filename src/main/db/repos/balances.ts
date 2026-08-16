/*
 * Balances, summed from the lines every time they are asked for.
 *
 * Invariant 4: nothing here is stored and nothing is cached. A stored balance is a
 * second source of truth, and the two disagree silently starting on a date nobody can
 * afterwards identify — which is the single most expensive bug a set of books can have,
 * because every report drawn between then and the discovery was wrong.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SQL LOOKS LIKE THIS
 *
 * Amounts are decimal strings, and `SUM(debit)` would coerce them to REAL. That is not a
 * theoretical objection: ten rows of '0.10' summed as REAL give 1, and '0.07' three
 * times plus '1234567.89' plus '0.01' gives 1234568.1099999999 rather than 1234568.11.
 * A trial balance that stops tying by one paisa is indistinguishable from a real error.
 *
 * So these sum PAISE AS INTEGERS — `CAST(REPLACE(debit, '.', '') AS INTEGER)` — which is
 * exact, and convert back with a division by 100 that cannot lose anything because the
 * numerator is an integer. It is only sound because every stored amount carries exactly
 * two decimal places and no sign, which is a CHECK constraint in migration 0004 rather
 * than a convention anyone has to remember.
 *
 * ---------------------------------------------------------------------------
 * WHAT A DATE RANGE MEANS HERE
 *
 * These sum the movement in the range: every line whose entry date falls inside it. With
 * no `fromDate` that is the balance from inception, which is the classic trial balance.
 *
 * Given a single fiscal year it is the year's movement — which is the right answer for
 * income and expense, and the wrong one for assets, liabilities and equity, whose
 * balances carry forward. Nothing here silently splits the difference: a year-end close
 * writes the entries that make an opening balance real, and until it has run, a
 * range-limited trial balance is exactly what it says it is.
 */

import { D, ZERO, toMoneyString, type Decimal } from '@main/domain/money'
import { normalBalanceOf, signedEffect } from '@main/domain/ledger'
import { sql } from 'kysely'

import type {
  AccountBalance,
  AccountType,
  DateString,
  TrialBalance,
  TrialBalanceRow,
} from '@shared/dto'

import type { CofferDb } from '../kysely'
import { RepoError } from './errors'

export interface BalanceRangeOptions {
  /** Inclusive. Omitted means from the first entry in the books. */
  fromDate?: DateString
  /** Inclusive. Omitted means up to the last. */
  toDate?: DateString
}

/** Paise, as an exact integer. Never `CAST(x AS REAL)` — see the note at the top. */
const PAISE_DEBIT = sql<number>`COALESCE(SUM(CAST(REPLACE(journal_lines.debit, '.', '') AS INTEGER)), 0)`
const PAISE_CREDIT = sql<number>`COALESCE(SUM(CAST(REPLACE(journal_lines.credit, '.', '') AS INTEGER)), 0)`

/** Integer paise back to a Decimal. Exact: the numerator is a whole number of paise. */
function fromPaise(paise: number): Decimal {
  return D(paise).dividedBy(100)
}

/**
 * The trial balance: every account with movement, and the two totals that must agree.
 *
 * Groups never appear — they hold no figures of their own, and a group's total is the
 * sum of the leaves already listed. Including them would double every subtotal, which is
 * exactly what the posting trigger against group accounts exists to prevent.
 */
export async function trialBalance(
  db: CofferDb,
  options: BalanceRangeOptions = {},
): Promise<TrialBalance> {
  const rows = await sumsByAccount(db, options)

  let totalDebit: Decimal = ZERO
  let totalCredit: Decimal = ZERO

  const result: TrialBalanceRow[] = rows.map((row) => {
    const debit = fromPaise(row.debitPaise)
    const credit = fromPaise(row.creditPaise)
    const difference = debit.minus(credit)

    totalDebit = totalDebit.plus(debit)
    totalCredit = totalCredit.plus(credit)

    return {
      accountId: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      debit: toMoneyString(debit),
      credit: toMoneyString(credit),
      debitBalance: toMoneyString(difference.isPositive() ? difference : ZERO),
      creditBalance: toMoneyString(difference.isNegative() ? difference.negated() : ZERO),
    }
  })

  return {
    fromDate: options.fromDate ?? null,
    toDate: options.toDate ?? null,
    rows: result,
    totalDebit: toMoneyString(totalDebit),
    totalCredit: toMoneyString(totalCredit),
    balanced: totalDebit.equals(totalCredit),
  }
}

/** One account's balance, positive in its own normal direction. */
export async function accountBalance(
  db: CofferDb,
  accountId: string,
  options: BalanceRangeOptions = {},
): Promise<AccountBalance> {
  const account = await db
    .selectFrom('accounts')
    .select(['id', 'code', 'name', 'type', 'is_group'])
    .where('id', '=', accountId)
    .executeTakeFirst()
  if (account === undefined) {
    throw new RepoError('ACCOUNT_NOT_FOUND', 'That account is not in this chart of accounts.', {
      accountId,
    })
  }
  if (account.is_group === 1) {
    throw new RepoError(
      'ACCOUNT_IS_GROUP',
      'A group holds no figures of its own. Total its children instead.',
      { accountId, code: account.code },
    )
  }

  const rows = await sumsByAccount(db, options, accountId)
  const row = rows[0]
  const debit = fromPaise(row?.debitPaise ?? 0)
  const credit = fromPaise(row?.creditPaise ?? 0)

  return {
    accountId: account.id,
    code: account.code,
    name: account.name,
    type: account.type,
    normalBalance: normalBalanceOf(account.type),
    debit: toMoneyString(debit),
    credit: toMoneyString(credit),
    balance: toMoneyString(signedEffect(account.type, debit, credit)),
  }
}

/**
 * The totals of every account in a subtree, including the group's own descendants.
 *
 * What a balance sheet or a profit and loss needs: a group's figure is the sum of the
 * leaves beneath it, computed here rather than stored anywhere.
 */
export async function subtreeBalance(
  db: CofferDb,
  rootAccountId: string,
  options: BalanceRangeOptions = {},
): Promise<Decimal> {
  const accounts = await db.selectFrom('accounts').select(['id', 'parent_id', 'type']).execute()

  const children = new Map<string, string[]>()
  for (const account of accounts) {
    if (account.parent_id !== null) {
      const siblings = children.get(account.parent_id)
      if (siblings === undefined) {
        children.set(account.parent_id, [account.id])
      } else {
        siblings.push(account.id)
      }
    }
  }

  const root = accounts.find((account) => account.id === rootAccountId)
  if (root === undefined) {
    throw new RepoError('ACCOUNT_NOT_FOUND', 'That account is not in this chart of accounts.', {
      accountId: rootAccountId,
    })
  }

  const wanted = new Set<string>()
  const visit = (id: string): void => {
    wanted.add(id)
    for (const child of children.get(id) ?? []) {
      visit(child)
    }
  }
  visit(rootAccountId)

  const rows = await sumsByAccount(db, options)
  let total: Decimal = ZERO
  for (const row of rows) {
    if (wanted.has(row.id)) {
      total = total.plus(
        signedEffect(root.type, fromPaise(row.debitPaise), fromPaise(row.creditPaise)),
      )
    }
  }
  return total
}

interface AccountSums {
  id: string
  code: string
  name: string
  type: AccountType
  debitPaise: number
  creditPaise: number
}

/** One grouped query. Accounts with no movement in the range simply do not come back. */
async function sumsByAccount(
  db: CofferDb,
  options: BalanceRangeOptions,
  accountId?: string,
): Promise<AccountSums[]> {
  let query = db
    .selectFrom('journal_lines')
    .innerJoin('journal_entries', 'journal_entries.id', 'journal_lines.entry_id')
    .innerJoin('accounts', 'accounts.id', 'journal_lines.account_id')
    .select([
      'accounts.id as id',
      'accounts.code as code',
      'accounts.name as name',
      'accounts.type as type',
      PAISE_DEBIT.as('debitPaise'),
      PAISE_CREDIT.as('creditPaise'),
    ])
    .groupBy(['accounts.id', 'accounts.code', 'accounts.name', 'accounts.type'])
    .orderBy('accounts.code')

  if (options.fromDate !== undefined) {
    query = query.where('journal_entries.entry_date', '>=', options.fromDate)
  }
  if (options.toDate !== undefined) {
    query = query.where('journal_entries.entry_date', '<=', options.toDate)
  }
  if (accountId !== undefined) {
    query = query.where('accounts.id', '=', accountId)
  }

  return query.execute()
}
