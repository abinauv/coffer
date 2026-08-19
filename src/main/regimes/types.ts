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

/**
 * A tax component the regime can levy, declared independently of any document.
 *
 * `TaxComponent` above is a *result* — a figure on a line that has been computed. This
 * is the standing declaration: which components exist at all, so that a chart of
 * accounts can be given one account per component before a single invoice is raised.
 *
 * WHY THIS IS NOT A LIST OF ACCOUNT NAMES. The regime says what it levies; the chart
 * says where it lands. Coffer builds the account codes and the role names
 * (`tax-output-cgst`) from `code`, so a regime never names an account and `CGST` never
 * appears in `domain/` or `db/` as anything but data.
 */
export interface TaxComponentDefinition {
  /** Stable, and the same string `TaxComponent.code` carries. e.g. 'CGST'. */
  code: string
  /** What the chart of accounts calls it. e.g. 'Central GST'. */
  label: string
  /**
   * Which sides of a supply the component arises on.
   *
   * Almost always `'both'`, and the distinction is not cosmetic: tax charged on a sale
   * is money owed to the government, and tax paid on a purchase is money reclaimable
   * from it. They are opposite sides of the balance sheet and must never share an
   * account — netting them would hide both figures behind their difference, and the
   * return asks for each.
   */
  levy: 'output' | 'input' | 'both'
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
  /**
   * The value in the form the regime says it should be kept in. Null when invalid.
   *
   * Required, and required for a reason. A regime that accepts `33aabcc1234d1zi` is
   * saying that number is right, not that its spelling is — GSTIN validation upper-cases
   * and strips spaces before it looks at anything, so a lower-case one passes and would
   * then be stored, and printed on a tax invoice, exactly as it was typed. Only the
   * regime knows what the canonical form is, so only the regime can be asked for it.
   */
  normalisedValue: string | null
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

  /**
   * Whether a document number is one this regime will accept on a tax document.
   *
   * India caps an invoice number at sixteen characters and allows only letters, digits,
   * '-' and '/'. That is not a preference — it is the width of the field in the return
   * schema, and a number that breaks it fails at the portal weeks later rather than at
   * the desk where it was typed.
   *
   * Uniqueness is not asked about here, because no function given one string can answer
   * it. That belongs to the numbering counter and the index behind it.
   */
  validateDocumentNumber(value: string): ValidationResult

  /** Human-readable jurisdiction name for a code, e.g. '33' -> 'Tamil Nadu'. */
  jurisdictionName(code: string): string | null

  /** Every jurisdiction in the regime, for pickers. */
  jurisdictions(): ReadonlyArray<{ code: string; name: string }>

  /**
   * Every tax component this regime can levy, in the order a return lists them.
   *
   * Asked once when a company's books are set up, to create an account per component
   * under `Duties and Taxes`. It takes no arguments on purpose: this is what the regime
   * *can* levy, not what a particular supply attracts, and a chart has to exist before
   * there is a supply to ask about.
   */
  taxComponents(): ReadonlyArray<TaxComponentDefinition>

  readonly classification: ClassificationScheme
  readonly fiscalYear: FiscalYearRule
  readonly numberFormat: NumberFormatRule

  /**
   * The amount spelled out, as the regime's invoices say it.
   *
   * India: `1234.50` -> 'Rupees One Thousand Two Hundred Thirty Four and Fifty Paise Only'.
   * The currency word leads, which is the Indian tax-invoice convention. Where a regime
   * words it differently, it words it differently — that is the point of the adapter.
   */
  amountInWords(value: Decimal): string

  readonly filings: ReadonlyArray<FilingDefinition>
}
