/*
 * The mapper.
 *
 * THE REGIME COMES FROM THE REGISTRY, NOT FROM A COPY IN THE FIXTURE. `describeRegime` is
 * asked for the real India description, so the jurisdiction names, the component order and
 * the number format under test are the ones production uses — a fixture holding its own
 * copy of them would agree by inspection and stop agreeing silently. Asked BY ID through
 * `getRegime`, because eslint refuses a direct import of `regimes/in-gst` here exactly as
 * it does in a screen (CONVENTIONS §1.6).
 *
 * AND ONE TEST ASKS A REGIME THAT IS NOT INDIA. The bundled adapter groups digits
 * [3, 2], calls its states by Indian names and levies CGST — so a mapping that reached
 * for it instead of for its argument would be indistinguishable from a correct one in
 * every other test in this file.
 */

import { describe, expect, it, vi } from 'vitest'

import { D } from '@main/domain/money'
import { describeRegime } from '@main/regime/service'
import { DEFAULT_REGIME_ID, getRegime } from '@main/regimes'
import type {
  CompanyProfile,
  DecimalString,
  Document,
  DocumentLineDto,
  Party,
  RegimeDescription,
} from '@shared/dto'

import { isPrintError } from './errors'
import {
  buildInvoicePrintModel,
  hsnSummaryOf,
  rateSummaryOf,
  taxColumnsFor,
  type InvoicePrintSources,
} from './invoice-model'
import fixtures from './__fixtures__/invoices.json'

interface Worked {
  party: Party
  document: Document
  expected: {
    taxColumns: string[]
    lineOrder: number[]
    rateSummary: {
      ratePct: string
      taxableValue: string
      totalTax: string
      taxes: { code: string; ratePct: string; amount: string }[]
    }[]
    hsnSummary: {
      classificationCode: string
      ratePct: string
      quantity: string
      unitCode: string
      taxableValue: string
      totalTax: string
    }[]
    placeOfSupply: string
    grandTotalInWords: string
  }
}

const fixture = fixtures as unknown as {
  company: CompanyProfile
  intraState: Worked
  interState: Worked
}

const india = getRegime(DEFAULT_REGIME_ID)
const INDIA_DESCRIPTION: RegimeDescription = describeRegime(india)

/** The regime's own sentence for the total. See the mapper's header for why it is passed. */
const amountInWords = (amount: DecimalString): string => india.amountInWords(D(amount))

function sourcesFor(worked: Worked, over: Partial<InvoicePrintSources> = {}): InvoicePrintSources {
  return {
    document: worked.document,
    company: fixture.company,
    party: worked.party,
    regime: INDIA_DESCRIPTION,
    amountInWords,
    ...over,
  }
}

function modelFor(worked: Worked, over: Partial<InvoicePrintSources> = {}) {
  return buildInvoicePrintModel(sourcesFor(worked, over))
}

const CASES: readonly (readonly [string, Worked])[] = [
  ['intra-state, CGST and SGST', fixture.intraState],
  ['inter-state, IGST', fixture.interState],
]

// ---- The fixtures are only worth anything if they disagree -------------------

/*
 * CONVENTIONS §6: order a fixture so it disagrees with the expected output, or the test
 * cannot tell a sorted answer from an unsorted one. These four assert that the fixture is
 * still built that way, so an innocent-looking tidy-up of the JSON cannot quietly turn
 * every ordering test below into a tautology.
 */
describe('the fixtures disagree with the expected output wherever order matters', () => {
  it('stores the intra-state lines out of line-number order', () => {
    expect(fixture.intraState.document.lines.map((line) => line.lineNumber)).not.toEqual(
      fixture.intraState.expected.lineOrder,
    )
  })

  it('lists SGST before CGST on one line, where the regime lists CGST first', () => {
    const backwards = fixture.intraState.document.lines.filter(
      (line) => line.taxes[0]?.code === 'SGST',
    )

    expect(backwards.length).toBeGreaterThan(0)
    expect(INDIA_DESCRIPTION.taxComponents.map((component) => component.code)).toEqual([
      'CGST',
      'SGST',
      'UTGST',
      'IGST',
    ])
  })

  it('mentions its rate slabs in an order that is not ascending', () => {
    const asMentioned = [...new Set(fixture.intraState.document.lines.map((l) => l.ratePct))]
    const ascending = fixture.intraState.expected.rateSummary.map((slab) => slab.ratePct)

    expect(asMentioned).not.toEqual(ascending)
  })

  it('mentions its classification codes in an order that is not ascending', () => {
    const asMentioned = fixture.intraState.document.lines.map((l) => l.classificationCode)
    const ascending = fixture.intraState.expected.hsnSummary.map((row) => row.classificationCode)

    expect(asMentioned).not.toEqual(ascending)
  })
})

