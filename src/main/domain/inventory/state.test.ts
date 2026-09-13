import { describe, expect, it } from 'vitest'
import { D, Decimal, ZERO } from '@main/domain/money'
import { layerOf, movementOf } from './__fixtures__/movements'
import {
  EMPTY_STOCK,
  checkMovement,
  checkMovementDate,
  checkState,
  statedCostOf,
  unitCostOfState,
} from './state'
import { STOCK_MOVEMENT_KIND_LIST, costSourceOf, type ValuationState } from './types'

function stateOf(
  quantity: string,
  value: string,
  layers = [layerOf({ key: 'l', quantity, value })],
) {
  return { quantity: D(quantity), value: D(value), layers } satisfies ValuationState
}

describe('EMPTY_STOCK', () => {
  it('holds nothing, is worth nothing, and has no layer to hold either', () => {
    expect(EMPTY_STOCK.quantity.toFixed(3)).toBe('0.000')
    expect(EMPTY_STOCK.value.toFixed(2)).toBe('0.00')
    expect(EMPTY_STOCK.layers).toHaveLength(0)
  })

  it('is a state nothing is wrong with', () => {
    expect(checkState(EMPTY_STOCK)).toBeNull()
  })

  it('has no unit cost, rather than an undefined one', () => {
    expect(unitCostOfState(EMPTY_STOCK).toFixed(6)).toBe('0.000000')
  })
})

describe('checkState — what a stock file may not be', () => {
  it('accepts an ordinary file', () => {
    expect(checkState(stateOf('10.000', '1000.00'))).toBeNull()
  })

  it('accepts quantity with no value, which is a free sample or a full write-down', () => {
    expect(checkState(stateOf('10.000', '0.00'))).toBeNull()
    expect(unitCostOfState(stateOf('10.000', '0.00')).toFixed(6)).toBe('0.000000')
  })

  it('refuses value with no quantity, which no movement can produce', () => {
    expect(checkState(stateOf('0.000', '250.00'))?.code).toBe('VALUE_WITHOUT_QUANTITY')
  })

  it('refuses a quantity that is not a number', () => {
    const state = { quantity: new Decimal(NaN), value: D('100.00'), layers: [] }
    expect(checkState(state)?.code).toBe('NOT_FINITE')
  })

  it('refuses a value that is not a number', () => {
    /* Separately from the quantity: the compound condition needs the input each half
     * alone excludes, or half of it is untested. */
    const state = { quantity: D('10.000'), value: new Decimal(Infinity), layers: [] }
    expect(checkState(state)?.code).toBe('NOT_FINITE')
  })

  it('refuses a quantity carrying more places than a quantity column holds', () => {
    expect(checkState(stateOf('10.0001', '1000.00'))?.code).toBe('SCALE_EXCEEDED')
  })

  it('refuses a value carrying more places than a money column holds', () => {
    expect(checkState(stateOf('10.000', '1000.001'))?.code).toBe('SCALE_EXCEEDED')
  })

  it('refuses a negative quantity', () => {
    expect(checkState(stateOf('-1.000', '100.00'))?.code).toBe('NEGATIVE_QUANTITY_ON_HAND')
  })

  it('refuses a negative value', () => {
    expect(checkState(stateOf('1.000', '-100.00'))?.code).toBe('NEGATIVE_VALUE_ON_HAND')
  })

  it('refuses layers whose quantities do not add up to the aggregate', () => {
    const state = {
      quantity: D('10.000'),
      value: D('1000.00'),
      layers: [layerOf({ key: 'a', quantity: '9.000', value: '1000.00' })],
    }
    expect(checkState(state)?.code).toBe('LAYERS_DISAGREE')
  })

  it('refuses layers whose values do not add up to the aggregate', () => {
    const state = {
      quantity: D('10.000'),
      value: D('1000.00'),
      layers: [layerOf({ key: 'a', quantity: '10.000', value: '900.00' })],
    }
    expect(checkState(state)?.code).toBe('LAYERS_DISAGREE')
  })

  it('refuses a layer that is not a number, before it is summed', () => {
    const state = {
      quantity: D('10.000'),
      value: D('1000.00'),
      layers: [
        { ...layerOf({ key: 'a', quantity: '10.000', value: '1000.00' }), value: new Decimal(NaN) },
      ],
    }
    expect(checkState(state)?.code).toBe('NOT_FINITE')
  })

  it('refuses a negative layer hiding behind a positive total', () => {
    const state = {
      quantity: D('10.000'),
      value: D('1000.00'),
      layers: [
        layerOf({ key: 'a', quantity: '11.000', value: '500.00' }),
        layerOf({ key: 'b', quantity: '-1.000', value: '500.00' }),
      ],
    }
    expect(checkState(state)?.code).toBe('NEGATIVE_QUANTITY_ON_HAND')
  })

  it('refuses a layer valued below nothing behind a positive total', () => {
    const state = {
      quantity: D('10.000'),
      value: D('1000.00'),
      layers: [
        layerOf({ key: 'a', quantity: '5.000', value: '1100.00' }),
        layerOf({ key: 'b', quantity: '5.000', value: '-100.00' }),
      ],
    }
    expect(checkState(state)?.code).toBe('NEGATIVE_VALUE_ON_HAND')
  })

  it('accepts a file broken into several layers that do add up', () => {
    const state = {
      quantity: D('10.000'),
      value: D('1000.00'),
      layers: [
        layerOf({
          key: 'a',
          quantity: '4.000',
          value: '600.00',
          receivedAt: '2026-04-01',
          sequence: 1,
        }),
        layerOf({
          key: 'b',
          quantity: '6.000',
          value: '400.00',
          receivedAt: '2026-04-09',
          sequence: 2,
        }),
      ],
    }
    expect(checkState(state)).toBeNull()
  })
})

