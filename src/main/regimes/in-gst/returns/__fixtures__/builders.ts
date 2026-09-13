/*
 * Document builders for the tests that need one document differing in one field.
 *
 * NOT A SECOND FIXTURE. `period.json` is the worked month and every figure in it was
 * computed by hand; these builders exist for the tests that isolate ONE condition — the
 * B2CL matrix, the export inference, the UQC cases — where a whole realistic invoice
 * would bury the single field under test.
 *
 * They live under `__fixtures__` so that coverage does not count them: a helper with no
 * branch of its own would otherwise report as covered code that nothing asserts.
 */

import type { PlaceOfSupply } from '@main/regimes/types'
import type { ReturnDocument, ReturnLine, ReturnTaxAmount } from '../types'

/** Within Tamil Nadu. CGST + SGST. */
export const INTRA_TN: PlaceOfSupply = {
  jurisdictionCode: '33',
  countryCode: 'in',
  isIntraJurisdiction: true,
  isExport: false,
}

/** Tamil Nadu to Karnataka. IGST. */
export const INTER_KA: PlaceOfSupply = {
  jurisdictionCode: '29',
  countryCode: 'in',
  isIntraJurisdiction: false,
  isExport: false,
}

/** Out of India altogether. */
export const EXPORT_AE: PlaceOfSupply = {
  jurisdictionCode: null,
  countryCode: 'ae',
  isIntraJurisdiction: false,
  isExport: true,
}

export function igst(amount: string, ratePct = '18'): ReturnTaxAmount[] {
  return [{ code: 'IGST', ratePct, amount }]
}

export function pair(amount: string, ratePct = '9'): ReturnTaxAmount[] {
  return [
    { code: 'CGST', ratePct, amount },
    { code: 'SGST', ratePct, amount },
  ]
}

export function line(over: Partial<ReturnLine> = {}): ReturnLine {
  return {
    lineNumber: 1,
    classificationCode: '8471',
    quantity: '1.000',
    unitCode: 'NOS',
    uqc: 'NOS',
    taxableValue: '1000.00',
    ratePct: '18',
    isCharge: false,
    itcEligibility: null,
    taxes: igst('180.00'),
    ...over,
  }
}

export function doc(over: Partial<ReturnDocument> = {}): ReturnDocument {
  return {
    id: 'x1',
    kind: 'sales-invoice',
    number: 'INV-9001',
    date: '2027-11-10',
    isCancelled: false,
    counterparty: {
      partyId: 'p-x',
      name: 'Test Party',
      registrationNumber: null,
      jurisdictionCode: '29',
      countryCode: 'in',
    },
    placeOfSupply: INTER_KA,
    corrects: null,
    exportDetail: null,
    roundOff: '0.00',
    isReverseCharge: false,
    supplyTreatment: null,
    lines: [line()],
    ...over,
  }
}

/** The month every builder-built document sits inside. */
export const NOVEMBER_2027 = { from: '2027-11-01', to: '2027-11-30', label: 'November 2027' }