// ---- The worked documents ----------------------------------------------------

describe.each(CASES)('%s', (_name, worked) => {
  const model = modelFor(worked)

  it('puts the lines in line-number order whatever order they arrived in', () => {
    expect(model.lines.map((line) => line.lineNumber)).toEqual(worked.expected.lineOrder)
  })

  it('takes the tax columns and their order from the regime', () => {
    expect(model.taxColumns.map((column) => column.code)).toEqual(worked.expected.taxColumns)
    expect(model.taxColumns.map((column) => column.label)).toEqual(worked.expected.taxColumns)
  })

  it('groups the tax by rate slab, ascending', () => {
    expect(
      model.rateSummary.map((slab) => ({
        ratePct: slab.ratePct,
        taxableValue: slab.taxableValue,
        totalTax: slab.totalTax,
        taxes: slab.taxes.map((tax) => ({
          code: tax.code,
          ratePct: tax.ratePct,
          amount: tax.amount,
        })),
      })),
    ).toEqual(worked.expected.rateSummary)
  })

  it('groups the same figures again by classification code', () => {
    expect(
      model.hsnSummary.map((row) => ({
        classificationCode: row.classificationCode,
        ratePct: row.ratePct,
        quantity: row.quantity,
        unitCode: row.unitCode,
        taxableValue: row.taxableValue,
        totalTax: row.totalTax,
      })),
    ).toEqual(worked.expected.hsnSummary)
  })

  it('names the place of supply rather than printing a bare code', () => {
    expect(model.placeOfSupply).toBe(worked.expected.placeOfSupply)
  })

  it('carries the regime’s words for the grand total', () => {
    expect(model.totals.grandTotalInWords).toBe(worked.expected.grandTotalInWords)
  })

  /*
   * COPIED, NOT RECOMPUTED. Every one of these is a figure main already worked out, and
   * the mapper's job is to move it — a mapper that re-derived the net total from the
   * taxable value and the tax would be doing the arithmetic twice, in two places that
   * could then disagree.
   */
  it('copies the document’s own totals across untouched', () => {
    expect(model.totals).toMatchObject({
      taxableValue: worked.document.totals.taxableValue,
      totalDiscount: worked.document.totals.totalDiscount,
      totalTax: worked.document.totals.totalTax,
      netTotal: worked.document.totals.netTotal,
      roundOff: worked.document.totals.roundOff,
      grandTotal: worked.document.totals.grandTotal,
    })
    expect(model.totals.taxes).toEqual(worked.document.totals.taxSummary)
  })

  it('supplies nothing for the blocks the company profile cannot hold yet', () => {
    expect(model.logo).toBeUndefined()
    expect(model.bank).toBeUndefined()
    expect(model.terms).toBeUndefined()
    expect(model.declaration).toBeUndefined()
    expect(model.signatory).toBeUndefined()
  })
})

// ---- The invoice a credit note corrects -------------------------------------

/*
 * A GST CREDIT NOTE IS REQUIRED TO REFERENCE THE INVOICE IT CORRECTS, by number and date.
 * This block was on the print model and rendered by the template from the day both were
 * written, and the mapper could only ever supply `undefined`: `Document` carried
 * `originalDocumentId` and nothing else, and an id appears on no piece of paper. The
 * repository joins the original's row now.
 */
