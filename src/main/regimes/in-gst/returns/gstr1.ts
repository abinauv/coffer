/*
 * GSTR-1 — outward supplies, section by section.
 *
 * READ `provisional.ts` FIRST. These shapes are a reading of the return, not a copy of a
 * schema, and every artefact this file produces says so in its own `issues`.
 *
 * ── WHAT THIS FUNCTION IS ──────────────────────────────────────────────────────────
 *
 * A pure fold from a period's documents to eight sections. It opens nothing, asks nothing
 * and recomputes no tax — see `types.ts` on why the last of those is the load-bearing
 * one. Everything it needs arrives in `Gstr1Input`, which is the seam a mapper fills.
 *
 * ── THE INVARIANT A RETURN IS REJECTED FOR FAILING ─────────────────────────────────
 *
 * Every section's total is the sum of the rows that section EMITTED — computed from the
 * rows, never from a second pass over the documents. Two folds is two answers, and the
 * one nobody printed is the one that stays wrong. `gstr1.test.ts` asserts it section by
 * section, and asserts the rows as well, because a total that ties is blind to a document
 * dropped from a section and to two errors that cancel.
 *
 * ── TWO TOTALS, WHICH IS NOT AN ACCIDENT ───────────────────────────────────────────
 *
 * `reported` is what the return says: every figure positive, as the document was raised.
 * A credit note for 5,000 was issued for 5,000, not for -5,000.
 * `net` is what was actually supplied: charges less refunds. It is the figure the HSN
 * summary carries, and asserting the two agree is what proves the HSN summary saw the
 * same documents the value sections did.
 */

import { D, sum, toMoneyString, type Decimal } from '@main/domain/money'
import { compareDates } from '@main/domain/time'
import { definitionOf, type DocumentKind } from '@shared/documents'
import type { DateString, DecimalString } from '@shared/scalars'
import {
  addTotals,
  negateTotals,
  sumTotals,
  toTaxAmounts,
  totalsOfComponents,
  type TaxAmounts,
  type TaxTotals,
} from './amounts'
import {
  assertNumbersDistinct,
  assertPeriod,
  assertReturnable,
  invoiceValueOf,
  isExportSupply,
  sectionOf,
  signOf,
  taxableValueOf,
  taxValueOf,
  type Gstr1SectionId,
} from './classify'
import { issue, ReturnError, type ReturnIssue } from './errors'
import { buildHsnSummary, type HsnSummary } from './hsn'
import { BUNDLED_COMPLIANCE_PACK, type IndiaCompliancePack } from '../compliance-pack'
import { PROVISIONAL_NOTICE } from './provisional'
import type {
  DocumentIssueRange,
  ExportTaxPayment,
  ReturnDocument,
  ReturnPeriod,
  SupplyTreatment,
} from './types'

// ---- Shared row shapes -----------------------------------------------------

/** One rate slab within a document: what was supplied at that rate and the tax on it. */
export interface RateRow {
  /** The full rate, 3dp — 18, not the 9 each component carries. */
  readonly ratePct: DecimalString
  readonly taxableValue: DecimalString
  readonly tax: TaxAmounts
}

/** One document, as a value section reports it. */
export interface ReportedDocument {
  readonly documentId: string
  readonly documentNumber: string
  readonly documentDate: DateString
  /** Taxable value + tax + round-off. What the customer paid. */
  readonly documentValue: DecimalString
  readonly placeOfSupplyCode: string | null
  readonly taxableValue: DecimalString
  readonly tax: TaxAmounts
  readonly items: readonly RateRow[]
}

/** A B2B row: a reported document plus the two flags the section carries. */
export interface B2bInvoice extends ReportedDocument {
  readonly isReverseCharge: boolean
  readonly invoiceType: SupplyTreatment
}

/** Whether a note reduces the value of a supply or raises it. */
export type NoteType = 'credit' | 'debit'

/** A credit or debit note, with the document it corrects. */
export interface ReportedNote extends ReportedDocument {
  readonly noteType: NoteType
  /**
   * The original. Legitimately null — one note against several invoices has been legal
   * since 2019 and has no single original to name (migration 0008).
   */
  readonly originalNumber: string | null
  readonly originalDate: DateString | null
}

