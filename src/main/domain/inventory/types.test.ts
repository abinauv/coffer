import { describe, expect, it } from 'vitest'
import {
  COST_SOURCE,
  STOCK_MOVEMENT_KINDS,
  STOCK_MOVEMENT_KIND_LIST,
  costSourceOf,
  definitionOf,
  directionOf,
  refusal,
  type StockDirection,
  type StockMovementKind,
} from './types'

describe('the movement kind table', () => {
  it('answers for every kind in the union, and for nothing else', () => {
    /* The two are written out separately — a `Record` the compiler checks, and a list a
     * screen iterates — so this is what keeps them the same set. */
    expect(Object.keys(STOCK_MOVEMENT_KINDS).sort()).toEqual([...STOCK_MOVEMENT_KIND_LIST].sort())
  })

  it('lists each kind once', () => {
    expect(new Set(STOCK_MOVEMENT_KIND_LIST).size).toBe(STOCK_MOVEMENT_KIND_LIST.length)
  })

  it.each(STOCK_MOVEMENT_KIND_LIST)('%s carries its own key, a label and a direction', (kind) => {
    const definition = definitionOf(kind)
    expect(definition.kind).toBe(kind)
    expect(definition.label.length).toBeGreaterThan(0)
    expect(['in', 'out']).toContain(definition.direction)
  })

  it('gives every kind a distinct label, so a card can be read', () => {
    const labels = STOCK_MOVEMENT_KIND_LIST.map((kind) => definitionOf(kind).label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('has both directions represented', () => {
    const directions = new Set(STOCK_MOVEMENT_KIND_LIST.map(directionOf))
    expect([...directions].sort()).toEqual(['in', 'out'])
  })

  it('puts each kind on the side the accounting says it is on', () => {
    /* Pinned by value. A stock movement that changed direction would change the sign of
     * a cost-of-goods-sold posting, and nothing downstream could tell. */
    const expected: Record<StockMovementKind, StockDirection> = {
      opening: 'in',
      receipt: 'in',
      issue: 'out',
      'purchase-return': 'out',
      'sales-return': 'in',
      'adjustment-in': 'in',
      'adjustment-out': 'out',
    }
    for (const kind of STOCK_MOVEMENT_KIND_LIST) {
      expect(directionOf(kind), kind).toBe(expected[kind])
    }
  })
})

describe('who supplies the cost', () => {
  it('is stated on the way in and computed on the way out', () => {
    expect(COST_SOURCE.in).toBe('stated')
    expect(COST_SOURCE.out).toBe('valued')
  })

  it('follows the direction for every kind, and is not a second field to disagree with it', () => {
    for (const kind of STOCK_MOVEMENT_KIND_LIST) {
      expect(costSourceOf(kind), kind).toBe(COST_SOURCE[directionOf(kind)])
    }
  })

  it('asks the caller for a cost on exactly the four inward kinds', () => {
    const stated = STOCK_MOVEMENT_KIND_LIST.filter((kind) => costSourceOf(kind) === 'stated')
    expect([...stated].sort()).toEqual(
      ['adjustment-in', 'opening', 'receipt', 'sales-return'].sort(),
    )
  })
})

describe('refusal', () => {
  it('carries the code, a sentence, and details as text that can cross IPC', () => {
    const problem = refusal('INSUFFICIENT_STOCK', 'There are 4.000 on hand.', {
      onHand: '4.000',
      sequence: 7,
    })
    expect(problem.code).toBe('INSUFFICIENT_STOCK')
    expect(problem.message).toBe('There are 4.000 on hand.')
    expect(problem.details).toEqual({ onHand: '4.000', sequence: 7 })
  })

  it('has empty details when none are given', () => {
    expect(refusal('NOT_FINITE', 'no').details).toEqual({})
  })
})
