import { describe, expect, it } from 'vitest'
import { D } from '@main/domain/money'
import fixture from './__fixtures__/stock-card.json'
import { TEST_ITEM, movementOf, type MovementSpec } from './__fixtures__/movements'
import { MOVING_AVERAGE, movingAverageState } from './moving-average'
import { runStockCard } from './stock-card'
import type { StockMovementKind } from './types'

interface GoldenMovement {
  sequence: number
  date: string
  kind: StockMovementKind
  quantity: string
  cost: string | null
}

interface GoldenRow {
  sequence: number
  kind: StockMovementKind
  moved: string
  cost: string
  quantity: string
  unitCost: string
  value: string
  why: string
}

const golden = fixture as unknown as {
  itemId: string
  opening: { quantity: string; value: string }
  movements: GoldenMovement[]
  expected: {
    rows: GoldenRow[]
    closing: { quantity: string; value: string; unitCost: string }
    quantityIn: string
    quantityOut: string
    costIn: string
    costOut: string
  }
}

const movements = golden.movements.map((entry) =>
  movementOf({
    kind: entry.kind,
    quantity: entry.quantity,
    cost: entry.cost,
    date: entry.date,
    sequence: entry.sequence,
    itemId: golden.itemId,
  }),
)

const card = runStockCard(
  MOVING_AVERAGE,
  golden.itemId,
  movements,
  movingAverageState(D(golden.opening.quantity), D(golden.opening.value)),
)

describe('the worked stock card', () => {
  it('is written down in an order that disagrees with the answer', () => {
    /* The guard on the fixture itself. A card listed in card order cannot tell a sorted
     * fold from an unsorted one, and this project has shipped that test twice. */
    const fileOrder = golden.movements.map((entry) => entry.sequence)
    const cardOrder = golden.expected.rows.map((row) => row.sequence)
    expect(fileOrder).not.toEqual(cardOrder)
    expect(fileOrder).not.toEqual([...cardOrder].reverse())
    expect([...fileOrder].sort((a, b) => a - b)).toEqual(cardOrder)
  })

  it('values every movement', () => {
    expect(card.problem).toBeNull()
    expect(card.rows).toHaveLength(golden.expected.rows.length)
  })

  it('folds them in date-then-sequence order, not the order they were listed', () => {
    expect(card.rows.map((row) => row.movement.sequence)).toEqual(
      golden.expected.rows.map((row) => row.sequence),
    )
  })

  golden.expected.rows.forEach((expected, index) => {
    it(`row ${String(index + 1)} — ${expected.kind} ${expected.moved}: ${expected.why}`, () => {
      const row = card.rows[index]
      expect(row, `no row ${String(index)}`).toBeDefined()
      if (row === undefined) return

      /* By position and by value, every column. A figure found "somewhere in the row" is
       * found just as happily when two columns have been swapped. */
      expect(row.movement.sequence).toBe(expected.sequence)
      expect(row.movement.kind).toBe(expected.kind)
      expect(row.movement.quantity.toFixed(3)).toBe(expected.moved)
      expect(row.cost.toFixed(2)).toBe(expected.cost)
      expect(row.quantity.toFixed(3)).toBe(expected.quantity)
      expect(row.unitCost.toFixed(6)).toBe(expected.unitCost)
      expect(row.value.toFixed(2)).toBe(expected.value)
    })
  })

  it('closes where the last row left it', () => {
    expect(card.closing.quantity.toFixed(3)).toBe(golden.expected.closing.quantity)
    expect(card.closing.value.toFixed(2)).toBe(golden.expected.closing.value)
    expect(card.rows.at(-1)?.value.toFixed(2)).toBe(golden.expected.closing.value)
  })

  it('adds up to the totals written in the fixture', () => {
    /* Pinned as LITERALS, not as an identity over the rows. An identity that holds by
     * construction stays true when a whole movement is dropped — CONVENTIONS §1.10. */
    expect(card.quantityIn.toFixed(3)).toBe(golden.expected.quantityIn)
    expect(card.quantityOut.toFixed(3)).toBe(golden.expected.quantityOut)
    expect(card.costIn.toFixed(2)).toBe(golden.expected.costIn)
    expect(card.costOut.toFixed(2)).toBe(golden.expected.costOut)
  })

  it('reconciles: opening plus what came in less what went out is the closing value', () => {
    expect(card.opening.value.plus(card.costIn).minus(card.costOut).toFixed(2)).toBe(
      golden.expected.closing.value,
    )
    expect(card.opening.quantity.plus(card.quantityIn).minus(card.quantityOut).toFixed(3)).toBe(
      golden.expected.closing.quantity,
    )
  })

  it('names the item and the method it was costed by', () => {
    expect(card.itemId).toBe(golden.itemId)
    expect(card.method).toBe('moving-average')
  })
})