// ---- The sections ----------------------------------------------------------

export interface B2bParty {
  readonly gstin: string
  readonly partyName: string
  readonly invoices: readonly B2bInvoice[]
  readonly taxableValue: DecimalString
  readonly tax: TaxAmounts
}

export interface B2bSection {
  readonly parties: readonly B2bParty[]
  readonly invoiceCount: number
  readonly taxableValue: DecimalString
  readonly tax: TaxAmounts
}

export interface B2clPlace {
  readonly placeOfSupplyCode: string | null
  readonly invoices: readonly ReportedDocument[]
  readonly taxableValue: DecimalString
  readonly tax: TaxAmounts
}

export interface B2clSection {
  readonly places: readonly B2clPlace[]
  readonly invoiceCount: number
  readonly taxableValue: DecimalString
  readonly tax: TaxAmounts
}

/** Whether a supply stayed inside the state. The portal infers it from the tax columns. */
export type SupplyType = 'intra' | 'inter'

/** One aggregated B2CS row. No document number: this is the section that has none. */
export interface B2csRow {
  readonly placeOfSupplyCode: string | null
  readonly supplyType: SupplyType
  readonly ratePct: DecimalString
  readonly taxableValue: DecimalString
  readonly tax: TaxAmounts
}

export interface B2csSection {
  readonly rows: readonly B2csRow[]
  /** How many documents were folded into the rows. Not a column; a check on the fold. */
  readonly documentCount: number
  readonly taxableValue: DecimalString
  readonly tax: TaxAmounts
}

export interface CdnrParty {
  readonly gstin: string
  readonly partyName: string
  readonly notes: readonly ReportedNote[]
  readonly taxableValue: DecimalString
  readonly tax: TaxAmounts
}

export interface CdnrSection {
  readonly parties: readonly CdnrParty[]
  readonly noteCount: number
  readonly taxableValue: DecimalString
  readonly tax: TaxAmounts
}

/** Which unregistered supply a note corrects. */
export type CdnurType = 'B2CL' | 'EXPWP' | 'EXPWOP'

export interface CdnurNote extends ReportedNote {
  readonly urType: CdnurType
}

export interface CdnurSection {
  readonly notes: readonly CdnurNote[]
  readonly noteCount: number
  readonly taxableValue: DecimalString
  readonly tax: TaxAmounts
}

export interface ExportInvoice extends ReportedDocument {
  readonly shippingBillNumber: string | null
  readonly shippingBillDate: DateString | null
  readonly portCode: string | null
}

export interface ExportGroup {
  readonly taxPayment: ExportTaxPayment
  readonly invoices: readonly ExportInvoice[]
  readonly taxableValue: DecimalString
  readonly tax: TaxAmounts
}

export interface ExpSection {
  readonly groups: readonly ExportGroup[]
  readonly invoiceCount: number
  readonly taxableValue: DecimalString
  readonly tax: TaxAmounts
}

export interface DocIssueRow {
  readonly natureOfDocument: string
  readonly seriesLabel: string
  readonly fromNumber: string
  readonly toNumber: string
  readonly totalIssued: number
  readonly cancelled: number
  /** `totalIssued - cancelled`. The column the portal calls "Total number". */
  readonly netIssued: number
}

export interface DocIssueSection {
  readonly rows: readonly DocIssueRow[]
  readonly totalIssued: number
  readonly cancelled: number
  readonly netIssued: number
}

// ---- The return ------------------------------------------------------------

/** Everything GSTR-1 needs. The seam a mapper fills — see `types.ts`. */
export interface Gstr1Input {
  readonly period: ReturnPeriod
  readonly documents: readonly ReturnDocument[]
  /**
   * The number ranges the company's series handed out in the period, cancellations
   * included. Not derivable from `documents` — see `DocumentIssueRange`.
   */
  readonly issuedRanges?: readonly DocumentIssueRange[]
  /**
   * The pack whose B2CL threshold decides B2CL from B2CS. Defaults to the bundled one,
   * exactly as `compliance-pack.ts` describes the pattern.
   */
  readonly pack?: IndiaCompliancePack
}

