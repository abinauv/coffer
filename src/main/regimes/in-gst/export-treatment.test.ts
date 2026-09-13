/*
 * AN EXPORT UNDER AN UNDERTAKING, FROM THE TAX FUNCTION TO THE RETURN.
 *
 * The two ways a supply leaves India zero-rated — with the integrated tax paid and
 * reclaimed afterwards, or under a letter of undertaking with no tax charged at all — and
 * the claim this file exists to prove: THE SAME SUPPLY MUST PRODUCE DIFFERENT TAX AND FILE
 * INTO A DIFFERENT SECTION OF GSTR-1.
 *
 * ── WHY IT IS ONE FILE RATHER THAN TWO ────────────────────────────────────────────
 *
 * Before migration 0020 an LUT export could not be represented in these books AT ALL.
 * `computeTax` gives an export IGST at the full rate, because a supply leaving India is
 * inter-state, and the only way to reach a nil figure was to set the line's rate to zero
 * — which makes the supply NIL-RATED, not zero-rated, and reverses the credit position on
 * its inputs instead of refunding it. Two different supplies, two different boxes, and
 * every total adds up either way.
 *
 * So the bug was never in one function. It was in the join: a tax function with nothing to
 * ask, and a return inferring the answer from whether tax happened to be charged. This
 * file runs the join — one supply, taxed twice, carried into two return documents built
 * from what `computeTax` actually answered, and filed.
 *
 * ── THE FIXTURE IS THE SAME SUPPLY TWICE ──────────────────────────────────────────
 *
 * Same goods, same customer, same day, same rate. The only difference is the treatment,
 * which is exactly the fixture a test comparing two answers needs: anything else that
 * differed could be the reason the figures differ.
 */

import { describe, expect, it } from 'vitest'

import type { PlaceOfSupply, TaxComputationInput, TaxedLine, TaxParty } from '@main/regimes/types'
import type { ExportTaxPayment } from '@shared/dto'

import { computeTax } from './tax'
import { placeOfSupply } from './place-of-supply'
import { buildGstr1 } from './returns/gstr1'
import type { ReturnDocument, ReturnLine, ReturnTaxAmount } from './returns/types'

const SUPPLIER: TaxParty = {
  registrationNumber: '33AABCC1234D1ZI',
  jurisdictionCode: '33',
  countryCode: 'in',
}

/** A customer outside India altogether, which is what makes the supply an export. */
const OVERSEAS: TaxParty = {
  registrationNumber: null,
  jurisdictionCode: null,
  countryCode: 'ae',
}

const PLACE: PlaceOfSupply = placeOfSupply(SUPPLIER, OVERSEAS)

const PERIOD = { from: '2027-11-01', to: '2027-11-30', label: 'November 2027' }

function taxed(exportTaxPayment: ExportTaxPayment | null, ratePct = '18'): TaxedLine {
  const input: TaxComputationInput = {
    supplier: SUPPLIER,
    customer: OVERSEAS,
    placeOfSupply: PLACE,
    lines: [{ lineId: '1', taxableAmount: '250000.00', ratePct, classificationCode: '8482' }],
    date: '2027-11-12',
    exportTaxPayment,
  }
  const result = computeTax(input)
  const line = result.lines[0]
  expect(line, 'computeTax answered no line for the one it was given').toBeDefined()
  return line!
}

/**
 * The invoice, as a return sees it, carrying what `computeTax` ACTUALLY ANSWERED.
 *
 * The tax is copied out of the computation rather than typed in again, so the return is
 * filing the same figures the invoice was raised on. That is the seam's own rule — "tax is
 * carried, never recomputed" — and it is what makes this an end-to-end test rather than
 * two unit tests sharing a describe block.
 */
function invoice(line: TaxedLine, exportTaxPayment: ExportTaxPayment | null): ReturnDocument {
  const taxes: ReturnTaxAmount[] = line.components.map((component) => ({
    code: component.code,
    ratePct: component.ratePct,
    amount: component.amount,
  }))
  const returnLine: ReturnLine = {
    lineNumber: 1,
    classificationCode: '8482',
    quantity: '100.000',
    unitCode: 'NOS',
    uqc: 'NOS',
    taxableValue: line.taxableAmount,
    ratePct: taxes[0]?.ratePct ?? '0',
    isCharge: false,
    itcEligibility: null,
    taxes,
  }

  return {
    id: `exp-${exportTaxPayment ?? 'unstated'}`,
    kind: 'sales-invoice',
    number: `EXP-${exportTaxPayment ?? 'unstated'}`,
    date: '2027-11-12',
    isCancelled: false,
    counterparty: {
      partyId: 'p-gulf',
      name: 'Gulf Bearings FZE',
      registrationNumber: null,
      jurisdictionCode: null,
      countryCode: 'ae',
    },
    placeOfSupply: PLACE,
    corrects: null,
    exportDetail: {
      taxPayment: exportTaxPayment,
      shippingBillNumber: 'SB-4471',
      shippingBillDate: '2027-11-13',
      portCode: 'INMAA1',
    },
    roundOff: '0.00',
    isReverseCharge: false,
    supplyTreatment: null,
    lines: [returnLine],
  }
}

function filed(exportTaxPayment: ExportTaxPayment | null) {
  return buildGstr1({
    period: PERIOD,
    documents: [invoice(taxed(exportTaxPayment), exportTaxPayment)],
  })
}

// ---- The tax ---------------------------------------------------------------

