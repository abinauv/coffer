/*
 * GSTR-3B — the summary return, and the one that carries the payment.
 *
 * READ `provisional.ts` FIRST. Same status as GSTR-1: the arithmetic is tested to the
 * paisa, the shape is a reading.
 *
 * ── HOW THIS DIFFERS FROM GSTR-1, WHICH IS THE THING TO GET RIGHT ──────────────────
 *
 * GSTR-1 reports DOCUMENTS and carries every figure positive, because a credit note for
 * 5,000 was issued for 5,000. GSTR-3B reports a PERIOD and is net: a credit note reduces
 * the outward supply and the tax on it. So every figure below is signed by the document's
 * direction, and `signOf` is where that happens — once, from the document table, rather
 * than by remembering which kinds are refunds.
 *
 * ── WHAT IS DERIVED AND WHAT HAD TO BE ASKED FOR ───────────────────────────────────
 *
 * Derived from documents: 3.1(a), (b) and (c), 3.2, 4(A)(3) and 4(A)(5), 4(D), and the
 * whole of the payment table.
 *
 * NOT DERIVABLE, and taken as `declared` inputs defaulting to zero: 3.1(e) non-GST
 * supplies, 4(A)(1) and (2) imports, 4(A)(4) ISD credit, 4(B) reversals, and 5.1 interest.
 * Every one of them is a `RETURN_MODEL_GAPS` entry, and taking them as zero is REPORTED
 * rather than assumed silently — a zero in a return is a claim that there was nothing,
 * not an admission that nobody looked.
 *
 * ── ROUNDING ───────────────────────────────────────────────────────────────────────
 *
 * One point, and it is the cash payable. Everything upstream is exact at 2dp. See the
 * long note in `amounts.ts`; the short version is that rounding 3.1 would make this
 * return disagree with the GSTR-1 filed beside it for the same period, which is this
 * project's own measured finding about rounding tax components separately, one layer up.
 */

import { D, min, sum, toMoneyString, ZERO, type Decimal } from '@main/domain/money'
import type { DecimalString } from '@shared/scalars'
import {
  addTotals,
  fromTaxAmounts,
  grandTotalOf,
  isZeroTotals,
  negateTotals,
  roundTotalsToRupees,
  sumTotals,
  TAX_BUCKETS,
  toTaxAmounts,
  totalsOfComponents,
  zeroAmounts,
  zeroTotals,
  type TaxAmounts,
  type TaxBucket,
  type TaxTotals,
} from './amounts'
import {
  assertNumbersDistinct,
  assertPeriod,
  assertReturnable,
  isExportSupply,
  isInterStateSupply,
  isRegisteredCounterparty,
  signOf,
} from './classify'
import { issue, type ReturnIssue } from './errors'
import { BUNDLED_COMPLIANCE_PACK, type IndiaCompliancePack } from '../compliance-pack'
import { PROVISIONAL_NOTICE } from './provisional'
import type { ItcEligibility, ReturnDocument, ReturnPeriod } from './types'

// ---- Inputs ----------------------------------------------------------------

/**
 * Which liability the remainder of the IGST credit is applied to first.
 *
 * A PREFERENCE, NOT A RULE. Section 49A fixes that IGST credit is exhausted first; rule
 * 88A leaves the order between CGST and SGST open. Any fixed order would therefore be a
 * choice pretending to be a rule, so it is an argument — see the
 * `igst-remainder-goes-to-cgst-before-sgst` decision.
 */
export type IgstCreditPreference = 'cgst-first' | 'sgst-first'

/**
 * Everything the return needs that no document can answer.
 *
 * Each field defaults to nothing and each absence is reported. See `RETURN_MODEL_GAPS`.
 */
export interface Gstr3bDeclared {
  /** 3.1(e). Alcohol, petroleum, a salary recharge. NOT inferred from a nil rate. */
  readonly nonGstOutwardValue?: DecimalString
  /** 4(A)(1). */
  readonly importOfGoodsCredit?: TaxAmounts
  /** 4(A)(2). */
  readonly importOfServicesCredit?: TaxAmounts
  /** 4(A)(4). */
  readonly isdCredit?: TaxAmounts
  /** 4(B)(1). Rule 42 and 43 — the apportionment a period with exempt supplies needs. */
  readonly reversalRule42And43?: TaxAmounts
  /** 4(B)(2). */
  readonly reversalOther?: TaxAmounts
  /** 5.1. Paid in cash, never from credit. */
  readonly interestAndLateFee?: TaxAmounts
}

