import { describe, expect, it } from 'vitest'
import { D, ZERO } from '../money'
import { contraLabel, runningLedger, type LedgerMovement } from './running'

function movement(over: Partial<LedgerMovement> = {}): LedgerMovement {
  return {
    entryId: 'e1',
    entryNumber: 'JV-2026-27-0001',
    date: '2026-04-01',
    narration: '',
    debit: ZERO,
    credit: ZERO,
    contraAccounts: ['Sales'],
    ...over,
  }
}

describe('runningLedger', () => {
  it('carries the balance forward through every row', () => {
    const ledger = runningLedger('asset', ZERO, [
      movement({ debit: D('1000.00') }),
      movement({ credit: D('250.00') }),
      movement({ debit: D('75.50') }),
    ])

    expect(ledger.rows.map((row) => row.balance.toString())).toEqual(['1000', '750', '825.5'])
  })

  it('starts from the opening balance rather than from zero', () => {
    const ledger = runningLedger('asset', D('5000.00'), [movement({ debit: D('1000.00') })])

    expect(ledger.openingBalance.toString()).toBe('5000')
    expect(ledger.rows[0]?.balance.toString()).toBe('6000')
  })

  /*
   * The direction is the whole reason `type` is a parameter. A credit to a liability
   * increases what is owed; the same credit to an asset reduces what is held.
   */
  it('increases a credit-normal account on a credit', () => {
    const ledger = runningLedger('liability', D('2000.00'), [
      movement({ credit: D('500.00') }),
      movement({ debit: D('300.00') }),
    ])

    expect(ledger.rows.map((row) => row.balance.toString())).toEqual(['2500', '2200'])
    expect(ledger.closingBalance.toString()).toBe('2200')
  })

  it('increases a debit-normal account on a debit', () => {
    const ledger = runningLedger('expense', ZERO, [
      movement({ debit: D('500.00') }),
      movement({ credit: D('100.00') }),
    ])

    expect(ledger.rows.map((row) => row.balance.toString())).toEqual(['500', '400'])
  })

  it('totals each column', () => {
    const ledger = runningLedger('asset', ZERO, [
      movement({ debit: D('1000.00') }),
      movement({ credit: D('250.00') }),
      movement({ debit: D('0.07') }),
      movement({ credit: D('0.07') }),
    ])

    expect(ledger.totalDebit.toString()).toBe('1000.07')
    expect(ledger.totalCredit.toString()).toBe('250.07')
  })

  it('adds exactly, where a float would drift', () => {
    const ledger = runningLedger(
      'asset',
      ZERO,
      Array.from({ length: 10 }, () => movement({ debit: D('0.10') })),
    )

    expect(ledger.closingBalance.toString()).toBe('1')
    expect(ledger.totalDebit.toString()).toBe('1')
  })

  /*
   * The closing balance is the last row's, not a second sum. Two ways of arriving at it
   * would agree until a sign convention changed under one of them, and the report would
   * then contradict its own last line.
   */
  it('closes on the balance of the last row', () => {
    const ledger = runningLedger('asset', D('100.00'), [
      movement({ debit: D('50.00') }),
      movement({ credit: D('20.00') }),
    ])

    expect(ledger.closingBalance).toBe(ledger.rows.at(-1)?.balance)
    expect(ledger.closingBalance.toString()).toBe('130')
  })

  it('closes on the opening balance when nothing moved', () => {
    const ledger = runningLedger('asset', D('420.00'), [])

    expect(ledger.rows).toEqual([])
    expect(ledger.closingBalance.toString()).toBe('420')
    expect(ledger.totalDebit.toString()).toBe('0')
    expect(ledger.totalCredit.toString()).toBe('0')
  })

  it('goes negative rather than clamping', () => {
    /* An account overdrawn by the entries in the range says so. */
    const ledger = runningLedger('asset', D('100.00'), [movement({ credit: D('400.00') })])
    expect(ledger.closingBalance.toString()).toBe('-300')
  })

  it('keeps everything the movement carried', () => {
    const ledger = runningLedger('asset', ZERO, [
      movement({ entryNumber: 'JV-2026-27-0009', narration: 'Cheque 41', debit: D('10.00') }),
    ])

    const row = ledger.rows[0]
    expect(row?.entryNumber).toBe('JV-2026-27-0009')
    expect(row?.narration).toBe('Cheque 41')
    expect(row?.contraAccounts).toEqual(['Sales'])
  })

  it('does not mutate what it was given', () => {
    const movements = [movement({ debit: D('10.00') })]
    runningLedger('asset', ZERO, movements)

    expect(movements[0]).not.toHaveProperty('balance')
  })
})

describe('contraLabel', () => {
  it('names the other account when there is exactly one', () => {
    expect(contraLabel(['Sales'])).toBe('Sales')
  })

  it('says Split when the entry touched several', () => {
    expect(contraLabel(['Sales', 'CGST Output', 'SGST Output'])).toBe('Split')
  })

  it('is empty when there is no other side, which cannot happen', () => {
    expect(contraLabel([])).toBe('')
  })
})
