import { describe, expect, it } from 'vitest'
import { D, Decimal, roundMoney, SCALE } from '@main/domain/money'
import { UNIT_COST_SCALE, roundUnitCost, shareOfCost, unitCostOf } from './cost'

describe('the unit-cost scale', () => {
  it('is six places', () => {
    /* Pinned by value. Changing it is a change to what a stock card reports and to the
     * quantity above which the column stops reconciling — see the header of cost.ts. */
    expect(UNIT_COST_SCALE).toBe(6)
  })

  it('is more places than a quantity carries, which is the whole point', () => {
    expect(UNIT_COST_SCALE).toBeGreaterThan(SCALE.quantity)
    expect(UNIT_COST_SCALE).toBeGreaterThan(SCALE.money)
  })

  it('rounds half-up, like everything else in the product', () => {
    expect(roundUnitCost(D('0.0000005')).toFixed(6)).toBe('0.000001')
    expect(roundUnitCost(D('1.2345675')).toFixed(6)).toBe('1.234568')
    expect(roundUnitCost(D('1.2345674')).toFixed(6)).toBe('1.234567')
    expect(roundUnitCost(D('-0.0000005')).toFixed(6)).toBe('-0.000001')
  })

  it('never produces a signed zero', () => {
    expect(roundUnitCost(D('-0.0000004')).isNegative()).toBe(false)
    expect(roundUnitCost(D('-0.0000004')).toFixed(6)).toBe('0.000000')
  })
})

describe('unitCostOf', () => {
  it('divides value by quantity', () => {
    expect(unitCostOf(D('150.000'), D('38750.00')).toFixed(6)).toBe('258.333333')
    expect(unitCostOf(D('3.000'), D('100.00')).toFixed(6)).toBe('33.333333')
  })

  it('is zero when nothing is on hand — not NaN and not Infinity', () => {
    const empty = unitCostOf(D('0.000'), D('0.00'))
    expect(empty.isFinite()).toBe(true)
    expect(empty.toFixed(6)).toBe('0.000000')
  })

  it('is zero, not Infinity, for a diverged file holding value against nothing', () => {
    /* `checkState` is what NAMES that state. This function's job is only never to be the
     * place a NaN or an Infinity is born, so that a caller who skipped the check still
     * gets a number a report can print. */
    const diverged = unitCostOf(D('0.000'), D('250.00'))
    expect(diverged.isFinite()).toBe(true)
    expect(diverged.toFixed(6)).toBe('0.000000')
  })

  it('is zero when either figure is not a number', () => {
    expect(unitCostOf(new Decimal(NaN), D('100.00')).toFixed(6)).toBe('0.000000')
    expect(unitCostOf(D('10.000'), new Decimal(NaN)).toFixed(6)).toBe('0.000000')
    expect(unitCostOf(new Decimal(Infinity), D('100.00')).toFixed(6)).toBe('0.000000')
    expect(unitCostOf(D('10.000'), new Decimal(Infinity)).toFixed(6)).toBe('0.000000')
  })

  it('reports a unit cost that multiplies back to the value it came from', () => {
    /* The reconciliation a stock card is read for. Every pair here is a figure from the
     * worked card in __fixtures__/stock-card.json. */
    const pairs: [string, string][] = [
      ['100.000', '25000.00'],
      ['150.000', '38750.00'],
      ['110.000', '28416.67'],
      ['110.000', '29616.67'],
      ['55.000', '14808.34'],
      ['75.000', '14808.34'],
      ['72.000', '14216.01'],
      ['19.500', '6240.00'],
      ['7.000', '1000.00'],
      ['3.000', '100.00'],
    ]
    for (const [quantity, value] of pairs) {
      const unitCost = unitCostOf(D(quantity), D(value))
      expect(roundMoney(D(quantity).times(unitCost)).toFixed(2), `${quantity} @ ${value}`).toBe(
        D(value).toFixed(2),
      )
    }
  })
})

describe('shareOfCost', () => {
  it('gives back the whole total when the whole quantity moves', () => {
    /* Exactly, at any precision — this is why an issue is a share of the VALUE and not a
     * quantity times a rate. An item issued down to nothing is worth nothing. */
    expect(shareOfCost(D('14216.01'), D('72.000'), D('72.000')).toFixed(2)).toBe('14216.01')
    expect(shareOfCost(D('100.00'), D('3.000'), D('3.000')).toFixed(2)).toBe('100.00')
    expect(shareOfCost(D('0.01'), D('7.000'), D('7.000')).toFixed(2)).toBe('0.01')
  })

  it('rounds the share half-up at money scale', () => {
    expect(shareOfCost(D('16154.55'), D('10.000'), D('60.000')).toFixed(2)).toBe('2692.43')
    expect(shareOfCost(D('16154.55'), D('5.000'), D('60.000')).toFixed(2)).toBe('1346.21')
    expect(shareOfCost(D('38750.00'), D('40.000'), D('150.000')).toFixed(2)).toBe('10333.33')
  })

  it('is zero when there is no whole to take a share of', () => {
    const nothing = shareOfCost(D('0.00'), D('0.000'), D('0.000'))
    expect(nothing.isFinite()).toBe(true)
    expect(nothing.toFixed(2)).toBe('0.00')
  })

  it('never takes out more than the total, for any share of it', () => {
    const total = D('1000.00')
    const whole = D('7.000')
    for (let step = 0; step <= 7000; step += 137) {
      const portion = D(step).dividedBy(1000).toDecimalPlaces(3)
      const share = shareOfCost(total, portion, whole)
      expect(share.lessThanOrEqualTo(total), portion.toString()).toBe(true)
      expect(share.isNegative()).toBe(false)
    }
  })

  it('beats the naive quantity-times-rounded-rate it replaces', () => {
    /* The whole reason invariant 1 exists. 100.00 over three units at money scale is
     * 33.33 a unit; three of them leave at 99.99 and a paisa is stranded in an item that
     * is now empty. The share-of-value form leaves nothing behind. */
    const value = D('100.00')
    const quantity = D('3.000')
    const naiveRate = roundMoney(value.dividedBy(quantity))
    const naiveCost = roundMoney(quantity.times(naiveRate))

    expect(naiveRate.toFixed(2)).toBe('33.33')
    expect(naiveCost.toFixed(2)).toBe('99.99')
    expect(shareOfCost(value, quantity, quantity).toFixed(2)).toBe('100.00')
  })

  it('holds a large quantity to the paisa', () => {
    /* Above the 10,000 units at which the reported unit-cost COLUMN stops reconciling to
     * half a paisa. The VALUE is still exact, because no value here was computed from a
     * unit cost. */
    const value = D('1234567.89')
    const whole = D('999999.000')
    const first = shareOfCost(value, D('1.000'), whole)
    const rest = shareOfCost(value.minus(first), D('999998.000'), D('999998.000'))
    expect(first.plus(rest).toFixed(2)).toBe('1234567.89')
  })
})
