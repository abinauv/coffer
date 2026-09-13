import { describe, expect, it } from 'vitest'
import { D, Decimal } from '@main/domain/money'
import fixture from './__fixtures__/edge-cases.json'
import { layerOf, movementOf, type LayerSpec, type MovementSpec } from './__fixtures__/movements'
import { MOVING_AVERAGE, POOLED_LAYER_KEY, movingAverageState } from './moving-average'
import { EMPTY_STOCK, checkState } from './state'
import type { InventoryErrorCode, ValuationState } from './types'

interface StateSpec {
  quantity: string
  value: string
  layers?: LayerSpec[]
}

interface EdgeCase {
  name: string
  why: string
  state: StateSpec
  movement: MovementSpec
  expected:
    | { ok: true; cost: string; quantity: string; value: string; unitCost: string }
    | { ok: false; code: InventoryErrorCode }
}

const golden = fixture as unknown as { cases: EdgeCase[] }

function stateFrom(spec: StateSpec): ValuationState {
  if (spec.layers === undefined) {
    return movingAverageState(D(spec.quantity), D(spec.value))
  }
  return { quantity: D(spec.quantity), value: D(spec.value), layers: spec.layers.map(layerOf) }
}

describe('moving average — the strategy it declares itself to be', () => {
  it('is moving weighted average, pooling everything and tracking no batches', () => {
    expect(MOVING_AVERAGE.method).toBe('moving-average')
    expect(MOVING_AVERAGE.label).toBe('Moving weighted average')
    expect(MOVING_AVERAGE.identifiesLayers).toBe(false)
    expect(MOVING_AVERAGE.tracksBatches).toBe(false)
  })

  it('starts an item at nothing', () => {
    expect(MOVING_AVERAGE.empty()).toBe(EMPTY_STOCK)
  })
})

describe('moving average — golden cases', () => {
  for (const entry of golden.cases) {
    const outcomeOf = () =>
      MOVING_AVERAGE.applyMovement(stateFrom(entry.state), movementOf(entry.movement))

    if (entry.expected.ok) {
      const expected = entry.expected

      it(`${entry.name} — ${entry.why}`, () => {
        const outcome = outcomeOf()
        expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
        if (!outcome.ok) return

        expect(outcome.result.cost.toFixed(2)).toBe(expected.cost)
        expect(outcome.result.state.quantity.toFixed(3)).toBe(expected.quantity)
        expect(outcome.result.state.value.toFixed(2)).toBe(expected.value)
        expect(outcome.result.unitCost.toFixed(6)).toBe(expected.unitCost)
      })

      it(`${entry.name} — leaves a file nothing is wrong with`, () => {
        const outcome = outcomeOf()
        expect(outcome.ok).toBe(true)
        if (!outcome.ok) return
        expect(checkState(outcome.result.state)).toBeNull()
      })

      it(`${entry.name} — moves exactly one layer, and it is the pool`, () => {
        const outcome = outcomeOf()
        expect(outcome.ok).toBe(true)
        if (!outcome.ok) return
        expect(outcome.result.slices.map((slice) => slice.key)).toEqual([POOLED_LAYER_KEY])
        expect(outcome.result.slices[0]?.value.toFixed(2)).toBe(expected.cost)
        expect(outcome.result.slices[0]?.quantity.toFixed(3)).toBe(
          D(entry.movement.quantity).toFixed(3),
        )
      })
    } else {
      const expected = entry.expected

      it(`${entry.name} — refused with ${expected.code}: ${entry.why}`, () => {
        const outcome = outcomeOf()
        expect(outcome.ok).toBe(false)
        if (outcome.ok) return
        expect(outcome.problem.code).toBe(expected.code)
        expect(outcome.problem.message.length).toBeGreaterThan(0)
      })
    }
  }
})

