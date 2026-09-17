/*
 * THE PRINT MODEL — exactly what a printed trade document needs, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SEAM EXISTS AT ALL, WHEN `Document` IS RIGHT THERE
 *
 * Two reasons, and the second is the one that would have made this batch be redone.
 *
 * FIRST: A DOCUMENT IS NOT A PAGE. `Document` carries `partyId`, `entryId`, `seriesId`,
 * `createdAt` and `originalDocumentId` — none of which prints — and does NOT carry the
 * customer's address, the name of the state its place-of-supply code stands for, or the
 * total in words. A template written against `Document` would have to reach for a
 * repository to draw a box, which is how a template stops being a pure function.
 *
 * SECOND, AND THE REAL ONE: THE COMPANY PROFILE DOES NOT YET HOLD WHAT A PRINTED INVOICE
 * NEEDS. `company_profile` (migration 0011) has the legal name, the trade name, the
 * registration number, the jurisdiction, the country, two address lines, a city, a
 * postcode, an e-mail address and a phone number. A professional invoice also wants a
 * LOGO, BANK AND UPI DETAILS so it can be paid, DEFAULT TERMS and a DECLARATION, and a
 * SIGNATORY BLOCK. Those need a migration, and that migration is a later batch.
 *
 * So they are on this model, OPTIONAL. The template renders them when they are there and
 * degrades cleanly when they are not; the mapper supplies `undefined` for every one of
 * them today. When the columns land, `invoice-model.ts` changes and `invoice-template.ts`
 * does not — which is the whole point of writing the seam before the storage.
 *
 * ---------------------------------------------------------------------------
 * EVERY FIGURE ON THIS MODEL ARRIVES COMPUTED
 *
 * CONVENTIONS §1.7 in spirit: the template computes nothing. Every amount here is an
 * exact decimal string that main has already worked out, `grandTotalInWords` is the
 * regime's own sentence rather than something reconstructed from the digits, and the tax
 * summaries are folded by the mapper. The template's whole job is to choose where on the
 * page each of them goes. There is a test that hands it a model whose totals disagree
 * with its own lines and asserts the model wins.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS PRE-ASSEMBLED HERE, AND WHY THAT IS NOT THE TEMPLATE'S JOB
 *
 * `PrintParty.addressLines` and `placeOfSupply` arrive as text, already put together with
 * the blanks dropped. Deciding that a missing address line two closes up rather than
 * leaving a gap is a rule about the data, not about the page, and a template full of
 * `?? ''` is a template where the next reader cannot tell which gaps are deliberate.
 */

import type { DocumentKind } from '@shared/documents'
import type { DateString, DecimalString, DocumentStatusDto, NumberFormat } from '@shared/dto'

// ---- Which copy this is -----------------------------------------------------

/*
 * An Indian tax invoice for a supply of goods is issued in triplicate, and each copy says
 * on its face which one it is — Rule 48 of the CGST Rules. The marking is not decoration:
 * a transporter stopped at a check post is expected to be carrying the duplicate.
 *
 * The list is the tuple and the type is read off it, so the record below cannot be missing
 * a member and a test can iterate every copy without a second list to keep in step.
 */

export const INVOICE_COPIES = ['original', 'duplicate', 'triplicate'] as const

export type InvoiceCopy = (typeof INVOICE_COPIES)[number]

/**
 * What each copy says on its face.
 *
 * A TOTAL RECORD, per CONVENTIONS §1.9 — a fourth copy would not compile until somebody
 * said what it is called, where a conditional would have silently given it whatever the
 * last branch said. These are the words the rule uses, in the case it uses.
 */
export const COPY_MARKINGS: Readonly<Record<InvoiceCopy, string>> = {
  original: 'ORIGINAL FOR RECIPIENT',
  duplicate: 'DUPLICATE FOR TRANSPORTER',
  triplicate: 'TRIPLICATE FOR SUPPLIER',
}

// ---- Pieces -----------------------------------------------------------------