export interface Gstr1Return {
  readonly period: ReturnPeriod
  readonly packVersion: string
  /** The artefact's own statement of its status. See `provisional.ts`. */
  readonly notice: string
  readonly b2b: B2bSection
  readonly b2cl: B2clSection
  readonly b2cs: B2csSection
  readonly cdnr: CdnrSection
  readonly cdnur: CdnurSection
  readonly exp: ExpSection
  readonly hsn: HsnSummary
  readonly docIssue: DocIssueSection
  /** Every figure as filed: positive, summed across the value sections. */
  readonly reported: {
    readonly documentCount: number
    readonly taxableValue: DecimalString
    readonly tax: TaxAmounts
  }
  /** Charges less refunds — what was actually supplied. Equals the HSN summary. */
  readonly net: {
    readonly taxableValue: DecimalString
    readonly tax: TaxAmounts
  }
  readonly issues: readonly ReturnIssue[]
}

// ---- Nature of document, for table 13 --------------------------------------

/**
 * What the portal calls each kind in the document-issued table.
 *
 * A TOTAL RECORD over the kinds — CONVENTIONS §1.9 — so a sixth kind does not compile
 * until somebody has decided what it is called. `null` means "not a series GSTR-1
 * declares", and a range naming one is refused rather than dropped.
 */
export const NATURE_OF_DOCUMENT: Readonly<Record<DocumentKind, string | null>> = {
  'sales-invoice': 'Invoices for outward supply',
  'credit-note': 'Credit note',
  /* Not a document GST recognises: it offers a price and makes no supply. */
  quotation: null,
  /* The number on a purchase bill is the VENDOR's, out of their series, not ours. */
  'purchase-bill': null,
  /* Coffer's debit note is the purchase-side refund — it corrects a bill, not an invoice
   * — so the supply it touches is inward and GSTR-1 declares outward series. A supplier's
   * outward debit note (a supplementary invoice raising the value of a supply) has no
   * kind in this data model at all; see RETURN_MODEL_GAPS. */
  'debit-note': null,
}

// ---- Building --------------------------------------------------------------

interface Placed {
  document: ReturnDocument
  section: Gstr1SectionId
  taxable: Decimal
  tax: TaxTotals
  value: Decimal
  items: RateRow[]
}

/**
 * Group a document's lines into one row per full rate.
 *
 * By the FULL rate, not by component rate: an 18% supply is one row whether it split into
 * two nines or landed as a single eighteen, and grouping by the component's rate would
 * give an intra-state invoice twice as many rows as the identical inter-state one.
 */
function rateRowsOf(document: ReturnDocument): RateRow[] {
  const buckets = new Map<string, { taxable: Decimal; tax: TaxTotals }>()

  for (const line of document.lines) {
    /* Keyed by the decimal's own form so '18' and '18.000' are one row. */
    const key = D(line.ratePct).toString()
    const lineTax = totalsOfComponents(line.taxes)
    const existing = buckets.get(key)
    if (existing === undefined) {
      buckets.set(key, { taxable: D(line.taxableValue), tax: lineTax })
    } else {
      existing.taxable = existing.taxable.plus(D(line.taxableValue))
      existing.tax = addTotals(existing.tax, lineTax)
    }
  }

  return [...buckets.entries()]
    .sort((a, b) => D(a[0]).comparedTo(D(b[0])))
    .map(([ratePct, bucket]) => ({
      ratePct,
      taxableValue: toMoneyString(bucket.taxable),
      tax: toTaxAmounts(bucket.tax),
    }))
}

function reportedOf(placed: Placed): ReportedDocument {
  return {
    documentId: placed.document.id,
    documentNumber: placed.document.number,
    documentDate: placed.document.date,
    documentValue: toMoneyString(placed.value),
    placeOfSupplyCode: placed.document.placeOfSupply.jurisdictionCode,
    taxableValue: toMoneyString(placed.taxable),
    tax: toTaxAmounts(placed.tax),
    items: placed.items,
  }
}

