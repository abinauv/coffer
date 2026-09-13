/*
 * GSTR-3B, against the same worked month, plus the credit-utilisation branches that a
 * single month cannot reach.
 *
 * TWO THINGS THIS FILE IS FOR BESIDES THE FIGURES:
 *
 * 1. That 3.1 and the GSTR-1 for the same period agree. They report the same supplies in
 *    two different arrangements, and the way a taxpayer finds out they do not is a notice
 *    months later. So it is asserted here, not left to inspection.
 * 2. That the cash payable is the ONLY thing rounded, and that its total is the sum of
 *    the rounded heads rather than the rounded sum. The month is arranged so the two
 *    genuinely differ — 39,554.31 + 1,812.50 + 1,812.50 rounds to 43,179 as a sum and to
 *    43,180 as three rounded heads — because an assertion where they agree proves nothing.
 */

import { describe, expect, it } from 'vitest'
import { D, sum } from '@main/domain/money'
import { buildGstr1 } from './gstr1'
import { buildGstr3b, utiliseCredit } from './gstr3b'
import { fromTaxAmounts, toTaxAmounts, zeroTotals, type TaxAmounts } from './amounts'
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
import type { DocumentIssueRange, ReturnDocument, ReturnPeriod } from './types'

import periodFixture from './__fixtures__/period.json'
import expectedFixture from './__fixtures__/expected.json'

const strip = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value, (key, inner) => (key.startsWith('$') ? undefined : inner))) as T

const fixture = periodFixture as unknown as {
  period: ReturnPeriod
  documents: ReturnDocument[]
  inwardDocuments: ReturnDocument[]
  issuedRanges: DocumentIssueRange[]
}

const outwardDocuments = strip(fixture.documents)
const inwardDocuments = strip(fixture.inwardDocuments)

const expected = expectedFixture as unknown as {
  gstr3b: {
    table31: Record<string, { taxableValue: string; tax: TaxAmounts }>
    table32: unknown
    table4: unknown
    payment: Record<string, unknown>
    issueCodes: string[]
    unrecordedReverseChargeCount: number
    unrecordedEligibilityCount: number
  }
}

const declared = {
  nonGstOutwardValue: '0.00',
  reversalRule42And43: { igst: '0.00', cgst: '150.00', sgst: '150.00', cess: '0.00' },
  interestAndLateFee: { igst: '120.60', cgst: '0.00', sgst: '0.00', cess: '0.00' },
}

const built = buildGstr3b({
  period: fixture.period,
  outwardDocuments,
  inwardDocuments,
  declared,
})

describe('GSTR-3B — the worked month', () => {
  it('table 3.1, row by row', () => {
    expect(built.table31).toEqual(expected.gstr3b.table31)
  })

  it('table 3.2 — inter-state supplies to unregistered persons, by place of supply', () => {
    expect(built.table32).toEqual(expected.gstr3b.table32)
  })

  it('table 4 — credit available, reversed, net and ineligible', () => {
    expect(built.table4).toEqual(expected.gstr3b.table4)
  })

  it('the payment table', () => {
    expect(built.payment).toEqual(expected.gstr3b.payment)
  })

  it('reports what it had to assume, and nothing else', () => {
    expect(built.issues.map((each) => each.code)).toEqual(expected.gstr3b.issueCodes)
  })

  it('counts the documents that took each default', () => {
    const reverseCharge = built.issues.find((each) => each.code === 'REVERSE_CHARGE_NOT_RECORDED')
    const eligibility = built.issues.find((each) => each.code === 'ITC_ELIGIBILITY_NOT_RECORDED')
    expect(reverseCharge?.value).toBe(String(expected.gstr3b.unrecordedReverseChargeCount))
    expect(eligibility?.value).toBe(String(expected.gstr3b.unrecordedEligibilityCount))
  })

  it('names every figure it took as nil because nothing could answer it', () => {
    const raised = built.issues.find((each) => each.code === 'FIGURE_NOT_DERIVABLE')
    expect(raised?.value).toBe(
      '4(A)(1) import of goods; 4(A)(2) import of services; 4(A)(4) ISD credit; ' +
        '4(B)(2) other reversal',
    )
  })

  it('always says it is provisional', () => {
    expect(built.issues[0]?.code).toBe('SCHEMA_UNVERIFIED')
    expect(built.notice).toContain('has not been checked against the portal')
  })
})