describe('the document a correction names', () => {
  const asCreditNote = (over: Partial<Document> = {}): Worked => ({
    ...fixture.intraState,
    document: {
      ...fixture.intraState.document,
      kind: 'credit-note',
      originalDocumentNumber: 'KPC/27-28/0011',
      originalDocumentDate: '2027-09-30',
      ...over,
    },
  })

  it('names it by number and date, in the kind table’s own word', () => {
    expect(modelFor(asCreditNote()).corrects).toEqual({
      /* Derived from `correctsKind`, not written here — so a debit note says "purchase
       * bill" without a second table, and no batch can put the wrong noun on the page. */
      label: 'Sales invoice',
      number: 'KPC/27-28/0011',
      date: '2027-09-30',
    })
  })

  it('says purchase bill on a debit note, because the kind table does', () => {
    const asDebitNote: Worked = {
      ...asCreditNote(),
      document: { ...asCreditNote().document, kind: 'debit-note' },
    }

    expect(modelFor(asDebitNote).corrects?.label).toBe('Purchase bill')
  })

  /* An invoice corrects nothing, so there is no block — even carrying the two fields,
   * which is a state the repository cannot produce and a mapper should still not print. */
  it('draws no block on a kind that corrects nothing', () => {
    const invoice: Worked = {
      ...asCreditNote(),
      document: { ...asCreditNote().document, kind: 'sales-invoice' },
    }

    expect(modelFor(invoice).corrects).toBeUndefined()
    expect(modelFor(fixture.intraState).corrects).toBeUndefined()
  })

  /*
   * BOTH HALVES OR NEITHER. An original still in draft has no number, and "Against sales
   * invoice — · 30 Sep 2027" is a reference to nothing wearing the shape of one. Each
   * null is asserted on its own, because a check of one would pass the other through.
   */
  it('draws no block when either half of the reference is missing', () => {
    expect(modelFor(asCreditNote({ originalDocumentNumber: null })).corrects).toBeUndefined()
    expect(modelFor(asCreditNote({ originalDocumentDate: null })).corrects).toBeUndefined()
  })
})

// ---- The figures, on the worked intra-state document -------------------------

describe('the intra-state document in detail', () => {
  const model = modelFor(fixture.intraState)

  it('keeps the charge line as an ordinary line, taxed and in place', () => {
    const freight = model.lines.filter((line) => line.isCharge)

    expect(freight).toHaveLength(1)
    expect(freight[0]).toMatchObject({
      lineNumber: 4,
      taxableAmount: '1740.00',
      ratePct: '5.000',
    })
    expect(freight[0]?.taxes.map((tax) => tax.amount)).toEqual(['43.50', '43.50'])
  })

  /*
   * ANCHORED. `toContain('0.28')` is true of '-0.28' too, and a round-off that lost its
   * sign is a document whose foot does not add up. Compared by value, not by presence.
   */
  it('carries the round-off with its sign', () => {
    expect(model.totals.roundOff).toBe('-0.28')
    expect(model.totals.roundOff).not.toBe('0.28')
  })

  it('heads the supplier box with the trading name and keeps the registered one under it', () => {
    expect(model.supplier.name).toBe('Kaveri Precision')
    expect(model.supplier.legalName).toBe('Kaveri Precision Components Private Limited')
    expect(model.supplier.registrationNumber).toBe('33AABCK1234M1Z7')
    expect(model.supplier.jurisdiction).toBe('Tamil Nadu (33)')
  })

  it('closes up the address rather than leaving a gap where a line is blank', () => {
    expect(model.customer.addressLines).toEqual([
      '27/3, Trichy Road',
      'Singanallur',
      'Coimbatore 641005',
    ])
    /* The Karnataka party has no second address line and no e-mail address at all. */
    const other = modelFor(fixture.interState)
    expect(other.customer.addressLines).toEqual(['4th Floor, Brigade Gateway', 'Bengaluru 560055'])
    expect(other.customer.email).toBeNull()
  })

  it('labels the reference with the word the recipient would use', () => {
    expect(model.reference).toEqual({ label: 'Your reference', value: 'PO-9931/2027' })
  })

  it('drops a reference that is absent or blank rather than printing an empty row', () => {
    expect(modelFor(fixture.interState).reference).toBeNull()
    expect(
      modelFor({
        ...fixture.intraState,
        document: { ...fixture.intraState.document, partyReference: '   ' },
      }).reference,
    ).toBeNull()
  })

  it('drops a narration that is blank, and keeps one that is not', () => {
    expect(model.narration).toBe('Delivered to the Hosur unit; test certificates attached.')
    expect(modelFor(fixture.interState).narration).toBeNull()
  })
})