/** Which way a note faces. A total record, so an outward debit note would file correctly. */
const NOTE_TYPE_OF: Readonly<Record<'charge' | 'refund', NoteType>> = {
  charge: 'debit',
  refund: 'credit',
}

function notedOf(placed: Placed): ReportedNote {
  const corrects = placed.document.corrects
  return {
    ...reportedOf(placed),
    noteType: NOTE_TYPE_OF[definitionOf(placed.document.kind).direction],
    originalNumber: corrects?.number ?? null,
    originalDate: corrects?.date ?? null,
  }
}

/** Documents in a stable order: by date, then by number. */
function byDateThenNumber(a: ReturnDocument, b: ReturnDocument): number {
  const byDate = compareDates(a.date, b.date)
  return byDate !== 0 ? byDate : compareText(a.number, b.number)
}

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0
  }
  return a < b ? -1 : 1
}

function compareNullableText(a: string | null, b: string | null): number {
  if (a === b) {
    return 0
  }
  if (a === null) {
    return 1
  }
  if (b === null) {
    return -1
  }
  return compareText(a, b)
}

/**
 * Which flavour of export this is, and what had to be assumed to say so.
 *
 * See the `exports-infer-payment-from-tax-charged` decision. The inference is exported so
 * a test can drive each branch of it directly rather than through a whole return.
 */
export function resolveExport(document: ReturnDocument): {
  taxPayment: ExportTaxPayment
  issues: ReturnIssue[]
} {
  const stated = document.exportDetail?.taxPayment ?? null
  const issues: ReturnIssue[] = []

  if (document.exportDetail?.shippingBillNumber == null) {
    issues.push(
      issue(
        'EXPORT_SHIPPING_BILL_MISSING',
        'error',
        `Export ${document.number} has no shipping bill number. The portal requires one, ` +
          'and a refund claim rests on it.',
        { documentId: document.id, documentNumber: document.number, section: 'EXP' },
      ),
    )
  }

  if (stated !== null) {
    return { taxPayment: stated, issues }
  }

  const carriesTax = !taxValueOf(document).isZero()
  const anyRate = document.lines.some((line) => !D(line.ratePct).isZero())

  if (carriesTax) {
    issues.push(
      issue(
        'EXPORT_TAX_PAYMENT_INFERRED',
        'warning',
        `Export ${document.number} carries tax, so it is filed as an export WITH payment ` +
          'of tax. Nothing in the data model records which it was.',
        { documentId: document.id, documentNumber: document.number, section: 'EXP' },
      ),
    )
    return { taxPayment: 'with-payment', issues }
  }

  issues.push(
    issue(
      anyRate ? 'EXPORT_TAX_PAYMENT_INFERRED' : 'EXPORT_TAX_PAYMENT_ASSUMED',
      'warning',
      anyRate
        ? `Export ${document.number} carries a rate but no tax, so it is filed as an ` +
            'export under LUT or bond. Nothing in the data model records which it was.'
        : `Export ${document.number} is nil-rated and carries no tax, so nothing in it ` +
            'can say whether it went under LUT or with payment. Filed as under LUT.',
      { documentId: document.id, documentNumber: document.number, section: 'EXP' },
    ),
  )
  return { taxPayment: 'without-payment', issues }
}

/**
 * Which CDNUR bucket an unregistered note belongs to.
 *
 * A domestic note has no export flavour and files as B2CL — which is the portal's name
 * for "a note against a supply to an unregistered person", not a claim that the original
 * was above the B2CL threshold. An export note files under the flavour of the export.
 */
function cdnurTypeOf(taxPayment: ExportTaxPayment | null): CdnurType {
  if (taxPayment === null) {
    return 'B2CL'
  }
  return taxPayment === 'with-payment' ? 'EXPWP' : 'EXPWOP'
}