describe('3B and GSTR-1 report the same month', () => {
  const gstr1 = buildGstr1({ period: fixture.period, documents: outwardDocuments })

  it('3.1(a) + 3.1(b) + 3.1(c) is the net outward supply GSTR-1 reports', () => {
    const outward = sum([
      built.table31.taxableOutward.taxableValue,
      built.table31.zeroRated.taxableValue,
      built.table31.nilRatedOrExempt.taxableValue,
    ])
    expect(outward.toFixed(2)).toBe(gstr1.net.taxableValue)
    expect(outward.toFixed(2)).toBe(gstr1.hsn.taxableValue)
  })

  it('the outward tax in 3.1 is the net tax GSTR-1 reports, head by head', () => {
    const rows = [built.table31.taxableOutward.tax, built.table31.zeroRated.tax]
    expect(sum(rows.map((row) => row.igst)).toFixed(2)).toBe(gstr1.net.tax.igst)
    expect(sum(rows.map((row) => row.cgst)).toFixed(2)).toBe(gstr1.net.tax.cgst)
    expect(sum(rows.map((row) => row.sgst)).toFixed(2)).toBe(gstr1.net.tax.sgst)
  })

  it('3.2 is the inter-state part of GSTR-1 B2CL and B2CS, less the notes', () => {
    /* B2CL 90,000 + B2CS inter 40,000.40 + 84,745.76, less the 30,000 credit note. */
    expect(sum(built.table32.toUnregistered.map((row) => row.taxableValue)).toFixed(2)).toBe(
      '184746.16',
    )
    expect(built.table32.toCompositionDealers).toEqual([])
    expect(built.table32.toUinHolders).toEqual([])
  })
})

describe('rounding: where it happens and where it does not', () => {
  it('3.1 carries paise — rounding it would make it disagree with GSTR-1', () => {
    expect(built.table31.taxableOutward.taxableValue).toBe('335246.16')
    expect(built.table31.taxableOutward.tax.igst).toBe('37754.31')
  })

  it('table 4 carries paise', () => {
    expect(built.table4.available.total.cgst).toBe('2050.00')
    expect(built.table4.net.cgst).toBe('1900.00')
  })

  it('the exact cash payable carries paise; only the rounded copy does not', () => {
    expect(built.payment.cashPayable).toEqual({
      igst: '39554.31',
      cgst: '1812.50',
      sgst: '1812.50',
      cess: '0.00',
    })
    expect(built.payment.cashPayableRounded).toEqual({
      igst: '39554.00',
      cgst: '1813.00',
      sgst: '1813.00',
      cess: '0.00',
    })
  })

  it('the total is the sum of the ROUNDED heads, which is not the rounded sum', () => {
    const roundedHeads = fromTaxAmounts(built.payment.cashPayableRounded)
    const exact = fromTaxAmounts(built.payment.cashPayable)

    const sumOfRounded = sum([
      roundedHeads.igst,
      roundedHeads.cgst,
      roundedHeads.sgst,
      roundedHeads.cess,
    ])
    const roundedSum = sum([exact.igst, exact.cgst, exact.sgst, exact.cess]).toDecimalPlaces(0)

    expect(sumOfRounded.toString()).toBe('43180')
    expect(roundedSum.toString()).toBe('43179')
    /* The month is built so the two genuinely differ; an assertion where they agreed
     * would pass whichever way round the code did it. */
    expect(sumOfRounded.equals(roundedSum)).toBe(false)

    /* And the figure the challan carries is the one that adds up to the cells. */
    expect(built.payment.totalCashPayable).toBe('43301.00')
    expect(sumOfRounded.plus(D('121')).toFixed(2)).toBe(built.payment.totalCashPayable)
  })

  it('rounds the interest per head too, so 120.60 is 121 and not 120', () => {
    expect(built.payment.interestAndLateFeeRounded.igst).toBe('121.00')
  })
})