/** What the return does where the data model records nothing. Stated, never implicit. */
export interface Gstr3bDefaults {
  /**
   * What an unrecorded reverse-charge flag means. FALSE, because forward charge is the
   * ordinary case and a document wrongly marked reverse charge invents a cash liability
   * that no credit can discharge.
   */
  readonly isReverseCharge?: boolean
  /**
   * What an unrecorded ITC eligibility means. ELIGIBLE, because that is what the books
   * already assert — an ineligible purchase would have been costed into the expense
   * rather than posted to input tax.
   *
   * APPLIED PER LINE, not per document, since migration 0021 put the column on the line:
   * a bill carrying a laptop and a staff car splits between 4(A) and 4(D), and a document
   * that states eligibility on one line and not the other takes this default only for the
   * line that is silent.
   */
  readonly itcEligibility?: ItcEligibility
}

export interface Gstr3bInput {
  readonly period: ReturnPeriod
  /** Sales-side documents in the period. Refused if any is not. */
  readonly outwardDocuments: readonly ReturnDocument[]
  /** Purchase-side documents in the period. Refused if any is not. */
  readonly inwardDocuments: readonly ReturnDocument[]
  readonly declared?: Gstr3bDeclared
  readonly defaults?: Gstr3bDefaults
  readonly igstCreditPreference?: IgstCreditPreference
  readonly pack?: IndiaCompliancePack
}

// ---- Outputs ---------------------------------------------------------------

/** A value and the tax on it. The shape every row of table 3.1 takes. */
export interface SupplyRow {
  readonly taxableValue: DecimalString
  readonly tax: TaxAmounts
}

/** Table 3.1 — outward supplies and inward supplies liable to reverse charge. */
export interface Gstr3bTable31 {
  /** (a) Outward taxable supplies, other than zero rated, nil rated and exempted. */
  readonly taxableOutward: SupplyRow
  /** (b) Outward taxable supplies, zero rated. Exports, both flavours. */
  readonly zeroRated: SupplyRow
  /** (c) Other outward supplies — nil rated and exempted. No tax by definition. */
  readonly nilRatedOrExempt: SupplyRow
  /** (d) Inward supplies liable to reverse charge. The tax here is payable in cash. */
  readonly inwardReverseCharge: SupplyRow
  /** (e) Non-GST outward supplies. Declared, never derived. */
  readonly nonGstOutward: SupplyRow
}

/** One row of table 3.2 — an inter-state supply to somebody who cannot claim credit. */
export interface InterStateSupplyRow {
  readonly placeOfSupplyCode: string | null
  readonly taxableValue: DecimalString
  readonly igst: DecimalString
}

/**
 * Table 3.2, of which only the first row is derivable.
 *
 * A composition dealer and a UIN holder both hold a registration, so nothing in the data
 * model distinguishes them from any other registered party — see the
 * `party-registration-type` gap. Both are returned empty rather than omitted, so a reader
 * can see that they were considered and found un-answerable.
 */
export interface Gstr3bTable32 {
  readonly toUnregistered: readonly InterStateSupplyRow[]
  readonly toCompositionDealers: readonly InterStateSupplyRow[]
  readonly toUinHolders: readonly InterStateSupplyRow[]
}

export interface Gstr3bItcAvailable {
  readonly importOfGoods: TaxAmounts
  readonly importOfServices: TaxAmounts
  readonly inwardReverseCharge: TaxAmounts
  readonly isd: TaxAmounts
  readonly allOther: TaxAmounts
  /** The sum of the five above, and nothing else. */
  readonly total: TaxAmounts
}

export interface Gstr3bItcReversed {
  readonly rule42And43: TaxAmounts
  readonly others: TaxAmounts
  readonly total: TaxAmounts
}

