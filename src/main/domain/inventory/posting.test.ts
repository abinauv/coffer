/*
 * The stock posting rule, and the correction a back-dated movement makes necessary.
 *
 * PURE, so every case here is a movement written down beside the entry it must produce.
 * There is no database and no clock: the resolver below is four literals.
 *
 * THE ASSERTIONS ARE SIGNED FIGURES PER ACCOUNT, not "there is a debit somewhere". A rule
 * with the two sides swapped still balances and still names both accounts, so an
 * assertion that only counted lines would pass against books that were exactly backwards.
 */

import { describe, expect, it } from 'vitest'

import { D, ZERO, sum, type Decimal } from '@main/domain/money'
import type {
  AccountRef,
  AccountResolver,
  AccountRole,
  EntryDraft,
  SourceDocument,
} from '@main/domain/ledger'
import { isPostingError } from '@main/domain/ledger'
import type { DateString } from '@shared/scalars'

import { MOVING_AVERAGE } from './moving-average'
import { runStockCard, type StockCard } from './stock-card'
import { COUNTER_ROLES, costChangesBetween, movementEntry, revaluationsFor } from './posting'
import { STOCK_MOVEMENT_KIND_LIST, directionOf, type StockMovement, type StockMovementKind } from './types' // prettier-ignore

// ---- A chart of accounts, as four literals ---------------------------------

const ACCOUNTS: Readonly<Record<AccountRole, AccountRef | undefined>> = {
  stock: { id: 'a-stock', code: '1400', name: 'Stock in Hand', type: 'asset' },
  purchases: { id: 'a-purchases', code: '5100', name: 'Purchases', type: 'expense' },
  'cost-of-goods-sold': { id: 'a-cogs', code: '5300', name: 'Cost of Goods Sold', type: 'expense' },
  'stock-adjustment': { id: 'a-adj', code: '5500', name: 'Stock Adjustment', type: 'expense' },
  'opening-balance-equity': { id: 'a-obe', code: '3400', name: 'Opening Balance Equity', type: 'equity' }, // prettier-ignore
  'accounts-receivable': undefined,
  'accounts-payable': undefined,
  sales: undefined,
  'sales-returns': undefined,
  'purchase-returns': undefined,
  cash: undefined,
  bank: undefined,
  'discount-allowed': undefined,
  'discount-received': undefined,
  'freight-outward': undefined,
  'freight-inward': undefined,
  'round-off': undefined,
  'retained-earnings': undefined,
  suspense: undefined,
}

interface ChartOptions {
  /** Roles to take off the chart, so a rule that needs one has to say so. */
  without?: readonly AccountRole[]
}

function chart(options: ChartOptions = {}): AccountResolver {
  const missing = new Set(options.without ?? [])
  return {
    byId: () => null,
    byCode: () => null,
    forRole: (role) => (missing.has(role) ? null : (ACCOUNTS[role] ?? null)),
    forTaxComponent: () => null,
  }
}

const SOURCE: SourceDocument = { type: 'stock-adjustment', id: 'm-1', number: 'GRN-7' }

// ---- Reading an entry back --------------------------------------------------

/** What one account moved by, signed debit-minus-credit. */
function movedBy(draft: EntryDraft, accountId: string): string {
  return sum(
    draft.lines
      .filter((line) => line.accountId === accountId)
      .map((line) => line.debit.minus(line.credit)),
  ).toString()
}

function totalsOf(draft: EntryDraft): { debit: string; credit: string } {
  return {
    debit: sum(draft.lines.map((line) => line.debit)).toString(),
    credit: sum(draft.lines.map((line) => line.credit)).toString(),
  }
}

function entryFor(kind: StockMovementKind, cost: string, date: DateString = '2026-04-12') {
  return movementEntry(
    { kind, date, cost: D(cost), source: SOURCE, narration: 'Ball bearing 6203' },
    chart(),
  )
}

function required(draft: EntryDraft | null): EntryDraft {
  expect(draft, 'the movement moved money and should have posted').not.toBeNull()
  return draft!
}

