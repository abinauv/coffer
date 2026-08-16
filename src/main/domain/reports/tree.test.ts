import { describe, expect, it } from 'vitest'
import { D, ZERO, type Decimal } from '../money'
import type { AccountType } from '../ledger'
import { buildReportTree, profitInEquity, type ReportAccount } from './tree'

function account(
  id: string,
  code: string,
  type: AccountType,
  parentId: string | null = null,
  isGroup = false,
): ReportAccount {
  return { id, code, name: `Account ${code}`, type, parentId, isGroup }
}

/*
 *   1000 Assets .................... group
 *     1100 Current Assets .......... group
 *       1110 Cash
 *       1120 Bank
 *     1500 Fixed Assets ............ group
 *       1510 Equipment
 *   2000 Liabilities ............... group
 *     2100 Payables
 */
const CHART: ReportAccount[] = [
  account('a', '1000', 'asset', null, true),
  account('ca', '1100', 'asset', 'a', true),
  account('cash', '1110', 'asset', 'ca'),
  account('bank', '1120', 'asset', 'ca'),
  account('fa', '1500', 'asset', 'a', true),
  account('equip', '1510', 'asset', 'fa'),
  account('l', '2000', 'liability', null, true),
  account('pay', '2100', 'liability', 'l'),
]

function balances(entries: Record<string, string>): Map<string, Decimal> {
  return new Map(Object.entries(entries).map(([id, amount]) => [id, D(amount)]))
}

