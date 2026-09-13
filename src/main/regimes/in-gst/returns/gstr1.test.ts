/*
 * GSTR-1, run against the worked month in `__fixtures__/period.json`.
 *
 * EVERY SECTION'S ROWS ARE ASSERTED, not only its totals. A test that checks only that a
 * total balances cannot see a whole document dropped from a section, and it cannot see
 * two mistakes with opposite signs — both of which this project has already shipped. So
 * each section is compared whole against a hand-worked expectation, and the tie-out
 * assertions sit BESIDE that rather than instead of it.
 */

import { describe, expect, it } from 'vitest'
import { sum } from '@main/domain/money'
import { buildDocIssue, buildGstr1, resolveExport, NATURE_OF_DOCUMENT } from './gstr1'
import { blockingCount } from './errors'
import { BUNDLED_COMPLIANCE_PACK } from '../compliance-pack'
import type { DocumentIssueRange, ReturnDocument, ReturnPeriod } from './types'
import type { TaxAmounts } from './amounts'
import { doc, EXPORT_AE, igst, line, NOVEMBER_2027 } from './__fixtures__/builders'

import periodFixture from './__fixtures__/period.json'
import expectedFixture from './__fixtures__/expected.json'

const fixture = periodFixture as unknown as {
  period: ReturnPeriod
  documents: ReturnDocument[]
  issuedRanges: DocumentIssueRange[]
}

/* `$why` keys carry the reasoning and are not part of the type. Stripped once, here, so
 * that every expectation below compares the real shape rather than a shape plus notes. */
const strip = <T>(value: T): T => JSON.parse(JSON.stringify(value, replacer)) as T
function replacer(key: string, value: unknown): unknown {
  return key.startsWith('$') ? undefined : value
}

const documents = strip(fixture.documents)
const issuedRanges = strip(fixture.issuedRanges)

const expected = expectedFixture as unknown as {
  gstr1: Record<string, unknown> & {
    hsnRows: unknown[]
    hsnTotals: { taxableValue: string; tax: TaxAmounts }
    reported: { documentCount: number; taxableValue: string; tax: TaxAmounts }
    net: { taxableValue: string; tax: TaxAmounts }
    issueCodes: string[]
  }
}

const built = buildGstr1({ period: fixture.period, documents, issuedRanges })

describe('GSTR-1 — the worked month, section by section', () => {
  it('B2B: parties in GSTIN order, invoices under each, rate rows inside those', () => {
    expect(built.b2b).toEqual(expected.gstr1['b2b'])
  })

  it('B2CL: the one document that is unregistered, inter-state and over the threshold', () => {
    expect(built.b2cl).toEqual(expected.gstr1['b2cl'])
  })

  it('B2CS: aggregated by place of supply and rate, with no document number anywhere', () => {
    expect(built.b2cs).toEqual(expected.gstr1['b2cs'])
  })

  it('CDNR: the note against the registered customer, carrying its original', () => {
    expect(built.cdnr).toEqual(expected.gstr1['cdnr'])
  })

  it('CDNUR: the note against the unregistered customer, with no original to name', () => {
    expect(built.cdnur).toEqual(expected.gstr1['cdnur'])
  })

  it('EXP: both flavours, always both present so an empty one is visible', () => {
    expect(built.exp).toEqual(expected.gstr1['exp'])
  })

  it('HSN: one row per code, UQC and rate, netted for the credit notes', () => {
    expect(built.hsn.rows).toEqual(expected.gstr1.hsnRows)
  })

  it('HSN totals', () => {
    expect(built.hsn.taxableValue).toBe(expected.gstr1.hsnTotals.taxableValue)
    expect(built.hsn.tax).toEqual(expected.gstr1.hsnTotals.tax)
  })

  it('DOC_ISSUE: the series, from the numbering rather than from the documents', () => {
    expect(built.docIssue).toEqual(expected.gstr1['docIssue'])
  })

  it('the return-level totals, reported and net', () => {
    expect(built.reported).toEqual(expected.gstr1.reported)
    expect(built.net).toEqual(expected.gstr1.net)
  })
})