describe('order', () => {
  const spec = (
    sequence: number,
    date: string,
    kind: StockMovementKind,
    quantity: string,
    cost?: string,
  ): MovementSpec => ({ kind, quantity, cost, date, sequence })

  it('puts a back-dated movement where its DATE says, not where its sequence does', () => {
    /* Entered third, dated second. Under moving average this is not a cosmetic reorder:
     * it changes the average the issue leaves at, and therefore the cost of a sale. */
    const backDated = [
      movementOf(spec(1, '2026-01-10', 'receipt', '10.000', '1000.00')),
      movementOf(spec(2, '2026-01-20', 'issue', '5.000')),
      movementOf(spec(3, '2026-01-15', 'receipt', '10.000', '3000.00')),
    ]
    const result = runStockCard(MOVING_AVERAGE, TEST_ITEM, backDated)

    expect(result.rows.map((row) => row.movement.sequence)).toEqual([1, 3, 2])
    /* Ordered by sequence alone the issue would have cost 500.00 and the card would have
     * closed at 3500.00. Both figures are plausible; only one is right. */
    expect(result.rows.map((row) => row.cost.toFixed(2))).toEqual(['1000.00', '3000.00', '1000.00'])
    expect(result.closing.value.toFixed(2)).toBe('3000.00')
    expect(result.closing.quantity.toFixed(3)).toBe('15.000')
  })

  it('breaks a tie on one date by sequence, not by the order the rows arrived', () => {
    /* All three on the same day, listed 3, 2, 1. A date-only sort is stable and would
     * leave them exactly as listed, which gives a different closing value. */
    const sameDay = [
      movementOf(spec(3, '2026-02-01', 'receipt', '10.000', '3000.00')),
      movementOf(spec(2, '2026-02-01', 'issue', '5.000')),
      movementOf(spec(1, '2026-02-01', 'receipt', '10.000', '1000.00')),
    ]
    const result = runStockCard(MOVING_AVERAGE, TEST_ITEM, sameDay)

    expect(result.rows.map((row) => row.movement.sequence)).toEqual([1, 2, 3])
    expect(result.rows.map((row) => row.cost.toFixed(2))).toEqual(['1000.00', '500.00', '3000.00'])
    expect(result.closing.value.toFixed(2)).toBe('3500.00')
  })

  it('refuses two movements that share a sequence', () => {
    const ambiguous = [
      movementOf(spec(1, '2026-02-01', 'receipt', '10.000', '1000.00')),
      movementOf(spec(1, '2026-02-01', 'issue', '5.000')),
    ]
    const result = runStockCard(MOVING_AVERAGE, TEST_ITEM, ambiguous)
    expect(result.problem?.code).toBe('DUPLICATE_SEQUENCE')
    expect(result.rows).toHaveLength(0)
  })
})

