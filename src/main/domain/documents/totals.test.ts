import { describe, expect, it } from 'vitest'
import { D, ZERO } from '@main/domain/money'
import { documentTotals, lineTax, lineTotal, type Summable } from './totals'
import type { DocumentLine, DocumentLineTax } from './types'

function tax(code: string, ratePct: string, amount: string): DocumentLineTax {
  return { code, label: `${code} @ ${ratePct}%`, ratePct: D(ratePct), amount: D(amount) }
}

let lineCounter = 0

function line(overrides: Partial<DocumentLine> = {}): DocumentLine {
  lineCounter += 1
  return {
    id: `line-${String(lineCounter)}`,
    lineNumber: lineCounter,
    itemId: null,
    description: 'A thing',
    quantity: D('1'),
    unitCode: 'NOS',
    unitPrice: D('100.00'),
    discount: ZERO,
    taxableAmount: D('100.00'),
    ratePct: D('18'),
    classificationCode: null,
    isCharge: false,
    accountId: null,
    itcEligibility: null,
    taxes: [],
    ...overrides,
  }
}

function document(lines: DocumentLine[], roundingPolicy: Summable['roundingPolicy']): Summable {
  return { roundingPolicy, lines }
}

describe('one line', () => {
  it('adds its components to reach its tax', () => {
    const subject = line({ taxes: [tax('CGST', '9', '90.00'), tax('SGST', '9', '90.00')] })
    expect(lineTax(subject).toString()).toBe('180')
  })

  it('is zero tax when the line is exempt', () => {
    expect(lineTax(line()).toString()).toBe('0')
  })

  it('totals to its taxable amount plus its tax', () => {
    const subject = line({
      taxableAmount: D('1000.00'),
      taxes: [tax('IGST', '18', '180.00')],
    })
    expect(lineTotal(subject).toString()).toBe('1180')
  })
})

describe('a document with nothing on it', () => {
  it('adds up to zero rather than throwing', () => {
    const totals = documentTotals(document([], 'whole-unit'))
    expect(totals.taxableValue.toString()).toBe('0')
    expect(totals.totalTax.toString()).toBe('0')
    expect(totals.grandTotal.toString()).toBe('0')
    expect(totals.taxSummary).toEqual([])
  })
})

describe('the figures on the foot of a document', () => {
  const lines = [
    line({
      taxableAmount: D('10000.00'),
      discount: D('500.00'),
      taxes: [tax('CGST', '9', '900.00'), tax('SGST', '9', '900.00')],
    }),
    line({
      taxableAmount: D('750.00'),
      isCharge: true,
      ratePct: D('5'),
      taxes: [tax('CGST', '2.5', '18.75'), tax('SGST', '2.5', '18.75')],
    }),
  ]

  it('sums the taxable value across lines, charges included', () => {
    expect(documentTotals(document(lines, 'none')).taxableValue.toString()).toBe('10750')
  })

  it('reports the discount that has already been taken out of it', () => {
    /* On the footer for the customer to see, not deducted again — the line's taxable
     * amount is already net of it. */
    const totals = documentTotals(document(lines, 'none'))
    expect(totals.totalDiscount.toString()).toBe('500')
    expect(totals.taxableValue.toString()).toBe('10750')
  })

  it('sums the tax across every component of every line', () => {
    expect(documentTotals(document(lines, 'none')).totalTax.toString()).toBe('1837.5')
  })

  it('reaches the net total by adding the two', () => {
    expect(documentTotals(document(lines, 'none')).netTotal.toString()).toBe('12587.5')
  })
})

describe('rounding', () => {
  const halfRupee = [line({ taxableAmount: D('1000.00'), taxes: [tax('IGST', '18', '180.60')] })]

  it('rounds the grand total to the whole unit and reports what it added', () => {
    const totals = documentTotals(document(halfRupee, 'whole-unit'))
    expect(totals.netTotal.toString()).toBe('1180.6')
    expect(totals.roundOff.toString()).toBe('0.4')
    expect(totals.grandTotal.toString()).toBe('1181')
  })

  it('reports a negative adjustment when it rounds down', () => {
    const down = [line({ taxableAmount: D('1000.00'), taxes: [tax('IGST', '18', '180.40')] })]
    const totals = documentTotals(document(down, 'whole-unit'))
    expect(totals.roundOff.toString()).toBe('-0.4')
    expect(totals.grandTotal.toString()).toBe('1180')
  })

  it('rounds a half up, which is what an invoice does', () => {
    const half = [line({ taxableAmount: D('1000.00'), taxes: [tax('IGST', '18', '180.50')] })]
    expect(documentTotals(document(half, 'whole-unit')).grandTotal.toString()).toBe('1181')
  })

  it('leaves the total alone when the policy is none', () => {
    const totals = documentTotals(document(halfRupee, 'none'))
    expect(totals.roundOff.toString()).toBe('0')
    expect(totals.grandTotal.toString()).toBe('1180.6')
    expect(totals.grandTotal.toString()).toBe(totals.netTotal.toString())
  })

  it('adds no adjustment to a total that is already whole', () => {
    const whole = [line({ taxableAmount: D('1000.00'), taxes: [tax('IGST', '18', '180.00')] })]
    const totals = documentTotals(document(whole, 'whole-unit'))
    /* Not '-0'. A round-off line reading minus nothing is a support ticket. */
    expect(totals.roundOff.toString()).toBe('0')
  })

  it('always leaves net plus round-off equal to the grand total', () => {
    for (const policy of ['whole-unit', 'none'] as const) {
      const totals = documentTotals(document(halfRupee, policy))
      expect(totals.netTotal.plus(totals.roundOff).toString()).toBe(totals.grandTotal.toString())
    }
  })
})