describe('the invariants a return is rejected for failing', () => {
  const taxOf = (amounts: TaxAmounts): string[] => [
    amounts.igst,
    amounts.cgst,
    amounts.sgst,
    amounts.cess,
  ]

  const addTax = (rows: readonly TaxAmounts[]): string[] => [
    sum(rows.map((row) => row.igst)).toFixed(2),
    sum(rows.map((row) => row.cgst)).toFixed(2),
    sum(rows.map((row) => row.sgst)).toFixed(2),
    sum(rows.map((row) => row.cess)).toFixed(2),
  ]

  it('B2B: the section total is the sum of the parties, and each party of its invoices', () => {
    for (const party of built.b2b.parties) {
      expect(party.taxableValue).toBe(
        sum(party.invoices.map((invoice) => invoice.taxableValue)).toFixed(2),
      )
      expect(taxOf(party.tax)).toEqual(addTax(party.invoices.map((invoice) => invoice.tax)))
      for (const invoice of party.invoices) {
        expect(invoice.taxableValue).toBe(
          sum(invoice.items.map((item) => item.taxableValue)).toFixed(2),
        )
        expect(taxOf(invoice.tax)).toEqual(addTax(invoice.items.map((item) => item.tax)))
      }
    }
    expect(built.b2b.taxableValue).toBe(
      sum(built.b2b.parties.map((party) => party.taxableValue)).toFixed(2),
    )
    expect(taxOf(built.b2b.tax)).toEqual(addTax(built.b2b.parties.map((party) => party.tax)))
  })

  it('B2CL: the section total is the sum of the places', () => {
    expect(built.b2cl.taxableValue).toBe(
      sum(built.b2cl.places.map((place) => place.taxableValue)).toFixed(2),
    )
    expect(taxOf(built.b2cl.tax)).toEqual(addTax(built.b2cl.places.map((place) => place.tax)))
  })

  it('B2CS: the section total is the sum of the rows', () => {
    expect(built.b2cs.taxableValue).toBe(
      sum(built.b2cs.rows.map((row) => row.taxableValue)).toFixed(2),
    )
    expect(taxOf(built.b2cs.tax)).toEqual(addTax(built.b2cs.rows.map((row) => row.tax)))
  })

  it('EXP: the section total is the sum of the groups', () => {
    expect(built.exp.taxableValue).toBe(
      sum(built.exp.groups.map((group) => group.taxableValue)).toFixed(2),
    )
    expect(taxOf(built.exp.tax)).toEqual(addTax(built.exp.groups.map((group) => group.tax)))
  })

  it('HSN: the summary total is the sum of the HSN rows', () => {
    expect(built.hsn.taxableValue).toBe(
      sum(built.hsn.rows.map((row) => row.taxableValue)).toFixed(2),
    )
    expect(taxOf(built.hsn.tax)).toEqual(addTax(built.hsn.rows.map((row) => row.tax)))
  })

  it('the reported total is the sum of the six value sections, positive throughout', () => {
    const sections = [built.b2b, built.b2cl, built.b2cs, built.cdnr, built.cdnur, built.exp]
    expect(built.reported.taxableValue).toBe(
      sum(sections.map((section) => section.taxableValue)).toFixed(2),
    )
    expect(taxOf(built.reported.tax)).toEqual(addTax(sections.map((section) => section.tax)))
  })

  it('the NET total equals the HSN summary — charges less refunds, on both sides', () => {
    expect(built.net.taxableValue).toBe(built.hsn.taxableValue)
    expect(built.net.tax).toEqual(built.hsn.tax)
  })

  it('the net differs from the reported by twice the notes, which is the whole point', () => {
    /* Reported 482,246.16 less net 412,246.16 is 70,000 — the 35,000 of notes counted
     * positive in the sections and negative in the net. If the two were equal, either the
     * notes had been dropped or the HSN summary was gross. */
    expect(built.reported.taxableValue).toBe('482246.16')
    expect(built.net.taxableValue).toBe('412246.16')
  })

  it('every document that was not cancelled is in exactly one value section', () => {
    const ids = [
      ...built.b2b.parties.flatMap((p) => p.invoices.map((i) => i.documentId)),
      ...built.b2cl.places.flatMap((p) => p.invoices.map((i) => i.documentId)),
      ...built.cdnr.parties.flatMap((p) => p.notes.map((n) => n.documentId)),
      ...built.cdnur.notes.map((n) => n.documentId),
      ...built.exp.groups.flatMap((g) => g.invoices.map((i) => i.documentId)),
    ]
    /* B2CS carries no document id at all, by design — it is the aggregated section — so
     * its documents are counted rather than named. */
    expect(ids.length + built.b2cs.documentCount).toBe(built.reported.documentCount)
    expect(new Set(ids).size).toBe(ids.length)

    const live = documents.filter((document) => !document.isCancelled)
    expect(built.reported.documentCount).toBe(live.length)
  })
})