/** Table 13, from the series rather than from the documents. */
export function buildDocIssue(ranges: readonly DocumentIssueRange[]): DocIssueSection {
  const rows = ranges.map((range): DocIssueRow => {
    const nature = NATURE_OF_DOCUMENT[range.kind]
    if (nature === null) {
      throw new ReturnError(
        'RETURN_DOCUMENT_WRONG_SIDE',
        `A '${range.kind}' series has no row in GSTR-1's document table — it is not an ` +
          'outward series this company issues under. Pass only outward series.',
      )
    }
    if (range.cancelled > range.totalIssued) {
      throw new ReturnError(
        'RETURN_PACK_VALUE_INVALID',
        `Series '${range.seriesLabel}' reports ${String(range.cancelled)} cancelled out of ` +
          `${String(range.totalIssued)} issued, which cannot be.`,
      )
    }
    return {
      natureOfDocument: nature,
      seriesLabel: range.seriesLabel,
      fromNumber: range.fromNumber,
      toNumber: range.toNumber,
      totalIssued: range.totalIssued,
      cancelled: range.cancelled,
      netIssued: range.totalIssued - range.cancelled,
    }
  })

  const ordered = [...rows].sort((a, b) => {
    const byNature = compareText(a.natureOfDocument, b.natureOfDocument)
    return byNature !== 0 ? byNature : compareText(a.fromNumber, b.fromNumber)
  })

  return {
    rows: ordered,
    totalIssued: ordered.reduce((running, row) => running + row.totalIssued, 0),
    cancelled: ordered.reduce((running, row) => running + row.cancelled, 0),
    netIssued: ordered.reduce((running, row) => running + row.netIssued, 0),
  }
}

/**
 * GSTR-1 for a period.
 *
 * Refuses a document that does not belong in it — outside the period, on the wrong side
 * of the trade, unnumbered, or correcting something it may not. None of those is filtered
 * out: see `assertReturnable`.
 */
