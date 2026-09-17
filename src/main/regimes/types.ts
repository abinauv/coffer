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
 * A `computeGst()` called straight from a screen is the mistake this file exists to
 * prevent.
 */

import type { Decimal } from '@main/domain/money'
import type { FiscalYearRule } from '@main/domain/time'
import type { DocumentKind } from '@shared/documents'
import type { ExportTaxPayment, ItcEligibility } from '@shared/dto'
import type { DateString, DecimalString } from '@shared/scalars'

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

/**
 * A rate the regime's schedules contain, offered when picking one for a line.
 *
 * ADVISORY, AND NOTHING GATES ON IT. `computeTax` takes the rate off the line and does
 * not consult this list, so a rate that is not in it is computed exactly as one that is.
 * That is deliberate: rates change on the Council's timetable rather than on ours, and a
 * bundled list that has gone stale must not be able to stop somebody raising an invoice.
 * The same argument `checkPassphrase` makes — a UI aid that refuses nothing.
 *
 * WHY A RATE IS ON THE REGIME AT ALL, when 18% is plainly not a property of CGST. It is
 * not: it is a property of the *schedules*, which the regime is the only layer that knows
 * about. A component and a rate are different kinds of fact — `taxComponents()` is the
 * structure of the Act and changes by amendment, this is the schedule under it and
 * changes by notification — and the compliance pack keeps them apart for that reason.
 * What this method adds is a way to ask, not a claim that the answer is binding.
 */
export interface TaxRateDefinition {
  /** The full rate as a percentage, e.g. '18'. What a line's `ratePct` carries. */
  ratePct: DecimalString
  /** What the user sees in a picker. e.g. 'Nil', '18%'. */
  label: string
  /** Why the slab exists, where it is not obvious. Shown as a hint, never as a rule. */
  note: string
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
  /**
   * Whether a supply leaving the country carries tax, or goes out under an undertaking.
   *
   * NOT A REPORTING FLAG, AND THIS IS WHY IT IS AN INPUT TO THE TAX RATHER THAN A COLUMN
   * SOMEWHERE ELSE. A supply that leaves is inter-state, so a regime asked for the tax on
   * it answers with the full rate. That is right where the tax is paid and reclaimed
   * afterwards, and wrong where the exporter gave an undertaking instead: then the supply
   * carries its RATE and NO TAX.
   *
   * The only other way to produce a nil figure is to set the line rate to zero, and that
   * is a DIFFERENT SUPPLY — nil-rated rather than zero-rated — whose input credit has to
   * be reversed rather than refunded. So a regime that could not be told this could not
   * represent an export under an undertaking at all.
   *
   * DOCUMENT-LEVEL, like the place of supply, because it is a fact about the supply and
   * not about a line. Undefined or null means nothing was stated, which is every domestic
   * document and every document written before the column existed; a regime that has no
   * such distinction ignores it.
   */
  exportTaxPayment?: ExportTaxPayment | null
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
  readonly validLengths: readonly number[]
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

// ---- Returns --------------------------------------------------------------

/*
 * WHAT A REGIME PREPARES FROM THE BOOKS, in words no regime owns.
 *
 * `filings` above is a declaration — what exists, how often. This is the capability: a
 * regime that can turn a period's documents into a return says so here, and one that
 * cannot leaves `returns` off. Nothing above `regimes/` names a form, a table or a tax
 * (CONVENTIONS §1.6): the screen asks which forms exist, sends a period, and draws rows
 * whose labels and descriptions came from here.
 *
 * THE TAX IS CARRIED, NEVER RECOMPUTED. Every figure on `ReturnSourceDocument` is what
 * the regime answered when the document was raised. A return that recomputed would be a
 * second answer to a settled question, and the two would disagree the first time a rate
 * changed.
 */

/** One return a regime can prepare. */
export interface ReturnFormDefinition {
  /** Stable, e.g. 'gstr-1'. What a screen sends back. */
  id: string
  /** What it is called, e.g. 'GSTR-1'. */
  label: string
  /** One sentence: what it reports. */
  description: string
}

/** The period a return covers, inclusive at both ends. */
export interface ReturnSourcePeriod {
  from: DateString
  to: DateString
  /** What a person calls it, e.g. 'August 2026'. Carried, never parsed. */
  label: string
}

/** One tax component on a line, exactly as the document recorded it. */
export interface ReturnSourceTax {
  code: string
  ratePct: DecimalString
  amount: DecimalString
}

export interface ReturnSourceLine {
  lineNumber: number
  classificationCode: string | null
  quantity: DecimalString
  unitCode: string | null
  /** After discount, before tax. */
  taxableValue: DecimalString
  /** The full rate before it splits. */
  ratePct: DecimalString
  isCharge: boolean
  /** Null on a document written before the column existed. */
  itcEligibility: ItcEligibility | null
  taxes: readonly ReturnSourceTax[]
}

/**
 * One document, as a regime preparing a return reads it.
 *
 * ISSUED OR CANCELLED, NEVER A DRAFT, and never a kind that posts nothing: the caller
 * selects by `postsToLedger`, which is a fact about the kind rather than about any
 * regime. The builders refuse anything else rather than filtering it, so a caller that
 * got the selection wrong finds out instead of filing a return with a hole in it.
 */
export interface ReturnSourceDocument {
  id: string
  kind: DocumentKind
  number: string
  date: DateString
  isCancelled: boolean
  counterparty: {
    partyId: string
    name: string
    registrationNumber: string | null
    jurisdictionCode: string | null
    countryCode: string
  }
  /** Resolved by the regime when the document was taxed, not re-derived here. */
  placeOfSupply: PlaceOfSupply
  /** The document a note corrects, when it names one. */
  corrects: { documentId: string; kind: DocumentKind; number: string; date: DateString } | null
  exportTaxPayment: ExportTaxPayment | null
  /** The whole-unit adjustment the document was issued with, signed to add. */
  roundOff: DecimalString
  isReverseCharge: boolean
  lines: readonly ReturnSourceLine[]
}

/** One row of a prepared return, as a screen draws it. */
export interface PreparedReturnRow {
  /** Stable within the form, e.g. 'b2b' or '3.1a'. */
  id: string
  /** The table's own name, e.g. 'B2B' or '3.1(a)'. */
  label: string
  /** What the row holds, in a sentence fragment a person can read. */
  what: string
  /** Null where the table counts no documents. */
  documentCount: number | null
  /** Null where the table carries no value, only tax. */
  taxableValue: DecimalString | null
  /** Every component on the row, added. */
  tax: DecimalString
}

/** Something doubtful about a prepared return, located well enough to go and fix. */
export interface PreparedReturnIssue {
  code: string
  /** 'error': it cannot be filed as it stands. 'warning': something was assumed. */
  severity: 'error' | 'warning'
  message: string
  documentNumber: string | null
}

export interface PreparedReturn {
  form: ReturnFormDefinition
  period: ReturnSourcePeriod
  /** Which version of the regime's rules produced it. */
  packVersion: string
  /**
   * True while the return's SHAPE has not been checked against the authority's own
   * schema. A screen shows `notice` whenever this is set, and a file carries both.
   */
  isProvisional: boolean
  notice: string | null
  rows: readonly PreparedReturnRow[]
  /** The line under the table. Its label differs by form: a total, or what is payable. */
  total: PreparedReturnRow
  /** Excluding the provisional status itself, which `isProvisional` already states. */
  issues: readonly PreparedReturnIssue[]
  /** The whole artefact, plain JSON, for a file. Never sent to the renderer. */
  artefact: unknown
}

/** The capability. See the section header. */
export interface RegimeReturns {
  readonly forms: readonly ReturnFormDefinition[]
  /**
   * Prepare one form for one period.
   *
   * @throws when `formId` is not one of `forms`, and when a document cannot be in a
   *         return at all — both are refusals, never silent omissions.
   */
  prepare(
    formId: string,
    input: { period: ReturnSourcePeriod; documents: readonly ReturnSourceDocument[] },
  ): PreparedReturn
}

// ---- The adapter ----------------------------------------------------------

export interface TaxRegime {
  readonly id: RegimeId
  readonly label: string