describe('a cancelled document', () => {
  it('reaches no value section and no HSN row', () => {
    /* The VALUE sections and the HSN summary only — table 13 is the one place a
     * cancelled document must appear, and searching the whole return would find it
     * there and pass for the wrong reason. */
    const valued = JSON.stringify([
      built.b2b,
      built.b2cl,
      built.b2cs,
      built.cdnr,
      built.cdnur,
      built.exp,
      built.hsn,
    ])
    expect(valued).not.toContain('INV-1007')
    expect(valued).not.toContain('"d11"')
  })

  it('is still counted in the document-issued table', () => {
    expect(built.docIssue.cancelled).toBe(1)
    expect(built.docIssue.netIssued).toBe(built.docIssue.totalIssued - 1)
  })
})

describe('the threshold comes from the pack, not from the code', () => {
  const higher = {
    ...BUNDLED_COMPLIANCE_PACK,
    returns: { ...BUNDLED_COMPLIANCE_PACK.returns, b2clInvoiceValueThreshold: '250000.00' },
  }

  it('the bundled pack puts INV-1003 in B2CL', () => {
    expect(
      built.b2cl.places.flatMap((place) => place.invoices.map((i) => i.documentNumber)),
    ).toEqual(['INV-1003'])
  })

  it('a pack with a higher threshold moves that same document to B2CS', () => {
    const raised = buildGstr1({ period: fixture.period, documents, pack: higher })
    expect(raised.b2cl.places).toEqual([])
    expect(raised.b2cl.invoiceCount).toBe(0)
    /* And it lands in B2CS as a 32 / inter / 18% row, folded in with INV-1006. */
    const row = raised.b2cs.rows.find(
      (each) => each.placeOfSupplyCode === '32' && each.ratePct === '18',
    )
    expect(row?.taxableValue).toBe('174745.76')
    expect(row?.tax.igst).toBe('31454.24')
  })

  it('the two runs report the same money, only in different places', () => {
    const raised = buildGstr1({ period: fixture.period, documents, pack: higher })
    expect(raised.reported.taxableValue).toBe(built.reported.taxableValue)
    expect(raised.reported.tax).toEqual(built.reported.tax)
    expect(raised.net.taxableValue).toBe(built.net.taxableValue)
  })

  it('names the pack version it ran, so a filed artefact says which rules made it', () => {
    expect(built.packVersion).toBe(BUNDLED_COMPLIANCE_PACK.packVersion)
  })
})

describe('order is asserted, and the fixture disagrees with it', () => {
  it('B2B parties come out in GSTIN order although the fixture lists them the other way', () => {
    const fixtureOrder = documents
      .filter((d) => d.counterparty.registrationNumber !== null && !d.isCancelled)
      .map((d) => d.counterparty.registrationNumber)
    expect(fixtureOrder[0]).toBe('33AABCC1234E1ZG')
    expect(built.b2b.parties.map((party) => party.gstin)).toEqual([
      '29AAAAA0000A1ZY',
      '33AABCC1234E1ZG',
    ])
  })

  it('rate rows inside an invoice are ordered by rate, ascending', () => {
    const anand = built.b2b.parties.find((p) => p.gstin === '33AABCC1234E1ZG')
    expect(anand?.invoices[0]?.items.map((item) => item.ratePct)).toEqual(['5', '18'])
  })

  it('B2CS rows are ordered by place, then supply type, then rate', () => {
    expect(built.b2cs.rows.map((row) => `${row.placeOfSupplyCode}/${row.ratePct}`)).toEqual([
      '29/18',
      '32/18',
      '33/0',
      '33/5',
    ])
  })

  it('HSN rows are ordered by code, then UQC, then rate — nulls last', () => {
    expect(built.hsn.rows.map((row) => `${row.classificationCode}/${row.ratePct}`)).toEqual([
      '0401/0',
      '1006/5',
      '6109/0',
      '6109/18',
      '8415/18',
      '8471/18',
      '8517/18',
      '9403/18',
      '996511/5',
    ])
  })

  it('table 13 is ordered by nature, then by the first number, not by input order', () => {
    expect(built.docIssue.rows.map((row) => row.seriesLabel)).toEqual([
      'Credit notes',
      'Export invoices',
      'Tax invoices',
    ])
    expect(issuedRanges.map((range) => range.seriesLabel)).toEqual([
      'Tax invoices',
      'Export invoices',
      'Credit notes',
    ])
  })

  it('the fixture is not in date order, so a builder returning input order would fail', () => {
    const dates = documents.map((document) => document.date)
    const sorted = [...dates].sort()
    expect(dates).not.toEqual(sorted)
  })
})