// ---- Which end of the supply is which ---------------------------------------

describe('the side of the trade decides which box is which', () => {
  const asPurchase: Worked = {
    ...fixture.intraState,
    document: { ...fixture.intraState.document, kind: 'purchase-bill' },
  }

  it('puts this company in the supplier box on a sale', () => {
    const model = modelFor(fixture.intraState)

    expect(model.supplier.name).toBe('Kaveri Precision')
    expect(model.customer.name).toBe('Sharma & Sons Traders')
  })

  /* The whole point of the record: a purchase bill is the VENDOR's document, so the two
   * boxes swap. A conditional written the other way round would be right for a sale and
   * silently wrong for every bill in the books. */
  it('puts the vendor in it on a purchase', () => {
    const model = modelFor(asPurchase)

    expect(model.supplier.name).toBe('Sharma & Sons Traders')
    expect(model.customer.name).toBe('Kaveri Precision')
  })

  it('asks for the vendor’s own invoice number by that name on a purchase', () => {
    expect(modelFor(asPurchase).reference?.label).toBe('Their invoice no.')
  })

  it('signs for whoever the supplier is, not for whoever is running Coffer', () => {
    const branding = { signatory: { name: 'R. Iyer', designation: 'Director' } }

    expect(modelFor(fixture.intraState, { branding }).signatory?.forLine).toBe(
      'For Kaveri Precision',
    )
    expect(modelFor(asPurchase, { branding }).signatory?.forLine).toBe('For Sharma & Sons Traders')
  })
})

// ---- The words on the page that are not the template's ----------------------

describe('the words that belong to somebody else', () => {
  it('takes the classification column’s name from the regime', () => {
    expect(modelFor(fixture.intraState).classificationLabel).toBe('HSN / SAC')
  })

  /*
   * TAKEN FROM THE REGIME, which is the point rather than the detail. This mapper printed
   * 'Registration no.' because `RegimeDescription` had no field for the word and writing
   * 'GSTIN' in `services/` would break CONVENTIONS §1.6 — a neutral default that is
   * silently wrong on the line of an Indian tax invoice a reader checks first.
   *
   * Asserted against a description that is NOT India as well, because an assertion that
   * only ever saw 'GSTIN / UIN' cannot tell a field read off the regime from a constant
   * somebody moved into this file.
   */
  it('takes the word for a registration number from the regime', () => {
    expect(modelFor(fixture.intraState).registrationLabel).toBe('GSTIN / UIN')

    const elsewhere: RegimeDescription = { ...INDIA_DESCRIPTION, registrationLabel: 'VAT number' }
    expect(modelFor(fixture.intraState, { regime: elsewhere }).registrationLabel).toBe('VAT number')
  })

  it('spells the GRAND total, not the net total', () => {
    const spy = vi.fn(() => 'the words')
    const model = modelFor(fixture.intraState, { amountInWords: spy })

    expect(spy).toHaveBeenCalledWith('77259.00')
    expect(spy).not.toHaveBeenCalledWith('77259.28')
    expect(model.totals.grandTotalInWords).toBe('the words')
  })
})

// ---- Not India ---------------------------------------------------------------

