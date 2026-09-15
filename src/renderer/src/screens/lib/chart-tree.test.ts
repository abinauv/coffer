import { describe, expect, it } from 'vitest'
import type { Account } from '@shared/dto'
import {
  accountLabel,
  filterChart,
  parentsForAccount,
  parentsForType,
  possibleParents,
  postableAccounts,
} from './chart-tree'

function account(over: Partial<Account> & Pick<Account, 'id' | 'code' | 'name'>): Account {
  return {
    type: 'asset',
    normalBalance: 'debit',
    parentId: null,
    isGroup: false,
    isArchived: false,
    description: null,
    depth: 0,
    roles: [],
    ...over,
  }
}

/** A small chart in tree order, as `listAccounts` returns it. */
const CHART: Account[] = [
  account({ id: 'a', code: '1000', name: 'Current Assets', isGroup: true, depth: 0 }),
  account({
    id: 'b',
    code: '1100',
    name: 'Cash in Hand',
    parentId: 'a',
    depth: 1,
    roles: ['cash'],
  }),
  account({ id: 'c', code: '1200', name: 'Bank Accounts', parentId: 'a', isGroup: true, depth: 1 }),
  account({
    id: 'd',
    code: '1210',
    name: 'Bank Account',
    parentId: 'c',
    depth: 2,
    roles: ['bank'],
  }),
  account({
    id: 'e',
    code: '4000',
    name: 'Revenue',
    type: 'income',
    normalBalance: 'credit',
    isGroup: true,
    depth: 0,
  }),
  account({
    id: 'f',
    code: '4100',
    name: 'Sales',
    type: 'income',
    normalBalance: 'credit',
    parentId: 'e',
    depth: 1,
  }),
]

const codes = (rows: { account: Account }[]) => rows.map((row) => row.account.code)

describe('filterChart', () => {
  it('returns everything, highlighted as nothing, for an empty query', () => {
    const rows = filterChart(CHART, '   ')

    expect(codes(rows)).toEqual(['1000', '1100', '1200', '1210', '4000', '4100'])
    expect(rows.every((row) => !row.isMatch)).toBe(true)
  })

  /*
   * The rule worth stating. `Bank Account` shown without `Current Assets` above it is
   * indented twice under nothing, and the reader cannot tell where it sits.
   */
  it('keeps the ancestors of a match, and marks only the match', () => {
    /* '1210' matches nothing but the leaf, so both rows above it are there purely to
     * hold it in place — which is the distinction `isMatch` exists to draw. */
    const rows = filterChart(CHART, '1210')

    expect(codes(rows)).toEqual(['1000', '1200', '1210'])
    expect(rows.filter((row) => row.isMatch).map((row) => row.account.code)).toEqual(['1210'])
  })

  it('marks every row that matches, ancestor or not', () => {
    /* 'Bank Accounts' contains 'bank account' too, so here the parent is a match in its
     * own right rather than a row kept for its child. */
    const rows = filterChart(CHART, 'bank account')

    expect(codes(rows)).toEqual(['1000', '1200', '1210'])
    expect(rows.filter((row) => row.isMatch).map((row) => row.account.code)).toEqual([
      '1200',
      '1210',
    ])
  })

  it('matches on the code as well as the name', () => {
    expect(codes(filterChart(CHART, '4100'))).toEqual(['4000', '4100'])
  })

  it('matches on a role, which is how somebody finds where receivables go', () => {
    const rows = filterChart(CHART, 'cash')
    expect(rows.filter((row) => row.isMatch).map((row) => row.account.code)).toEqual(['1100'])
  })

  it('ignores case', () => {
    expect(codes(filterChart(CHART, 'SALES'))).toEqual(['4000', '4100'])
  })

  it('keeps a matching group and everything it needs, but not its children', () => {
    const rows = filterChart(CHART, 'Revenue')
    expect(codes(rows)).toEqual(['4000'])
  })

  it('returns nothing when nothing matches', () => {
    expect(filterChart(CHART, 'zzz')).toEqual([])
  })

  it('keeps the original order rather than the order things matched in', () => {
    const rows = filterChart(CHART, '00')
    expect(codes(rows)).toEqual(
      codes(filterChart(CHART, '')).filter((c) => codes(rows).includes(c)),
    )
  })

  it('does not lose a row whose parent is missing from the list', () => {
    const orphan = [account({ id: 'z', code: '9999', name: 'Orphan', parentId: 'gone' })]
    expect(codes(filterChart(orphan, 'orphan'))).toEqual(['9999'])
  })
})

describe('choosing a parent', () => {
  it('offers groups only — a leaf cannot hold children', () => {
    expect(possibleParents(CHART).map((a) => a.code)).toEqual(['1000', '1200', '4000'])
  })

  it('leaves out an archived group', () => {
    const withArchived = [
      ...CHART,
      account({ id: 'g', code: '1900', name: 'Old', isGroup: true, isArchived: true }),
    ]
    expect(possibleParents(withArchived).map((a) => a.code)).not.toContain('1900')
  })

  it('narrows to the type, because a child carries its parent’s type', () => {
    expect(parentsForType(CHART, 'income').map((a) => a.code)).toEqual(['4000'])
    expect(parentsForType(CHART, 'asset').map((a) => a.code)).toEqual(['1000', '1200'])
  })

  it('returns nothing when the chart has no group of that type', () => {
    expect(parentsForType(CHART, 'liability')).toEqual([])
  })
})

describe('moving an account', () => {
  it('offers groups of its own type, and never itself or a group beneath it', () => {
    /* 1000 is the group being moved: 1200 sits inside it, so moving 1000 into 1200 is a loop. */
    expect(parentsForAccount(CHART, CHART[0]!).map((a) => a.code)).toEqual([])
    expect(parentsForAccount(CHART, CHART[3]!).map((a) => a.code)).toEqual(['1000', '1200'])
    expect(parentsForAccount(CHART, CHART[5]!).map((a) => a.code)).toEqual(['4000'])
  })

  it('keeps the group it sits in now even when that group is archived', () => {
    const chart = [
      account({ id: 'g', code: '1900', name: 'Old', isGroup: true, isArchived: true }),
      account({ id: 'h', code: '1910', name: 'Under old', parentId: 'g', depth: 1 }),
      account({ id: 'i', code: '1800', name: 'Retired', isGroup: true, isArchived: true }),
    ]
    expect(parentsForAccount(chart, chart[1]!).map((a) => a.code)).toEqual(['1900'])
  })
})

describe('postableAccounts', () => {
  it('is the leaves, and never an archived one', () => {
    const withArchived = [
      ...CHART,
      account({ id: 'g', code: '1150', name: 'Old Cash', isArchived: true }),
    ]
    const codesOf = postableAccounts(withArchived).map((a) => a.code)

    expect(codesOf).toEqual(['1100', '1210', '4100'])
    expect(codesOf).not.toContain('1000')
    expect(codesOf).not.toContain('1150')
  })
})

describe('accountLabel', () => {
  it('reads as a code and a name', () => {
    expect(accountLabel(CHART[3]!)).toBe('1210 · Bank Account')
  })
})
