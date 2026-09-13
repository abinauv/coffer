/*
 * Which section a document belongs in — one condition at a time.
 *
 * THE B2CL MATRIX IS THE POINT OF THIS FILE. B2CL is three conditions at once, and a
 * fixture that fails two of them at a time proves nothing about either: the case that
 * separates them is the one where everything else is satisfied. So there are four rows —
 * one satisfying all three, and three each failing exactly one — and the assertion says
 * which section each lands in and therefore what the failing condition alone excluded.
 */

import { describe, expect, it } from 'vitest'
import { D } from '@main/domain/money'
import {
  assertNumbersDistinct,
  assertPeriod,
  assertReturnable,
  invoiceValueOf,
  isAboveThreshold,
  isCorrection,
  isExportSupply,
  isInterStateSupply,
  isRegisteredCounterparty,
  parseThreshold,
  sectionOf,
  signOf,
  taxableValueOf,
  taxValueOf,
} from './classify'
import { isReturnError, ReturnError } from './errors'
import {
  doc,
  EXPORT_AE,
  igst,
  INTER_KA,
  INTRA_TN,
  line,
  NOVEMBER_2027,
  pair,
} from './__fixtures__/builders'

const THRESHOLD = '100000.00'

/**
 * A supply worth 118,000 — comfortably over the threshold — that can be moved one
 * condition at a time. 100,000 taxable at 18% is 18,000 of tax, so the invoice value is
 * 118,000 whichever way the tax splits.
 */
const bigLine = line({ taxableValue: '100000.00', ratePct: '18', taxes: igst('18000.00') })

describe('the three conditions B2CL is made of, failed one at a time', () => {
  it('all three satisfied — unregistered, inter-state, above the threshold — is B2CL', () => {
    const document = doc({ lines: [bigLine] })
    expect(isRegisteredCounterparty(document)).toBe(false)
    expect(isInterStateSupply(document)).toBe(true)
    expect(isAboveThreshold(invoiceValueOf(document), THRESHOLD)).toBe(true)
    expect(sectionOf(document, THRESHOLD)).toBe('B2CL')
  })

  it('REGISTERED alone excludes it: the same supply to a party with a GSTIN is B2B', () => {
    const document = doc({
      lines: [bigLine],
      counterparty: {
        partyId: 'p-reg',
        name: 'Registered Buyer',
        registrationNumber: '29AAAAA0000A1ZY',
        jurisdictionCode: '29',
        countryCode: 'in',
      },
    })
    expect(isInterStateSupply(document)).toBe(true)
    expect(isAboveThreshold(invoiceValueOf(document), THRESHOLD)).toBe(true)
    expect(sectionOf(document, THRESHOLD)).toBe('B2B')
  })

  it('INTRA-STATE alone excludes it: value is irrelevant within a state, so B2CS', () => {
    const document = doc({
      lines: [line({ taxableValue: '100000.00', ratePct: '18', taxes: pair('9000.00') })],
      placeOfSupply: INTRA_TN,
    })
    expect(isRegisteredCounterparty(document)).toBe(false)
    expect(isAboveThreshold(invoiceValueOf(document), THRESHOLD)).toBe(true)
    expect(sectionOf(document, THRESHOLD)).toBe('B2CS')
  })

  it('BELOW THE THRESHOLD alone excludes it: one rupee less and it is B2CS', () => {
    /* 84,745.76 + 15,254.24 is exactly 100,000.00, and 'more than' excludes it. */
    const atThreshold = doc({
      lines: [line({ taxableValue: '84745.76', ratePct: '18', taxes: igst('15254.24') })],
    })
    expect(invoiceValueOf(atThreshold).toString()).toBe('100000')
    expect(isRegisteredCounterparty(atThreshold)).toBe(false)
    expect(isInterStateSupply(atThreshold)).toBe(true)
    expect(sectionOf(atThreshold, THRESHOLD)).toBe('B2CS')
  })

  it('one paisa over the threshold is B2CL — the boundary is exclusive, not approximate', () => {
    const justOver = doc({
      lines: [line({ taxableValue: '84745.77', ratePct: '18', taxes: igst('15254.24') })],
    })
    expect(invoiceValueOf(justOver).toString()).toBe('100000.01')
    expect(sectionOf(justOver, THRESHOLD)).toBe('B2CL')
  })
})