describe('a regime that is not India', () => {
  /*
   * Every field here is Indian in the bundled adapter, so a mapping that reached for the
   * bundled one — or for an India-shaped constant — is indistinguishable from a correct
   * one until something asks it this. The same argument `regime/service.test.ts` makes
   * with its Portugal stub, and the same stub shape.
   */
  const portugal: RegimeDescription = {
    id: 'pt',
    label: 'Portugal — IVA',
    registrationLabel: 'NIF',
    numberFormat: {
      groupSizes: [3],
      decimalSeparator: ',',
      groupSeparator: '.',
      currencyCode: 'EUR',
      currencySymbol: '€',
    },
    jurisdictions: [{ code: '33', name: 'Área Metropolitana de Lisboa' }],
    taxRates: [{ ratePct: '23', label: '23%', note: 'The standard rate.' }],
    taxComponents: [{ code: 'IVA', label: 'IVA', levy: 'output' }],
    classification: { code: null, label: 'CPA', validLengths: [] },
    returnForms: [],
  }

  const model = modelFor(fixture.intraState, { regime: portugal })

  it('carries that regime’s number format, not the Indian one', () => {
    expect(model.numberFormat).toEqual(portugal.numberFormat)
  })

  it('names the jurisdiction the way that regime names it', () => {
    expect(model.placeOfSupply).toBe('Área Metropolitana de Lisboa (33)')
  })

  it('calls the classification column what that regime calls it', () => {
    expect(model.classificationLabel).toBe('CPA')
  })

  /*
   * A component the regime has not declared still gets a column. This document carries
   * CGST and SGST, which Portugal levies neither of — dropping them would be tax charged
   * on the face of the document and not shown on it.
   *
   * SGST FIRST, AND THAT IS THE RIGHT ANSWER HERE. With no declaration to order them by,
   * first appearance across the lines is the only order there is — and line 1 of this
   * fixture lists SGST first. Under India the same document gives CGST first, which is
   * the assertion two describes above; the pair together is what says the order comes
   * from the regime whenever the regime has one.
   */
  it('still gives a column to a component the regime never declared', () => {
    expect(model.taxColumns.map((column) => column.code)).toEqual(['SGST', 'CGST'])
    expect(modelFor(fixture.intraState).taxColumns.map((c) => c.code)).toEqual(['CGST', 'SGST'])
  })
})

// ---- The folds, on their own -------------------------------------------------

describe('the folds', () => {
  const line = (over: Partial<DocumentLineDto>): DocumentLineDto => ({
    id: 'l',
    lineNumber: 1,
    itemId: null,
    description: 'thing',
    quantity: '1.000',
    unitCode: 'NOS',
    unitPrice: '100.00',
    discount: '0.00',
    taxableAmount: '100.00',
    ratePct: '18.000',
    classificationCode: '1234',
    isCharge: false,
    accountId: null,
    taxes: [{ code: 'IGST', label: 'IGST @ 18%', ratePct: '18', amount: '18.00' }],
    ...over,
  })

  it('reads 18 and 18.000 as one slab rather than two', () => {
    const summary = rateSummaryOf([line({ ratePct: '18' }), line({ ratePct: '18.000' })])

    expect(summary).toHaveLength(1)
    expect(summary[0]?.taxableValue).toBe('200.00')
    expect(summary[0]?.totalTax).toBe('36.00')
  })

  /*
   * A nil-rated line carries no components at all — `taxLine` returns an empty list
   * rather than a row of zeroes, because which taxes WOULD have applied is not a fact
   * about an exempt supply. It is still a row in the summary: the taxable value of an
   * exempt supply is exactly what a return asks for.
   */
  it('gives a nil-rated line its own slab, with no tax on it', () => {
    const summary = rateSummaryOf([line({ ratePct: '0', taxes: [] }), line({})])

    expect(summary.map((slab) => slab.ratePct)).toEqual(['0.000', '18.000'])
    expect(summary[0]?.totalTax).toBe('0.00')
    expect(summary[0]?.taxes).toEqual([])
  })

  it('keeps one classification code in two units as two rows', () => {
    const rows = hsnSummaryOf([
      line({ unitCode: 'MTR', quantity: '10.000' }),
      line({ unitCode: 'NOS', quantity: '2.000' }),
    ])

    expect(rows.map((row) => [row.unitCode, row.quantity])).toEqual([
      ['MTR', '10.000'],
      ['NOS', '2.000'],
    ])
  })

  it('keeps one classification code at two rates as two rows', () => {
    const rows = hsnSummaryOf([line({}), line({ ratePct: '12.000' })])

    expect(rows.map((row) => row.ratePct)).toEqual(['12.000', '18.000'])
  })

  /*
   * An unclassified line is the row a reader checks last, not first — and it must not
   * sort as though its code were the empty string, which would put it at the top.
   *
   * BOTH INPUT ORDERS, and that is not belt and braces. A comparator has two arms for
   * this case and a two-element sort only ever calls one of them, so a mutation that
   * reversed the arm the fixture does not reach survives a test written one way round.
   * Measured: it did.
   */
  it.each([
    ['classified first', ['0001', null]],
    ['unclassified first', [null, '0001']],
  ] as const)('sorts a line with no classification code last (%s)', (_order, codes) => {
    const rows = hsnSummaryOf(codes.map((code) => line({ classificationCode: code })))

    expect(rows.map((row) => row.classificationCode)).toEqual(['0001', null])
  })

  /*
   * The separator earns its place. Without it 'A1' at 8% and 'A' at 18% both key on
   * 'A18.000' and become one row carrying two rates — which is the kind of collision
   * that is invisible on a page and wrong in a return.
   */
  it('cannot collide two keys by concatenation', () => {
    const rows = hsnSummaryOf([
      line({ classificationCode: 'A1', ratePct: '8', unitCode: null }),
      line({ classificationCode: 'A', ratePct: '18', unitCode: null }),
    ])

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => [row.classificationCode, row.ratePct])).toEqual([
      ['A', '18.000'],
      ['A1', '8.000'],
    ])
  })

  it('gives a document with no lines no summaries and no columns', () => {
    expect(rateSummaryOf([], ['IGST'])).toEqual([])
    expect(hsnSummaryOf([], ['IGST'])).toEqual([])
    expect(taxColumnsFor([], INDIA_DESCRIPTION)).toEqual([])
  })

  /*
   * The order inside a slab is the COLUMNS' order, not the line's. It is invisible on the
   * page — the template looks a cell up by code — which is precisely why it needs an
   * assertion: a model whose arrays are in an order nobody chose is a model the next
   * reader cannot trust.
   */
  it('orders a slab’s components the way the columns are ordered', () => {
    const backwards = line({
      taxes: [
        { code: 'SGST', label: 'SGST @ 9%', ratePct: '9', amount: '9.00' },
        { code: 'CGST', label: 'CGST @ 9%', ratePct: '9', amount: '9.00' },
      ],
    })

    expect(rateSummaryOf([backwards], ['CGST', 'SGST'])[0]?.taxes.map((t) => t.code)).toEqual([
      'CGST',
      'SGST',
    ])
    expect(rateSummaryOf([backwards], ['SGST', 'CGST'])[0]?.taxes.map((t) => t.code)).toEqual([
      'SGST',
      'CGST',
    ])
    /* And with no order at all it keeps the one it was handed, rather than inventing one. */
    expect(rateSummaryOf([backwards], [])[0]?.taxes.map((t) => t.code)).toEqual(['SGST', 'CGST'])
  })
})