describe('moving average — the rule itself', () => {
  const receipt = (quantity: string, cost: string, sequence: number) =>
    movementOf({ kind: 'receipt', quantity, cost, sequence })
  const issue = (quantity: string, sequence: number) =>
    movementOf({ kind: 'issue', quantity, sequence })

  function apply(state: ValuationState, movement: ReturnType<typeof issue>): ValuationState {
    const outcome = MOVING_AVERAGE.applyMovement(state, movement)
    if (!outcome.ok) {
      throw new Error(`${outcome.problem.code}: ${outcome.problem.message}`)
    }
    return outcome.result.state
  }

  it('a receipt at a new cost moves the average, weighted by what is already there', () => {
    let state = apply(EMPTY_STOCK, receipt('10.000', '1000.00', 1))
    expect(state.value.dividedBy(state.quantity).toFixed(2)).toBe('100.00')

    state = apply(state, receipt('30.000', '6000.00', 2))
    /* Not 150.00, which is the average of 100 and 200. 7000.00 over 40.000 is 175.00 */
    expect(state.value.dividedBy(state.quantity).toFixed(2)).toBe('175.00')
    expect(state.value.toFixed(2)).toBe('7000.00')
  })

  it('an issue does not move the average', () => {
    let state = apply(EMPTY_STOCK, receipt('10.000', '1000.00', 1))
    state = apply(state, issue('3.000', 2))
    expect(state.quantity.toFixed(3)).toBe('7.000')
    expect(state.value.toFixed(2)).toBe('700.00')
    expect(state.value.dividedBy(state.quantity).toFixed(2)).toBe('100.00')

    state = apply(state, issue('4.000', 3))
    expect(state.value.dividedBy(state.quantity).toFixed(2)).toBe('100.00')
  })

  it('the average resets rather than carrying a stale figure across a zero', () => {
    let state = apply(EMPTY_STOCK, receipt('10.000', '1000.00', 1))
    state = apply(state, issue('10.000', 2))
    expect(state.quantity.toFixed(3)).toBe('0.000')
    expect(state.value.toFixed(2)).toBe('0.00')
    expect(state.layers).toHaveLength(0)

    state = apply(state, receipt('10.000', '400.00', 3))
    /* 40.00, not 100.00 and not 70.00. There was nothing left to average against. */
    expect(state.value.dividedBy(state.quantity).toFixed(2)).toBe('40.00')
  })

  it('holds one pooled layer while there is stock, and none when there is not', () => {
    const held = apply(EMPTY_STOCK, receipt('10.000', '1000.00', 1))
    expect(held.layers.map((layer) => layer.key)).toEqual([POOLED_LAYER_KEY])
    expect(held.layers[0]?.quantity.toFixed(3)).toBe('10.000')
    expect(held.layers[0]?.value.toFixed(2)).toBe('1000.00')
    /* The pool has no single origin, and says so rather than reporting the last one. */
    expect(held.layers[0]?.receivedAt).toBeNull()
    expect(held.layers[0]?.sequence).toBeNull()
    expect(held.layers[0]?.batch).toBeNull()

    expect(apply(held, issue('10.000', 2)).layers).toHaveLength(0)
  })

  it('keeps the pool when quantity survives a value of nothing', () => {
    /* Both zero drops the pool; only one zero must not. */
    let state = apply(EMPTY_STOCK, receipt('10.000', '0.00', 1))
    expect(state.layers).toHaveLength(1)
    expect(state.quantity.toFixed(3)).toBe('10.000')
    state = apply(state, issue('10.000', 2))
    expect(state.layers).toHaveLength(0)
  })

  it('strands nothing over a long run of awkward issues', () => {
    /* 100.00 over 3.000 units, taken out one thousandth at a time and then emptied. The
     * value must reach exactly zero, and every intermediate value must reconcile. */
    let state = apply(EMPTY_STOCK, receipt('3.000', '100.00', 1))
    for (let step = 0; step < 40; step += 1) {
      state = apply(state, issue('0.001', step + 2))
      expect(checkState(state)).toBeNull()
    }
    state = apply(state, issue(state.quantity.toFixed(3), 100))
    expect(state.quantity.toFixed(3)).toBe('0.000')
    expect(state.value.toFixed(2)).toBe('0.00')
  })

  it('values a million units without losing the paisa', () => {
    let state = apply(EMPTY_STOCK, receipt('999999.000', '1234567.89', 1))
    state = apply(state, issue('1.000', 2))
    expect(state.value.decimalPlaces()).toBeLessThanOrEqual(2)
    expect(state.value.toFixed(2)).toBe('1234566.66')
    state = apply(state, issue('999998.000', 3))
    expect(state.value.toFixed(2)).toBe('0.00')
  })
})

