/*
 * THE SEAM. What a return needs from a document, and nothing else.
 *
 * This is the only input these functions take. There is no repository call anywhere in
 * this folder, no `db` import, and no clock — the same purity `domain/` has, for the same
 * reason: a return is a pure function of a period's documents and it has to be testable
 * against a fixture rather than against a database.
 *
 * ── THE RULE THAT SHAPED EVERY FIELD BELOW: TAX IS CARRIED, NEVER RECOMPUTED ───────
 *
 * `ReturnLine.taxes` is what `computeTax` answered when the document was raised, copied
 * out of `document_line_taxes`. This module reads it, buckets it and adds it up. It never
 * multiplies a rate by an amount.
 *
 * That is not an optimisation. `computeTax` already answered this question and its answer
 * is what was printed, what the customer holds, and what posted to the ledger. A return
 * that recomputed would be a SECOND answer to a settled question, and the two would
 * disagree the first time a rate changed — the invoice taxed at the old rate, the return
 * filed at the new one, and nothing in the product able to say which was right. It is the
 * same argument migration 0008 makes for storing `document_line_taxes` at all.
 *
 * The one arithmetic this module does on tax is ADDITION, and the one thing it does to a
 * rate is compare it, so that rows can be grouped by it.
 *
 * ── FIELDS THAT NO TABLE HAS ───────────────────────────────────────────────────────
 *
 * Several of these are marked GAP. They are inputs here because a return genuinely needs
 * them and the data model genuinely does not have them; each is listed in
 * `RETURN_MODEL_GAPS` with the column it wants and what this module does meanwhile. A
 * mapper filling this type in is the batch that has to read that list.
 *
 * THREE OF THEM STOPPED BEING GAPS IN PHASE 4.2 and their entries have gone from that
 * list: `documents.export_tax_payment` and `documents.is_reverse_charge` (migration 0020)
 * and `document_lines.itc_eligibility` (0021). What has NOT changed is that every field
 * below is still an INPUT rather than a query — the seam is the point — and that null
 * still means "the caller did not say", which a mapper reading an older document will
 * still produce. The interim behaviour each gap described is therefore kept, and so is
 * the issue it raises: a resolved default is now a caller's omission rather than the data
 * model's, and both deserve saying out loud.
 */

import type { ExportTaxPayment, ItcEligibility } from '@shared/dto'
import type { DocumentKind } from '@shared/documents'
import type { DateString, DecimalString } from '@shared/scalars'
import type { PlaceOfSupply } from '@main/regimes/types'

export type { ExportTaxPayment, ItcEligibility }

// ---- The period ------------------------------------------------------------

/**
 * The period a return covers, inclusive at both ends.
 *
 * A DATE RANGE RATHER THAN A MONTH, because a taxpayer under QRMP files a quarter and the
 * frequency is a per-company setting rather than a fact about the return — which is what
 * `filings.ts` says in its own header and what this type has to be shaped by.
 *
 * The range is INCLUSIVE at both ends. Every off-by-one this project could have here is a
 * document silently missing from a filed return, so the boundary is stated rather than
 * implied, and both ends have a fixture sitting exactly on them.
 */
export interface ReturnPeriod {
  readonly from: DateString
  readonly to: DateString
  /** What a screen calls it, e.g. 'August 2027'. Never parsed; only carried. */
  readonly label?: string
}

// ---- The document ----------------------------------------------------------

/** One tax component, exactly as the document recorded it. Never recomputed. */
export interface ReturnTaxAmount {
  /** The regime's own code — 'CGST', 'SGST', 'UTGST', 'IGST'. */
  readonly code: string
  /** Rate, 3dp. The component's own rate, so 9 on an 18% intra-state supply. */
  readonly ratePct: DecimalString
  /** Money, 2dp. */
  readonly amount: DecimalString
}

