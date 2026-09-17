/*
 * The template.
 *
 * ASSERTIONS ARE ON THE CONTENT, NOT ON THE MARKUP. Cells are pulled out of the rendered
 * table and compared BY POSITION and BY VALUE — a figure found "somewhere in the row" is
 * found just as happily when two columns have been swapped, and `toContain('300.00')` is
 * a substring match that '-300.00' satisfies. Whitespace, attribute order and indentation
 * are nowhere in this file, so reformatting the template breaks nothing and changing a
 * figure breaks something.
 *
 * The two worked documents go through the real mapper on their way in, so what is under
 * test is the pipeline a user's Print button will run.
 */

import { describe, expect, it } from 'vitest'

import { D } from '@main/domain/money'
import { describeRegime } from '@main/regime/service'
import { DEFAULT_REGIME_ID, getRegime } from '@main/regimes'
import { DOCUMENT_KINDS } from '@shared/documents'
import type {
  CompanyProfile,
  DecimalString,
  Document,
  NumberFormat,
  Party,
  RegimeDescription,
} from '@shared/dto'

import { escapeHtml } from './escape'
import { isFormattableDecimal } from './format'
import { buildInvoicePrintModel } from './invoice-model'
import { PAGE } from './invoice-styles'
import {
  renderInvoiceCopies,
  renderInvoiceHtml,
  renderInvoiceRun,
  headingFor,
} from './invoice-template'
import { COPY_MARKINGS, INVOICE_COPIES, type InvoiceCopy, type InvoicePrintModel } from './model'
import fixtures from './__fixtures__/invoices.json'

// ---- Reading the rendered page ----------------------------------------------

/*
 * Tags out, whitespace collapsed. Entities are deliberately NOT decoded: the escaping
 * tests below have to be able to tell `&amp;` from `&`, and a helper that quietly undid
 * the escaping would make every one of them pass.
 */