describe('credit utilisation', () => {
  const totals = (igstAmount: string, cgst: string, sgst: string, cess = '0'): TaxAmounts =>
    toTaxAmounts({ igst: D(igstAmount), cgst: D(cgst), sgst: D(sgst), cess: D(cess) })

  it('spends IGST credit on the IGST liability first', () => {
    const result = utiliseCredit(
      fromTaxAmounts(totals('1000', '500', '500')),
      fromTaxAmounts(totals('600', '0', '0')),
    )
    expect(toTaxAmounts(result.remainingLiability)).toEqual(totals('400', '500', '500'))
    expect(toTaxAmounts(result.carriedForward)).toEqual(totals('0', '0', '0'))
  })

  it('spends the IGST remainder on CGST before SGST, by default', () => {
    const result = utiliseCredit(
      fromTaxAmounts(totals('100', '500', '500')),
      fromTaxAmounts(totals('700', '0', '0')),
    )
    /* 100 to IGST, then 500 to CGST, then the last 100 to SGST. */
    expect(toTaxAmounts(result.remainingLiability)).toEqual(totals('0', '0', '400'))
  })

  it('spends it on SGST first when the preference says so — the order is a choice', () => {
    const result = utiliseCredit(
      fromTaxAmounts(totals('100', '500', '500')),
      fromTaxAmounts(totals('700', '0', '0')),
      'sgst-first',
    )
    expect(toTaxAmounts(result.remainingLiability)).toEqual(totals('0', '400', '0'))
  })

  it('never sets CGST credit against an SGST liability', () => {
    const result = utiliseCredit(
      fromTaxAmounts(totals('0', '0', '500')),
      fromTaxAmounts(totals('0', '900', '0')),
    )
    expect(toTaxAmounts(result.remainingLiability)).toEqual(totals('0', '0', '500'))
    expect(toTaxAmounts(result.carriedForward)).toEqual(totals('0', '900', '0'))
  })

  it('never sets SGST credit against a CGST liability', () => {
    const result = utiliseCredit(
      fromTaxAmounts(totals('0', '500', '0')),
      fromTaxAmounts(totals('0', '0', '900')),
    )
    expect(toTaxAmounts(result.remainingLiability)).toEqual(totals('0', '500', '0'))
    expect(toTaxAmounts(result.carriedForward)).toEqual(totals('0', '0', '900'))
  })

  it('does set CGST and SGST credit against an IGST liability, own head first', () => {
    const result = utiliseCredit(
      fromTaxAmounts(totals('1000', '100', '100')),
      fromTaxAmounts(totals('0', '400', '400')),
    )
    /* 100 each to their own heads, then 300 each to IGST. */
    expect(toTaxAmounts(result.remainingLiability)).toEqual(totals('400', '0', '0'))
    expect(toTaxAmounts(result.carriedForward)).toEqual(totals('0', '0', '0'))
  })

  it('keeps cess to itself', () => {
    const result = utiliseCredit(
      fromTaxAmounts(totals('500', '0', '0', '200')),
      fromTaxAmounts(totals('0', '0', '0', '500')),
    )
    expect(toTaxAmounts(result.remainingLiability)).toEqual(totals('500', '0', '0', '0'))
    expect(toTaxAmounts(result.carriedForward)).toEqual(totals('0', '0', '0', '300'))
  })

  it('reports what was spent, head by head, as credit less what is left', () => {
    /* 700 of IGST credit covers the 100 IGST liability, then all 500 of CGST, then 100 of
     * SGST -- so the CGST credit is never touched and 400 of SGST credit is. */
    const credit = fromTaxAmounts(totals('700', '400', '400'))
    const result = utiliseCredit(fromTaxAmounts(totals('100', '500', '500')), credit)
    expect(toTaxAmounts(result.utilised)).toEqual(totals('700', '0', '400'))
    expect(toTaxAmounts(result.carriedForward)).toEqual(totals('0', '400', '0'))
    expect(toTaxAmounts(result.remainingLiability)).toEqual(totals('0', '0', '0'))
  })

  it('spends nothing on a NEGATIVE liability, which a month of returns can produce', () => {
    /* A period whose credit notes outweigh its invoices. `min` would return the negative
     * and subtracting it would hand back credit that was never held. */
    const result = utiliseCredit(
      fromTaxAmounts(totals('-500', '0', '0')),
      fromTaxAmounts(totals('300', '0', '0')),
    )
    expect(toTaxAmounts(result.carriedForward)).toEqual(totals('300', '0', '0'))
    expect(toTaxAmounts(result.utilised)).toEqual(totals('0', '0', '0'))
    expect(toTaxAmounts(result.remainingLiability)).toEqual(totals('-500', '0', '0'))
  })

  it('spends nothing when there is nothing to spend it on', () => {
    const result = utiliseCredit(zeroTotals(), fromTaxAmounts(totals('900', '900', '900')))
    expect(toTaxAmounts(result.utilised)).toEqual(totals('0', '0', '0'))
    expect(toTaxAmounts(result.carriedForward)).toEqual(totals('900', '900', '900'))
  })
})