  /** Which taxes apply, and how much. The whole point of the interface. */
  computeTax(input: TaxComputationInput): TaxComputationResult

  /** Where a supply is treated as happening. Decides intra vs inter jurisdiction. */
  placeOfSupply(supplier: TaxParty, customer: TaxParty): PlaceOfSupply

  /**
   * What this regime calls a registration number, as it prints on a document.
   *
   * 'GSTIN / UIN' in India, 'VAT number' in the EU, 'EIN' in the United States. It is on
   * the adapter for the reason `ClassificationScheme.label` is: the word is the regime's
   * and nothing above `regimes/` may invent it (CONVENTIONS §1.6). The PDF mapper printed
   * 'Registration no.' until this existed — neutral, defensible, and silently wrong for
   * the only country this build ships a regime for, on the one line of a tax invoice a
   * reader checks first.
   *
   * A READONLY FIELD AND NOT A METHOD, unlike `taxRates()`: it is a fact about the regime
   * rather than something a compliance pack supplies, and it cannot change while a
   * company file is open.
   */
  readonly registrationLabel: string

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

  /**
   * The rates the regime's schedules contain, for a picker. Advisory — see
   * `TaxRateDefinition`, which explains why nothing refuses a rate that is not here.
   *
   * A method rather than a readonly field, like `jurisdictions()` and `taxComponents()`,
   * because the answer comes out of a compliance pack that Phase 5 will load at runtime.
   */
  taxRates(): ReadonlyArray<TaxRateDefinition>

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

  /**
   * The returns this regime can prepare from the books. Absent when it can prepare none,
   * which is a complete answer: the screen says so and offers nothing.
   */
  readonly returns?: RegimeReturns
}