function textOf(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Decodes the five entities, for the assertions that are about words rather than safety. */
function decode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function rowsOf(html: string): string[][] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(([, body = '']) =>
    [...body.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map(([, cell = '']) => textOf(cell)),
  )
}

/**
 * The one row whose first cell is `label`, as a list of cells.
 *
 * Refuses two matches rather than taking the first. A `.find` here would implement
 * "whichever row the template happened to emit first", so a block rendered twice — the
 * totals inside the summary AND again at the foot — would read as correct.
 */
function rowStartingWith(html: string, label: string): string[] {
  const found = rowsOf(html).filter((cells) => cells[0] === label)
  const [only, ...rest] = found
  if (only === undefined) throw new Error(`No row starts with '${label}'.`)
  if (rest.length > 0) throw new Error(`${found.length} rows start with '${label}'.`)
  return only
}

function headingOf(html: string): string {
  const match = /<h1 class="head__heading">([\s\S]*?)<\/h1>/.exec(html)
  if (match?.[1] === undefined) throw new Error('The page has no heading.')
  return decode(textOf(match[1]))
}

// ---- The worked documents ----------------------------------------------------

interface Worked {
  party: Party
  document: Document
  expected: { grandTotalInWords: string; placeOfSupply: string }
}

const fixture = fixtures as unknown as {
  company: CompanyProfile
  intraState: Worked
  interState: Worked
}

const india = getRegime(DEFAULT_REGIME_ID)
const INDIA_DESCRIPTION: RegimeDescription = describeRegime(india)

function modelFor(worked: Worked): InvoicePrintModel {
  return buildInvoicePrintModel({
    document: worked.document,
    company: fixture.company,
    party: worked.party,
    regime: INDIA_DESCRIPTION,
    amountInWords: (amount: DecimalString) => india.amountInWords(D(amount)),
  })
}

const intraState = modelFor(fixture.intraState)
const interState = modelFor(fixture.interState)

describe('a worked intra-state invoice — CGST and SGST', () => {
  const page = renderInvoiceHtml(intraState)

  it('heads itself with the word the kind table supplies', () => {
    expect(headingOf(page)).toBe('Sales invoice')
  })

  it('states the number, the dates and the customer’s own reference', () => {
    expect(rowStartingWith(page, 'Number')).toEqual(['Number', 'KPC/27-28/0042'])
    expect(rowStartingWith(page, 'Date')).toEqual(['Date', '04 Nov 2027'])
    expect(rowStartingWith(page, 'Due')).toEqual(['Due', '04 Dec 2027'])
    expect(rowStartingWith(page, 'Your reference')).toEqual(['Your reference', 'PO-9931/2027'])
  })

  it('names both ends of the supply, with their registration numbers', () => {
    const text = decode(textOf(page))

    expect(text).toContain('Kaveri Precision')
    expect(text).toContain('Kaveri Precision Components Private Limited')
    /* The word above the number is the REGIME's now — `RegimeDescription.registrationLabel`
     * — where this test used to hand the mapper 'GSTIN' itself. India says 'GSTIN / UIN'
     * because a body that cannot be registered as a taxpayer carries a UIN in the same
     * box, and the printed document is the one place both have to be named. */
    expect(text).toContain('GSTIN / UIN: 33AABCK1234M1Z7')
    expect(text).toContain('Sharma & Sons Traders')
    expect(text).toContain('GSTIN / UIN: 33AAFCS9012K1ZB')
    expect(text).toContain('27/3, Trichy Road')
    expect(text).toContain('Coimbatore 641005')
  })

  /* It decides CGST+SGST against IGST, so a reader checking the split has to see it. */
  it('states the place of supply on the face of the document', () => {
    expect(decode(textOf(page))).toContain('Place of supply: Tamil Nadu (33)')
  })

  it('draws one column pair per component, in the regime’s order', () => {
    const heading = rowStartingWith(page, '#')

    expect(heading).toEqual([
      '#',
      'Description',
      'HSN / SAC',
      'Qty',
      'Rate',
      'Discount',
      'Taxable value',
      'CGST',
      'SGST',
    ])
  })

  it('prints each line by position: description, code, quantity, rate, discount, value, tax', () => {
    expect(rowStartingWith(page, '1')).toEqual([
      '1',
      'CNC machined flange, 6 inch, EN8 with black oxide finish',
      '8481',
      '40 NOS',
      '1,250.00',
      '2,000.00',
      '48,000.00',
      '9%',
      '4,320.00',
      '9%',
      '4,320.00',
    ])
    expect(rowStartingWith(page, '2')).toEqual([
      '2',
      'Neoprene gasket set',
      '4016',
      '120 NOS',
      '84.95',
      '0.00',
      '10,194.00',
      '6%',
      '611.64',
      '6%',
      '611.64',
    ])
  })

  /*
   * A charge line is an ordinary line. Hardcoding "freight is never taxed" is a design
   * CONVENTIONS §9 refuses — so freight prints
   * with its rate, its tax and its place in the numbering, marked and not hidden.
   */
  it('prints the charge line as an ordinary line, taxed and numbered', () => {
    expect(rowStartingWith(page, '4')).toEqual([
      '4',
      'Freight and packing to Coimbatore (charge)',
      '9965',
      '1 NOS',
      '1,740.00',
      '0.00',
      '1,740.00',
      '2.5%',
      '43.50',
      '2.5%',
      '43.50',
    ])
  })

  it('summarises the tax by rate slab, ascending', () => {
    expect(rowStartingWith(page, '5%')).toEqual([
      '5%',
      '1,740.00',
      '2.5%',
      '43.50',
      '2.5%',
      '43.50',
      '87.00',
    ])
    expect(rowStartingWith(page, '12%')).toEqual([
      '12%',
      '10,194.00',
      '6%',
      '611.64',
      '6%',
      '611.64',
      '1,223.28',
    ])
    expect(rowStartingWith(page, '18%')).toEqual([
      '18%',
      '54,250.00',
      '9%',
      '4,882.50',
      '9%',
      '4,882.50',
      '9,765.00',
    ])
  })

  it('summarises the same figures again by classification code', () => {
    expect(rowStartingWith(page, '8481')).toEqual([
      '8481',
      '40 NOS',
      '18%',
      '48,000.00',
      '9%',
      '4,320.00',
      '9%',
      '4,320.00',
      '8,640.00',
    ])
  })

  it('foots the document with the discount, the tax and the grand total', () => {
    expect(rowStartingWith(page, 'Taxable value')).toEqual(['Taxable value', '66,184.00'])
    expect(rowStartingWith(page, 'Less discount')).toEqual(['Less discount', '2,000.00'])
    expect(rowStartingWith(page, 'CGST @ 9%')).toEqual(['CGST @ 9%', '4,882.50'])
    expect(rowStartingWith(page, 'SGST @ 2.5%')).toEqual(['SGST @ 2.5%', '43.50'])
    expect(rowStartingWith(page, 'Net total')).toEqual(['Net total', '77,259.28'])
    expect(rowStartingWith(page, 'Grand total (INR)')).toEqual(['Grand total (INR)', '₹ 77,259.00'])
  })

  /*
   * ANCHORED BY VALUE. `toContain('0.28')` is satisfied by '-0.28' and by '10.28', so a
   * template that dropped the sign — or printed the unsigned figure under a heading that
   * did not carry it — would pass a substring assertion while producing a document whose
   * foot does not add up. This mutant escaped a batch here today.
   */
  it('prints a negative round-off with its sign', () => {
    expect(rowStartingWith(page, 'Round off')).toEqual(['Round off', '-0.28'])
    expect(rowStartingWith(page, 'Round off')[1]).not.toBe('0.28')
  })

  it('spells the total out, in the regime’s own words', () => {
    expect(decode(textOf(page))).toContain(fixture.intraState.expected.grandTotalInWords)
  })

  it('prints the narration as a note', () => {
    expect(decode(textOf(page))).toContain(
      'Note: Delivered to the Hosur unit; test certificates attached.',
    )
  })

  /* Nothing in `company_profile` holds any of these yet, so the page has to read as a
   * finished document without them. */
  it('degrades cleanly with no logo, bank details, terms or declaration', () => {
    expect(page).not.toContain('<img')
    expect(page).not.toContain('Payment')
    expect(page).not.toContain('Terms')
    expect(page).not.toContain('Declaration')
    /* The signature space stays, because somebody signs the paper copy by hand. */
    expect(decode(textOf(page))).toContain('Authorised signatory')
  })
})

describe('a worked inter-state invoice — IGST', () => {
  const page = renderInvoiceHtml(interState)

  it('draws one column pair, not two', () => {
    expect(rowStartingWith(page, '#')).toEqual([
      '#',
      'Description',
      'HSN / SAC',
      'Qty',
      'Rate',
      'Discount',
      'Taxable value',
      'IGST',
    ])
    expect(page).not.toContain('>CGST<')
  })

  it('states the other state as the place of supply', () => {
    expect(decode(textOf(page))).toContain('Place of supply: Karnataka (29)')
  })

  it('prints the service line with its own unit', () => {
    expect(rowStartingWith(page, '2')).toEqual([
      '2',
      'Calibration service, on site',
      '998719',
      '2 DAY',
      '4,500.00',
      '0.00',
      '9,000.00',
      '18%',
      '1,620.00',
    ])
  })

  it('keeps the two units apart in the classification summary', () => {
    expect(rowStartingWith(page, '998719')[1]).toBe('2 DAY')
    expect(rowStartingWith(page, '9031')[1]).toBe('6 NOS')
  })

  /* A round-off of nothing is not a line on a document. */
  it('omits the round-off row entirely when there is none', () => {
    expect(rowsOf(page).some((cells) => cells[0] === 'Round off')).toBe(false)
    expect(rowsOf(page).some((cells) => cells[0] === 'Net total')).toBe(false)
    expect(rowStartingWith(page, 'Grand total (INR)')).toEqual(['Grand total (INR)', '₹ 70,628.00'])
  })

  it('omits the reference row when the customer gave none', () => {
    expect(rowsOf(page).some((cells) => cells[0] === 'Your reference')).toBe(false)
  })

  it('omits the note when the narration is blank', () => {
    /* On the element, not on the class name: the stylesheet mentions every class, so a
     * bare `not.toContain('narration')` would be true of no page this template renders. */
    expect(page).not.toContain('<div class="narration">')
    expect(renderInvoiceHtml(intraState)).toContain('<div class="narration">')
  })
})

// ---- The heading comes from the table ----------------------------------------

describe('the heading is the kind’s own word', () => {
  /*
   * ITERATED OVER THE TABLE, NOT LISTED BY HAND. A sixth document kind is covered the day
   * somebody adds a row, and there is no string in this file that a template could be
   * made to agree with by copying it.
   */
  it.each(DOCUMENT_KINDS.map((definition) => [definition.kind, definition] as const))(
    'heads a %s with its own label',
    (_kind, definition) => {
      const page = renderInvoiceHtml({ ...intraState, kind: definition.kind })

      expect(headingOf(page)).toBe(definition.label)
      expect(headingFor({ ...intraState, kind: definition.kind })).toBe(definition.label)
    },
  )

  /* The failure this is really about: a credit note going out under the invoice's word. */
  it('does not print a sales invoice’s heading on a credit note', () => {
    const page = renderInvoiceHtml({ ...intraState, kind: 'credit-note' })

    expect(headingOf(page)).toBe('Credit note')
    expect(headingOf(page)).not.toBe('Sales invoice')
    expect(decode(page)).not.toContain('Sales invoice')
  })

  it('titles the browser tab and the PDF with the same word', () => {
    const page = renderInvoiceHtml({ ...intraState, kind: 'credit-note' })

    expect(page).toContain('<title>Credit note KPC/27-28/0042</title>')
  })
})

// ---- Which copy this is ------------------------------------------------------

describe('the copy marking', () => {
  it.each(INVOICE_COPIES)('marks the %s copy, and only that one', (copy) => {
    const page = renderInvoiceHtml(intraState, { copy })
    const text = decode(textOf(page))

    expect(text).toContain(COPY_MARKINGS[copy])
    for (const other of INVOICE_COPIES) {
      if (other === copy) continue
      expect(text).not.toContain(COPY_MARKINGS[other])
    }
  })

  it('is the original when nothing is said', () => {
    expect(decode(textOf(renderInvoiceHtml(intraState)))).toContain(COPY_MARKINGS.original)
  })

  /*
   * THE SAME MODEL RENDERS ALL THREE. Building it again per copy would be three chances
   * for the second sheet to disagree with the first about a figure, which is exactly the
   * failure a triplicate invoice cannot survive — so the three differ in the marking and
   * in nothing else.
   */
  it('renders three copies that differ only in the marking', () => {
    const rendered = renderInvoiceCopies(intraState, INVOICE_COPIES)
    const stripped = rendered.map((copy) =>
      copy.html.replace(COPY_MARKINGS[copy.copy], 'THE MARKING'),
    )

    expect(rendered.map((copy) => copy.copy)).toEqual([...INVOICE_COPIES])
    expect(new Set(stripped).size).toBe(1)
  })

  it('refuses to answer for a copy nobody has named', () => {
    const marked = renderInvoiceHtml(intraState, { copy: 'quadruplicate' as InvoiceCopy })

    /* `COPY_MARKINGS` is a total record, so an unknown member renders as nothing rather
     * than as another copy's words. A wrong marking would be worse than none. */
    for (const words of Object.values(COPY_MARKINGS)) {
      expect(decode(textOf(marked))).not.toContain(words)
    }
  })
})

// ---- Draft and cancelled -----------------------------------------------------

describe('the status stamp', () => {
  it('says so on a draft, which has no number yet either', () => {
    const page = renderInvoiceHtml({ ...intraState, status: 'draft', number: null })

    expect(decode(textOf(page))).toContain('DRAFT — NOT ISSUED')
    expect(rowStartingWith(page, 'Number')).toEqual(['Number', '—'])
  })

  it('says so on a cancelled one, which keeps its number', () => {
    const page = renderInvoiceHtml({ ...intraState, status: 'cancelled' })

    expect(decode(textOf(page))).toContain('CANCELLED')
    expect(rowStartingWith(page, 'Number')).toEqual(['Number', 'KPC/27-28/0042'])
  })

  it('stamps nothing on an issued one', () => {
    const page = renderInvoiceHtml(intraState)

    expect(page).not.toContain('<div class="head__status">')
    expect(renderInvoiceHtml({ ...intraState, status: 'draft' })).toContain(
      '<div class="head__status">',
    )
  })
})

// ---- The template computes nothing -------------------------------------------

describe('the template computes nothing', () => {
  /*
   * THE TEST THAT PROVES THE RULE. Every total on this model disagrees with the lines
   * underneath it, and the printed document has to show the model's figures — which it
   * can only do if it never adds a number to another number. The lines sum to 300.00 and
   * nothing on the page may say so.
   */
  const lying: InvoicePrintModel = {
    ...intraState,
    lines: [
      { ...intraState.lines[0]!, lineNumber: 1, taxableAmount: '100.00', taxes: [] },
      { ...intraState.lines[1]!, lineNumber: 2, taxableAmount: '200.00', taxes: [] },
    ],
    rateSummary: [],
    hsnSummary: [],
    totals: {
      taxableValue: '11.00',
      totalDiscount: '22.00',
      totalTax: '33.00',
      netTotal: '44.00',
      roundOff: '55.00',
      grandTotal: '66.00',
      taxes: [{ code: 'IGST', label: 'IGST @ 18%', ratePct: '18', amount: '77.00' }],
      grandTotalInWords: 'Rupees Sixty Six Only',
    },
  }
  const page = renderInvoiceHtml(lying)

  it('prints the model’s totals, not the lines’ sum', () => {
    expect(rowStartingWith(page, 'Taxable value')).toEqual(['Taxable value', '11.00'])
    expect(rowStartingWith(page, 'Less discount')).toEqual(['Less discount', '22.00'])
    expect(rowStartingWith(page, 'IGST @ 18%')).toEqual(['IGST @ 18%', '77.00'])
    expect(rowStartingWith(page, 'Net total')).toEqual(['Net total', '44.00'])
    expect(rowStartingWith(page, 'Round off')).toEqual(['Round off', '55.00'])
    expect(rowStartingWith(page, 'Grand total (INR)')).toEqual(['Grand total (INR)', '₹ 66.00'])
  })

  it('does not put the sum of the lines anywhere on the page', () => {
    const cells = rowsOf(page).flat()

    expect(cells).toContain('100.00')
    expect(cells).toContain('200.00')
    expect(cells).not.toContain('300.00')
    expect(cells).not.toContain('-300.00')
  })

  it('prints the words it was given, without checking them against the figures', () => {
    expect(decode(textOf(page))).toContain('Rupees Sixty Six Only')
  })

  /*
   * A negative figure keeps its sign, and the assertion is by value. A credit note is the
   * ordinary case for one — money going the other way — and a lost minus makes a refund
   * read as a charge.
   */
  it('keeps a negative quantity and a negative amount negative', () => {
    const returned = renderInvoiceHtml({
      ...lying,
      kind: 'credit-note',
      lines: [
        {
          ...lying.lines[0]!,
          description: 'Returned flanges',
          quantity: '-12.500',
          unitPrice: '1250.00',
          discount: '0.00',
          taxableAmount: '-15625.00',
        },
      ],
    })
    const row = rowStartingWith(returned, '1')

    expect(row[3]).toBe('-12.5 NOS')
    expect(row[3]).not.toBe('12.5 NOS')
    expect(row[6]).toBe('-15,625.00')
    expect(row[6]).not.toBe('15,625.00')
  })
})

// ---- The number format comes from the regime ---------------------------------

describe('the number format is the model’s, never this file’s', () => {
  /*
   * The Indian lakh/crore grouping was hard-coded in the renderer's formatter until
   * 2.2e-2 removed it, and the reason it survived so long is that a suite which only ever
   * renders Indian invoices cannot see the difference. So one page is rendered under a
   * rule that is not India's in every field.
   */
  const elsewhere: NumberFormat = {
    groupSizes: [3],
    decimalSeparator: ',',
    groupSeparator: '.',
    currencyCode: 'EUR',
    currencySymbol: '€',
  }
  const page = renderInvoiceHtml({ ...intraState, numberFormat: elsewhere })

  it('groups and punctuates every figure the way that rule says', () => {
    expect(rowStartingWith(page, 'Taxable value')).toEqual(['Taxable value', '66.184,00'])
    expect(rowStartingWith(page, 'Round off')).toEqual(['Round off', '-0,28'])
    expect(rowStartingWith(page, 'Grand total (EUR)')).toEqual(['Grand total (EUR)', '€ 77.259,00'])
  })

  it('groups the quantities by it too', () => {
    expect(rowStartingWith(page, '3')[3]).toBe('500 NOS')
  })

  it('leaves no trace of the Indian grouping on that page', () => {
    expect(page).not.toContain('77,259.00')
    expect(page).not.toContain('₹')
    expect(page).not.toContain('INR')
  })
})

// ---- Everything is escaped ---------------------------------------------------

/*
 * A model whose every string is a marker containing an angle bracket, an ampersand, a
 * double quote and a single quote — and a unique number, so a field that never reaches
 * the page can be named rather than guessed at.
 *
 * Amount-shaped strings are left alone on purpose: a decimal that stayed a decimal is
 * what makes the FORMATTER run, which is the only way the group and decimal separators —
 * themselves free text from a compliance pack — get onto the page at all. The pass-through
 * path, where a figure is not a decimal string and is printed as it arrived, gets its own
 * test below.
 */
const SKIP_KEYS = new Set([
  /* Closed unions, never user text. A marker here would not resolve to a kind or a status. */
  'kind',
  'status',
  /* A code is a lookup key and never a word on the page: `taxOn` matches a line's tax to
   * its column by it, so marking it would only break the join and prove nothing. */
  'code',
])

interface Mark {
  path: string
  marker: string
}

function markStrings(value: unknown, path: string, marks: Mark[]): unknown {
  if (typeof value === 'string') {
    const marker = `<x&"'${marks.length}>`
    marks.push({ path, marker })
    return marker
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => markStrings(item, `${path}[]`, marks))
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const keep = SKIP_KEYS.has(key) || (typeof item === 'string' && isFormattableDecimal(item))
        return [
          keep ? key : key,
          keep ? item : markStrings(item, path === '' ? key : `${path}.${key}`, marks),
        ]
      }),
    )
  }
  return value
}