describe('the order the conditions are asked in', () => {
  it('an export is EXP even though its customer has no GSTIN', () => {
    const document = doc({
      placeOfSupply: EXPORT_AE,
      counterparty: {
        partyId: 'p-gulf',
        name: 'Gulf Trading LLC',
        registrationNumber: null,
        jurisdictionCode: null,
        countryCode: 'ae',
      },
      lines: [bigLine],
    })
    expect(isRegisteredCounterparty(document)).toBe(false)
    expect(isInterStateSupply(document)).toBe(true)
    expect(isAboveThreshold(invoiceValueOf(document), THRESHOLD)).toBe(true)
    /* Every B2CL condition holds and it is still EXP, which is what asking export first
     * buys: none of the later tests can see the difference. */
    expect(sectionOf(document, THRESHOLD)).toBe('EXP')
  })

  it('a note to a registered party is CDNR, not B2B', () => {
    const document = doc({
      kind: 'credit-note',
      counterparty: {
        partyId: 'p-reg',
        name: 'Registered Buyer',
        registrationNumber: '29AAAAA0000A1ZY',
        jurisdictionCode: '29',
        countryCode: 'in',
      },
      corrects: {
        documentId: 'd0',
        kind: 'sales-invoice',
        number: 'INV-1',
        date: '2027-11-02',
      },
    })
    expect(sectionOf(document, THRESHOLD)).toBe('CDNR')
  })

  it('a note to an unregistered party is CDNUR whatever its value, never netted into B2CS', () => {
    const small = doc({
      kind: 'credit-note',
      lines: [line({ taxableValue: '100.00', taxes: igst('18.00') })],
      corrects: null,
    })
    expect(sectionOf(small, THRESHOLD)).toBe('CDNUR')

    const big = doc({ kind: 'credit-note', lines: [bigLine], corrects: null })
    expect(sectionOf(big, THRESHOLD)).toBe('CDNUR')
  })

  it('an export note is CDNUR, not EXP', () => {
    const document = doc({
      kind: 'credit-note',
      placeOfSupply: EXPORT_AE,
      corrects: null,
    })
    expect(sectionOf(document, THRESHOLD)).toBe('CDNUR')
  })
})

describe('isCorrection reads the document table rather than naming kinds', () => {
  it('says yes for the refund kinds and no for the charge kinds', () => {
    expect(isCorrection('credit-note')).toBe(true)
    expect(isCorrection('debit-note')).toBe(true)
    expect(isCorrection('sales-invoice')).toBe(false)
    expect(isCorrection('purchase-bill')).toBe(false)
    expect(isCorrection('quotation')).toBe(false)
  })
})

describe('signOf', () => {
  it('is +1 for a charge and -1 for a refund, off the document table', () => {
    expect(signOf('sales-invoice')).toBe(1)
    expect(signOf('purchase-bill')).toBe(1)
    expect(signOf('credit-note')).toBe(-1)
    expect(signOf('debit-note')).toBe(-1)
  })
})

describe('the figures a section is built from', () => {
  const document = doc({
    roundOff: '-0.47',
    lines: [
      line({ lineNumber: 1, taxableValue: '40000.40', taxes: igst('7200.07') }),
      line({ lineNumber: 2, taxableValue: '500.00', ratePct: '5', taxes: igst('25.00', '5') }),
    ],
  })

  it('taxable value is the sum of the lines and carries no tax and no round-off', () => {
    expect(taxableValueOf(document).toString()).toBe('40500.4')
  })

  it('tax is the sum of every component on every line', () => {
    expect(taxValueOf(document).toString()).toBe('7225.07')
  })

  it('invoice value is taxable plus tax PLUS the round-off, which is on the paper', () => {
    /* 40,500.40 + 7,225.07 = 47,725.47, and the customer paid 47,725.00. */
    expect(invoiceValueOf(document).toString()).toBe('47725')
  })

  it('the round-off is nowhere in the taxable value — a discount would have been', () => {
    expect(taxableValueOf(document).plus(taxValueOf(document)).toString()).toBe('47725.47')
  })
})

describe('the threshold is a value, and a bad one is refused rather than read as zero', () => {
  it('parses an ordinary threshold', () => {
    expect(parseThreshold('250000.00').toString()).toBe('250000')
  })

  it('refuses a negative threshold', () => {
    expect(() => parseThreshold('-1.00')).toThrow(ReturnError)
    expect(() => parseThreshold('-1.00')).toThrow(/not a usable amount/)
  })

  it('refuses a threshold that is not a number at all', () => {
    let caught: unknown = null
    try {
      parseThreshold('one lakh')
    } catch (error) {
      caught = error
    }
    expect(isReturnError(caught)).toBe(true)
    expect((caught as ReturnError).code).toBe('RETURN_PACK_VALUE_INVALID')
  })

  it('compares with strictly greater, at the paisa', () => {
    expect(isAboveThreshold(D('100000.00'), THRESHOLD)).toBe(false)
    expect(isAboveThreshold(D('100000.01'), THRESHOLD)).toBe(true)
    expect(isAboveThreshold(D('99999.99'), THRESHOLD)).toBe(false)
  })
})