export interface Gstr3bTable4 {
  readonly available: Gstr3bItcAvailable
  readonly reversed: Gstr3bItcReversed
  /** (C) Net ITC: available less reversed. What the payment table may spend. */
  readonly net: TaxAmounts
  /** (D) Ineligible credit — reported, never availed. */
  readonly ineligible: {
    readonly section17_5: TaxAmounts
    readonly others: TaxAmounts
  }
}

/** Table 6.1 — what is owed, what credit covers it, and what has to be paid in money. */
export interface Gstr3bPayment {
  /** Output tax on forward-charge supplies, net of credit notes. */
  readonly outwardLiability: TaxAmounts
  /** Tax on inward reverse-charge supplies. Cash only — no credit is set against it. */
  readonly reverseChargeLiability: TaxAmounts
  /** Net ITC from table 4(C). */
  readonly creditAvailable: TaxAmounts
  /** How much of it was spent, by the head it was held in. */
  readonly creditUtilised: TaxAmounts
  /** What is left, by head. Carried to the next period. */
  readonly creditCarriedForward: TaxAmounts
  /** Exact, at 2dp: liability left after credit, plus the reverse-charge tax. */
  readonly cashPayable: TaxAmounts
  /** THE ONE ROUNDING POINT IN THIS FOLDER. Each head to the rupee, on its own. */
  readonly cashPayableRounded: TaxAmounts
  /** 5.1, rounded the same way. */
  readonly interestAndLateFeeRounded: TaxAmounts
  /**
   * The money that leaves the bank: the sum of the ROUNDED cells above, tax and interest
   * together. Never the rounded sum — a return whose parts do not add to its own total is
   * rejected.
   */
  readonly totalCashPayable: DecimalString
}

export interface Gstr3bReturn {
  readonly period: ReturnPeriod
  readonly packVersion: string
  readonly notice: string
  readonly table31: Gstr3bTable31
  readonly table32: Gstr3bTable32
  readonly table4: Gstr3bTable4
  readonly payment: Gstr3bPayment
  readonly issues: readonly ReturnIssue[]
}

// ---- Defaults --------------------------------------------------------------

const DEFAULT_REVERSE_CHARGE = false
const DEFAULT_ITC_ELIGIBILITY: ItcEligibility = 'eligible'

interface Signed {
  taxable: Decimal
  tax: TaxTotals
}

function zeroSigned(): Signed {
  return { taxable: ZERO, tax: zeroTotals() }
}

function addSigned(a: Signed, b: Signed): Signed {
  return { taxable: a.taxable.plus(b.taxable), tax: addTotals(a.tax, b.tax) }
}

function rowOf(signed: Signed): SupplyRow {
  return { taxableValue: toMoneyString(signed.taxable), tax: toTaxAmounts(signed.tax) }
}

function declaredTotals(amounts: TaxAmounts | undefined): TaxTotals {
  return amounts === undefined ? zeroTotals() : fromTaxAmounts(amounts)
}

// ---- Credit utilisation ----------------------------------------------------

export interface Utilisation {
  readonly utilised: TaxTotals
  readonly remainingLiability: TaxTotals
  readonly carriedForward: TaxTotals
}

/**
 * Set the available credit against the liability, head by head.
 *
 * THE PART THAT IS A RULE: IGST credit is spent first, on IGST and then on the other two;
 * CGST credit never touches an SGST liability and SGST credit never touches a CGST one.
 * THE PART THAT IS A CHOICE: which of CGST and SGST the IGST remainder goes to, which is
 * `preference` and not a constant. See the two decisions named for it.
 *
 * Exported so a test can drive it directly — the interesting cases are the ones where the
 * credit runs out partway, and reaching those through a whole return would take a fixture
 * per branch.
 */
