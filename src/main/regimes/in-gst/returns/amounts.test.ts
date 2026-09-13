/*
 * The four tax columns: what files where, and what happens to a code with no column.
 *
 * THE REFUSAL IS THE POINT OF THIS FILE. A tax this module has no box for must not be
 * quietly dropped — the return would understate the liability and every total in it would
 * still tie, which is the exact shape of error this codebase has learned to fear. And
 * because the shipped map covers every code the regime can emit, the guard is unreachable
 * from real data: so `bucketFor` takes the map as an argument and a test hands it one the
 * shipped table cannot produce (CONVENTIONS §6).
 */

import { describe, expect, it } from 'vitest'
import { D } from '@main/domain/money'
import { GST_COMPONENT_ORDER } from '../tax'
import {
  addTotals,
  bucketFor,
  fromTaxAmounts,
  grandTotalOf,
  isZeroTotals,
  negateTotals,
  RETURN_TAX_BUCKETS,
  roundTotalsToRupees,
  sumTotals,
  TAX_BUCKETS,
  toTaxAmounts,
  totalsOfComponents,
  zeroAmounts,
  zeroTotals,
  type TaxBucket,
} from './amounts'
import { ReturnError, isReturnError } from './errors'

describe('every component the regime can levy has a column', () => {
  it('answers for all four of GST_COMPONENT_ORDER', () => {
    for (const code of GST_COMPONENT_ORDER) {
      expect(() => bucketFor(code)).not.toThrow()
    }
  })

  it('files UTGST where SGST goes — one State/UT column, not two', () => {
    expect(bucketFor('SGST')).toBe('sgst')
    expect(bucketFor('UTGST')).toBe('sgst')
    expect(bucketFor('CGST')).toBe('cgst')
    expect(bucketFor('IGST')).toBe('igst')
  })

  it('has a cess column ready for a component nothing computes yet', () => {
    expect(bucketFor('CESS')).toBe('cess')
    expect(GST_COMPONENT_ORDER).not.toContain('CESS')
  })
})

describe('a component with no column is refused, never dropped', () => {
  it('refuses a code the shipped map does not carry', () => {
    let caught: unknown = null
    try {
      bucketFor('VAT')
    } catch (error) {
      caught = error
    }
    expect(isReturnError(caught)).toBe(true)
    expect((caught as ReturnError).code).toBe('RETURN_COMPONENT_UNKNOWN')
    expect((caught as ReturnError).message).toContain("'VAT'")
  })

  it('refuses through a MAP HANDED TO IT, so the guard is reachable at all', () => {
    /* The shipped map answers for every code the regime emits, so this refusal could
     * never fire on real data and no mutation of it could be killed. The map is an
     * argument for exactly that reason. */
    const partial: Record<string, TaxBucket> = { IGST: 'igst' }
    expect(() => bucketFor('IGST', partial)).not.toThrow()
    expect(() => bucketFor('CGST', partial)).toThrow(ReturnError)
  })

  it('refuses from inside totalsOfComponents too, rather than skipping the line', () => {
    expect(() =>
      totalsOfComponents([{ code: 'SURCHARGE', ratePct: '2', amount: '50.00' }]),
    ).toThrow(/has no column in this return/)
  })

  it('names every code the shipped map carries, so an addition is a visible change', () => {
    expect(Object.keys(RETURN_TAX_BUCKETS).sort()).toEqual([
      'CESS',
      'CGST',
      'IGST',
      'SGST',
      'UTGST',
    ])
  })
})