describe('reverse charge', () => {
  const rcmBill = doc({
    id: 'r1',
    kind: 'purchase-bill',
    number: 'RCM-9',
    placeOfSupply: INTRA_TN,
    isReverseCharge: true,
    lines: [
      line({
        taxableValue: '10000.00',
        ratePct: '18',
        taxes: pair('900.00'),
        itcEligibility: 'eligible',
      }),
    ],
  })

  it('puts an inward reverse-charge supply in 3.1(d) and its credit in 4(A)(3)', () => {
    const result = buildGstr3b({
      period: NOVEMBER_2027,
      outwardDocuments: [],
      inwardDocuments: [rcmBill],
    })
    expect(result.table31.inwardReverseCharge).toEqual({
      taxableValue: '10000.00',
      tax: { igst: '0.00', cgst: '900.00', sgst: '900.00', cess: '0.00' },
    })
    expect(result.table4.available.inwardReverseCharge).toEqual({
      igst: '0.00',
      cgst: '900.00',
      sgst: '900.00',
      cess: '0.00',
    })
    expect(result.table4.available.allOther).toEqual({
      igst: '0.00',
      cgst: '0.00',
      sgst: '0.00',
      cess: '0.00',
    })
  })

  it('pays that tax in CASH, refusing to set the credit it just created against it', () => {
    const result = buildGstr3b({
      period: NOVEMBER_2027,
      outwardDocuments: [],
      inwardDocuments: [rcmBill],
    })
    /* There is no outward liability at all, so every rupee of the 1,800 is cash and the
     * whole 1,800 of credit is carried forward. Offsetting them would show nil due. */
    expect(result.payment.cashPayable).toEqual({
      igst: '0.00',
      cgst: '900.00',
      sgst: '900.00',
      cess: '0.00',
    })
    expect(result.payment.creditCarriedForward).toEqual({
      igst: '0.00',
      cgst: '900.00',
      sgst: '900.00',
      cess: '0.00',
    })
    expect(result.payment.totalCashPayable).toBe('1800.00')
  })

  it('reports an OUTWARD reverse-charge supply at value and charges no tax on it', () => {
    const result = buildGstr3b({
      period: NOVEMBER_2027,
      outwardDocuments: [
        doc({
          isReverseCharge: true,
          lines: [line({ taxableValue: '20000.00', taxes: igst('3600.00') })],
        }),
      ],
      inwardDocuments: [],
    })
    expect(result.table31.taxableOutward.taxableValue).toBe('20000.00')
    expect(result.table31.taxableOutward.tax.igst).toBe('3600.00')
    /* The value is reported; the liability is the recipient's. */
    expect(result.payment.outwardLiability.igst).toBe('0.00')
    expect(result.payment.totalCashPayable).toBe('0.00')
  })

  it('defaults an unrecorded flag to forward charge, and says how many took it', () => {
    const result = buildGstr3b({
      period: NOVEMBER_2027,
      outwardDocuments: [doc({ isReverseCharge: null })],
      inwardDocuments: [],
    })
    expect(result.payment.outwardLiability.igst).toBe('180.00')
    expect(result.issues.find((each) => each.code === 'REVERSE_CHARGE_NOT_RECORDED')?.value).toBe(
      '1',
    )
  })

  it('takes the caller’s default when one is given, so the assumption is the caller’s', () => {
    const result = buildGstr3b({
      period: NOVEMBER_2027,
      outwardDocuments: [doc({ isReverseCharge: null })],
      inwardDocuments: [],
      defaults: { isReverseCharge: true },
    })
    expect(result.payment.outwardLiability.igst).toBe('0.00')
  })
})

