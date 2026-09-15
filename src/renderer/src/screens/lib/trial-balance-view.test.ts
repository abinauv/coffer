/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TrialBalance, TrialBalanceRow } from '@shared/dto'
import { sectionsOf } from './trial-balance-view'

function row(
  over: Partial<TrialBalanceRow> & Pick<TrialBalanceRow, 'code' | 'type'>,
): TrialBalanceRow {
  return {
    accountId: over.code,
    name: over.code,
    debit: '0.00',
    credit: '0.00',
    debitBalance: '0.00',
    creditBalance: '0.00',
    ...over,
  }
}

function report(rows: TrialBalanceRow[], over: Partial<TrialBalance> = {}): TrialBalance {
  return {
    fromDate: null,
    toDate: null,
    rows,
    sections: [],
    totalDebit: '0.00',
    totalCredit: '0.00',
    balanced: true,
    ...over,
  }
}

describe('sectionsOf', () => {
  const rows = [
    row({ code: '6200', type: 'expense', debitBalance: '15000.00' }),
    row({ code: '1210', type: 'asset', debitBalance: '85000.00' }),
    row({ code: '4100', type: 'income', creditBalance: '23600.00' }),
    row({ code: '1300', type: 'asset', debitBalance: '23600.00' }),
    row({ code: '3100', type: 'equity', creditBalance: '100000.00' }),
  ]

  const sections: TrialBalance['sections'] = [
    { type: 'asset', debitTotal: '108600.00', creditTotal: '0.00' },
    { type: 'equity', debitTotal: '0.00', creditTotal: '100000.00' },
    { type: 'income', debitTotal: '0.00', creditTotal: '23600.00' },
    { type: 'expense', debitTotal: '15000.00', creditTotal: '0.00' },
  ]

  it('draws main’s sections in main’s order', () => {
    expect(sectionsOf(report(rows, { sections })).map((section) => section.type)).toEqual([
      'asset',
      'equity',
      'income',
      'expense',
    ])
  })

  it('keeps the rows of a section in the order they arrived', () => {
    const assets = sectionsOf(report(rows, { sections })).find((s) => s.type === 'asset')
    expect(assets?.rows.map((r) => r.code)).toEqual(['1210', '1300'])
  })

  /* B23. Deliberately NOT the sum of the rows: what is shown is what main said. */
  it('carries main’s subtotals rather than adding up the rows', () => {
    const wrong = [{ type: 'asset' as const, debitTotal: '1.00', creditTotal: '2.00' }]
    const [assets] = sectionsOf(report(rows, { sections: wrong }))
    expect(assets?.debitTotal).toBe('1.00')
    expect(assets?.creditTotal).toBe('2.00')
  })

  it('gives each section a plural heading', () => {
    expect(sectionsOf(report(rows, { sections })).map((s) => s.label)).toEqual([
      'Assets',
      'Equity',
      'Income',
      'Expenses',
    ])
  })

  it('returns nothing for an empty report', () => {
    expect(sectionsOf(report([]))).toEqual([])
  })

  /*
   * `balanced` is main's answer, summed from the lines. Re-deriving it here would be a
   * second opinion about the one fact this report exists to state.
   */
  it('does not recompute whether the report balances', () => {
    const drawn = sectionsOf(report(rows, { sections, balanced: false }))
    for (const section of drawn) {
      expect(section).not.toHaveProperty('balanced')
    }
  })

  /* The adder is gone, and the file says why; a second one must not grow back. */
  it('holds no arithmetic on amounts', () => {
    const source = readFileSync(
      resolve('src/renderer/src/screens/lib/trial-balance-view.ts'),
      'utf8',
    )
    /* The header says what used to be here; only the code is held to it. */
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/bigint|BigInt|paise|parseFloat|Number\(|\+=/)
  })
})