function codeOf(build: () => unknown): string {
  try {
    build()
  } catch (error) {
    return isPostingError(error) ? error.code : `not a posting error: ${String(error)}`
  }
  return 'no error thrown'
}

// ---- The table --------------------------------------------------------------

describe('what a movement posts', () => {
  /*
   * THE HEADER TABLE, ROW BY ROW, AS SIGNED FIGURES. Each case says both which account the
   * other side went to AND which way round, because either can be wrong on its own.
   */
  const cases: readonly [StockMovementKind, AccountRole, string, string][] = [
    ['opening', 'opening-balance-equity', '1000', '-1000'],
    ['receipt', 'purchases', '1000', '-1000'],
    ['sales-return', 'cost-of-goods-sold', '1000', '-1000'],
    ['adjustment-in', 'stock-adjustment', '1000', '-1000'],
    ['issue', 'cost-of-goods-sold', '-1000', '1000'],
    ['purchase-return', 'stock-adjustment', '-1000', '1000'],
    ['adjustment-out', 'stock-adjustment', '-1000', '1000'],
  ]

  for (const [kind, role, onStock, onCounter] of cases) {
    it(`posts a ${kind} against ${role}, ${directionOf(kind) === 'in' ? 'into' : 'out of'} stock`, () => {
      const draft = required(entryFor(kind, '1000.00'))

      expect(movedBy(draft, 'a-stock')).toBe(onStock)
      expect(movedBy(draft, ACCOUNTS[role]!.id)).toBe(onCounter)
      expect(draft.lines).toHaveLength(2)
    })
  }

  it('answers for every kind the domain knows', () => {
    /* The join between this file's cases and the union. An eighth kind fails here rather
     * than posting to whatever the table happened to say last. */
    expect(cases.map(([kind]) => kind).sort()).toEqual([...STOCK_MOVEMENT_KIND_LIST].sort())
    expect(Object.keys(COUNTER_ROLES).sort()).toEqual([...STOCK_MOVEMENT_KIND_LIST].sort())
  })

  it('balances, whichever way the stock went', () => {
    for (const kind of STOCK_MOVEMENT_KIND_LIST) {
      const draft = required(entryFor(kind, '742.19'))
      expect(totalsOf(draft), kind).toEqual({ debit: '742.19', credit: '742.19' })
    }
  })

  it('posts as of the movement’s own date and carries its source through', () => {
    const draft = required(entryFor('issue', '250.00', '2026-03-31'))

    expect(draft.date).toBe('2026-03-31')
    expect(draft.source).toEqual({ type: 'stock-adjustment', id: 'm-1', number: 'GRN-7' })
    expect(draft.narration).toBe('Ball bearing 6203')
  })

  /*
   * A MOVEMENT THAT MOVED NO MONEY POSTS NOTHING, and null is the answer rather than an
   * empty draft. A free sample taken in at nil moves quantity and no value; ledger
   * invariant 5 refuses an entry of two zero lines, so there is no entry to make. Returned
   * rather than thrown, because it is not a failure — nothing moved.
   */
  it('posts nothing at all when the movement cost nothing', () => {
    for (const kind of STOCK_MOVEMENT_KIND_LIST) {
      expect(entryFor(kind, '0.00'), kind).toBeNull()
    }
  })

  it('refuses when the chart has no account for the role it needs', () => {
    expect(codeOf(() => entryFor('issue', '10.00'))).toBe('no error thrown')
    expect(
      codeOf(() =>
        movementEntry(
          { kind: 'issue', date: '2026-04-12', cost: D('10.00'), source: SOURCE, narration: 'x' },
          chart({ without: ['cost-of-goods-sold'] }),
        ),
      ),
    ).toBe('ROLE_UNMAPPED')
    expect(
      codeOf(() =>
        movementEntry(
          { kind: 'issue', date: '2026-04-12', cost: D('10.00'), source: SOURCE, narration: 'x' },
          chart({ without: ['stock'] }),
        ),
      ),
    ).toBe('ROLE_UNMAPPED')
  })
})

// ---- What a late movement did ----------------------------------------------