describe('input tax credit eligibility', () => {
  const blocked = doc({
    kind: 'purchase-bill',
    number: 'BILL-CAR',
    placeOfSupply: INTRA_TN,
    isReverseCharge: false,
    lines: [
      line({
        taxableValue: '100000.00',
        ratePct: '28',
        taxes: pair('14000.00', '14'),
        itcEligibility: 'ineligible-17-5',
      }),
    ],
  })

  it('keeps blocked credit out of 4(A) and reports it in 4(D)', () => {
    const result = buildGstr3b({
      period: NOVEMBER_2027,
      outwardDocuments: [],
      inwardDocuments: [blocked],
    })
    expect(result.table4.available.allOther).toEqual({
      igst: '0.00',
      cgst: '0.00',
      sgst: '0.00',
      cess: '0.00',
    })
    expect(result.table4.ineligible.section17_5).toEqual({
      igst: '0.00',
      cgst: '14000.00',
      sgst: '14000.00',
      cess: '0.00',
    })
  })

  it('separates 17(5) from other ineligible credit', () => {
    const other = {
      ...blocked,
      id: 'other',
      number: 'BILL-X',
      lines: blocked.lines.map((each) => ({
        ...each,
        itcEligibility: 'ineligible-other' as const,
      })),
    }
    const result = buildGstr3b({
      period: NOVEMBER_2027,
      outwardDocuments: [],
      inwardDocuments: [other],
    })
    expect(result.table4.ineligible.others.cgst).toBe('14000.00')
    expect(result.table4.ineligible.section17_5.cgst).toBe('0.00')
  })

  it('nets a purchase return out of the credit available', () => {
    const bill = doc({
      id: 'b1',
      kind: 'purchase-bill',
      number: 'BILL-1',
      placeOfSupply: INTRA_TN,
      isReverseCharge: false,
      lines: [
        line({ taxableValue: '10000.00', taxes: pair('900.00'), itcEligibility: 'eligible' }),
      ],
    })
    const returned = doc({
      id: 'b2',
      kind: 'debit-note',
      number: 'DBN-1',
      date: '2027-11-20',
      placeOfSupply: INTRA_TN,
      isReverseCharge: false,
      corrects: {
        documentId: 'b1',
        kind: 'purchase-bill',
        number: 'BILL-1',
        date: '2027-11-10',
      },
      lines: [line({ taxableValue: '4000.00', taxes: pair('360.00'), itcEligibility: 'eligible' })],
    })
    const result = buildGstr3b({
      period: NOVEMBER_2027,
      outwardDocuments: [],
      inwardDocuments: [bill, returned],
    })
    expect(result.table4.available.allOther.cgst).toBe('540.00')
    expect(result.table4.net.cgst).toBe('540.00')
  })

  it('defaults an unrecorded eligibility to eligible, and says how many took it', () => {
    const result = buildGstr3b({
      period: NOVEMBER_2027,
      outwardDocuments: [],
      inwardDocuments: [
        doc({
          kind: 'purchase-bill',
          number: 'BILL-2',
          placeOfSupply: INTRA_TN,
          isReverseCharge: false,
          lines: [line({ taxableValue: '1000.00', taxes: pair('90.00'), itcEligibility: null })],
        }),
      ],
    })
    expect(result.table4.available.allOther.cgst).toBe('90.00')
    expect(result.issues.find((each) => each.code === 'ITC_ELIGIBILITY_NOT_RECORDED')?.value).toBe(
      '1',
    )
  })

  it('takes the caller’s default when one is given', () => {
    const result = buildGstr3b({
      period: NOVEMBER_2027,
      outwardDocuments: [],
      inwardDocuments: [
        doc({
          kind: 'purchase-bill',
          number: 'BILL-3',
          placeOfSupply: INTRA_TN,
          isReverseCharge: false,
          lines: [line({ taxableValue: '1000.00', taxes: pair('90.00'), itcEligibility: null })],
        }),
      ],
      defaults: { itcEligibility: 'ineligible-other' },
    })
    expect(result.table4.available.allOther.cgst).toBe('0.00')
    expect(result.table4.ineligible.others.cgst).toBe('90.00')
  })
})