/** One line of a document, as a return sees it. */
export interface ReturnLine {
  /** 1-based, and the order the user put them in. Carried so an issue can name a line. */
  readonly lineNumber: number
  /** HSN or SAC. Null on a free-text line, which the HSN summary has nowhere to put. */
  readonly classificationCode: string | null
  /** Quantity, 3dp. Zero on a line with no countable quantity. */
  readonly quantity: DecimalString
  /** The company's own unit — 'BAGS'. What prints. Null for a service. */
  readonly unitCode: string | null
  /**
   * GAP — `units_of_measure.regime_code`. The unit's UQC, which is a closed set the
   * portal fixes: a company measuring in `BAGS` files `BAG`. The column exists since
   * migration 0006 and nothing has ever written to it.
   */
  readonly uqc: string | null
  /** Money, 2dp. After discount, before tax. What tax was charged on. */
  readonly taxableValue: DecimalString
  /** Rate, 3dp. The FULL rate before it splits — 18, not 9. What the return groups by. */
  readonly ratePct: DecimalString
  /** Freight, packing, insurance. Taxable like anything else; carried for reporting. */
  readonly isCharge: boolean
  /**
   * Whether credit may be taken on this line — `document_lines.itc_eligibility` (0021).
   *
   * ON THE LINE, WHICH IS WHERE IT MOVED TO. It was on `ReturnDocument` while it was a
   * gap, and being on the document was the gap: one bill can carry a laptop and a staff
   * car, and a document-level answer has to be wrong about one of them. GSTR-3B table 4
   * therefore splits a single inward document across 4(A) and 4(D) line by line.
   *
   * Null means the caller did not say, which is every document written before 0021. A
   * return resolves it to `eligible` — what the books already assert, since an ineligible
   * purchase would have been costed into the expense rather than posted to input tax —
   * and COUNTS the resolution in an `ITC_ELIGIBILITY_NOT_RECORDED` issue rather than
   * making it silently.
   */
  readonly itcEligibility: ItcEligibility | null
  /** What the regime answered for this line. Read, bucketed, added — never recomputed. */
  readonly taxes: readonly ReturnTaxAmount[]
}

/** The other party, as a return sees them. */
export interface ReturnCounterparty {
  readonly partyId: string
  /** What prints on the return beside the GSTIN. */
  readonly name: string
  /** Their GSTIN, normalised. Null makes them an unregistered person — B2CS, B2CL, CDNUR. */
  readonly registrationNumber: string | null
  /** Indian state code. */
  readonly jurisdictionCode: string | null
  /** ISO 3166-1 alpha-2, lower case. Anything but 'in' makes the supply an export. */
  readonly countryCode: string
}

/** The document a credit or debit note corrects. */
export interface CorrectedDocument {
  readonly documentId: string
  readonly kind: DocumentKind
  readonly number: string
  readonly date: DateString
}

/**
 * What the portal wants about an export.
 *
 * `taxPayment` is `documents.export_tax_payment` (migration 0020) and is no longer a gap:
 * the refund a taxpayer claims depends on which of the two it is, and it is now a column
 * and an input to `computeTax` rather than something inferred. When it is null the
 * flavour is still inferred from whether the export carries tax, and the inference is
 * still reported as an issue every time it is made — see `resolveExport` in `gstr1.ts` —
 * because a caller may hand over a document raised before the column existed.
 *
 * THE OTHER THREE ARE STILL GAPS. `shipping-bill` remains in `RETURN_MODEL_GAPS`: the
 * portal requires a shipping bill number, date and port code for a refund claim, and no
 * column holds any of them.
 */
export interface ExportDetail {
  readonly taxPayment: ExportTaxPayment | null
  readonly shippingBillNumber: string | null
  readonly shippingBillDate: DateString | null
  readonly portCode: string | null
}