export function utiliseCredit(
  liability: TaxTotals,
  credit: TaxTotals,
  preference: IgstCreditPreference = 'cgst-first',
): Utilisation {
  const owed: Record<TaxBucket, Decimal> = { ...liability }
  const held: Record<TaxBucket, Decimal> = { ...credit }

  /* `greaterThan(0)` and not `isPositive()`, which decimal.js answers TRUE for zero — and
   * more than tidiness is riding on it: a period whose credit notes outweigh its invoices
   * has a NEGATIVE liability, `min` then returns that negative, and subtracting it would
   * hand the taxpayer credit they never had. Nothing is spent on a liability that is not
   * there. */
  const spend = (from: TaxBucket, on: TaxBucket): void => {
    const used = min(held[from], owed[on])
    if (used.greaterThan(0)) {
      held[from] = held[from].minus(used)
      owed[on] = owed[on].minus(used)
    }
  }

  /* Section 49A: the integrated-tax credit is exhausted before any other is touched. */
  spend('igst', 'igst')
  const remainderOrder: TaxBucket[] =
    preference === 'cgst-first' ? ['cgst', 'sgst'] : ['sgst', 'cgst']
  for (const on of remainderOrder) {
    spend('igst', on)
  }

  /* Own head first, then IGST. Never each other — that prohibition is not a preference. */
  spend('cgst', 'cgst')
  spend('cgst', 'igst')
  spend('sgst', 'sgst')
  spend('sgst', 'igst')

  /* Cess stands alone: it may only be set against cess. */
  spend('cess', 'cess')

  const utilised: Record<TaxBucket, Decimal> = { ...zeroTotals() }
  for (const bucket of TAX_BUCKETS) {
    utilised[bucket] = credit[bucket].minus(held[bucket])
  }

  return { utilised, remainingLiability: owed, carriedForward: held }
}

// ---- The return ------------------------------------------------------------

/**
 * GSTR-3B for a period.
 *
 * Refuses an outward document that is not a sales-side document in the period, and an
 * inward one that is not a purchase-side document in the period.
 *
 * NUMBERS ARE CHECKED FOR REPEATS ON THE OUTWARD SIDE ONLY, and the asymmetry is real
 * rather than an oversight: an outward number comes out of this company's own series and
 * cannot repeat, while a purchase bill carries the VENDOR's number — two vendors both
 * numbering from 001 is an ordinary Tuesday.
 */