describe('exempt supplies and rule 42', () => {
  const withExempt = doc({
    lines: [line({ taxableValue: '5000.00', ratePct: '0', taxes: [] })],
  })

  it('raises an error when there are exempt supplies and no reversal is declared', () => {
    const result = buildGstr3b({
      period: NOVEMBER_2027,
      outwardDocuments: [withExempt],
      inwardDocuments: [],
    })
    const raised = result.issues.find((each) => each.code === 'EXEMPT_SUPPLIES_WITHOUT_REVERSAL')
    expect(raised?.severity).toBe('error')
    expect(raised?.section).toBe('4(B)(1)')
  })

  it('does not raise it once a reversal is declared', () => {
    const result = buildGstr3b({
      period: NOVEMBER_2027,
      outwardDocuments: [withExempt],
      inwardDocuments: [],
      declared: {
        reversalRule42And43: { igst: '0.00', cgst: '10.00', sgst: '10.00', cess: '0.00' },
      },
    })
    expect(result.issues.map((each) => each.code)).not.toContain('EXEMPT_SUPPLIES_WITHOUT_REVERSAL')
  })

  it('does not raise it when there are no exempt supplies at all', () => {
    const result = buildGstr3b({
      period: NOVEMBER_2027,
      outwardDocuments: [doc()],
      inwardDocuments: [],
    })
    expect(result.issues.map((each) => each.code)).not.toContain('EXEMPT_SUPPLIES_WITHOUT_REVERSAL')
  })
})

describe('table 3.1 splits by LINE, not by document', () => {
  it('puts a nil-rated line and a taxable line from one invoice in two rows', () => {
    const result = buildGstr3b({
      period: NOVEMBER_2027,
      outwardDocuments: [
        doc({
          lines: [
            line({ lineNumber: 1, taxableValue: '1000.00', taxes: igst('180.00') }),
            line({ lineNumber: 2, taxableValue: '400.00', ratePct: '0', taxes: [] }),
          ],
        }),
      ],
      inwardDocuments: [],
    })
    expect(result.table31.taxableOutward.taxableValue).toBe('1000.00')
    expect(result.table31.nilRatedOrExempt.taxableValue).toBe('400.00')
  })

  it('puts every line of an export in the zero-rated row, whatever its rate', () => {
    const result = buildGstr3b({
      period: NOVEMBER_2027,
      outwardDocuments: [
        doc({
          placeOfSupply: EXPORT_AE,
          lines: [
            line({ lineNumber: 1, taxableValue: '1000.00', taxes: igst('180.00') }),
            line({ lineNumber: 2, taxableValue: '400.00', ratePct: '0', taxes: [] }),
          ],
        }),
      ],
      inwardDocuments: [],
    })
    expect(result.table31.zeroRated.taxableValue).toBe('1400.00')
    expect(result.table31.nilRatedOrExempt.taxableValue).toBe('0.00')
    expect(result.table31.taxableOutward.taxableValue).toBe('0.00')
  })
})

