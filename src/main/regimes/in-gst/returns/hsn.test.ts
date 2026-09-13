/*
 * The HSN summary, and the three UQC cases that are genuinely different.
 *
 * The middle case is the one worth a test of its own: a service has no unit and is not a
 * unit whose mapping is missing. Reporting the two the same way would put an error on
 * every consultancy invoice ever raised, and an error that fires on everything is one
 * people learn to click past.
 */

import { describe, expect, it } from 'vitest'
import { buildHsnSummary, emptyHsnSummary, uqcOf, UQC_NOT_APPLICABLE } from './hsn'
import { doc, igst, line, pair } from './__fixtures__/builders'

describe('the UQC, one case at a time', () => {
  const document = doc()

  it('a unit with a regime code files under it, upper-cased', () => {
    const resolved = uqcOf(document, line({ unitCode: 'bags', uqc: 'bag' }))
    expect(resolved.uqc).toBe('BAG')
    expect(resolved.issue).toBeNull()
  })

  it('a line with NO unit at all is a service and files as NA, raising nothing', () => {
    const resolved = uqcOf(document, line({ unitCode: null, uqc: null }))
    expect(resolved.uqc).toBe(UQC_NOT_APPLICABLE)
    expect(resolved.uqc).toBe('NA')
    expect(resolved.issue).toBeNull()
  })

  it('a blank unit is the same as no unit — a service, not a missing mapping', () => {
    const resolved = uqcOf(document, line({ unitCode: '   ', uqc: null }))
    expect(resolved.uqc).toBe('NA')
    expect(resolved.issue).toBeNull()
  })

  it('a unit with NO regime code is the gap: no UQC, and an error naming the unit', () => {
    const resolved = uqcOf(document, line({ unitCode: 'BAGS', uqc: null }))
    expect(resolved.uqc).toBeNull()
    expect(resolved.issue?.code).toBe('UQC_NOT_MAPPED')
    expect(resolved.issue?.severity).toBe('error')
    expect(resolved.issue?.value).toBe('BAGS')
    expect(resolved.issue?.message).toContain("The unit 'BAGS' has no UQC")
  })

  it('a blank regime code counts as none, not as an empty UQC', () => {
    const resolved = uqcOf(document, line({ unitCode: 'BAGS', uqc: '  ' }))
    expect(resolved.uqc).toBeNull()
    expect(resolved.issue?.code).toBe('UQC_NOT_MAPPED')
  })
})

describe('the key is three things', () => {
  it('splits one HSN across two rates', () => {
    const summary = buildHsnSummary([
      doc({
        lines: [
          line({ lineNumber: 1, taxableValue: '1000.00', ratePct: '18', taxes: igst('180.00') }),
          line({
            lineNumber: 2,
            taxableValue: '2000.00',
            ratePct: '5',
            taxes: igst('100.00', '5'),
          }),
        ],
      }),
    ])
    expect(summary.rows.map((row) => `${row.classificationCode}/${row.ratePct}`)).toEqual([
      '8471/5',
      '8471/18',
    ])
  })

  it('splits one HSN at one rate across two units', () => {
    const summary = buildHsnSummary([
      doc({
        lines: [
          line({ lineNumber: 1, unitCode: 'NOS', uqc: 'NOS', quantity: '2.000' }),
          line({ lineNumber: 2, unitCode: 'BOX', uqc: 'BOX', quantity: '3.000' }),
        ],
      }),
    ])
    expect(summary.rows.map((row) => row.uqc)).toEqual(['BOX', 'NOS'])
  })

  it("does not split '18' from '18.000' — the rate is keyed as a decimal, not as text", () => {
    const summary = buildHsnSummary([
      doc({
        lines: [
          line({ lineNumber: 1, ratePct: '18', quantity: '1.000' }),
          line({ lineNumber: 2, ratePct: '18.000', quantity: '1.000' }),
        ],
      }),
    ])
    expect(summary.rows).toHaveLength(1)
    expect(summary.rows[0]?.quantity).toBe('2.000')
    expect(summary.rows[0]?.ratePct).toBe('18')
  })
})