describe('what an export costs in tax', () => {
  it('charges integrated tax at the full rate when the tax is paid', () => {
    const line = taxed('with-payment')

    expect(line.totalTax).toBe('45000.00')
    expect(line.components.map((each) => [each.code, each.ratePct, each.amount])).toEqual([
      ['IGST', '18', '45000.00'],
    ])
  })

  /*
   * THE RATE SURVIVES AND THE TAX DOES NOT, which is the whole shape of a zero-rated
   * supply. A component of `IGST @ 18%` for nothing says "this is the tax that would have
   * applied and did not"; that is what an invoice under an LUT is required to show, and
   * it is what lets a return group the supply by 18% without re-deriving anything.
   */
  it('charges nothing at all under an undertaking, and keeps the rate', () => {
    const line = taxed('without-payment')

    expect(line.totalTax).toBe('0.00')
    expect(line.components.map((each) => [each.code, each.ratePct, each.amount])).toEqual([
      ['IGST', '18', '0.00'],
    ])
  })

  it('is the same supply, so the taxable value does not move', () => {
    expect(taxed('with-payment').taxableAmount).toBe(taxed('without-payment').taxableAmount)
    expect(taxed('with-payment').totalTax).not.toBe(taxed('without-payment').totalTax)
  })

  /*
   * A ZERO-RATED SUPPLY IS NOT A NIL-RATED ONE, and this is the assertion the whole column
   * exists for. A nil-rated line carries NO components — which taxes would have applied is
   * not a fact about an exempt supply — where a zero-rated one carries IGST at the rate for
   * nothing. Before 0020 the second was unreachable and every LUT export was filed as the
   * first, with its input credit reversed rather than refunded.
   */
  it('is not the same as setting the rate to zero, which is a different supply', () => {
    const nilRated = taxed(null, '0')

    expect(nilRated.totalTax).toBe('0.00')
    expect(nilRated.components).toEqual([])
    expect(taxed('without-payment').components).toHaveLength(1)
  })

  /*
   * NOT HONOURED WHERE THE SUPPLY DID NOT LEAVE THE COUNTRY. The place of supply is the
   * REGIME's answer, and a treatment recorded against a domestic document must not be able
   * to zero a real liability. The repository refuses to store one; this refuses to act on
   * one, and this is the layer that matters because it is the one that can see the place.
   */
  it('zeroes nothing on a domestic supply, whatever the document says', () => {
    const home: TaxParty = { registrationNumber: null, jurisdictionCode: '33', countryCode: 'in' }
    const domestic = computeTax({
      supplier: SUPPLIER,
      customer: home,
      placeOfSupply: placeOfSupply(SUPPLIER, home),
      lines: [{ lineId: '1', taxableAmount: '250000.00', ratePct: '18', classificationCode: null }],
      date: '2027-11-12',
      exportTaxPayment: 'without-payment',
    })

    expect(domestic.totalTax).toBe('45000.00')
    expect(domestic.lines[0]?.components.map((each) => each.code)).toEqual(['CGST', 'SGST'])
  })
})

// ---- The return ------------------------------------------------------------

describe('where the two file', () => {
  it('puts each in its own EXP group, with the other empty', () => {
    const withPayment = filed('with-payment')
    const underLut = filed('without-payment')

    expect(
      withPayment.exp.groups.map((group) => [group.taxPayment, group.invoices.length]),
    ).toEqual([
      ['with-payment', 1],
      ['without-payment', 0],
    ])
    expect(underLut.exp.groups.map((group) => [group.taxPayment, group.invoices.length])).toEqual([
      ['with-payment', 0],
      ['without-payment', 1],
    ])
  })

  it('files the tax in one and nothing in the other', () => {
    expect(filed('with-payment').exp.tax.igst).toBe('45000.00')
    expect(filed('without-payment').exp.tax.igst).toBe('0.00')

    /* And the VALUE is the same in both, because the same goods left the country. A
     * return that filed the LUT export at nil value would be understating turnover. */
    expect(filed('with-payment').exp.taxableValue).toBe('250000.00')
    expect(filed('without-payment').exp.taxableValue).toBe('250000.00')
  })

  /*
   * NEITHER RAISES AN INFERENCE ISSUE, because neither had to be inferred. That is the
   * gap closing: `exports-infer-payment-from-tax-charged` still governs a document that
   * says nothing, and a document that says something is taken at its word.
   */
  it('says nothing was assumed, on either', () => {
    for (const treatment of ['with-payment', 'without-payment'] as const) {
      const codes = filed(treatment).issues.map((each) => each.code)
      expect(codes, treatment).not.toContain('EXPORT_TAX_PAYMENT_INFERRED')
      expect(codes, treatment).not.toContain('EXPORT_TAX_PAYMENT_ASSUMED')
    }
  })

  /*
   * AND WHAT IT LOOKS LIKE WITHOUT THE COLUMN, kept as the contrast rather than deleted.
   * A document that states nothing is still inferred from whether tax was charged — which
   * is right for an export with a rate and cannot be right for a nil-rated one — and the
   * inference is reported every time it is made.
   */
  it('still infers, and says so, for a document that states nothing', () => {
    const unstated = filed(null)

    expect(unstated.exp.groups.map((group) => [group.taxPayment, group.invoices.length])).toEqual([
      ['with-payment', 1],
      ['without-payment', 0],
    ])
    expect(unstated.issues.map((each) => each.code)).toContain('EXPORT_TAX_PAYMENT_INFERRED')
  })
})
