/*
 * The translation between the books and the builders.
 *
 * The builders are tested to the paisa next door and the service test puts real invoices
 * through the whole path. What is left for here is the translation itself: that the three
 * fields no column holds arrive as null rather than as a guess, and that a refusal from
 * inside this regime is one the rest of main can recognise without naming the regime.
 */

import { describe, expect, it } from 'vitest'

import { isRegimeRefusal } from '../../errors'
import type { ReturnSourceDocument } from '../../types'
import { INDIA_RETURN_FORMS, indiaReturns, toReturnDocument } from './prepare'

const SOURCE: ReturnSourceDocument = {
  id: 'd1',
  kind: 'sales-invoice',
  number: 'INV/2026-27/0001',
  date: '2026-08-05',
  isCancelled: false,
  counterparty: {
    partyId: 'p1',
    name: 'Bharat Steel',
    registrationNumber: null,
    jurisdictionCode: '33',
    countryCode: 'in',
  },
  placeOfSupply: {
    jurisdictionCode: '33',
    countryCode: 'in',
    isIntraJurisdiction: true,
    isExport: false,
  },
  corrects: null,
  exportTaxPayment: null,
  roundOff: '0.00',
  isReverseCharge: false,
  lines: [
    {
      lineNumber: 1,
      classificationCode: '8482',
      quantity: '2.000',
      unitCode: 'NOS',
      taxableValue: '1000.00',
      ratePct: '18',
      isCharge: false,
      itcEligibility: null,
      taxes: [
        { code: 'CGST', ratePct: '9', amount: '90.00' },
        { code: 'SGST', ratePct: '9', amount: '90.00' },
      ],
    },
  ],
}

const PERIOD = { from: '2026-08-01', to: '2026-08-31', label: 'August 2026' }

describe('the forms', () => {
  it('prepares the two returns a business files from its own documents', () => {
    expect(INDIA_RETURN_FORMS.map((form) => form.id)).toEqual(['gstr-1', 'gstr-3b'])
  })

  it('refuses a form it does not prepare, in a way main recognises', () => {
    let thrown: unknown
    try {
      indiaReturns.prepare('gstr-2b', { period: PERIOD, documents: [] })
    } catch (error) {
      thrown = error
    }
    expect(isRegimeRefusal(thrown)).toBe(true)
    expect((thrown as { code: string }).code).toBe('RETURN_FORM_UNKNOWN')
  })
})

describe('a document as the builders read it', () => {
  /* The unit's UQC, the shipping bill and the supply treatment have no column. Null is
   * "the books do not say", which the builders report; a value here would be a guess. */
  it('leaves the fields no column holds as null', () => {
    const mapped = toReturnDocument(SOURCE)

    expect(mapped.lines[0]?.uqc).toBeNull()
    expect(mapped.supplyTreatment).toBeNull()
    expect(mapped.exportDetail).toBeNull()
  })

  it('carries every stored figure as it was, and recomputes none', () => {
    const mapped = toReturnDocument(SOURCE)

    expect(mapped.lines[0]?.taxes).toEqual(SOURCE.lines[0]?.taxes)
    expect(mapped.lines[0]?.taxableValue).toBe('1000.00')
    expect(mapped.number).toBe('INV/2026-27/0001')
  })

  it('gives an export its export detail, with the shipping bill left to be filled', () => {
    const mapped = toReturnDocument({
      ...SOURCE,
      placeOfSupply: { ...SOURCE.placeOfSupply, countryCode: 'us', isExport: true },
      exportTaxPayment: 'without-payment',
    })

    expect(mapped.exportDetail).toEqual({
      taxPayment: 'without-payment',
      shippingBillNumber: null,
      shippingBillDate: null,
      portCode: null,
    })
  })
})

describe('the rows', () => {
  it('adds every component on a row in main, so a screen never has to', () => {
    const prepared = indiaReturns.prepare('gstr-1', { period: PERIOD, documents: [SOURCE] })

    expect(prepared.rows.find((row) => row.id === 'b2cs')?.tax).toBe('180.00')
    expect(prepared.total).toMatchObject({ documentCount: 1, tax: '180.00' })
  })

  it('draws a document count only where the table counts documents', () => {
    const prepared = indiaReturns.prepare('gstr-3b', { period: PERIOD, documents: [SOURCE] })

    for (const row of prepared.rows) expect(row.documentCount).toBeNull()
  })
})