describe('what the return says about itself', () => {
  it('always carries the schema notice, in the artefact and in its issues', () => {
    expect(built.notice).toMatch(/^These figures are computed from your own documents/)
    expect(built.notice).toContain('has not been checked against the portal')
    expect(built.issues[0]?.code).toBe('SCHEMA_UNVERIFIED')
  })

  it('reports every issue the month raises, in order, and nothing else', () => {
    expect(built.issues.map((each) => each.code)).toEqual(expected.gstr1.issueCodes)
  })

  it('counts the documents that took the reverse-charge default', () => {
    const raised = built.issues.find((each) => each.code === 'REVERSE_CHARGE_NOT_RECORDED')
    /* Nine of the ten live documents; INV-1001 states its flag. */
    expect(raised?.value).toBe('9')
  })

  it('names the unit that has no UQC, and calls it an error', () => {
    const raised = built.issues.find((each) => each.code === 'UQC_NOT_MAPPED')
    expect(raised?.severity).toBe('error')
    expect(raised?.value).toBe('BAGS')
  })

  it('two issues would stop a filing: the missing shipping bill and the missing UQC', () => {
    expect(blockingCount(built.issues)).toBe(2)
  })
})

describe('exports, and the flavour the data model does not record', () => {
  it('believes a stated flavour and raises nothing when the shipping bill is there', () => {
    const stated = doc({
      placeOfSupply: EXPORT_AE,
      exportDetail: {
        taxPayment: 'without-payment',
        shippingBillNumber: '9001',
        shippingBillDate: '2027-11-12',
        portCode: 'INMAA1',
      },
    })
    const resolved = resolveExport(stated)
    expect(resolved.taxPayment).toBe('without-payment')
    expect(resolved.issues).toEqual([])
  })

  it('infers WITH payment from tax having been charged, and says so', () => {
    const taxed = doc({
      placeOfSupply: EXPORT_AE,
      exportDetail: {
        taxPayment: null,
        shippingBillNumber: '9002',
        shippingBillDate: '2027-11-12',
        portCode: 'INMAA1',
      },
      lines: [line({ taxableValue: '1000.00', taxes: igst('180.00') })],
    })
    const resolved = resolveExport(taxed)
    expect(resolved.taxPayment).toBe('with-payment')
    expect(resolved.issues.map((each) => each.code)).toEqual(['EXPORT_TAX_PAYMENT_INFERRED'])
  })

  it('infers UNDER LUT from a rated supply carrying no tax', () => {
    const untaxed = doc({
      placeOfSupply: EXPORT_AE,
      exportDetail: {
        taxPayment: null,
        shippingBillNumber: '9003',
        shippingBillDate: '2027-11-12',
        portCode: 'INMAA1',
      },
      lines: [line({ taxableValue: '1000.00', ratePct: '18', taxes: [] })],
    })
    const resolved = resolveExport(untaxed)
    expect(resolved.taxPayment).toBe('without-payment')
    expect(resolved.issues.map((each) => each.code)).toEqual(['EXPORT_TAX_PAYMENT_INFERRED'])
  })

  it('ASSUMES under LUT for a nil-rated export, where nothing can tell the two apart', () => {
    const nil = doc({
      placeOfSupply: EXPORT_AE,
      exportDetail: {
        taxPayment: null,
        shippingBillNumber: '9004',
        shippingBillDate: '2027-11-12',
        portCode: 'INMAA1',
      },
      lines: [line({ taxableValue: '1000.00', ratePct: '0', taxes: [] })],
    })
    const resolved = resolveExport(nil)
    expect(resolved.taxPayment).toBe('without-payment')
    expect(resolved.issues.map((each) => each.code)).toEqual(['EXPORT_TAX_PAYMENT_ASSUMED'])
    expect(resolved.issues[0]?.message).toContain('nothing in it can say')
  })

  it('calls a missing shipping bill an error, whatever the flavour', () => {
    const resolved = resolveExport(doc({ placeOfSupply: EXPORT_AE, exportDetail: null }))
    const raised = resolved.issues.find((each) => each.code === 'EXPORT_SHIPPING_BILL_MISSING')
    expect(raised?.severity).toBe('error')
  })
})