describe('checkMovementDate', () => {
  it('accepts a real calendar date', () => {
    expect(checkMovementDate(movementOf({ kind: 'issue', quantity: '1.000' }))).toBeNull()
  })

  it('refuses a day that does not exist', () => {
    const movement = movementOf({ kind: 'issue', quantity: '1.000', date: '2026-04-31' })
    expect(checkMovementDate(movement)?.code).toBe('INVALID_DATE')
  })

  it('refuses text that is not a date at all', () => {
    const movement = movementOf({ kind: 'issue', quantity: '1.000', date: 'yesterday' })
    expect(checkMovementDate(movement)?.code).toBe('INVALID_DATE')
  })
})

describe('checkMovement — what a movement may not be', () => {
  it('accepts an ordinary receipt and an ordinary issue', () => {
    expect(
      checkMovement(movementOf({ kind: 'receipt', quantity: '1.000', cost: '100.00' })),
    ).toBeNull()
    expect(checkMovement(movementOf({ kind: 'issue', quantity: '1.000' }))).toBeNull()
  })

  it('refuses a movement with no valid date, before anything else', () => {
    const movement = movementOf({ kind: 'receipt', quantity: '-1.000', date: '2026-04-31' })
    expect(checkMovement(movement)?.code).toBe('INVALID_DATE')
  })

  it('refuses a quantity that is not a number', () => {
    const movement = {
      ...movementOf({ kind: 'issue', quantity: '1.000' }),
      quantity: new Decimal(NaN),
    }
    expect(checkMovement(movement)?.code).toBe('NOT_FINITE')
  })

  it('refuses a negative quantity, because direction is on the kind', () => {
    expect(
      checkMovement(movementOf({ kind: 'receipt', quantity: '-1.000', cost: '100.00' }))?.code,
    ).toBe('NEGATIVE_QUANTITY')
  })

  it('accepts a quantity of zero, which is a real movement', () => {
    expect(
      checkMovement(movementOf({ kind: 'receipt', quantity: '0.000', cost: '140.00' })),
    ).toBeNull()
  })

  it('refuses a quantity carrying a fourth decimal place', () => {
    expect(
      checkMovement(movementOf({ kind: 'receipt', quantity: '1.0001', cost: '100.00' }))?.code,
    ).toBe('SCALE_EXCEEDED')
  })

  it('refuses a cost that is not a number', () => {
    const movement = {
      ...movementOf({ kind: 'receipt', quantity: '1.000', cost: '100.00' }),
      cost: new Decimal(Infinity),
    }
    expect(checkMovement(movement)?.code).toBe('NOT_FINITE')
  })

  it('refuses a negative cost', () => {
    expect(
      checkMovement(movementOf({ kind: 'receipt', quantity: '1.000', cost: '-100.00' }))?.code,
    ).toBe('NEGATIVE_COST')
  })

  it('refuses a cost carrying a third decimal place', () => {
    expect(
      checkMovement(movementOf({ kind: 'receipt', quantity: '1.000', cost: '100.001' }))?.code,
    ).toBe('SCALE_EXCEEDED')
  })

  it('accepts a cost of zero, which is a free sample', () => {
    expect(
      checkMovement(movementOf({ kind: 'receipt', quantity: '5.000', cost: '0.00' })),
    ).toBeNull()
  })

  /*
   * Invariant 4 over the WHOLE table rather than over the two kinds that came to mind.
   * An eighth movement kind is answered for here the day it is added.
   */
  it.each(STOCK_MOVEMENT_KIND_LIST)('%s asks for a cost exactly as its direction says', (kind) => {
    const withCost = checkMovement(movementOf({ kind, quantity: '1.000', cost: '100.00' }))
    const withoutCost = checkMovement(movementOf({ kind, quantity: '1.000' }))

    if (costSourceOf(kind) === 'stated') {
      expect(withCost).toBeNull()
      expect(withoutCost?.code).toBe('COST_REQUIRED')
    } else {
      expect(withCost?.code).toBe('COST_NOT_PERMITTED')
      expect(withoutCost).toBeNull()
    }
  })
})

describe('statedCostOf', () => {
  it('is the cost an inward movement stated', () => {
    expect(
      statedCostOf(movementOf({ kind: 'receipt', quantity: '1.000', cost: '140.00' })).toFixed(2),
    ).toBe('140.00')
  })

  it('is zero for an outward movement, which states none', () => {
    expect(statedCostOf(movementOf({ kind: 'issue', quantity: '1.000' })).equals(ZERO)).toBe(true)
  })
})

describe('unitCostOfState', () => {
  it('is the value over the quantity', () => {
    expect(unitCostOfState(stateOf('150.000', '38750.00')).toFixed(6)).toBe('258.333333')
  })
})