describe('corrections enter the summary negative', () => {
  const invoice = doc({
    id: 'a',
    number: 'INV-1',
    lines: [line({ quantity: '10.000', taxableValue: '10000.00', taxes: igst('1800.00') })],
  })
  const note = doc({
    id: 'b',
    kind: 'credit-note',
    number: 'CRN-1',
    date: '2027-11-20',
    corrects: null,
    lines: [line({ quantity: '4.000', taxableValue: '4000.00', taxes: igst('720.00') })],
  })

  it('nets the quantity, the value and the tax', () => {
    const summary = buildHsnSummary([invoice, note])
    expect(summary.rows).toHaveLength(1)
    expect(summary.rows[0]?.quantity).toBe('6.000')
    expect(summary.rows[0]?.taxableValue).toBe('6000.00')
    expect(summary.rows[0]?.tax.igst).toBe('1080.00')
  })

  it('can go negative outright when a period returns more than it sold', () => {
    const summary = buildHsnSummary([note])
    /* Anchored, both ends: `toContain('1080.00')` would be just as happy with '-1080.00',
     * and a dropped sign here is a return claiming a supply that was refunded. */
    expect(summary.rows[0]?.taxableValue).toBe('-4000.00')
    expect(summary.rows[0]?.tax.igst).toBe('-720.00')
    expect(summary.rows[0]?.quantity).toBe('-4.000')
    expect(summary.taxableValue).toBe('-4000.00')
  })
})

describe('a line with no classification code', () => {
  const summary = buildHsnSummary([
    doc({ number: 'INV-77', lines: [line({ classificationCode: null })] }),
  ])

  it('keeps the value in the summary rather than losing it', () => {
    expect(summary.rows).toHaveLength(1)
    expect(summary.rows[0]?.classificationCode).toBeNull()
    expect(summary.taxableValue).toBe('1000.00')
  })

  it('and says the portal will reject it', () => {
    expect(summary.issues.map((each) => each.code)).toEqual(['CLASSIFICATION_CODE_MISSING'])
    expect(summary.issues[0]?.severity).toBe('error')
    expect(summary.issues[0]?.documentNumber).toBe('INV-77')
  })

  it('sorts the coded rows first and the uncoded one last', () => {
    const mixed = buildHsnSummary([
      doc({
        lines: [
          line({ lineNumber: 1, classificationCode: null }),
          line({ lineNumber: 2, classificationCode: '9403' }),
        ],
      }),
    ])
    expect(mixed.rows.map((row) => row.classificationCode)).toEqual(['9403', null])
  })
})

describe('an issue is raised once, not once per line', () => {
  it('reports one unmapped unit however many lines carry it', () => {
    const summary = buildHsnSummary([
      doc({
        lines: [
          line({ lineNumber: 1, unitCode: 'BAGS', uqc: null }),
          line({ lineNumber: 2, unitCode: 'BAGS', uqc: null, ratePct: '5', taxes: [] }),
        ],
      }),
      doc({ id: 'c', number: 'INV-2', lines: [line({ unitCode: 'BAGS', uqc: null })] }),
    ])
    expect(summary.issues.filter((each) => each.code === 'UQC_NOT_MAPPED')).toHaveLength(1)
  })
})

describe('cancelled documents and empty periods', () => {
  it('skips a cancelled document entirely', () => {
    const summary = buildHsnSummary([doc({ isCancelled: true })])
    expect(summary.rows).toEqual([])
    expect(summary.taxableValue).toBe('0.00')
  })

  it('reports zero at money scale for an empty period, not an empty string', () => {
    const summary = buildHsnSummary([])
    expect(summary).toEqual(emptyHsnSummary())
    expect(summary.tax).toEqual({ igst: '0.00', cgst: '0.00', sgst: '0.00', cess: '0.00' })
  })
})

describe('the intra-state pair lands in one State/UT column', () => {
  it('adds CGST and SGST separately, never into each other', () => {
    const summary = buildHsnSummary([
      doc({ lines: [line({ taxableValue: '10000.00', taxes: pair('900.00') })] }),
    ])
    expect(summary.rows[0]?.tax).toEqual({
      igst: '0.00',
      cgst: '900.00',
      sgst: '900.00',
      cess: '0.00',
    })
  })

  it('files UTGST where SGST goes, because the return has one column for both', () => {
    const summary = buildHsnSummary([
      doc({
        lines: [
          line({
            taxableValue: '10000.00',
            taxes: [
              { code: 'CGST', ratePct: '9', amount: '900.00' },
              { code: 'UTGST', ratePct: '9', amount: '900.00' },
            ],
          }),
        ],
      }),
    ])
    expect(summary.rows[0]?.tax.sgst).toBe('900.00')
    expect(summary.rows[0]?.tax.cgst).toBe('900.00')
  })
})