describe('what a return refuses, because none of it is a filter', () => {
  it('refuses a period whose end precedes its start', () => {
    expect(() => assertPeriod({ from: '2027-11-30', to: '2027-11-01' })).toThrow(
      /ends before it starts/,
    )
  })

  it('refuses a period whose dates are not dates', () => {
    expect(() => assertPeriod({ from: 'November', to: '2027-11-30' })).toThrow(/needs two dates/)
  })

  it('accepts a document dated on the first day of the period', () => {
    expect(() =>
      assertReturnable(doc({ date: '2027-11-01' }), NOVEMBER_2027, 'sales'),
    ).not.toThrow()
  })

  it('accepts a document dated on the last day of the period', () => {
    expect(() =>
      assertReturnable(doc({ date: '2027-11-30' }), NOVEMBER_2027, 'sales'),
    ).not.toThrow()
  })

  it('refuses a document one day before the period, by name and by date', () => {
    expect(() => assertReturnable(doc({ date: '2027-10-31' }), NOVEMBER_2027, 'sales')).toThrow(
      /INV-9001 is dated 2027-10-31, outside 2027-11-01 to 2027-11-30/,
    )
  })

  it('refuses a document one day after the period', () => {
    expect(() => assertReturnable(doc({ date: '2027-12-01' }), NOVEMBER_2027, 'sales')).toThrow(
      /outside 2027-11-01 to 2027-11-30/,
    )
  })

  it('refuses a purchase-side document in an outward return', () => {
    expect(() => assertReturnable(doc({ kind: 'purchase-bill' }), NOVEMBER_2027, 'sales')).toThrow(
      /is a purchase document and this return reports sales/,
    )
  })

  it('refuses a sales-side document in an inward return', () => {
    expect(() =>
      assertReturnable(doc({ kind: 'sales-invoice' }), NOVEMBER_2027, 'purchase'),
    ).toThrow(/is a sales document and this return reports purchase/)
  })

  it('refuses a quotation, which makes no supply', () => {
    expect(() => assertReturnable(doc({ kind: 'quotation' }), NOVEMBER_2027, 'sales')).toThrow(
      /makes no supply/,
    )
  })

  it('refuses an unnumbered document', () => {
    expect(() => assertReturnable(doc({ number: '   ' }), NOVEMBER_2027, 'sales')).toThrow(
      /has no number/,
    )
  })

  it('refuses a charge that names an original document', () => {
    expect(() =>
      assertReturnable(
        doc({
          corrects: {
            documentId: 'd0',
            kind: 'sales-invoice',
            number: 'INV-1',
            date: '2027-11-02',
          },
        }),
        NOVEMBER_2027,
        'sales',
      ),
    ).toThrow(/corrects nothing, yet names INV-1/)
  })

  it('refuses a credit note that names a kind it may not correct', () => {
    expect(() =>
      assertReturnable(
        doc({
          kind: 'credit-note',
          corrects: {
            documentId: 'd0',
            kind: 'purchase-bill',
            number: 'BILL-1',
            date: '2027-11-02',
          },
        }),
        NOVEMBER_2027,
        'sales',
      ),
    ).toThrow(/may only correct a sales invoice/)
  })

  it('accepts a credit note naming the kind it may correct', () => {
    expect(() =>
      assertReturnable(
        doc({
          kind: 'credit-note',
          corrects: {
            documentId: 'd0',
            kind: 'sales-invoice',
            number: 'INV-1',
            date: '2027-11-02',
          },
        }),
        NOVEMBER_2027,
        'sales',
      ),
    ).not.toThrow()
  })

  it('refuses two documents of one kind sharing a number', () => {
    expect(() =>
      assertNumbersDistinct([
        doc({ id: 'a', number: 'INV-1', date: '2027-11-02' }),
        doc({ id: 'b', number: 'inv-1', date: '2027-11-20' }),
      ]),
    ).toThrow(/both carry the number/)
  })

  it('allows one number across two KINDS, which is an ordinary series arrangement', () => {
    expect(() =>
      assertNumbersDistinct([
        doc({ id: 'a', kind: 'sales-invoice', number: '0001' }),
        doc({ id: 'b', kind: 'credit-note', number: '0001', corrects: null }),
      ]),
    ).not.toThrow()
  })
})

describe('a blank registration is not a registration', () => {
  it('treats an empty GSTIN as unregistered rather than filing a B2B row with no number', () => {
    const document = doc({
      counterparty: {
        partyId: 'p-blank',
        name: 'Blank',
        registrationNumber: '   ',
        jurisdictionCode: '29',
        countryCode: 'in',
      },
    })
    expect(isRegisteredCounterparty(document)).toBe(false)
    expect(sectionOf(document, THRESHOLD)).toBe('B2CS')
  })
})

describe('isExportSupply is carried, not re-derived', () => {
  it('believes the place of supply even when the customer looks domestic', () => {
    /* placeOfSupply() deliberately does not guess — an SEZ supply resolves to a
     * jurisdiction the caller knows. Re-deriving here would throw that away. */
    const document = doc({
      placeOfSupply: EXPORT_AE,
      counterparty: {
        partyId: 'p-sez',
        name: 'SEZ Unit',
        registrationNumber: null,
        jurisdictionCode: '33',
        countryCode: 'in',
      },
    })
    expect(isExportSupply(document)).toBe(true)
    expect(sectionOf(document, THRESHOLD)).toBe('EXP')
  })

  it('reads inter-state off the regime, so an unknown state stays inter-state', () => {
    expect(isInterStateSupply(doc({ placeOfSupply: INTER_KA }))).toBe(true)
    expect(isInterStateSupply(doc({ placeOfSupply: INTRA_TN }))).toBe(false)
  })
})