export function buildGstr1(input: Gstr1Input): Gstr1Return {
  const pack = input.pack ?? BUNDLED_COMPLIANCE_PACK
  const period = input.period
  assertPeriod(period)

  const issues: ReturnIssue[] = [
    issue('SCHEMA_UNVERIFIED', 'warning', PROVISIONAL_NOTICE, { section: 'GSTR-1' }),
  ]

  for (const document of input.documents) {
    assertReturnable(document, period, 'sales')
  }
  assertNumbersDistinct(input.documents)

  const live = input.documents.filter((document) => !document.isCancelled)

  const placed: Placed[] = [...live].sort(byDateThenNumber).map((document) => ({
    document,
    section: sectionOf(document, pack.returns.b2clInvoiceValueThreshold),
    taxable: taxableValueOf(document),
    tax: totalsOfComponents(document.lines.flatMap((line) => line.taxes)),
    value: invoiceValueOf(document),
    items: rateRowsOf(document),
  }))

  const inSection = (id: Gstr1SectionId): Placed[] => placed.filter((entry) => entry.section === id)

  const notRecordingReverseCharge = live.filter(
    (document) => document.isReverseCharge === null,
  ).length
  if (notRecordingReverseCharge > 0) {
    issues.push(
      issue(
        'REVERSE_CHARGE_NOT_RECORDED',
        'warning',
        `${String(notRecordingReverseCharge)} document(s) do not record whether the supply ` +
          'is under reverse charge, so they are filed as forward charge. The data model ' +
          'has no column for it.',
        { section: 'B2B', value: String(notRecordingReverseCharge) },
      ),
    )
  }

  const exportPayments = new Map<string, ExportTaxPayment>()
  for (const entry of placed) {
    if (isExportSupply(entry.document)) {
      const resolved = resolveExport(entry.document)
      exportPayments.set(entry.document.id, resolved.taxPayment)
      issues.push(...resolved.issues)
    }
  }

  for (const entry of placed) {
    if (
      entry.document.corrects === null &&
      (entry.section === 'CDNR' || entry.section === 'CDNUR')
    ) {
      issues.push(
        issue(
          'CORRECTED_DOCUMENT_UNNAMED',
          'warning',
          `${entry.document.number} names no original document. That is legal — one note ` +
            'against several invoices has been since 2019 — and the portal will want the ' +
            'original before it accepts the row.',
          {
            documentId: entry.document.id,
            documentNumber: entry.document.number,
            section: entry.section,
          },
        ),
      )
    }
  }

  const b2b = buildB2b(inSection('B2B'))
  const b2cl = buildB2cl(inSection('B2CL'))
  const b2cs = buildB2cs(inSection('B2CS'))
  const cdnr = buildCdnr(inSection('CDNR'))
  const cdnur = buildCdnur(inSection('CDNUR'), exportPayments)
  const exp = buildExp(inSection('EXP'), exportPayments)
  const hsn = buildHsnSummary(live)
  issues.push(...hsn.issues)

  const docIssue = buildDocIssue(input.issuedRanges ?? [])

  /* The return's own totals are the sum of the SECTIONS, which are themselves the sum of
   * their rows. Nothing here goes back to the documents.
   *
   * A MUTATION REPLACING THIS WITH A SUM OVER THE DOCUMENTS SURVIVES, and it survives
   * honestly: while every document lands in exactly one section, the two folds give the
   * same number, so no fixture can separate them. What makes the row-derivation
   * observable is the PAIR of assertions in the test -- each section total equals the sum
   * of its rows, AND every non-cancelled document appears in exactly one section. A
   * document dropped from a section fails the first; a document counted twice fails the
   * second. Deriving the total from the rows is what keeps both of those checkable at
   * all: a total folded from the documents would agree with the documents by
   * construction and could never disagree with the rows.
   */
  const sectionTotals: { taxable: DecimalString; tax: TaxAmounts }[] = [
    { taxable: b2b.taxableValue, tax: b2b.tax },
    { taxable: b2cl.taxableValue, tax: b2cl.tax },
    { taxable: b2cs.taxableValue, tax: b2cs.tax },
    { taxable: cdnr.taxableValue, tax: cdnr.tax },
    { taxable: cdnur.taxableValue, tax: cdnur.tax },
    { taxable: exp.taxableValue, tax: exp.tax },
  ]

  const reportedTaxable = sum(sectionTotals.map((each) => each.taxable))
  const reportedTax = sumTotals(
    sectionTotals.map((each) => ({
      igst: D(each.tax.igst),
      cgst: D(each.tax.cgst),
      sgst: D(each.tax.sgst),
      cess: D(each.tax.cess),
    })),
  )

  const net = placed.map((entry) =>
    signOf(entry.document.kind) === 1
      ? { taxable: entry.taxable, tax: entry.tax }
      : { taxable: entry.taxable.negated(), tax: negateTotals(entry.tax) },
  )

  return {
    period,
    packVersion: pack.packVersion,
    notice: PROVISIONAL_NOTICE,
    b2b,
    b2cl,
    b2cs,
    cdnr,
    cdnur,
    exp,
    hsn,
    docIssue,
    reported: {
      documentCount: placed.length,
      taxableValue: toMoneyString(reportedTaxable),
      tax: toTaxAmounts(reportedTax),
    },
    net: {
      taxableValue: toMoneyString(sum(net.map((each) => each.taxable))),
      tax: toTaxAmounts(sumTotals(net.map((each) => each.tax))),
    },
    issues,
  }
}

// ---- Section builders ------------------------------------------------------

/** The GSTIN of a party in a registered section. Never reached with an unregistered one. */
function gstinOf(entry: Placed): string {
  const gstin = entry.document.counterparty.registrationNumber
  if (gstin === null || gstin.trim() === '') {
    /* Unreachable: `sectionOf` sends an unregistered party to B2CS, B2CL or CDNUR. */
    throw new ReturnError(
      'RETURN_DOCUMENT_WRONG_SIDE',
      `${entry.document.number} reached a registered section with no GSTIN.`,
    )
  }
  return gstin.trim().toUpperCase()
}

function totalsOf(entries: readonly Placed[]): { taxable: Decimal; tax: TaxTotals } {
  return {
    taxable: sum(entries.map((entry) => entry.taxable)),
    tax: sumTotals(entries.map((entry) => entry.tax)),
  }
}