/**
 * A picture on the page: a logo, a scanned signature, a payment QR code.
 *
 * `source` IS A `data:` URI AND NOTHING ELSE. The template does no I/O and the document
 * it produces must not either — a rendered invoice that fetches a logo over the network
 * is a document that leaks who is reading it and looks broken offline, which is the one
 * state this product guarantees works. Whoever loads the file turns it into a data URI
 * first; that is a decision about which paths may be read, and it belongs on the side of
 * the boundary that can enforce one.
 */
export interface PrintImage {
  /** A `data:` URI. Never an http(s) URL, never a file path. */
  source: string
  /** What a reader whose images did not render sees instead. */
  alt: string
  /** How wide it is drawn, in millimetres. The height follows the aspect ratio. */
  widthMm: number
}

/**
 * One end of the supply, as a box on the page.
 *
 * Not `Party` and not `CompanyProfile`: the two are the same thing to a printed document
 * and are different records in the database, so the mapper flattens both onto this and
 * the template never learns which end it is looking at.
 */
export interface PrintParty {
  /** The name that heads the box. The trade name where there is one, else the legal one. */
  name: string
  /** Printed under the name when it differs — a tax invoice carries the registered name. */
  legalName: string | null
  /** Address, city and postcode, assembled with the blanks already closed up. */
  addressLines: readonly string[]
  /** GSTIN in India. Null for a business below the registration threshold. */
  registrationNumber: string | null
  /** The regime's name for the jurisdiction code, e.g. 'Tamil Nadu (33)'. */
  jurisdiction: string | null
  email: string | null
  phone: string | null
}

/** One tax component on one line, as the regime named it. The wording is never rebuilt. */
export interface PrintTax {
  /** 'CGST', 'IGST'. What the column is keyed by. */
  code: string
  /** What prints, e.g. 'CGST @ 9%'. The regime's words. */
  label: string
  ratePct: DecimalString
  amount: DecimalString
}

/**
 * One pair of columns in the line table.
 *
 * The set and the ORDER come from the regime's own component list rather than from
 * whichever line happened to be first, so an invoice cannot print SGST to the left of
 * CGST because one line's array was built the other way round.
 */
export interface PrintTaxColumn {
  code: string
  /** The heading over the pair: the bare component name, without a rate in it. */
  label: string
}

/**
 * One line of the document.
 *
 * A CHARGE LINE IS AN ORDINARY LINE. Freight, packing and insurance are goods and
 * services with a rate on them, and hardcoding "freight is never taxed" is a design
 * CONVENTIONS §9 refuses. `isCharge` is here so the
 * page can mark one, never so it can leave it out.
 */
export interface PrintLine {
  /** The document's own numbering, printed in the first column. */
  lineNumber: number
  description: string
  /** HSN or SAC in India. Null where none applies. */
  classificationCode: string | null
  quantity: DecimalString
  unitCode: string | null
  unitPrice: DecimalString
  discount: DecimalString
  /** `quantity x unitPrice - discount`, as main computed it. What tax was charged on. */
  taxableAmount: DecimalString
  /** The whole slab, e.g. '18'. The components below carry their own halves. */
  ratePct: DecimalString
  isCharge: boolean
  taxes: readonly PrintTax[]
}

/**
 * The taxable value and the tax at one rate slab.
 *
 * An Indian invoice states this and a reader checks the arithmetic against it, so it is
 * grouped by the rate rather than by the component: 18% and 12% goods are two rows, and
 * CGST appears in both.
 */
export interface PrintRateSlab {
  ratePct: DecimalString
  taxableValue: DecimalString
  taxes: readonly PrintTax[]
  totalTax: DecimalString
}

/**
 * One row of the HSN-wise summary.
 *
 * Table 12 of GSTR-1 asks for exactly this — classification code, unit, quantity, taxable
 * value and tax — which is why the grouping key carries the unit as well as the rate: a
 * total quantity across two units is not a quantity.
 */