describe('moving average — states it will not touch', () => {
  it('refuses a file whose quantity is not a number, before valuing anything', () => {
    const outcome = MOVING_AVERAGE.applyMovement(
      { quantity: new Decimal(NaN), value: D('100.00'), layers: [] },
      movementOf({ kind: 'issue', quantity: '1.000' }),
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.problem.code).toBe('NOT_FINITE')
  })

  it('refuses a movement whose quantity is not a number', () => {
    const movement = {
      ...movementOf({ kind: 'issue', quantity: '1.000' }),
      quantity: new Decimal(NaN),
    }
    const outcome = MOVING_AVERAGE.applyMovement(
      movingAverageState(D('10.000'), D('1000.00')),
      movement,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.problem.code).toBe('NOT_FINITE')
  })
})

describe('movingAverageState', () => {
  it('puts everything on hand into one pool', () => {
    const state = movingAverageState(D('10.000'), D('1000.00'))
    expect(state.layers.map((layer) => layer.key)).toEqual([POOLED_LAYER_KEY])
    expect(checkState(state)).toBeNull()
  })

  it('holds no layer for an item with nothing on hand', () => {
    expect(movingAverageState(D('0.000'), D('0.00')).layers).toHaveLength(0)
  })

  it('will build a diverged file, so that a test can hand one to the code that refuses it', () => {
    const diverged = movingAverageState(D('0.000'), D('250.00'))
    expect(checkState(diverged)?.code).toBe('VALUE_WITHOUT_QUANTITY')
  })
})

describe('revalue — writing stock down to net realisable value', () => {
  const held = movingAverageState(D('10.000'), D('1000.00'))

  it('writes down, and reports the adjustment with the sign it posts at', () => {
    const outcome = MOVING_AVERAGE.revalue(held, D('600.00'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.state.value.toFixed(2)).toBe('600.00')
    expect(outcome.result.state.quantity.toFixed(3)).toBe('10.000')
    expect(outcome.result.adjustment.toFixed(2)).toBe('-400.00')
    expect(outcome.result.unitCost.toFixed(6)).toBe('60.000000')
    expect(checkState(outcome.result.state)).toBeNull()
  })

  it('writes up as readily as down', () => {
    const outcome = MOVING_AVERAGE.revalue(held, D('1500.00'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.adjustment.toFixed(2)).toBe('500.00')
  })

  it('reports no adjustment, and no signed zero, when nothing changes', () => {
    const outcome = MOVING_AVERAGE.revalue(held, D('1000.00'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.adjustment.toFixed(2)).toBe('0.00')
    expect(outcome.result.adjustment.isNegative()).toBe(false)
  })

  it('writes stock down to nothing while keeping the quantity', () => {
    const outcome = MOVING_AVERAGE.revalue(held, D('0.00'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.state.quantity.toFixed(3)).toBe('10.000')
    expect(outcome.result.state.value.toFixed(2)).toBe('0.00')
    expect(outcome.result.state.layers).toHaveLength(1)
    expect(outcome.result.unitCost.toFixed(6)).toBe('0.000000')
  })

  it('refuses a value below nothing', () => {
    const outcome = MOVING_AVERAGE.revalue(held, D('-1.00'))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.problem.code).toBe('NEGATIVE_VALUE_ON_HAND')
  })

  it('refuses a value that is not a number', () => {
    const outcome = MOVING_AVERAGE.revalue(held, new Decimal(NaN))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.problem.code).toBe('NOT_FINITE')
  })

  it('refuses a value carrying a third decimal place', () => {
    const outcome = MOVING_AVERAGE.revalue(held, D('600.001'))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.problem.code).toBe('SCALE_EXCEEDED')
  })

  it('refuses to carry a value against an item holding nothing', () => {
    const outcome = MOVING_AVERAGE.revalue(EMPTY_STOCK, D('600.00'))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.problem.code).toBe('COST_WITHOUT_QUANTITY')
  })

  it('revalues an empty item to nothing without complaint', () => {
    const outcome = MOVING_AVERAGE.revalue(EMPTY_STOCK, D('0.00'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.state.layers).toHaveLength(0)
    expect(outcome.result.adjustment.toFixed(2)).toBe('0.00')
  })

  it('refuses a diverged file rather than restating it', () => {
    const outcome = MOVING_AVERAGE.revalue(movingAverageState(D('-1.000'), D('100.00')), D('50.00'))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.problem.code).toBe('NEGATIVE_QUANTITY_ON_HAND')
  })
})