/** A model carrying every optional block, so nothing escapes the sweep by being absent. */
function fullModel(): InvoicePrintModel {
  return {
    ...intraState,
    corrects: { label: 'Sales invoice', number: 'KPC/27-28/0011', date: '2027-09-30' },
    totals: { ...intraState.totals, taxableValue: '1234567.89' },
    logo: { source: 'data:image/png;base64,AAA', alt: 'The mark', widthMm: 30 },
    bank: {
      accountName: 'Kaveri Precision',
      bankName: 'A bank',
      branch: 'Guindy',
      accountNumber: '00112233445566',
      routingCode: { label: 'IFSC', value: 'XXXX0001234' },
      swiftCode: 'XXXXINBB',
      upiId: 'kaveri@examplebank',
      paymentQr: { source: 'data:image/png;base64,BBB', alt: 'Scan to pay', widthMm: 22 },
    },
    terms: ['Payable in 30 days.', 'Interest at 18% after that.'],
    declaration: 'We declare that this invoice shows the actual price of the goods.',
    signatory: { forLine: 'For Kaveri Precision', name: 'R. Iyer', designation: 'Director' },
  }
}

describe('every value is escaped', () => {
  const marks: Mark[] = []
  const marked = markStrings(fullModel(), '', marks) as InvoicePrintModel
  const page = renderInvoiceHtml(marked, { copy: 'duplicate' })

  it('sweeps a good number of fields, so the assertions below are not vacuous', () => {
    expect(marks.length).toBeGreaterThan(40)
  })

  /* THE SECURITY ASSERTION. Not one marker survives as markup, in text or in an
   * attribute. Named individually, so a failure says which field leaked. */
  it.each(marks.map((mark) => [mark.path, mark.marker] as const))('escapes %s', (_path, marker) => {
    expect(page).not.toContain(marker)
  })

  /*
   * THE VACUITY GUARD, and it is the half that catches a field nobody prints. Every
   * marker must appear in its escaped form; the ones that do not are named here, and the
   * list is short and explained. A field added to the model and forgotten by the template
   * fails this test with its own path in the message.
   */
  it('renders every field it carries, except the three that are lookup data', () => {
    const missing = [
      ...new Set(
        marks
          .filter((mark) => !page.includes(escapeHtml(mark.marker)))
          .map((mark) => mark.path.replace(/\[\d*\]/g, '[]')),
      ),
    ].sort()

    /* A per-line component's LABEL ('CGST @ 9%') is not printed in the line table or in
     * either summary: the column heading carries the wording and the cells carry the rate
     * and the amount. It IS printed in the totals block, which is where a reader needs the
     * words — and `totals.taxes[].label` is not in this list because of it. */
    expect(missing).toEqual([
      'hsnSummary[].taxes[].label',
      'lines[].taxes[].label',
      'rateSummary[].taxes[].label',
    ])
  })

  /*
   * The sweep above names each field; this one needs no list at all. Take out the
   * doctype and every tag, and what is left is the document's TEXT — which, on a page
   * whose every value is a marker full of angle brackets, must contain not one.
   */
  it('leaves no raw angle bracket that did not open a tag', () => {
    const stray = page.replace(/<!doctype[^>]*>/gi, '').replace(/<\/?[a-zA-Z][^>]*>/g, '')

    expect(stray).not.toContain('<')
    expect(stray).toContain('&lt;')
  })
})