/**
 * The register from the reconciliation fixture, without the back-dated receipt and with
 * it. Worked by hand; see `db/repos/stock-reconciliation.test.ts` for the table.
 */
function movement(
  sequence: number,
  kind: StockMovementKind,
  date: DateString,
  quantity: string,
  cost: string | null = null,
): StockMovement {
  return {
    itemId: 'i-1',
    kind,
    date,
    sequence,
    quantity: D(quantity),
    cost: cost === null ? null : D(cost),
    layerKey: null,
    batch: null,
  }
}

const HELD: readonly StockMovement[] = [
  movement(1, 'receipt', '2026-04-05', '10.000', '1000.00'),
  movement(2, 'receipt', '2026-04-10', '20.000', '3000.00'),
  movement(3, 'issue', '2026-04-12', '5.000'),
  movement(4, 'sales-return', '2026-04-15', '5.000', '600.00'),
  movement(5, 'adjustment-out', '2026-04-18', '4.000'),
  movement(6, 'purchase-return', '2026-04-20', '6.000'),
]

/** Recorded last, dated second. The whole point. */
const LATE = movement(7, 'receipt', '2026-04-08', '10.000', '2000.00')

function cardOf(movements: readonly StockMovement[]): StockCard {
  return runStockCard(MOVING_AVERAGE, 'i-1', movements)
}

describe('what a back-dated movement changed', () => {
  const before = cardOf(HELD)
  const after = cardOf([...HELD, LATE])
  const changes = costChangesBetween(before, after)

  it('finds every outward movement it re-valued, and only those', () => {
    expect(
      changes.map((change) => [
        change.sequence,
        change.date,
        change.before.toString(),
        change.after.toString(),
        change.delta.toString(),
      ]),
    ).toEqual([
      [3, '2026-04-12', '666.67', '750', '83.33'],
      [5, '2026-04-18', '524.44', '585', '60.56'],
      [6, '2026-04-20', '786.67', '877.5', '90.83'],
    ])
  })

  /*
   * THE SALES RETURN ON THE 15TH IS NOT IN THE LIST, and its absence is the assertion
   * rather than an accident of the fixture. An inward movement STATES its cost (invariant
   * 4) and no re-average can move a figure the row itself carries. The day a strategy
   * re-values a receipt, this goes red and `revaluationsFor` has to be looked at again.
   */
  it('never re-values an inward movement, because an inward movement states its cost', () => {
    expect(changes.every((change) => directionOf(change.kind) === 'out')).toBe(true)
    expect(changes.map((change) => change.sequence)).not.toContain(4)
  })

  it('finds nothing when the movement is recorded in date order', () => {
    const inOrder = movement(7, 'receipt', '2026-04-25', '10.000', '2000.00')
    expect(costChangesBetween(cardOf(HELD), cardOf([...HELD, inOrder]))).toEqual([])
  })

  /*
   * A CARD THAT COULD NOT BE FOLDED CONTRIBUTES NOTHING. `runStockCard` stops at the first
   * movement it cannot value, so its later rows are ABSENT rather than unchanged — and
   * reading an absence as "the cost fell to nothing" would post a correction for movements
   * that are simply not in the answer.
   */
  it('says nothing changed when either card stopped early', () => {
    const broken = cardOf([movement(1, 'issue', '2026-04-01', '5.000')])
    expect(broken.problem?.code).toBe('INSUFFICIENT_STOCK')
    expect(costChangesBetween(broken, after)).toEqual([])
    expect(costChangesBetween(before, broken)).toEqual([])
  })
})

