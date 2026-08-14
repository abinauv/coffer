/*
 * The tax regime adapter — Coffer's internationalisation seam.
 *
 * GST must never appear in `domain/`, in `db/`, or in any screen. Everything that is
 * true of India and not of everywhere else lives behind this interface: how tax is
 * computed, what a registration number looks like, how goods are classified, when the
 * financial year starts, how numbers are grouped, how amounts are said in words, and
 * which returns exist.
 *
 * `in-gst/` is the first implementation. Adding a second regime must require no change
 * outside its own folder — if it does, something has leaked through this interface and
 * the interface is what needs fixing.
 *
 * The reference project called `computeGst()` straight from its screens. That is the
 * mistake this file exists to prevent.
 */

import type { Decimal } from '@main/domain/money'
import type { FiscalYearRule } from '@main/domain/time'
import type { DecimalString } from '@shared/scalars'

// ---- Identity -------------------------------------------------------------

/** ISO 3166-1 alpha-2, lower case. The regime's registry key. */
export type RegimeId = 'in' | (string & {})

// ---- Parties and place of supply ------------------------------------------

/**
 * What a regime needs to know about a party to tax a transaction. Deliberately not the
 * full party record — a regime has no business seeing a customer's payment terms.
 */
export interface TaxParty {
  /** Regime-specific registration number. GSTIN in India, VAT number in the EU. */
  registrationNumber: string | null
  /**
   * Sub-national jurisdiction code, where the regime has one. Indian state code
   * ('33'), US state, Canadian province. Null where the concept does not apply.
   */
  jurisdictionCode: string | null
  /** ISO 3166-1 alpha-2, lower case. */
  countryCode: string
}

/**
 * Where a supply is treated as taking place. This is what decides *which* taxes apply
 * — in India, whether a sale is CGST+SGST or IGST.
 */
export interface PlaceOfSupply {
  jurisdictionCode: string | null
  countryCode: string
  /** True when supplier and place of supply share a jurisdiction. */
  isIntraJurisdiction: boolean
  /** True when the supply leaves the regime's country entirely. */
  isExport: boolean
}

// ---- Tax computation ------------------------------------------------------

/**
 * One taxable line, as the regime sees it. Amounts are exact decimal strings; the
 * regime parses them with the domain money primitives.
 */
export interface TaxableLine {
  /** Stable identifier so the caller can match results back to its own lines. */
  lineId: string
  /** Amount after discount, before tax. */
  taxableAmount: DecimalString
  /** Full tax rate as a percentage, e.g. '18'. */
  ratePct: DecimalString
  /** Classification code — HSN or SAC in India. Null where none applies. */
  classificationCode: string | null
  /**
   * Whether this line is a charge (freight, packing, insurance) rather than goods or
   * services. Charges are taxable by default; whether a given charge is taxed is
   * configuration, never a hardcoded policy.
   */
  isCharge?: boolean
}

/** A single named tax component, e.g. CGST at 9%. */
export interface TaxComponent {
  /** Stable code used in returns and stored on the document. e.g. 'CGST'. */
  code: string
  /** What the user sees. e.g. 'CGST @ 9%'. */
  label: string
  ratePct: DecimalString
  amount: DecimalString
}

/** Per-line result. Components sum to `totalTax`. */
export interface TaxedLine {
  lineId: string
  taxableAmount: DecimalString
  components: TaxComponent[]
  totalTax: DecimalString
}

export interface TaxComputationInput {
  supplier: TaxParty
  customer: TaxParty
  placeOfSupply: PlaceOfSupply
  lines: TaxableLine[]
  /** Document date — rates change, and a document is taxed as of its own date. */
  date: string
}

export interface TaxComputationResult {
  lines: TaxedLine[]
  /** Components aggregated across lines, for the document's tax summary. */
  summary: TaxComponent[]
  totalTax: DecimalString
}

// ---- Registration numbers -------------------------------------------------

export interface ValidationResult {
  isValid: boolean
  /** Why it failed, phrased for the user. Null when valid. */
  message: string | null
  /** Jurisdiction derived from the number, where the format encodes one. */
  derivedJurisdictionCode?: string | null
}

// ---- Classification -------------------------------------------------------

export interface ClassificationScheme {
  /** 'HSN', 'SAC', 'NAICS'. Null where the regime classifies nothing. */
  code: string | null
  label: string
  /** Valid code lengths, e.g. [4, 6, 8] for HSN. Empty when unconstrained. */
  validLengths: number[]
  validate(code: string): ValidationResult
}

// ---- Number and word formatting -------------------------------------------

export interface NumberFormatRule {
  /**
   * Digit grouping from the right, e.g. [3, 2] for the Indian lakh/crore system
   * (12,34,567) and [3] for thousands (1,234,567).
   */
  groupSizes: number[]
  decimalSeparator: string
  groupSeparator: string
  currencyCode: string
  currencySymbol: string
}

// ---- Filings --------------------------------------------------------------

export type FilingFrequency = 'monthly' | 'quarterly' | 'annual'

export interface FilingDefinition {
  /** Stable identifier, e.g. 'gstr-1'. */
  id: string
  label: string
  frequency: FilingFrequency
  description: string
}

// ---- The adapter ----------------------------------------------------------

export interface TaxRegime {
  readonly id: RegimeId
  readonly label: string

  /** Which taxes apply, and how much. The whole point of the interface. */
  computeTax(input: TaxComputationInput): TaxComputationResult

  /** Where a supply is treated as happening. Decides intra vs inter jurisdiction. */
  placeOfSupply(supplier: TaxParty, customer: TaxParty): PlaceOfSupply

  /** GSTIN, VAT number, EIN. Also derives the jurisdiction when the format encodes it. */
  validateRegistrationNumber(value: string): ValidationResult

  /** Human-readable jurisdiction name for a code, e.g. '33' -> 'Tamil Nadu'. */
  jurisdictionName(code: string): string | null

  /** Every jurisdiction in the regime, for pickers. */
  jurisdictions(): ReadonlyArray<{ code: string; name: string }>

  readonly classification: ClassificationScheme
  readonly fiscalYear: FiscalYearRule
  readonly numberFormat: NumberFormatRule

  /** '1,234.50' -> 'One Thousand Two Hundred Thirty Four Rupees and Fifty Paise Only'. */
  amountInWords(value: Decimal): string

  readonly filings: ReadonlyArray<FilingDefinition>
}