describe('a line that carries one component twice', () => {
  /*
   * A GUARD AGAINST A STATE THE REAL DATA CANNOT REACH IS A GUARD NOTHING CAN KILL
   * (CONVENTIONS §6), so the test hands the template the state it is guarding against.
   * `taxOn` counts its matches instead of taking the first, because "the CGST on this
   * line" is a rule that says ONE — and `find` would silently print the first of two,
   * which is a figure that looks right and is half the tax.
   */
  const page = renderInvoiceHtml({
    ...intraState,
    lines: [
      {
        ...intraState.lines[0]!,
        lineNumber: 1,
        taxes: [
          { code: 'CGST', label: 'CGST @ 9%', ratePct: '9', amount: '111.00' },
          { code: 'CGST', label: 'CGST @ 9%', ratePct: '9', amount: '222.00' },
          { code: 'SGST', label: 'SGST @ 9%', ratePct: '9', amount: '333.00' },
        ],
      },
    ],
  })

  it('prints nothing in that column rather than the first of the two', () => {
    const row = rowStartingWith(page, '1')

    /* CGST's pair is blank; SGST's, which is unambiguous, still prints. */
    expect(row.slice(7)).toEqual(['', '', '9%', '333.00'])
    expect(row).not.toContain('111.00')
    expect(row).not.toContain('222.00')
  })
})