describe('the document-issued table', () => {
  it('refuses a series for a kind GSTR-1 does not declare', () => {
    expect(() =>
      buildDocIssue([
        {
          kind: 'purchase-bill',
          seriesLabel: 'Purchase bills',
          fromNumber: 'B1',
          toNumber: 'B9',
          totalIssued: 9,
          cancelled: 0,
        },
      ]),
    ).toThrow(/has no row in GSTR-1's document table/)
  })

  it('refuses more cancelled than issued', () => {
    expect(() =>
      buildDocIssue([
        {
          kind: 'sales-invoice',
          seriesLabel: 'Tax invoices',
          fromNumber: 'A1',
          toNumber: 'A2',
          totalIssued: 2,
          cancelled: 3,
        },
      ]),
    ).toThrow(/cancelled out of 2 issued, which cannot be/)
  })

  it('answers for every document kind, so a sixth would not compile until it did', () => {
    expect(Object.keys(NATURE_OF_DOCUMENT).sort()).toEqual([
      'credit-note',
      'debit-note',
      'purchase-bill',
      'quotation',
      'sales-invoice',
    ])
  })

  it('is empty and adds to nothing when no ranges are supplied', () => {
    const noRanges = buildGstr1({ period: fixture.period, documents })
    expect(noRanges.docIssue).toEqual({
      rows: [],
      totalIssued: 0,
      cancelled: 0,
      netIssued: 0,
    })
  })
})

describe('an empty period', () => {
  const empty = buildGstr1({ period: NOVEMBER_2027, documents: [] })

  it('produces every section, empty, rather than omitting them', () => {
    expect(empty.b2b.parties).toEqual([])
    expect(empty.b2cl.places).toEqual([])
    expect(empty.b2cs.rows).toEqual([])
    expect(empty.cdnr.parties).toEqual([])
    expect(empty.cdnur.notes).toEqual([])
    expect(empty.exp.groups.map((group) => group.taxPayment)).toEqual([
      'with-payment',
      'without-payment',
    ])
    expect(empty.hsn.rows).toEqual([])
  })

  it('reports zero, at money scale, and not an empty string', () => {
    expect(empty.reported).toEqual({
      documentCount: 0,
      taxableValue: '0.00',
      tax: { igst: '0.00', cgst: '0.00', sgst: '0.00', cess: '0.00' },
    })
    expect(empty.net.taxableValue).toBe('0.00')
  })

  it('still says it is provisional', () => {
    expect(empty.issues.map((each) => each.code)).toEqual(['SCHEMA_UNVERIFIED'])
  })
})

describe('refusals reach the caller of buildGstr1, not a quiet omission', () => {
  it('refuses a document dated outside the period', () => {
    expect(() =>
      buildGstr1({ period: NOVEMBER_2027, documents: [doc({ date: '2027-12-02' })] }),
    ).toThrow(/outside 2027-11-01 to 2027-11-30/)
  })

  it('refuses a purchase bill', () => {
    expect(() =>
      buildGstr1({ period: NOVEMBER_2027, documents: [doc({ kind: 'purchase-bill' })] }),
    ).toThrow(/this return reports sales/)
  })

  it('refuses two invoices sharing a number', () => {
    expect(() =>
      buildGstr1({
        period: NOVEMBER_2027,
        documents: [doc({ id: 'a' }), doc({ id: 'b', date: '2027-11-11' })],
      }),
    ).toThrow(/both carry the number/)
  })
})

describe('a rate written two ways is one row', () => {
  /* `rate_pct` is a 3dp column, so a document raised before a migration and one raised
   * after can carry '18' and '18.000' for the same slab. Keying a row by the raw text
   * would split them into two rows that each look right and neither of which is. */
  const twoSpellings = [
    line({ lineNumber: 1, ratePct: '18', taxableValue: '1000.00', taxes: igst('180.00') }),
    line({ lineNumber: 2, ratePct: '18.000', taxableValue: '2000.00', taxes: igst('360.00') }),
  ]

  it('collapses them into one rate row inside a B2B invoice', () => {
    const result = buildGstr1({
      period: NOVEMBER_2027,
      documents: [
        doc({
          counterparty: {
            partyId: 'p-reg',
            name: 'Registered Buyer',
            registrationNumber: '29AAAAA0000A1ZY',
            jurisdictionCode: '29',
            countryCode: 'in',
          },
          lines: twoSpellings,
        }),
      ],
    })
    const items = result.b2b.parties[0]?.invoices[0]?.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0]?.ratePct).toBe('18')
    expect(items[0]?.taxableValue).toBe('3000.00')
    expect(items[0]?.tax.igst).toBe('540.00')
  })

  it('collapses them into one B2CS row as well', () => {
    const result = buildGstr1({
      period: NOVEMBER_2027,
      documents: [doc({ lines: twoSpellings })],
    })
    expect(result.b2cs.rows).toHaveLength(1)
    expect(result.b2cs.rows[0]?.ratePct).toBe('18')
    expect(result.b2cs.rows[0]?.taxableValue).toBe('3000.00')
  })
})