function buildB2b(entries: readonly Placed[]): B2bSection {
  const byParty = groupBy(entries, gstinOf)

  const parties = [...byParty.entries()]
    .sort((a, b) => compareText(a[0], b[0]))
    .map(([gstin, forParty]): B2bParty => {
      const totals = totalsOf(forParty)
      return {
        gstin,
        partyName: forParty[0]?.document.counterparty.name ?? '',
        invoices: forParty.map((entry): B2bInvoice => ({
          ...reportedOf(entry),
          isReverseCharge: entry.document.isReverseCharge ?? false,
          invoiceType: entry.document.supplyTreatment ?? 'regular',
        })),
        taxableValue: toMoneyString(totals.taxable),
        tax: toTaxAmounts(totals.tax),
      }
    })

  const taxable = sum(parties.map((party) => party.taxableValue))
  return {
    parties,
    invoiceCount: parties.reduce((running, party) => running + party.invoices.length, 0),
    taxableValue: toMoneyString(taxable),
    tax: toTaxAmounts(sumTotals(parties.map((party) => fromAmounts(party.tax)))),
  }
}

function buildB2cl(entries: readonly Placed[]): B2clSection {
  const byPlace = groupBy(entries, (entry) => entry.document.placeOfSupply.jurisdictionCode ?? '')

  const places = [...byPlace.entries()]
    .sort((a, b) => compareText(a[0], b[0]))
    .map(([, forPlace]): B2clPlace => {
      const totals = totalsOf(forPlace)
      return {
        placeOfSupplyCode: forPlace[0]?.document.placeOfSupply.jurisdictionCode ?? null,
        invoices: forPlace.map(reportedOf),
        taxableValue: toMoneyString(totals.taxable),
        tax: toTaxAmounts(totals.tax),
      }
    })

  return {
    places,
    invoiceCount: places.reduce((running, place) => running + place.invoices.length, 0),
    taxableValue: toMoneyString(sum(places.map((place) => place.taxableValue))),
    tax: toTaxAmounts(sumTotals(places.map((place) => fromAmounts(place.tax)))),
  }
}

/**
 * B2CS: aggregated by place of supply and rate, with no document number anywhere.
 *
 * Aggregated at LINE level rather than document level, because one counter sale can carry
 * a 5% line and an 18% line and the two belong in different rows.
 */
function buildB2cs(entries: readonly Placed[]): B2csSection {
  interface Row {
    placeOfSupplyCode: string | null
    supplyType: SupplyType
    ratePct: string
    taxable: Decimal
    tax: TaxTotals
  }
  const rows = new Map<string, Row>()

  for (const entry of entries) {
    const place = entry.document.placeOfSupply
    const supplyType: SupplyType = place.isIntraJurisdiction ? 'intra' : 'inter'
    for (const line of entry.document.lines) {
      const ratePct = D(line.ratePct).toString()
      /* Joined with a character no part can contain -- a state code is digits, a
       * supply type is one of two words, a rate is a decimal.
       *
       * MEASURED: a mutation replacing the separator with an empty string survives,
       * because with those three domains no two distinct key triples can concatenate to
       * the same string. The separator is therefore defence against a future part rather
       * than a rule under test; the rule under test is that two places at one rate, and
       * two rates at one place, stay two rows -- which the worked month asserts. */
      const key = [place.jurisdictionCode ?? '', supplyType, ratePct].join('|')
      const lineTax = totalsOfComponents(line.taxes)
      const existing = rows.get(key)
      if (existing === undefined) {
        rows.set(key, {
          placeOfSupplyCode: place.jurisdictionCode,
          supplyType,
          ratePct,
          taxable: D(line.taxableValue),
          tax: lineTax,
        })
      } else {
        existing.taxable = existing.taxable.plus(D(line.taxableValue))
        existing.tax = addTotals(existing.tax, lineTax)
      }
    }
  }

  const ordered = [...rows.values()]
    .sort((a, b) => {
      const byPlace = compareNullableText(a.placeOfSupplyCode, b.placeOfSupplyCode)
      if (byPlace !== 0) {
        return byPlace
      }
      const byType = compareText(a.supplyType, b.supplyType)
      return byType !== 0 ? byType : D(a.ratePct).comparedTo(D(b.ratePct))
    })
    .map((row): B2csRow => ({
      placeOfSupplyCode: row.placeOfSupplyCode,
      supplyType: row.supplyType,
      ratePct: row.ratePct,
      taxableValue: toMoneyString(row.taxable),
      tax: toTaxAmounts(row.tax),
    }))

  return {
    rows: ordered,
    documentCount: entries.length,
    taxableValue: toMoneyString(sum(ordered.map((row) => row.taxableValue))),
    tax: toTaxAmounts(sumTotals(ordered.map((row) => fromAmounts(row.tax)))),
  }
}