describe('the tax summary', () => {
  /* Ordered so that first-met disagrees with both the alphabet and the rate: the 18%
   * component appears first, the 5% second, and the 18% again at the end. */
  const mixed = [
    line({ taxableAmount: D('1000.00'), taxes: [tax('IGST', '18', '180.00')] }),
    line({ taxableAmount: D('200.00'), isCharge: true, taxes: [tax('IGST', '5', '10.00')] }),
    line({ taxableAmount: D('500.00'), taxes: [tax('IGST', '18', '90.00')] }),
  ]

  it('gathers a component across the lines that carry it', () => {
    const summary = documentTotals(document(mixed, 'none')).taxSummary
    expect(summary.map((row) => row.amount.toString())).toEqual(['270', '10'])
  })

  it('keeps one row per rate, not one per component', () => {
    /* A single 'IGST 280.00' line is a figure the customer cannot check against any rate
     * and the return has no box for. */
    const summary = documentTotals(document(mixed, 'none')).taxSummary
    expect(summary.map((row) => row.ratePct.toString())).toEqual(['18', '5'])
    expect(summary).toHaveLength(2)
  })

  it('lists the rows in the order the document first met them', () => {
    const summary = documentTotals(document(mixed, 'none')).taxSummary
    expect(summary.map((row) => row.label)).toEqual(['IGST @ 18%', 'IGST @ 5%'])
  })

  it('splits components that share a rate', () => {
    const intra = [
      line({
        taxableAmount: D('1000.00'),
        taxes: [tax('CGST', '9', '90.00'), tax('SGST', '9', '90.00')],
      }),
    ]
    const summary = documentTotals(document(intra, 'none')).taxSummary
    expect(summary.map((row) => row.code)).toEqual(['CGST', 'SGST'])
  })

  it('treats 9 and 9.000 as one rate', () => {
    /* Two lines whose rate was parsed from differently written text are the same rate,
     * and must not print as two summary rows that each look wrong. */
    const written = [
      line({ taxes: [tax('CGST', '9', '90.00')] }),
      line({ taxes: [tax('CGST', '9.000', '45.00')] }),
    ]
    const summary = documentTotals(document(written, 'none')).taxSummary
    expect(summary).toHaveLength(1)
    expect(summary[0]?.amount.toString()).toBe('135')
  })

  it("does not hand back the line's own tax object to be mutated later", () => {
    const source = tax('IGST', '18', '180.00')
    const summary = documentTotals(document([line({ taxes: [source] })], 'none')).taxSummary
    expect(summary[0]).not.toBe(source)
    expect(summary[0]?.amount.toString()).toBe('180')
  })
})

describe('exactness', () => {
  it('adds money the ledger would lose to floating point', () => {
    /* The same figures that showed `SUM()` over decimal text is not exact (batch 1.1C).
     * 0.07 three times plus 1234567.89 plus 0.01 is 1234568.11, not 1234568.1099999999. */
    const awkward = [
      line({ taxableAmount: D('0.07') }),
      line({ taxableAmount: D('0.07') }),
      line({ taxableAmount: D('0.07') }),
      line({ taxableAmount: D('1234567.89') }),
      line({ taxableAmount: D('0.01') }),
    ]
    expect(documentTotals(document(awkward, 'none')).taxableValue.toString()).toBe('1234568.11')
  })

  it('adds a hundred paise to exactly one rupee', () => {
    const pennies = Array.from({ length: 100 }, () => line({ taxableAmount: D('0.01') }))
    expect(documentTotals(document(pennies, 'none')).taxableValue.toString()).toBe('1')
  })
})