describe('buildReportTree', () => {
  it('rolls a leaf up through every ancestor', () => {
    const tree = buildReportTree(CHART, balances({ cash: '500.00', bank: '1500.00' }), {
      types: ['asset'],
    })

    const amounts = new Map(tree.lines.map((line) => [line.code, line.amount.toString()]))
    expect(amounts.get('1110')).toBe('500')
    expect(amounts.get('1100')).toBe('2000')
    expect(amounts.get('1000')).toBe('2000')
    expect(tree.total.toString()).toBe('2000')
  })

  it('flattens in tree order, parent before its descendants', () => {
    const tree = buildReportTree(
      CHART,
      balances({ cash: '500.00', bank: '1500.00', equip: '9000.00' }),
      { types: ['asset'] },
    )

    expect(tree.lines.map((line) => line.code)).toEqual([
      '1000',
      '1100',
      '1110',
      '1120',
      '1500',
      '1510',
    ])
  })

  it('carries the depth to indent by', () => {
    const tree = buildReportTree(CHART, balances({ cash: '500.00' }), { types: ['asset'] })
    const depths = new Map(tree.lines.map((line) => [line.code, line.depth]))

    expect(depths.get('1000')).toBe(0)
    expect(depths.get('1100')).toBe(1)
    expect(depths.get('1110')).toBe(2)
  })

  it('keeps only the requested types', () => {
    const tree = buildReportTree(CHART, balances({ cash: '500.00', pay: '300.00' }), {
      types: ['liability'],
    })

    expect(tree.lines.map((line) => line.code)).toEqual(['2000', '2100'])
    expect(tree.total.toString()).toBe('300')
  })

  it('takes several types at once', () => {
    const tree = buildReportTree(CHART, balances({ cash: '500.00', pay: '300.00' }), {
      types: ['asset', 'liability'],
    })

    expect(tree.lines.map((line) => line.code)).toEqual(['1000', '1100', '1110', '2000', '2100'])
    /* Roots only: 500 of assets and 300 of liabilities, each already the subtree. */
    expect(tree.total.toString()).toBe('800')
  })

  // ---- Which rows appear ---------------------------------------------------

  it('drops a subtree nothing has been posted to', () => {
    /* Nothing has ever been posted to a fixed asset. A statement that listed the group,
     * its children and three zeroes would bury the two figures that matter. */
    const tree = buildReportTree(CHART, balances({ cash: '500.00' }), { types: ['asset'] })

    expect(tree.lines.map((line) => line.code)).toEqual(['1000', '1100', '1110'])
    expect(tree.lines.map((line) => line.code)).not.toContain('1500')
  })

  it('keeps the zeroes when asked', () => {
    const tree = buildReportTree(CHART, balances({ cash: '500.00' }), {
      types: ['asset'],
      includeZero: true,
    })

    expect(tree.lines.map((line) => line.code)).toEqual([
      '1000',
      '1100',
      '1110',
      '1120',
      '1500',
      '1510',
    ])
  })

  /*
   * The rule that took a rewrite. Dropping on the *total* rather than on whether
   * anything was posted made real money vanish from a balance sheet that still balanced:
   * a group holding +500 of cash and -500 of bank nets to nothing, and both children
   * went with it. A thousand rupees the user cannot see is not an empty group.
   */
  it('keeps a group whose children cancel out, and both children with it', () => {
    const cancelling = balances({ cash: '500.00', bank: '-500.00' })
    const tree = buildReportTree(CHART, cancelling, { types: ['asset'] })

    expect(tree.lines.map((line) => line.code)).toEqual(['1000', '1100', '1110', '1120'])
    expect(tree.total.toString()).toBe('0')

    const amounts = new Map(tree.lines.map((line) => [line.code, line.amount.toString()]))
    expect(amounts.get('1110')).toBe('500')
    expect(amounts.get('1120')).toBe('-500')
    expect(amounts.get('1100')).toBe('0')
  })

  it('keeps an account posted to whose own balance is exactly zero', () => {
    /* A receipt and a payment of the same amount. The account has a history, and hiding
     * it hides both sides of it. */
    const tree = buildReportTree(CHART, balances({ cash: '0.00' }), { types: ['asset'] })

    expect(tree.lines.map((line) => line.code)).toEqual(['1000', '1100', '1110'])
  })

  it('still drops a sibling nothing touched, alongside one that cancelled out', () => {
    const tree = buildReportTree(CHART, balances({ cash: '500.00', bank: '-500.00' }), {
      types: ['asset'],
    })
    /* Fixed assets were never posted to and stay out. */
    expect(tree.lines.map((line) => line.code)).not.toContain('1500')
    expect(tree.lines.map((line) => line.code)).not.toContain('1510')
  })

  it('returns nothing for a chart with no balances at all', () => {
    const tree = buildReportTree(CHART, new Map(), { types: ['asset'] })
    expect(tree.lines).toEqual([])
    expect(tree.total.toString()).toBe('0')
  })

  it('returns nothing for a type the chart does not have', () => {
    const tree = buildReportTree(CHART, balances({ cash: '500.00' }), { types: ['income'] })
    expect(tree.lines).toEqual([])
    expect(tree.total.toString()).toBe('0')
  })

  // ---- Signs ---------------------------------------------------------------

  it('keeps a negative balance negative rather than moving it to the other side', () => {
    /* An overdrawn bank is a negative asset. Reclassifying it as a liability would
     * misstate both sides, and nothing in the ledger says it should move. */
    const tree = buildReportTree(CHART, balances({ cash: '500.00', bank: '-800.00' }), {
      types: ['asset'],
    })

    const amounts = new Map(tree.lines.map((line) => [line.code, line.amount.toString()]))
    expect(amounts.get('1120')).toBe('-800')
    expect(amounts.get('1100')).toBe('-300')
    expect(tree.total.toString()).toBe('-300')
  })

  it('adds exactly, without going near a float', () => {
    const tree = buildReportTree(
      CHART,
      balances({ cash: '0.07', bank: '0.07', equip: '1234567.89' }),
      { types: ['asset'] },
    )
    expect(tree.total.toString()).toBe('1234568.03')
  })

  // ---- Ordering ------------------------------------------------------------

  it('orders siblings by code numerically, not as text', () => {
    /* 100, 200, 1000 sorts as 100, 1000, 200 as text — an order the user did not choose
     * and cannot correct from the chart. */
    const chart = [
      account('g', '1', 'asset', null, true),
      account('x', '1000', 'asset', 'g'),
      account('y', '200', 'asset', 'g'),
      account('z', '100', 'asset', 'g'),
    ]
    const tree = buildReportTree(chart, balances({ x: '1.00', y: '2.00', z: '3.00' }), {
      types: ['asset'],
    })

    expect(tree.lines.map((line) => line.code)).toEqual(['1', '100', '200', '1000'])
  })

  it('falls back to text order for a code that is not a plain number', () => {
    const chart = [
      account('g', '1', 'asset', null, true),
      account('b', '1200-B', 'asset', 'g'),
      account('a', '1200-A', 'asset', 'g'),
    ]
    const tree = buildReportTree(chart, balances({ a: '1.00', b: '2.00' }), { types: ['asset'] })

    expect(tree.lines.map((line) => line.code)).toEqual(['1', '1200-A', '1200-B'])
  })

  // ---- Things that should not happen, and must not hang or vanish ----------

  it('treats an account whose parent was filtered out as a root', () => {
    /* A child carries its parent's type, so this cannot arise from the database. The
     * alternative to defending against it is a figure disappearing from a statement. */
    const orphaned = [
      account('p', '3000', 'equity', null, true),
      account('c', '3100', 'income', 'p'),
    ]
    const tree = buildReportTree(orphaned, balances({ c: '750.00' }), { types: ['income'] })

    expect(tree.lines.map((line) => line.code)).toEqual(['3100'])
    expect(tree.total.toString()).toBe('750')
  })

  it('does not hang on a cycle', () => {
    const cyclic = [
      { ...account('x', '1', 'asset', 'y', true) },
      { ...account('y', '2', 'asset', 'x', true) },
    ]
    /* Neither is reachable as a root, so nothing is emitted — but the point is that it
     * returns at all rather than recursing forever with no error. */
    expect(buildReportTree(cyclic, balances({}), { types: ['asset'] }).lines).toEqual([])
  })

  it('reports a group as a group and a leaf as a leaf', () => {
    const tree = buildReportTree(CHART, balances({ cash: '500.00' }), { types: ['asset'] })
    const groups = new Map(tree.lines.map((line) => [line.code, line.isGroup]))

    expect(groups.get('1000')).toBe(true)
    expect(groups.get('1110')).toBe(false)
  })
})

describe('profitInEquity', () => {
  it('is income less expenses', () => {
    expect(profitInEquity(D('100000.00'), D('72500.50')).toString()).toBe('27499.5')
  })

  it('is negative for a loss, and is not relabelled', () => {
    expect(profitInEquity(D('10000.00'), D('25000.00')).toString()).toBe('-15000')
  })

  it('is zero for books that have traded exactly nothing', () => {
    expect(profitInEquity(ZERO, ZERO).toString()).toBe('0')
  })
})