function buildCdnr(entries: readonly Placed[]): CdnrSection {
  const byParty = groupBy(entries, gstinOf)

  const parties = [...byParty.entries()]
    .sort((a, b) => compareText(a[0], b[0]))
    .map(([gstin, forParty]): CdnrParty => {
      const totals = totalsOf(forParty)
      return {
        gstin,
        partyName: forParty[0]?.document.counterparty.name ?? '',
        notes: forParty.map(notedOf),
        taxableValue: toMoneyString(totals.taxable),
        tax: toTaxAmounts(totals.tax),
      }
    })

  return {
    parties,
    noteCount: parties.reduce((running, party) => running + party.notes.length, 0),
    taxableValue: toMoneyString(sum(parties.map((party) => party.taxableValue))),
    tax: toTaxAmounts(sumTotals(parties.map((party) => fromAmounts(party.tax)))),
  }
}

function buildCdnur(
  entries: readonly Placed[],
  exportPayments: ReadonlyMap<string, ExportTaxPayment>,
): CdnurSection {
  const notes = entries.map((entry): CdnurNote => ({
    ...notedOf(entry),
    urType: cdnurTypeOf(exportPayments.get(entry.document.id) ?? null),
  }))
  const totals = totalsOf(entries)

  return {
    notes,
    noteCount: notes.length,
    taxableValue: toMoneyString(totals.taxable),
    tax: toTaxAmounts(totals.tax),
  }
}

/** The two flavours, always both present, so a reader can see which one is empty. */
const EXPORT_GROUP_ORDER: readonly ExportTaxPayment[] = ['with-payment', 'without-payment']

function buildExp(
  entries: readonly Placed[],
  exportPayments: ReadonlyMap<string, ExportTaxPayment>,
): ExpSection {
  const groups = EXPORT_GROUP_ORDER.map((taxPayment): ExportGroup => {
    const forGroup = entries.filter((entry) => exportPayments.get(entry.document.id) === taxPayment)
    const totals = totalsOf(forGroup)
    return {
      taxPayment,
      invoices: forGroup.map((entry): ExportInvoice => ({
        ...reportedOf(entry),
        shippingBillNumber: entry.document.exportDetail?.shippingBillNumber ?? null,
        shippingBillDate: entry.document.exportDetail?.shippingBillDate ?? null,
        portCode: entry.document.exportDetail?.portCode ?? null,
      })),
      taxableValue: toMoneyString(totals.taxable),
      tax: toTaxAmounts(totals.tax),
    }
  })

  return {
    groups,
    invoiceCount: groups.reduce((running, group) => running + group.invoices.length, 0),
    taxableValue: toMoneyString(sum(groups.map((group) => group.taxableValue))),
    tax: toTaxAmounts(sumTotals(groups.map((group) => fromAmounts(group.tax)))),
  }
}

// ---- Small shared helpers --------------------------------------------------

function fromAmounts(amounts: TaxAmounts): TaxTotals {
  return {
    igst: D(amounts.igst),
    cgst: D(amounts.cgst),
    sgst: D(amounts.sgst),
    cess: D(amounts.cess),
  }
}

/** Stable grouping: keys come out in the order first met, so nothing depends on a Map. */
function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const bucket = grouped.get(key)
    if (bucket === undefined) {
      grouped.set(key, [item])
    } else {
      bucket.push(item)
    }
  }
  return grouped
}