describe('what a card refuses before it values anything', () => {
  it('refuses a movement belonging to another item', () => {
    const mixed = [
      movementOf({ kind: 'receipt', quantity: '10.000', cost: '1000.00', sequence: 1 }),
      movementOf({
        kind: 'receipt',
        quantity: '5.000',
        cost: '900.00',
        sequence: 2,
        itemId: 'item-gadget',
      }),
    ]
    const result = runStockCard(MOVING_AVERAGE, TEST_ITEM, mixed)
    expect(result.problem?.code).toBe('WRONG_ITEM')
    expect(result.problem?.details.found).toBe('item-gadget')
    expect(result.rows).toHaveLength(0)
  })

  it('refuses a movement with no real date, rather than letting the sort throw', () => {
    const undated = [
      movementOf({ kind: 'receipt', quantity: '10.000', cost: '1000.00', sequence: 1 }),
      movementOf({
        kind: 'receipt',
        quantity: '5.000',
        cost: '900.00',
        sequence: 2,
        date: '2026-04-31',
      }),
    ]
    const result = runStockCard(MOVING_AVERAGE, TEST_ITEM, undated)
    expect(result.problem?.code).toBe('INVALID_DATE')
    expect(result.rows).toHaveLength(0)
  })
})

describe('a card that cannot be completed', () => {
  const movementsWithGap = [
    movementOf({
      kind: 'receipt',
      quantity: '10.000',
      cost: '1000.00',
      date: '2026-03-01',
      sequence: 1,
    }),
    movementOf({ kind: 'issue', quantity: '20.000', date: '2026-03-02', sequence: 2 }),
    movementOf({
      kind: 'receipt',
      quantity: '5.000',
      cost: '900.00',
      date: '2026-03-03',
      sequence: 3,
    }),
  ]
  const result = runStockCard(MOVING_AVERAGE, TEST_ITEM, movementsWithGap)

  it('stops at the movement it cannot value', () => {
    expect(result.problem?.code).toBe('INSUFFICIENT_STOCK')
    expect(result.problem?.details.onHand).toBe('10')
    expect(result.problem?.details.requested).toBe('20')
  })

  it('does not skip it and carry on', () => {
    /* The third movement is perfectly valuable and must NOT appear. A card that skipped
     * the bad row would tie at the foot and close at the wrong figure. */
    expect(result.rows.map((row) => row.movement.sequence)).toEqual([1])
    expect(result.closing.value.toFixed(2)).toBe('1000.00')
    expect(result.costIn.toFixed(2)).toBe('1000.00')
  })
})

describe('a card with nothing on it', () => {
  const result = runStockCard(MOVING_AVERAGE, TEST_ITEM, [])

  it('is complete, empty, and closes where it opened', () => {
    expect(result.problem).toBeNull()
    expect(result.rows).toHaveLength(0)
    expect(result.closing).toBe(MOVING_AVERAGE.empty())
    expect(result.quantityIn.toFixed(3)).toBe('0.000')
    expect(result.quantityOut.toFixed(3)).toBe('0.000')
    expect(result.costIn.toFixed(2)).toBe('0.00')
    expect(result.costOut.toFixed(2)).toBe('0.00')
  })

  it('carries an opening state through untouched when one is given', () => {
    const opened = runStockCard(
      MOVING_AVERAGE,
      TEST_ITEM,
      [],
      movingAverageState(D('4.000'), D('900.00')),
    )
    expect(opened.opening.value.toFixed(2)).toBe('900.00')
    expect(opened.closing.value.toFixed(2)).toBe('900.00')
  })
})

describe('the movements are not mutated', () => {
  it('sorts a copy, so the caller keeps the array it passed', () => {
    const given = [
      movementOf({ kind: 'issue', quantity: '1.000', date: '2026-05-02', sequence: 2 }),
      movementOf({
        kind: 'receipt',
        quantity: '10.000',
        cost: '1000.00',
        date: '2026-05-01',
        sequence: 1,
      }),
    ]
    const before = given.map((movement) => movement.sequence)
    runStockCard(MOVING_AVERAGE, TEST_ITEM, given)
    expect(given.map((movement) => movement.sequence)).toEqual(before)
  })
})
