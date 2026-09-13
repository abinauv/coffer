/*
 * Which documents move stock, and which way.
 *
 * The point of the module is that the answer is DERIVED from `DOCUMENT_KINDS` rather than
 * listed, so the tests are written the same way: the expectations below are the four
 * sentences a person would say, and the join back to the table is asserted rather than
 * assumed. A sixth kind that nobody answered for fails here.
 */

import { describe, expect, it } from 'vitest'

import { DOCUMENT_KINDS, definitionOf, postsToLedger, type DocumentKind } from '@shared/documents'
import { STOCK_MOVEMENT_KINDS, directionOf, type StockMovementKind } from '@main/domain/inventory'

import { MOVEMENT_KINDS, movementKindFor, movesStock } from './movement'

describe('which kinds move stock', () => {
  it('is every kind that reaches the books, and only those', () => {
    expect(
      DOCUMENT_KINDS.filter((definition) => movesStock(definition.kind)).map((each) => each.kind),
    ).toEqual(['sales-invoice', 'credit-note', 'purchase-bill', 'debit-note'])
  })

  /*
   * A QUOTATION MOVES NOTHING, and the two answers coincide for a reason rather than by
   * accident: it offers a price and supplies nothing, so there is no value to move on the
   * balance sheet and no goods to take out of the register. `movesStock` asks
   * `postsToLedger` instead of carrying a second flag, and this is the join.
   */
  it('answers the same as postsToLedger for every kind', () => {
    for (const definition of DOCUMENT_KINDS) {
      expect(movesStock(definition.kind), definition.kind).toBe(postsToLedger(definition.kind))
    }
    expect(movesStock('quotation')).toBe(false)
    expect(movementKindFor('quotation')).toBeNull()
  })
})

describe('what each one does to the register', () => {
  /* The four sentences, written out. Each says both which movement and, through the
   * inventory table, which way the stock went — a mapping with two of them swapped would
   * still be total and would still name four real kinds. */
  const expected: readonly [DocumentKind, StockMovementKind, 'in' | 'out'][] = [
    ['sales-invoice', 'issue', 'out'],
    ['credit-note', 'sales-return', 'in'],
    ['purchase-bill', 'receipt', 'in'],
    ['debit-note', 'purchase-return', 'out'],
  ]

  for (const [kind, movement, direction] of expected) {
    it(`turns a ${kind} into a ${movement}, which takes stock ${direction}`, () => {
      expect(movementKindFor(kind)).toBe(movement)
      expect(directionOf(STOCK_MOVEMENT_KINDS[movement].kind)).toBe(direction)
    })
  }

  it('is total over both unions, so a kind on a new side would not compile', () => {
    /* The runtime half of a compile-time guarantee: every side and direction the table
     * actually holds has an answer here. The type is what stops a new one being added
     * without one; this is what stops the table and the record drifting apart. */
    for (const definition of DOCUMENT_KINDS) {
      const answer = MOVEMENT_KINDS[definition.side][definition.direction]
      expect(answer, `${definition.side}/${definition.direction}`).toBeDefined()
      expect(STOCK_MOVEMENT_KINDS[answer].kind).toBe(answer)
    }
  })

  /*
   * DERIVED FROM THE TWO FIELDS, NOT LISTED PER KIND. The property that says so: the
   * answer depends on the side and the direction and on nothing else, so two kinds with
   * the same pair get the same movement. There is no such pair in the shipped table — a
   * quotation is the only other sales/charge row and it posts nothing — so the assertion
   * is made against the derivation itself.
   */
  it('reads the answer off the side and the direction, and nothing else', () => {
    for (const definition of DOCUMENT_KINDS) {
      if (!movesStock(definition.kind)) continue
      expect(movementKindFor(definition.kind), definition.kind).toBe(
        MOVEMENT_KINDS[definitionOf(definition.kind).side][definitionOf(definition.kind).direction],
      )
    }
  })
})