describe('the entries that restate what changed', () => {
  const changes = costChangesBetween(cardOf(HELD), cardOf([...HELD, LATE]))
  const narrate = (date: DateString) => `Re-valued on ${date}`
  const revaluations = revaluationsFor(changes, chart(), SOURCE, narrate)

  it('makes one per affected date, in date order, and dates each at the movement it restates', () => {
    expect(revaluations.map((each) => [each.date, each.draft.date])).toEqual([
      ['2026-04-12', '2026-04-12'],
      ['2026-04-18', '2026-04-18'],
      ['2026-04-20', '2026-04-20'],
    ])
  })

  it('moves stock the other way from the expense, by the change in cost', () => {
    const [issue, writeOff, sentBack] = revaluations
    expect(issue).toBeDefined()

    expect(movedBy(issue!.draft, 'a-stock')).toBe('-83.33')
    expect(movedBy(issue!.draft, 'a-cogs')).toBe('83.33')
    expect(issue!.stockAmount.toString()).toBe('-83.33')

    /* A write-off and a purchase return both face the adjustment account. */
    expect(movedBy(writeOff!.draft, 'a-adj')).toBe('60.56')
    expect(movedBy(sentBack!.draft, 'a-adj')).toBe('90.83')
  })

  /*
   * GROUPED BY THE COUNTER ACCOUNT OF EACH RESTATED MOVEMENT, not lumped onto cost of
   * goods sold. Two movements of different kinds on one day move two different expense
   * accounts, and posting both to one nets to the right profit with both lines wrong.
   */
  it('splits one date across the accounts the movements on it face', () => {
    const sameDay: readonly StockMovement[] = [
      movement(1, 'receipt', '2026-04-05', '10.000', '1000.00'),
      movement(2, 'issue', '2026-04-12', '2.000'),
      movement(3, 'adjustment-out', '2026-04-12', '2.000'),
    ]
    const late = movement(4, 'receipt', '2026-04-06', '10.000', '3000.00')

    const [entry, ...rest] = revaluationsFor(
      costChangesBetween(cardOf(sameDay), cardOf([...sameDay, late])),
      chart(),
      SOURCE,
      narrate,
    )
    expect(rest).toEqual([])
    expect(entry).toBeDefined()

    /*
     * 10 at 100 then 10 at 300 is 20 at 200, so the pool doubles in unit cost. The issue
     * of 2 cost 400 where it cost 200, and the write-off of 2 cost 400 where it cost 200
     * — each account moves by 200 and stock by the 400 they add up to.
     */
    expect(movedBy(entry!.draft, 'a-cogs')).toBe('200')
    expect(movedBy(entry!.draft, 'a-adj')).toBe('200')
    expect(movedBy(entry!.draft, 'a-stock')).toBe('-400')
    expect(entry!.changes).toHaveLength(2)
  })

  it('makes nothing at all when nothing changed', () => {
    expect(revaluationsFor([], chart(), SOURCE, narrate)).toEqual([])
  })

  /*
   * A DATE WHOSE CHANGES CANCEL POSTS NOTHING. The stock line would be zero and ledger
   * invariant 5 refuses a line that is neither a debit nor a credit — so the entry has to
   * be skipped rather than built and refused three layers down.
   */
  it('posts nothing for a date whose changes cancel each other out', () => {
    const cancelling = [
      { kind: 'issue' as const, date: '2026-04-12' as DateString, sequence: 1, before: D('10.00'), after: D('20.00'), delta: D('10.00') }, // prettier-ignore
      { kind: 'issue' as const, date: '2026-04-12' as DateString, sequence: 2, before: D('20.00'), after: D('10.00'), delta: D('-10.00') }, // prettier-ignore
    ]
    expect(revaluationsFor(cancelling, chart(), SOURCE, narrate)).toEqual([])
  })

  it('balances every entry it makes, at a figure that is not nothing', () => {
    expect(revaluations.map((each) => [each.date, totalsOf(each.draft)])).toEqual([
      ['2026-04-12', { debit: '83.33', credit: '83.33' }],
      ['2026-04-18', { debit: '60.56', credit: '60.56' }],
      ['2026-04-20', { debit: '90.83', credit: '90.83' }],
    ])

    /* "It balances" on its own is true of an entry of two zeroes, which invariant 5
     * refuses — so the figures above are written out and the total is checked against
     * nothing separately. */
    for (const revaluation of revaluations) {
      const debits: Decimal = sum(revaluation.draft.lines.map((line) => line.debit))
      expect(debits.greaterThan(ZERO), revaluation.date).toBe(true)
      expect(revaluation.draft.lines.length, revaluation.date).toBeGreaterThanOrEqual(2)
    }
  })
})