export interface PrintHsnRow {
  classificationCode: string | null
  ratePct: DecimalString
  quantity: DecimalString
  unitCode: string | null
  taxableValue: DecimalString
  taxes: readonly PrintTax[]
  totalTax: DecimalString
}

/** The foot of the document. Every figure arrives added up. */
export interface PrintTotals {
  taxableValue: DecimalString
  totalDiscount: DecimalString
  totalTax: DecimalString
  netTotal: DecimalString
  /** What rounding added, signed. Its sign is printed as it arrived (§1.7). */
  roundOff: DecimalString
  grandTotal: DecimalString
  /**
   * The tax, component by component, as it appears in the totals block.
   *
   * ONE ROW PER COMPONENT AND RATE, straight off `DocumentTotalsDto.taxSummary` with
   * nothing re-added: an invoice with 18% and 12% goods on it prints CGST twice, and the
   * two rows are two different rates rather than one figure somebody totalled. This is
   * not the same fold as `rateSummary` — that one is keyed by the slab and is what a
   * reader checks the split against; this is what the foot of the document adds up.
   */
  taxes: readonly PrintTax[]
  /**
   * The grand total spelled out, in the regime's own words.
   *
   * SUPPLIED, NEVER DERIVED HERE. `RegimeDescription` drops everything executable on
   * purpose, so `TaxRegime.amountInWords` cannot be reached from a DTO — the caller
   * passes the sentence in. It is the human-readable check on the figures, and an invoice
   * whose words disagree with its numerals is disputed rather than paid.
   */
  grandTotalInWords: string
}

/**
 * Where the money goes.
 *
 * AWAITS A MIGRATION. Nothing in `company_profile` holds any of this today, so the mapper
 * supplies `undefined` and the block does not print. See the report for the columns.
 *
 * `routingCode` carries its own label because only the person who typed it knows whether
 * it is an IFSC, a sort code or a routing number, and a field labelled for one country is
 * a field the next regime has to work around.
 */
export interface PrintBankDetails {
  accountName: string | null
  bankName: string | null
  branch: string | null
  accountNumber: string | null
  routingCode: { label: string; value: string } | null
  swiftCode: string | null
  /** UPI virtual payment address. What most Indian small-business invoices are paid by. */
  upiId: string | null
  /** A scan-to-pay code, pre-rendered as an image. Nothing here draws one. */
  paymentQr?: PrintImage
}

/**
 * Who signed it.
 *
 * AWAITS THE SAME MIGRATION. `forLine` is assembled by the mapper from the supplier's own
 * name, so the block cannot end up signed for a company the document is not from.
 */
export interface PrintSignatory {
  /** 'For Acme Traders' — the supplier's name, not a word chosen here. */
  forLine: string
  name: string | null
  designation: string | null
  /** A scanned signature, where the business has one. */
  image?: PrintImage
}

/**
 * The document this one corrects, as it must be named on the face of a credit note.
 *
 * A GST credit note references the invoice it corrects BY NUMBER AND DATE. `Document`
 * carried only `originalDocumentId` until the integration gate, so this block was on the
 * model, rendered by the template, and fillable by nobody; it now comes from
 * `originalDocumentNumber` and `originalDocumentDate`, which the repository joins.
 *
 * STILL OPTIONAL, because most documents correct nothing and because an original still
 * in draft has no number to print.
 */
export interface PrintCorrectedDocument {
  /** What that document is called: the kind table's own label. */
  label: string
  number: string
  date: DateString
}

// ---- The model --------------------------------------------------------------

/**
 * Everything a printed trade document needs.
 *
 * `kind` IS HERE AND A HEADING IS NOT. The template reads the heading off the kind table
 * with `definitionOf`, so no batch can put the word "Tax Invoice" on a credit note by
 * typing it into a string — this project has found the hand-written-label failure often
 * enough that `settlesLabel` exists because of it. A kind this build does not recognise
 * fails in the mapper, loudly, rather than printing under a heading somebody invented.
 */
