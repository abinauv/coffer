/*
 * An account's ledger: the movements against one account, in order, each carrying the
 * balance as it stood after that movement.
 *
 * ---------------------------------------------------------------------------
 * THE RUNNING BALANCE IS COMPUTED, NEVER STORED
 *
 * Invariant 4 again, and it bites harder here than anywhere else. A stored running
 * balance is wrong the moment an earlier entry is posted with a back-date — which is
 * ordinary, not exceptional: a bank statement arrives a week late and the entries go in
 * on the day they happened. Every figure below the insertion point would need rewriting,
 * and the one that did not get rewritten is the one nobody notices.
 *
 * So the fold runs from an opening balance every time the report is asked for. It is
 * O(rows) over a range the user chose, which is the cheapest thing in the request.
 *
 * ---------------------------------------------------------------------------
 * WHY THE OPENING BALANCE IS A SEPARATE FIGURE
 *
 * A ledger for April must start with what the account held on 31 March, or its closing
 * balance is only the month's movement wearing the closing balance's name. That figure
 * comes from summing everything before the range — it is not in the rows, and it cannot
 * be derived from them.
 */

import { ZERO, type Decimal } from '../money'
import { signedEffect, type AccountType } from '../ledger'

/** One line against the account, before the running balance has been worked out. */
export interface LedgerMovement {
  entryId: string
  entryNumber: string
  date: string
  narration: string
  debit: Decimal
  credit: Decimal
  /**
   * The accounts on the other side of the entry, by name.
   *
   * Empty for a one-sided entry, which cannot exist. One name is the common case and is
   * what a ledger column shows; more than one is a split.
   */
  contraAccounts: readonly string[]
}

export interface LedgerRow extends LedgerMovement {
  /** The account's balance after this movement, in its own normal direction. */
  balance: Decimal
}

export interface RunningLedger {
  openingBalance: Decimal
  rows: LedgerRow[]
  totalDebit: Decimal
  totalCredit: Decimal
  closingBalance: Decimal
}

/**
 * Folds the movements into rows, each carrying the balance after it.
 *
 * `type` decides the direction: a credit to a liability increases it, a credit to an
 * asset reduces it, and a ledger that showed either as a bare negative would be read
 * wrongly by the person it is for.
 */
export function runningLedger(
  type: AccountType,
  openingBalance: Decimal,
  movements: readonly LedgerMovement[],
): RunningLedger {
  let balance = openingBalance
  let totalDebit: Decimal = ZERO
  let totalCredit: Decimal = ZERO

  const rows: LedgerRow[] = movements.map((movement) => {
    balance = balance.plus(signedEffect(type, movement.debit, movement.credit))
    totalDebit = totalDebit.plus(movement.debit)
    totalCredit = totalCredit.plus(movement.credit)
    return { ...movement, balance }
  })

  return {
    openingBalance,
    rows,
    totalDebit,
    totalCredit,
    /*
     * The last row's balance, not a separately computed sum. Two ways of arriving at the
     * closing figure is one way too many: they would agree until a rounding rule or a
     * sign convention changed under one of them, and the report would then disagree with
     * its own last line.
     */
    closingBalance: rows.at(-1)?.balance ?? openingBalance,
  }
}

/**
 * What goes in the "particulars" column against a movement.
 *
 * The convention every hand-kept ledger uses: name the other side when there is exactly
 * one, and say `Split` when the entry touched several, because listing four accounts in
 * a column sized for one is how a ledger becomes unreadable. The entry itself is one
 * click away for the detail.
 */
export function contraLabel(contraAccounts: readonly string[]): string {
  if (contraAccounts.length === 1) return contraAccounts[0] ?? ''
  if (contraAccounts.length === 0) return ''
  return 'Split'
}