describe('a value that is not a figure is still escaped on its way through', () => {
  /*
   * `formatAmount`, `formatQuantity`, `formatRate` and `formatPrintDate` all return their
   * input unchanged when it is not the shape they expect — a figure main has not vouched
   * for should look wrong rather than be rendered as something plausible. Which means the
   * text that comes back out is still whatever was typed, and still has to be escaped.
   */
  const hostile = '</td><script>alert(1)</script>'
  const page = renderInvoiceHtml({
    ...intraState,
    date: hostile,
    lines: [
      {
        ...intraState.lines[0]!,
        quantity: hostile,
        unitPrice: hostile,
        ratePct: hostile,
        taxableAmount: hostile,
        classificationCode: hostile,
      },
    ],
    totals: { ...intraState.totals, grandTotal: hostile },
    numberFormat: { ...intraState.numberFormat, groupSeparator: hostile },
  })

  it('cannot be made to emit a script tag through a figure', () => {
    expect(page).not.toContain('<script')
    expect(page).not.toContain('</td><script')
    expect(page).toContain('&lt;script&gt;')
  })

  it('shows the unusable value rather than a plausible-looking substitute', () => {
    expect(decode(textOf(page))).toContain('alert(1)')
  })
})

// ---- Print rules -------------------------------------------------------------

