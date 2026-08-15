/*
 * The contract, pinned.
 *
 * These are not tests of clever code — `normalBalanceOf` is a lookup. They exist
 * because the values are load-bearing definitions rather than choices, and a build in
 * which income has a debit normal balance produces books that are wrong everywhere at
 * once, quietly, with every total still adding up.
 */

import { describe, expect, it } from 'vitest'

import { D } from '@main/domain/money'

import {
  ACCOUNT_ROLES,
  ACCOUNT_TYPES,
  MANUAL_SOURCE,
  NORMAL_BALANCE,
  acceptsPostings,
  isPermanent,
  normalBalanceOf,
  signedEffect,
  type AccountType,
  type AccountingPeriodRef,
  type PeriodStatus,
} from './types'

describe('account types', () => {
  it('are exactly the five', () => {
    expect([...ACCOUNT_TYPES]).toEqual(['asset', 'liability', 'equity', 'income', 'expense'])
  })

  it('each have a normal balance', () => {
    for (const type of ACCOUNT_TYPES) {
      expect(NORMAL_BALANCE[type]).toBeDefined()
    }
    expect(Object.keys(NORMAL_BALANCE)).toHaveLength(ACCOUNT_TYPES.length)
  })

  /* Written out rather than derived, so that changing one is a visible change here. */
  it('are debit for assets and expenses, credit for the rest', () => {
    expect(normalBalanceOf('asset')).toBe('debit')
    expect(normalBalanceOf('expense')).toBe('debit')
    expect(normalBalanceOf('liability')).toBe('credit')
    expect(normalBalanceOf('equity')).toBe('credit')
    expect(normalBalanceOf('income')).toBe('credit')
  })

  it('are permanent for the balance sheet, temporary for the profit and loss', () => {
    expect(isPermanent('asset')).toBe(true)
    expect(isPermanent('liability')).toBe(true)
    expect(isPermanent('equity')).toBe(true)
    expect(isPermanent('income')).toBe(false)
    expect(isPermanent('expense')).toBe(false)
  })
})

describe('signedEffect', () => {
  it('is positive in the account’s own direction', () => {
    /* 100 debited to a bank account is 100 more in the bank. */
    expect(signedEffect('asset', D(100), D(0)).toString()).toBe('100')
    /* 100 credited to a loan is 100 more owed. */
    expect(signedEffect('liability', D(0), D(100)).toString()).toBe('100')
    expect(signedEffect('income', D(0), D(100)).toString()).toBe('100')
    expect(signedEffect('expense', D(100), D(0)).toString()).toBe('100')
  })

  it('is negative against it', () => {
    expect(signedEffect('asset', D(0), D(100)).toString()).toBe('-100')
    expect(signedEffect('liability', D(100), D(0)).toString()).toBe('-100')
  })

  it('does not round', () => {
    expect(signedEffect('asset', D('0.005'), D(0)).toString()).toBe('0.005')
  })

  /*
   * The accounting equation — Assets + Expenses = Liabilities + Equity + Income — as a
   * property of a balanced entry rather than a slogan. Both sides are movements, so
   * they must move together. If this fails, `NORMAL_BALANCE` is wrong and so is every
   * report in the product.
   */
  it('keeps both sides of the accounting equation moving together', () => {
    /* A 1,000 sale with 180 tax: the customer owes 1,180, of which 180 is not ours. */
    const entry: Array<{ type: AccountType; debit: string; credit: string }> = [
      { type: 'asset', debit: '1180', credit: '0' },
      { type: 'income', debit: '0', credit: '1000' },
      { type: 'liability', debit: '0', credit: '180' },
    ]

    const sideOf = (type: AccountType): 'left' | 'right' =>
      normalBalanceOf(type) === 'debit' ? 'left' : 'right'

    let left = D(0)
    let right = D(0)
    for (const line of entry) {
      const effect = signedEffect(line.type, D(line.debit), D(line.credit))
      if (sideOf(line.type) === 'left') {
        left = left.plus(effect)
      } else {
        right = right.plus(effect)
      }
    }

    expect(left.toString()).toBe('1180')
    expect(right.toString()).toBe('1180')
  })
})

describe('account roles', () => {
  it('are unique', () => {
    expect(new Set(ACCOUNT_ROLES).size).toBe(ACCOUNT_ROLES.length)
  })

  /* A role naming a tax component would put a regime's vocabulary into domain/. */
  it('name no tax component', () => {
    for (const role of ACCOUNT_ROLES) {
      expect(role).not.toMatch(/gst|vat|cess|cgst|sgst|igst/i)
    }
  })
})

describe('periods', () => {
  const period = (status: PeriodStatus): AccountingPeriodRef => ({
    id: 'p1',
    fiscalYearLabel: '2026-27',
    index: 1,
    startDate: '2026-04-01',
    endDate: '2026-04-30',
    status,
  })

  it('accept postings only while open', () => {
    expect(acceptsPostings(period('open'))).toBe(true)
    expect(acceptsPostings(period('closed'))).toBe(false)
    expect(acceptsPostings(period('locked'))).toBe(false)
  })
})

describe('the manual source', () => {
  it('carries no document', () => {
    expect(MANUAL_SOURCE).toEqual({ type: 'manual', id: null, number: null })
  })
})