describe('several documents for one party', () => {
  const buyer = {
    partyId: 'p-reg',
    name: 'Registered Buyer',
    registrationNumber: '29AAAAA0000A1ZY',
    jurisdictionCode: '29',
    countryCode: 'in',
  }

  it('groups B2B invoices under ONE party, in date order, with the party total', () => {
    /* The worked month has one invoice per party, so nothing in it can tell a builder
     * that groups from one that emits a party row per invoice. This can. */
    const result = buildGstr1({
      period: NOVEMBER_2027,
      documents: [
        doc({
          id: 'later',
          number: 'INV-2',
          date: '2027-11-20',
          counterparty: buyer,
          lines: [line({ taxableValue: '2000.00', taxes: igst('360.00') })],
        }),
        doc({
          id: 'earlier',
          number: 'INV-1',
          date: '2027-11-05',
          counterparty: buyer,
          lines: [line({ taxableValue: '1000.00', taxes: igst('180.00') })],
        }),
      ],
    })
    expect(result.b2b.parties).toHaveLength(1)
    const party = result.b2b.parties[0]
    expect(party?.invoices.map((invoice) => invoice.documentNumber)).toEqual(['INV-1', 'INV-2'])
    expect(party?.taxableValue).toBe('3000.00')
    expect(party?.tax.igst).toBe('540.00')
    expect(result.b2b.invoiceCount).toBe(2)
  })

  it('groups CDNR notes under ONE party the same way', () => {
    const note = (id: string, number: string, date: string, value: string, tax: string) =>
      doc({
        id,
        number,
        date,
        kind: 'credit-note' as const,
        counterparty: buyer,
        corrects: {
          documentId: 'orig',
          kind: 'sales-invoice' as const,
          number: 'INV-0',
          date: '2027-11-01',
        },
        lines: [line({ taxableValue: value, taxes: igst(tax) })],
      })
    const result = buildGstr1({
      period: NOVEMBER_2027,
      documents: [
        note('n2', 'CRN-2', '2027-11-22', '500.00', '90.00'),
        note('n1', 'CRN-1', '2027-11-08', '300.00', '54.00'),
      ],
    })
    expect(result.cdnr.parties).toHaveLength(1)
    expect(result.cdnr.parties[0]?.notes.map((n) => n.documentNumber)).toEqual(['CRN-1', 'CRN-2'])
    expect(result.cdnr.parties[0]?.taxableValue).toBe('800.00')
    expect(result.cdnr.noteCount).toBe(2)
  })
})

describe('a supply whose place is not known', () => {
  /* `placeOfSupply()` resolves an unknown state to INTER-state, which is the conservative
   * answer -- IGST charged where CGST+SGST was due is a correctable filing error, a state
   * split against the wrong state is money paid to the wrong government. The return has to
   * inherit that rather than invent a state. */
  const unknownPlace = {
    jurisdictionCode: null,
    countryCode: 'in',
    isIntraJurisdiction: false,
    isExport: false,
  }

  it('carries a null place of supply through B2CL rather than inventing one', () => {
    const result = buildGstr1({
      period: NOVEMBER_2027,
      documents: [
        doc({
          placeOfSupply: unknownPlace,
          lines: [line({ taxableValue: '200000.00', taxes: igst('36000.00') })],
        }),
      ],
    })
    expect(result.b2cl.places).toHaveLength(1)
    expect(result.b2cl.places[0]?.placeOfSupplyCode).toBeNull()
    expect(result.b2cl.places[0]?.invoices[0]?.placeOfSupplyCode).toBeNull()
  })

  it('carries it through B2CS, as an inter-state row', () => {
    const result = buildGstr1({
      period: NOVEMBER_2027,
      documents: [doc({ placeOfSupply: unknownPlace })],
    })
    expect(result.b2cs.rows).toHaveLength(1)
    expect(result.b2cs.rows[0]?.placeOfSupplyCode).toBeNull()
    expect(result.b2cs.rows[0]?.supplyType).toBe('inter')
  })
})