describe('the page is laid out for A4, and survives a long one', () => {
  const page = renderInvoiceHtml(intraState)

  it('sizes the sheet and its margins in millimetres', () => {
    expect(page).toMatch(/@page\s*\{[\s\S]*?size: A4 portrait/)
    expect(page).toMatch(/@page\s*\{[\s\S]*?margin: \d+mm \d+mm \d+mm/)
    for (const millimetres of Object.values(PAGE)) {
      expect(millimetres).toBeGreaterThan(0)
      expect(millimetres).toBeLessThan(30)
    }
  })

  it('repeats the line table’s heading on every printed page', () => {
    expect(page).toMatch(/\.lines thead\s*\{[^}]*display: table-header-group/)
  })

  /*
   * ANCHORED ON THE FIRST DECLARATION IN THE BLOCK, not on the block containing the
   * words somewhere. `[^}]*break-inside: avoid` is satisfied by the `page-break-inside`
   * line that sits under it, so a rule switched to `auto` matched it happily — measured,
   * by a mutation that survived until this was tightened.
   */
  it('keeps a line, a summary and the totals from being split across the fold', () => {
    expect(page).toMatch(/\.lines tbody tr,\s*\.lines thead tr\s*\{\s*break-inside: avoid/)
    expect(page).toMatch(/\.block\s*\{\s*break-inside: avoid/)
    expect(page).not.toMatch(/break-inside: auto/)
    expect(page).toContain('class="summaries__right block"')
    expect(page).toContain('class="words block"')
  })

  it('right-aligns figures and gives them tabular numerals', () => {
    expect(page).toMatch(/\.figure\s*\{\s*text-align: right/)
    expect(page).toMatch(/\.figure\s*\{[^}]*font-variant-numeric: tabular-nums/)
  })

  it('wraps a long description instead of widening the table', () => {
    expect(page).toMatch(/\.lines__description\s*\{[^}]*overflow-wrap: anywhere/)
  })

  it('carries its stylesheet inside the document, so nothing has to be fetched', () => {
    expect(page).toContain('<style>')
    expect(page).not.toMatch(/<link[^>]+stylesheet/)
    expect(page).not.toMatch(/src="https?:/)
  })

  it('renders a forty-line invoice with every line on it and one grand total', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      ...intraState.lines[0]!,
      lineNumber: index + 1,
      description: `Line ${index + 1} — ${'a very long description with no natural break '.repeat(4)}`,
    }))
    const long = renderInvoiceHtml({ ...intraState, lines: many })

    for (let number = 1; number <= 40; number += 1) {
      expect(rowStartingWith(long, String(number))[0]).toBe(String(number))
    }
    expect(rowStartingWith(long, 'Grand total (INR)')).toEqual(['Grand total (INR)', '₹ 77,259.00'])
  })

  it('survives a description with no spaces in it at all', () => {
    const unbroken = 'x'.repeat(400)
    const long = renderInvoiceHtml({
      ...intraState,
      lines: [{ ...intraState.lines[0]!, lineNumber: 1, description: unbroken }],
    })

    expect(rowStartingWith(long, '1')[1]).toBe(unbroken)
  })
})

// ---- The blocks that await a migration ---------------------------------------

describe('the blocks the company profile cannot hold yet', () => {
  const page = renderInvoiceHtml(fullModel())

  it('prints the bank and UPI details when they are there', () => {
    expect(rowStartingWith(page, 'Account no.')).toEqual(['Account no.', '00112233445566'])
    expect(rowStartingWith(page, 'IFSC')).toEqual(['IFSC', 'XXXX0001234'])
    expect(rowStartingWith(page, 'UPI')).toEqual(['UPI', 'kaveri@examplebank'])
  })

  it('prints the terms, the declaration and the signatory', () => {
    const text = decode(textOf(page))

    expect(text).toContain('Payable in 30 days.')
    expect(text).toContain('We declare that this invoice shows the actual price of the goods.')
    expect(text).toContain('For Kaveri Precision')
    expect(text).toContain('R. Iyer')
    expect(text).toContain('Director')
  })

  it('draws the logo and the payment code from the data URIs it was given', () => {
    expect(page).toContain('src="data:image/png;base64,AAA"')
    expect(page).toContain('src="data:image/png;base64,BBB"')
    expect(page).toContain('width: 30mm')
  })

  it('names the document it corrects, when it is told which', () => {
    expect(rowStartingWith(page, 'Against sales invoice')).toEqual([
      'Against sales invoice',
      'KPC/27-28/0011 · 30 Sep 2027',
    ])
  })

  it('drops a bank row whose value is missing rather than printing an empty one', () => {
    const partial = renderInvoiceHtml({
      ...fullModel(),
      bank: {
        accountName: null,
        bankName: 'A bank',
        branch: null,
        accountNumber: '9',
        routingCode: null,
        swiftCode: null,
        upiId: null,
      },
    })

    expect(rowsOf(partial).some((cells) => cells[0] === 'Account name')).toBe(false)
    expect(rowsOf(partial).some((cells) => cells[0] === 'UPI')).toBe(false)
    expect(rowStartingWith(partial, 'Bank')).toEqual(['Bank', 'A bank'])
  })

  it('prints no terms block for an empty list, which is the same as none', () => {
    expect(renderInvoiceHtml({ ...fullModel(), terms: [] })).not.toContain('Terms')
  })
})

describe('the blocks a print run may leave off', () => {
  it('prints both unless told otherwise', () => {
    const page = renderInvoiceHtml(intraState)

    expect(page).toContain('Amount in words')
    expect(page).toContain(headingOfHsn())
  })

  it('leaves the words off, and nothing else with them', () => {
    const page = renderInvoiceHtml(intraState, { amountInWords: false })

    expect(page).not.toContain('Amount in words')
    /* The grand total is still on the page — it is the words that were declined. */
    expect(rowStartingWith(page, 'Grand total (INR)')).toHaveLength(2)
    expect(page).toContain(headingOfHsn())
  })

  it('leaves the classification summary off, and nothing else with it', () => {
    const page = renderInvoiceHtml(intraState, { hsnSummary: false })

    expect(page).not.toContain(headingOfHsn())
    expect(page).toContain('Amount in words')
  })

  it('leaves both off when both are declined', () => {
    const page = renderInvoiceHtml(intraState, { amountInWords: false, hsnSummary: false })

    expect(page).not.toContain('Amount in words')
    expect(page).not.toContain(headingOfHsn())
    /* Still an invoice: the lines and the total are not optional. */
    expect(rowStartingWith(page, 'Grand total (INR)')).toHaveLength(2)
  })
})

/** What the classification summary is headed, off the regime rather than typed here. */
function headingOfHsn(): string {
  return `${INDIA_DESCRIPTION.classification.label} summary`
}

describe('a run of copies, as one document', () => {
  it('puts every copy in one page, each marked', () => {
    const run = renderInvoiceRun(intraState, ['original', 'duplicate', 'triplicate'])

    expect(run.match(/<!doctype html>/gi)).toHaveLength(1)
    expect(run.match(/class="doc"/g)).toHaveLength(3)
    for (const copy of INVOICE_COPIES) expect(run).toContain(COPY_MARKINGS[copy])
  })

  it('renders one copy as one body, the same as rendering it alone', () => {
    const run = renderInvoiceRun(intraState, ['original'])

    expect(run.match(/class="doc"/g)).toHaveLength(1)
    expect(textOf(run)).toBe(textOf(renderInvoiceHtml(intraState, { copy: 'original' })))
  })

  /* Three copies of one invoice cannot disagree about a figure: the model is built once
   * and the copy decides only the marking. */
  it('prints the same grand total on every copy', () => {
    const run = renderInvoiceRun(intraState, ['original', 'duplicate', 'triplicate'])
    const totals = rowsOf(run).filter((cells) => cells[0] === 'Grand total (INR)')

    expect(totals).toHaveLength(3)
    expect(new Set(totals.map((cells) => cells[1])).size).toBe(1)
  })

  it('refuses a run of no copies rather than producing an empty page', () => {
    expect(() => renderInvoiceRun(intraState, [])).toThrow(/at least one copy/)
  })

  it('carries the include flags into every copy', () => {
    const run = renderInvoiceRun(intraState, ['original', 'duplicate'], { amountInWords: false })

    expect(run).not.toContain('Amount in words')
    expect(run.match(/class="doc"/g)).toHaveLength(2)
  })
})

describe('the heading font the page carries', () => {
  const FONT = { family: 'Coffer Print Serif', source: 'data:font/woff2;base64,d09GMgABAAA=' }

  it('embeds the face and points the headings at it', () => {
    const page = renderInvoiceHtml(intraState, { headingFont: FONT })

    expect(page).toContain("@font-face{font-family:'Coffer Print Serif'")
    expect(page).toContain(FONT.source)
  })

  it('prints in the machine own serif when no font was supplied', () => {
    expect(renderInvoiceHtml(intraState)).not.toContain('@font-face')
  })

  /*
   * THE ONE VALUE IN THIS MODULE THAT REACHES THE PAGE WITHOUT GOING THROUGH `html`, so
   * it is checked rather than trusted. A source that is not a woff2 data URI, or a family
   * that is not plain letters, is dropped — it cannot close the declaration and open a
   * rule of its own.
   */
  it('drops a family that could close the declaration', () => {
    const page = renderInvoiceHtml(intraState, {
      headingFont: { ...FONT, family: "x';} body{display:none} @font-face{font-family:'y" },
    })

    expect(page).not.toContain('display:none')
    expect(page).not.toContain('@font-face')
  })

  it('drops a source that is not a font', () => {
    for (const source of [
      'https://example.com/font.woff2',
      'data:text/html;base64,PHNjcmlwdD4=',
      "data:font/woff2;base64,AAA') format('woff2');} body{display:none",
    ]) {
      expect(renderInvoiceHtml(intraState, { headingFont: { ...FONT, source } })).not.toContain(
        '@font-face',
      )
    }
  })
})