describe('what 3B refuses', () => {
  it('refuses a sales invoice among the inward documents', () => {
    expect(() =>
      buildGstr3b({
        period: NOVEMBER_2027,
        outwardDocuments: [],
        inwardDocuments: [doc({ kind: 'sales-invoice' })],
      }),
    ).toThrow(/this return reports purchase/)
  })

  it('refuses an out-of-period inward document', () => {
    expect(() =>
      buildGstr3b({
        period: NOVEMBER_2027,
        outwardDocuments: [],
        inwardDocuments: [
          doc({ kind: 'purchase-bill', date: '2027-10-30', placeOfSupply: INTRA_TN }),
        ],
      }),
    ).toThrow(/outside 2027-11-01 to 2027-11-30/)
  })

  it('ALLOWS two vendors to use the same bill number — it is their series, not ours', () => {
    const one = doc({
      id: 'v1',
      kind: 'purchase-bill',
      number: '001',
      placeOfSupply: INTRA_TN,
      lines: [line({ taxableValue: '100.00', taxes: pair('9.00') })],
    })
    const two = { ...one, id: 'v2', date: '2027-11-12' }
    expect(() =>
      buildGstr3b({ period: NOVEMBER_2027, outwardDocuments: [], inwardDocuments: [one, two] }),
    ).not.toThrow()
  })

  it('still refuses two OUTWARD documents sharing a number', () => {
    expect(() =>
      buildGstr3b({
        period: NOVEMBER_2027,
        outwardDocuments: [doc({ id: 'a' }), doc({ id: 'b', date: '2027-11-12' })],
        inwardDocuments: [],
      }),
    ).toThrow(/both carry the number/)
  })
})

describe('an empty period', () => {
  const empty = buildGstr3b({ period: NOVEMBER_2027, outwardDocuments: [], inwardDocuments: [] })

  it('reports nil everywhere, at money scale', () => {
    expect(empty.table31.taxableOutward).toEqual({
      taxableValue: '0.00',
      tax: { igst: '0.00', cgst: '0.00', sgst: '0.00', cess: '0.00' },
    })
    expect(empty.payment.totalCashPayable).toBe('0.00')
    expect(empty.table32.toUnregistered).toEqual([])
  })

  it('and still names every figure nobody could answer', () => {
    expect(empty.issues.map((each) => each.code)).toEqual([
      'SCHEMA_UNVERIFIED',
      'FIGURE_NOT_DERIVABLE',
    ])
  })
})

describe('an INTER-state inward reverse-charge supply', () => {
  /* Every reverse-charge bill in the worked month is intra-state, so its tax is CGST and
   * SGST and nothing in that month can see whether the IGST head is wired up at all. An
   * import of a service, or an unregistered supplier in another state, is IGST -- and a
   * mutation deleting the IGST term of the cash payable survived until this existed. */
  const importedService = doc({
    id: 'r2',
    kind: 'purchase-bill',
    number: 'RCM-IGST-1',
    placeOfSupply: INTER_KA,
    isReverseCharge: true,
    lines: [line({ taxableValue: '20000.00', ratePct: '18', taxes: igst('3600.00') })],
  })

  const result = buildGstr3b({
    period: NOVEMBER_2027,
    outwardDocuments: [],
    inwardDocuments: [importedService],
  })

  it('reports it in 3.1(d) under IGST', () => {
    expect(result.table31.inwardReverseCharge).toEqual({
      taxableValue: '20000.00',
      tax: { igst: '3600.00', cgst: '0.00', sgst: '0.00', cess: '0.00' },
    })
  })

  it('adds that IGST to the cash payable and to nothing else', () => {
    expect(result.payment.reverseChargeLiability.igst).toBe('3600.00')
    expect(result.payment.cashPayable.igst).toBe('3600.00')
    expect(result.payment.cashPayableRounded.igst).toBe('3600.00')
    expect(result.payment.totalCashPayable).toBe('3600.00')
    /* And the credit it created is carried forward rather than set against it. */
    expect(result.payment.creditCarriedForward.igst).toBe('3600.00')
  })

  it('leaves an outward IGST liability standing beside it, not netted into it', () => {
    const both = buildGstr3b({
      period: NOVEMBER_2027,
      outwardDocuments: [
        doc({ lines: [line({ taxableValue: '1000.00', taxes: igst('180.00') })] }),
      ],
      inwardDocuments: [importedService],
    })
    /* The outward 180 is covered by the 3,600 of credit; the 3,600 of reverse-charge tax
     * is not, and is due in cash. */
    expect(both.payment.creditUtilised.igst).toBe('180.00')
    expect(both.payment.cashPayable.igst).toBe('3600.00')
  })
})