export function buildGstr3b(input: Gstr3bInput): Gstr3bReturn {
  const pack = input.pack ?? BUNDLED_COMPLIANCE_PACK
  const period = input.period
  assertPeriod(period)

  const declared = input.declared ?? {}
  const defaultReverseCharge = input.defaults?.isReverseCharge ?? DEFAULT_REVERSE_CHARGE
  const defaultEligibility = input.defaults?.itcEligibility ?? DEFAULT_ITC_ELIGIBILITY

  for (const document of input.outwardDocuments) {
    assertReturnable(document, period, 'sales')
  }
  for (const document of input.inwardDocuments) {
    assertReturnable(document, period, 'purchase')
  }
  assertNumbersDistinct(input.outwardDocuments)

  const outward = input.outwardDocuments.filter((document) => !document.isCancelled)
  const inward = input.inwardDocuments.filter((document) => !document.isCancelled)

  const issues: ReturnIssue[] = [
    issue('SCHEMA_UNVERIFIED', 'warning', PROVISIONAL_NOTICE, { section: 'GSTR-3B' }),
  ]

  // ---- Table 3.1 -----------------------------------------------------------

  let taxableOutward = zeroSigned()
  let zeroRated = zeroSigned()
  let nilRatedOrExempt = zeroSigned()
  /** Output tax the company itself owes: everything but reverse-charge supplies. */
  let forwardChargeTax = zeroTotals()

  for (const document of outward) {
    const sign = signOf(document.kind)
    const isExport = isExportSupply(document)
    const reverseCharge = document.isReverseCharge ?? defaultReverseCharge

    for (const line of document.lines) {
      const lineTax = totalsOfComponents(line.taxes)
      const signed: Signed = {
        taxable: D(line.taxableValue).times(sign),
        tax: sign === 1 ? lineTax : negateTotals(lineTax),
      }

      if (isExport) {
        zeroRated = addSigned(zeroRated, signed)
      } else if (D(line.ratePct).isZero()) {
        nilRatedOrExempt = addSigned(nilRatedOrExempt, signed)
      } else {
        taxableOutward = addSigned(taxableOutward, signed)
      }

      /* An outward supply under reverse charge is reported at its value and creates no
       * liability here — the recipient discharges it. See the decision of that name. */
      if (!reverseCharge) {
        forwardChargeTax = addTotals(forwardChargeTax, signed.tax)
      }
    }
  }

  // ---- Table 3.1(d): inward supplies liable to reverse charge --------------

  let inwardReverseCharge = zeroSigned()
  let reverseChargeCredit = zeroTotals()
  let otherCredit = zeroTotals()
  let ineligible175 = zeroTotals()
  let ineligibleOther = zeroTotals()

  for (const document of inward) {
    const sign = signOf(document.kind)
    const reverseCharge = document.isReverseCharge ?? defaultReverseCharge

    /*
     * 3.1(d) IS A DOCUMENT'S FIGURE AND TABLE 4 IS A LINE'S, which is the asymmetry
     * migration 0021 introduced and it is a real one. Whether the recipient discharges
     * the tax is a fact about the SUPPLY: the whole bill is under reverse charge or none
     * of it is. Whether credit may be taken is a fact about what was BOUGHT, and one bill
     * can carry a laptop and a staff car.
     */
    const documentTax = totalsOfComponents(document.lines.flatMap((line) => line.taxes))
    const documentTaxable = sum(document.lines.map((line) => D(line.taxableValue)))
    const signed: Signed = {
      taxable: documentTaxable.times(sign),
      tax: sign === 1 ? documentTax : negateTotals(documentTax),
    }

    if (reverseCharge) {
      inwardReverseCharge = addSigned(inwardReverseCharge, signed)
    }

    for (const line of document.lines) {
      const eligibility = line.itcEligibility ?? defaultEligibility
      const lineTax = totalsOfComponents(line.taxes)
      const signedTax = sign === 1 ? lineTax : negateTotals(lineTax)

      /* Ineligible credit is reported in 4(D) and never availed in 4(A). */
      if (eligibility === 'ineligible-17-5') {
        ineligible175 = addTotals(ineligible175, signedTax)
      } else if (eligibility === 'ineligible-other') {
        ineligibleOther = addTotals(ineligibleOther, signedTax)
      } else if (reverseCharge) {
        reverseChargeCredit = addTotals(reverseChargeCredit, signedTax)
      } else {
        otherCredit = addTotals(otherCredit, signedTax)
      }
    }
  }

  const nonGstValue = D(declared.nonGstOutwardValue ?? '0')

  const table31: Gstr3bTable31 = {
    taxableOutward: rowOf(taxableOutward),
    zeroRated: rowOf(zeroRated),
    nilRatedOrExempt: rowOf(nilRatedOrExempt),
    inwardReverseCharge: rowOf(inwardReverseCharge),
    nonGstOutward: { taxableValue: toMoneyString(nonGstValue), tax: zeroAmounts() },
  }

  // ---- Table 3.2 -----------------------------------------------------------

  const table32: Gstr3bTable32 = {
    toUnregistered: interStateToUnregistered(outward),
    toCompositionDealers: [],
    toUinHolders: [],
  }

  // ---- Table 4 -------------------------------------------------------------

  const importOfGoods = declaredTotals(declared.importOfGoodsCredit)
  const importOfServices = declaredTotals(declared.importOfServicesCredit)
  const isd = declaredTotals(declared.isdCredit)
  const availableTotal = sumTotals([
    importOfGoods,
    importOfServices,
    reverseChargeCredit,
    isd,
    otherCredit,
  ])

  const rule42And43 = declaredTotals(declared.reversalRule42And43)
  const reversalOther = declaredTotals(declared.reversalOther)
  const reversedTotal = addTotals(rule42And43, reversalOther)

  const netItc: TaxTotals = {
    igst: availableTotal.igst.minus(reversedTotal.igst),
    cgst: availableTotal.cgst.minus(reversedTotal.cgst),
    sgst: availableTotal.sgst.minus(reversedTotal.sgst),
    cess: availableTotal.cess.minus(reversedTotal.cess),
  }

  const table4: Gstr3bTable4 = {
    available: {
      importOfGoods: toTaxAmounts(importOfGoods),
      importOfServices: toTaxAmounts(importOfServices),
      inwardReverseCharge: toTaxAmounts(reverseChargeCredit),
      isd: toTaxAmounts(isd),
      allOther: toTaxAmounts(otherCredit),
      total: toTaxAmounts(availableTotal),
    },
    reversed: {
      rule42And43: toTaxAmounts(rule42And43),
      others: toTaxAmounts(reversalOther),
      total: toTaxAmounts(reversedTotal),
    },
    net: toTaxAmounts(netItc),
    ineligible: {
      section17_5: toTaxAmounts(ineligible175),
      others: toTaxAmounts(ineligibleOther),
    },
  }

  // ---- Payment -------------------------------------------------------------

  const utilisation = utiliseCredit(
    forwardChargeTax,
    netItc,
    input.igstCreditPreference ?? 'cgst-first',
  )

  /* Reverse-charge tax is added AFTER credit has been set against the forward-charge
   * liability, and never offered to it. See the decision of that name. */
  const cashPayable: TaxTotals = {
    igst: utilisation.remainingLiability.igst.plus(inwardReverseCharge.tax.igst),
    cgst: utilisation.remainingLiability.cgst.plus(inwardReverseCharge.tax.cgst),
    sgst: utilisation.remainingLiability.sgst.plus(inwardReverseCharge.tax.sgst),
    cess: utilisation.remainingLiability.cess.plus(inwardReverseCharge.tax.cess),
  }

  const cashPayableRounded = roundTotalsToRupees(cashPayable)
  const interest = declaredTotals(declared.interestAndLateFee)
  const interestRounded = roundTotalsToRupees(interest)

  const payment: Gstr3bPayment = {
    outwardLiability: toTaxAmounts(forwardChargeTax),
    reverseChargeLiability: toTaxAmounts(inwardReverseCharge.tax),
    creditAvailable: toTaxAmounts(netItc),
    creditUtilised: toTaxAmounts(utilisation.utilised),
    creditCarriedForward: toTaxAmounts(utilisation.carriedForward),
    cashPayable: toTaxAmounts(cashPayable),
    cashPayableRounded: toTaxAmounts(cashPayableRounded),
    interestAndLateFeeRounded: toTaxAmounts(interestRounded),
    /* The sum of the ROUNDED cells. Rounding the sum instead would give a challan that
     * disagrees with the cells printed above it by up to two rupees. */
    totalCashPayable: toMoneyString(
      grandTotalOf(cashPayableRounded).plus(grandTotalOf(interestRounded)),
    ),
  }

  // ---- What had to be assumed ---------------------------------------------

  issues.push(
    ...assumptionIssues({
      outward,
      inward,
      declared,
      nilRatedOrExemptValue: nilRatedOrExempt.taxable,
      reversedTotal,
    }),
  )

  return {
    period,
    packVersion: pack.packVersion,
    notice: PROVISIONAL_NOTICE,
    table31,
    table32,
    table4,
    payment,
    issues,
  }
}