describe('arithmetic on the columns is exact', () => {
  it('adds components into their columns', () => {
    const totals = totalsOfComponents([
      { code: 'CGST', ratePct: '9', amount: '900.00' },
      { code: 'SGST', ratePct: '9', amount: '900.00' },
      { code: 'CGST', ratePct: '2.5', amount: '12.50' },
      { code: 'SGST', ratePct: '2.5', amount: '12.50' },
    ])
    expect(toTaxAmounts(totals)).toEqual({
      igst: '0.00',
      cgst: '912.50',
      sgst: '912.50',
      cess: '0.00',
    })
  })

  it('keeps the paisa a float would lose', () => {
    const totals = totalsOfComponents(
      Array.from({ length: 10 }, () => ({ code: 'IGST', ratePct: '18', amount: '0.07' })),
    )
    expect(toTaxAmounts(totals).igst).toBe('0.70')
  })

  it('negates every column, sign and all', () => {
    const totals = fromTaxAmounts({
      igst: '10.00',
      cgst: '0.00',
      sgst: '-5.00',
      cess: '1.00',
    })
    /* Anchored assertions: a substring match would take '-10.00' for '10.00'. */
    expect(toTaxAmounts(negateTotals(totals))).toEqual({
      igst: '-10.00',
      cgst: '0.00',
      sgst: '5.00',
      cess: '-1.00',
    })
  })

  it('sums any number of sets', () => {
    const one = fromTaxAmounts({ igst: '1.11', cgst: '0.00', sgst: '0.00', cess: '0.00' })
    const two = fromTaxAmounts({ igst: '2.22', cgst: '3.33', sgst: '0.00', cess: '0.00' })
    expect(toTaxAmounts(sumTotals([one, two, one]))).toEqual({
      igst: '4.44',
      cgst: '3.33',
      sgst: '0.00',
      cess: '0.00',
    })
    expect(toTaxAmounts(addTotals(one, two)).igst).toBe('3.33')
  })

  it('adds the four columns into one figure', () => {
    const totals = fromTaxAmounts({
      igst: '1.00',
      cgst: '2.00',
      sgst: '3.00',
      cess: '4.00',
    })
    expect(grandTotalOf(totals).toString()).toBe('10')
  })

  it('knows nothing from something', () => {
    expect(isZeroTotals(zeroTotals())).toBe(true)
    expect(
      isZeroTotals(fromTaxAmounts({ igst: '0.00', cgst: '0.01', sgst: '0.00', cess: '0.00' })),
    ).toBe(false)
    expect(zeroAmounts()).toEqual({
      igst: '0.00',
      cgst: '0.00',
      sgst: '0.00',
      cess: '0.00',
    })
  })

  it('round-trips through the string form without losing a paisa', () => {
    const amounts = { igst: '12345.67', cgst: '0.01', sgst: '-0.01', cess: '0.00' }
    expect(toTaxAmounts(fromTaxAmounts(amounts))).toEqual(amounts)
  })

  it('lists the columns in the order a return lists them', () => {
    expect([...TAX_BUCKETS]).toEqual(['igst', 'cgst', 'sgst', 'cess'])
  })
})

describe('the one rounding function, and what it is for', () => {
  it('rounds each column on its own, half up, away from zero', () => {
    const totals = fromTaxAmounts({
      igst: '1812.50',
      cgst: '1812.49',
      sgst: '-1812.50',
      cess: '0.49',
    })
    expect(toTaxAmounts(roundTotalsToRupees(totals))).toEqual({
      igst: '1813.00',
      cgst: '1812.00',
      sgst: '-1813.00',
      cess: '0.00',
    })
  })

  it('the sum of the rounded columns is not the rounded sum, and that is deliberate', () => {
    const totals = fromTaxAmounts({
      igst: '0.50',
      cgst: '0.50',
      sgst: '0.50',
      cess: '0.00',
    })
    expect(grandTotalOf(roundTotalsToRupees(totals)).toString()).toBe('3')
    expect(grandTotalOf(totals).toDecimalPlaces(0).toString()).toBe('2')
  })

  it('does not round anything a section row carries — those are already exact', () => {
    /* The sum of exact 2dp figures is an exact 2dp figure, so there is nothing to round.
     * Rounding here is what made intra-state and inter-state disagree (tax.ts). */
    const totals = totalsOfComponents([
      { code: 'CGST', ratePct: '9', amount: '9.00' },
      { code: 'SGST', ratePct: '9', amount: '9.00' },
    ])
    const asIgst = totalsOfComponents([{ code: 'IGST', ratePct: '18', amount: '18.01' }])
    expect(grandTotalOf(totals).toString()).toBe('18')
    expect(grandTotalOf(asIgst).toString()).toBe('18.01')
    /* The two supplies really do differ by a paisa on the DOCUMENT, and the return
     * carries that difference through rather than papering over it. */
    expect(grandTotalOf(asIgst).minus(grandTotalOf(totals)).toString()).toBe('0.01')
  })

  it('never produces a signed zero', () => {
    const totals = fromTaxAmounts({
      igst: '-0.004',
      cgst: '0.00',
      sgst: '0.00',
      cess: '0.00',
    })
    expect(toTaxAmounts(roundTotalsToRupees(totals)).igst).toBe('0.00')
    expect(D(toTaxAmounts(roundTotalsToRupees(totals)).igst).isNegative()).toBe(false)
  })
})