/**
 * GAP — `documents.supply_treatment`. What kind of B2B supply this is.
 *
 * Affects the invoice-type label on a B2B row and nothing else here. It does NOT move an
 * SEZ supply into the zero-rated row of GSTR-3B, because a field that defaults to
 * `regular` cannot be trusted to carry a decision that size.
 */
export type SupplyTreatment =
  'regular' | 'sez-with-payment' | 'sez-without-payment' | 'deemed-export'

/**
 * One document, as a return sees it.
 *
 * Note what is NOT here: no party address, no narration, no due date, no ledger entry.
 * A return has no business seeing them, and passing the whole record around is how a tax
 * function ends up knowing a customer's payment terms.
 */
export interface ReturnDocument {
  readonly id: string
  readonly kind: DocumentKind
  /**
   * The number it was issued under. NOT nullable, because a draft has no number and a
   * return has nothing to file it as — an unnumbered document is refused, not skipped.
   */
  readonly number: string
  readonly date: DateString
  /**
   * A cancelled document contributes to no value section and is counted in DOC_ISSUE.
   * See the `cancelled-documents-appear-only-in-doc-issue` decision.
   */
  readonly isCancelled: boolean
  readonly counterparty: ReturnCounterparty
  /**
   * What the regime answered, carried rather than re-derived.
   *
   * `placeOfSupply()` already resolved this against the supplier and the customer, and it
   * deliberately does not guess — an SEZ supply or a section 10(1)(b) delivery resolves to
   * a jurisdiction the CALLER knows. Recomputing it here from the counterparty would throw
   * away exactly the cases the seam exists for.
   */
  readonly placeOfSupply: PlaceOfSupply
  /**
   * The document this one corrects. Null on a charge, and legitimately null on a note:
   * one credit note against several invoices has been legal since 2019 and has no single
   * original to name (migration 0008).
   */
  readonly corrects: CorrectedDocument | null
  /** Export fields. Null on a domestic supply; see `ExportDetail` for the gap. */
  readonly exportDetail: ExportDetail | null
  /**
   * The whole-rupee adjustment the document was issued with, signed to add. '0.00' when
   * the rounding policy is `none`.
   *
   * Carried rather than recomputed for the same reason the tax is: it is on the paper.
   * It is part of the INVOICE value and part of no rate row, which is why B2B and B2CL
   * carry it and B2CS — which has no invoice-value column — has nowhere to lose it.
   */
  readonly roundOff: DecimalString
  /**
   * Whether the buyer discharges the tax — `documents.is_reverse_charge` (0020).
   *
   * Null means the CALLER did not say, which is no longer the same thing as "the model
   * cannot": the column is `NOT NULL DEFAULT 0`, so a mapper reading a document always
   * has an answer. Null survives on this type because the seam takes documents from
   * anywhere — an import, a fixture, a test — and the return resolves it to a stated
   * default and counts it rather than assuming in silence.
   */
  readonly isReverseCharge: boolean | null
  /** GAP — `documents.supply_treatment`. Null resolves to `'regular'`. */
  readonly supplyTreatment: SupplyTreatment | null
  readonly lines: readonly ReturnLine[]
}

// ---- The numbering series --------------------------------------------------

/**
 * One range of document numbers issued in the period.
 *
 * NOT DERIVED FROM THE DOCUMENTS, and that is the point. A period in which every invoice
 * raised was cancelled still has a range to declare, and a return assembled only from the
 * documents it contains could not see it. `numbering_series` and `numbering_counters`
 * already know; nothing queries them for this yet.
 */
export interface DocumentIssueRange {
  /** The kind the series numbers. Maps to the portal's nature-of-document wording. */
  readonly kind: DocumentKind
  /** What the series is called, for the person reading. */
  readonly seriesLabel: string
  readonly fromNumber: string
  readonly toNumber: string
  /** How many numbers the series handed out in the period, cancellations included. */
  readonly totalIssued: number
  /** How many of them were cancelled. Never returned to the series — migration 0008. */
  readonly cancelled: number
}