/**
 * Table 3.2's first row: inter-state supplies to people who cannot claim the credit.
 *
 * Three conditions, and each excludes something on its own — unregistered excludes a B2B
 * supply, inter-state excludes a local counter sale, and not-an-export excludes a
 * shipment, which is zero-rated and belongs in 3.1(b) rather than here.
 */
function interStateToUnregistered(documents: readonly ReturnDocument[]): InterStateSupplyRow[] {
  const rows = new Map<string, { place: string | null; taxable: Decimal; igst: Decimal }>()

  for (const document of documents) {
    if (isRegisteredCounterparty(document) || isExportSupply(document)) {
      continue
    }
    if (!isInterStateSupply(document)) {
      continue
    }
    const sign = signOf(document.kind)
    const place = document.placeOfSupply.jurisdictionCode
    const key = place ?? ''
    const taxable = sum(document.lines.map((line) => D(line.taxableValue))).times(sign)
    const tax = totalsOfComponents(document.lines.flatMap((line) => line.taxes))
    const igst = tax.igst.times(sign)

    const existing = rows.get(key)
    if (existing === undefined) {
      rows.set(key, { place, taxable, igst })
    } else {
      existing.taxable = existing.taxable.plus(taxable)
      existing.igst = existing.igst.plus(igst)
    }
  }

  return [...rows.values()]
    .sort((a, b) => comparePlaces(a.place, b.place))
    .map((row) => ({
      placeOfSupplyCode: row.place,
      taxableValue: toMoneyString(row.taxable),
      igst: toMoneyString(row.igst),
    }))
}