export interface InvoicePrintModel {
  /** Which document this is. The heading is read off the kind table from it. */
  kind: DocumentKind
  /** Draft and cancelled documents are marked on their face. Issued ones are not. */
  status: DocumentStatusDto
  /** Null while draft — there is no number until it is issued. */
  number: string | null
  date: DateString
  /** Null on a kind that charges nobody, and while draft. */
  dueDate: DateString | null
  /** Their own number for it, with the word that side of the trade calls it by. */
  reference: { label: string; value: string } | null
  /**
   * Where the supply is treated as taking place, in words.
   *
   * ON THE FACE OF THE DOCUMENT BECAUSE IT IS WHAT DECIDES THE TAX. Whether an invoice
   * carries CGST+SGST or IGST follows from this and the supplier's own jurisdiction, so a
   * reader checking the split has to be able to see it. Null only where the regime has no
   * jurisdictions at all.
   */
  placeOfSupply: string | null
  /** What the day book says about it. Printed as a note at the foot. */
  narration: string | null
  /** The document this one corrects. See `PrintCorrectedDocument`. */
  corrects?: PrintCorrectedDocument

  supplier: PrintParty
  customer: PrintParty
  /**
   * What a registration number is called here — 'GSTIN / UIN' in India.
   *
   * ON THE MODEL RATHER THAN IN THE TEMPLATE because writing 'GSTIN' in `services/` would
   * break CONVENTIONS §1.6. It comes off `RegimeDescription.registrationLabel`, which
   * comes off the adapter; the mapper printed a neutral 'Registration no.' until that
   * field existed, which was defensible and wrong for the only regime that ships.
   */
  registrationLabel: string
  /** What the classification column is called: `RegimeDescription.classification.label`. */
  classificationLabel: string

  taxColumns: readonly PrintTaxColumn[]
  lines: readonly PrintLine[]
  /** Taxable value and tax per rate slab. Empty renders no table. */
  rateSummary: readonly PrintRateSlab[]
  /** The same fold keyed by classification code, unit and rate. Empty renders no table. */
  hsnSummary: readonly PrintHsnRow[]
  totals: PrintTotals

  /** How this regime writes a number. Required — see the header of `format.ts`. */
  numberFormat: NumberFormat

  // -- Everything below awaits the company-profile migration --------------------

  /** The business's mark, as a data URI. */
  logo?: PrintImage
  bank?: PrintBankDetails
  /** Terms of the sale, one per line. Empty and absent are the same thing to the page. */
  terms?: readonly string[]
  /** The declaration an Indian invoice usually carries above the signature. */
  declaration?: string
  signatory?: PrintSignatory
}

/** What `renderInvoiceHtml` is told beyond the model itself. */
export interface InvoiceRenderOptions {
  /**
   * Which of the three copies this rendering is.
   *
   * A parameter rather than a field on the model, because the same document is printed
   * three times and only this differs. Building the model again per copy would be three
   * chances for the second one to disagree with the first about a figure.
   */
  copy?: InvoiceCopy
  /**
   * Print the grand total in words. On unless said otherwise.
   *
   * AN OPTION RATHER THAN A FIELD ON THE MODEL for the reason `copy` is: the model is
   * what is true of the document, and whether a block is wanted on a particular run is
   * true of the run. The words themselves are on the model either way — the mapper asked
   * the regime for them, and asking twice could produce two different sentences.
   */
  amountInWords?: boolean
  /** Print the per-classification fold at the foot. On unless said otherwise. */
  hsnSummary?: boolean
  /**
   * A font for the headings, carried by the page itself.
   *
   * ABSENT IS NOT A FAILURE. Nothing in this module may read a file, so the bytes arrive
   * from the caller or not at all, and a page with no `@font-face` falls back to the
   * machine's own serif. That is a worse-looking invoice and a perfectly valid one.
   */
  headingFont?: PrintFontFace
}

/** A font the page carries, so that it needs nothing from the network or the disk. */
export interface PrintFontFace {
  /** The family name the stylesheet asks for. */
  family: string
  /** `data:font/woff2;base64,…`. Never a path and never an http URL. */
  source: string
}