// ---- Refusals ----------------------------------------------------------------

describe('what it refuses, and what it says', () => {
  it('refuses a document kind this build does not know', () => {
    const call = () =>
      modelFor({
        ...fixture.intraState,
        document: { ...fixture.intraState.document, kind: 'delivery-challan' },
      })

    expect(call).toThrow(/delivery-challan/)
    expect(call).toThrow(/newer Coffer/)
    try {
      call()
    } catch (error) {
      expect(isPrintError(error) && error.code).toBe('DOCUMENT_KIND_UNKNOWN')
    }
  })

  it('refuses to print books that do not say who they belong to', () => {
    const call = () => modelFor(fixture.intraState, { company: null })

    expect(call).toThrow(/company profile/)
    try {
      call()
    } catch (error) {
      expect(isPrintError(error) && error.code).toBe('COMPANY_PROFILE_MISSING')
    }
  })

  it('refuses when the other end of the supply was not supplied', () => {
    const call = () => modelFor(fixture.intraState, { party: null })

    expect(call).toThrow(/Sharma & Sons Traders/)
    try {
      call()
    } catch (error) {
      expect(isPrintError(error) && error.code).toBe('PARTY_MISSING')
    }
  })

  /* A state code the bundled pack has not heard of is a real situation — a downgrade, a
   * newer compliance pack — and dropping the place of supply off a tax invoice is not an
   * acceptable answer to it. */
  it('prints a jurisdiction code it cannot name rather than dropping it', () => {
    const model = modelFor({
      ...fixture.intraState,
      document: { ...fixture.intraState.document, placeOfSupplyJurisdiction: '98' },
    })

    expect(model.placeOfSupply).toBe('98')
  })

  it('falls back to the country when there is no jurisdiction at all', () => {
    const model = modelFor({
      ...fixture.intraState,
      document: {
        ...fixture.intraState.document,
        placeOfSupplyJurisdiction: null,
        placeOfSupplyCountry: 'ae',
      },
    })

    expect(model.placeOfSupply).toBe('AE')
  })
})