/** Place-of-supply order, with an unknown place last so it is where somebody sees it. */
function comparePlaces(a: string | null, b: string | null): number {
  if (a === b) {
    return 0
  }
  if (a === null) {
    return 1
  }
  if (b === null) {
    return -1
  }
  return a < b ? -1 : 1
}

/** Every figure that rested on a default, counted and named. */
function assumptionIssues(context: {
  outward: readonly ReturnDocument[]
  inward: readonly ReturnDocument[]
  declared: Gstr3bDeclared
  nilRatedOrExemptValue: Decimal
  reversedTotal: TaxTotals
}): ReturnIssue[] {
  const issues: ReturnIssue[] = []
  const all = [...context.outward, ...context.inward]

  const unrecordedReverseCharge = all.filter((document) => document.isReverseCharge === null).length
  if (unrecordedReverseCharge > 0) {
    issues.push(
      issue(
        'REVERSE_CHARGE_NOT_RECORDED',
        'warning',
        `${String(unrecordedReverseCharge)} document(s) do not record whether the supply is ` +
          'under reverse charge, so they are treated as forward charge. The data model has ' +
          'no column for it.',
        { section: '3.1', value: String(unrecordedReverseCharge) },
      ),
    )
  }

  /*
   * COUNTED PER LINE, because that is where the column is (0021) and where the answer can
   * differ. A bill whose laptop line says `eligible` and whose car line says nothing is a
   * bill with one unrecorded line, and counting the document instead would report it the
   * same way as a bill that records nothing at all.
   */
  const unrecordedEligibility = context.inward
    .flatMap((document) => document.lines)
    .filter((line) => line.itcEligibility === null).length
  if (unrecordedEligibility > 0) {
    issues.push(
      issue(
        'ITC_ELIGIBILITY_NOT_RECORDED',
        'warning',
        `${String(unrecordedEligibility)} inward line(s) do not record whether credit may ` +
          'be taken, so the credit on them is claimed in full.',
        { section: '4(A)', value: String(unrecordedEligibility) },
      ),
    )
  }

  const undeclared = (
    [
      ['3.1(e) non-GST outward supplies', context.declared.nonGstOutwardValue],
      ['4(A)(1) import of goods', context.declared.importOfGoodsCredit],
      ['4(A)(2) import of services', context.declared.importOfServicesCredit],
      ['4(A)(4) ISD credit', context.declared.isdCredit],
      ['4(B)(1) rule 42 and 43 reversal', context.declared.reversalRule42And43],
      ['4(B)(2) other reversal', context.declared.reversalOther],
      ['5.1 interest and late fee', context.declared.interestAndLateFee],
    ] as const
  )
    .filter(([, value]) => value === undefined)
    .map(([label]) => label)

  if (undeclared.length > 0) {
    issues.push(
      issue(
        'FIGURE_NOT_DERIVABLE',
        'warning',
        `Taken as nil because nothing in the data model can answer them: ${undeclared.join(
          '; ',
        )}. A nil here is a claim that there was nothing, not a note that nobody looked.`,
        { section: 'GSTR-3B', value: undeclared.join('; ') },
      ),
    )
  }

  if (context.nilRatedOrExemptValue.greaterThan(0) && isZeroTotals(context.reversedTotal)) {
    issues.push(
      issue(
        'EXEMPT_SUPPLIES_WITHOUT_REVERSAL',
        'error',
        'This period has nil-rated or exempt outward supplies and declares no rule 42 or 43 ' +
          'reversal. Where inputs are used partly for exempt supplies, part of the credit ' +
          'has to be reversed — confirm the figure before filing.',
        { section: '4(B)(1)' },
      ),
    )
  }

  return issues
}
