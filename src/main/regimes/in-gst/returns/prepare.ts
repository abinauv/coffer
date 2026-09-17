/*
 * India's returns, as the regime-neutral capability `TaxRegime.returns`.
 *
 * The builders in this folder take `ReturnDocument` and produce GSTR-1 and GSTR-3B in
 * their own shapes. Nothing outside `regimes/in-gst/` may name either (CONVENTIONS §1.6),
 * so this file is the translation both ways: books-shaped documents in, rows with their
 * own words out. A screen that draws the result knows a table has a label, a sentence, a
 * count, a value and a tax — and never which country's tables they are.
 *
 * ── WHAT THE MAPPING LEAVES NULL, AND WHY THAT IS NOT A GUESS ─────────────────────────
 *
 * Three fields on `ReturnDocument` have no column anywhere: the unit's UQC, the shipping
 * bill, and the supply treatment. Each is listed in `RETURN_MODEL_GAPS` with what the
 * builders do meanwhile, and each raises its own issue when it matters. They are passed
 * as null here — "the books do not say" — which is exactly what the builders were written
 * to receive. Inventing a UQC from a unit's name would be a figure nobody checked.
 *
 * ── WHAT IS NOT PREPARED ──────────────────────────────────────────────────────────────
 *
 * The documents-issued table (GSTR-1 table 13) needs the number ranges each series handed
 * out, which are a fact about the series and not about any document. Nothing reads them
 * yet, so the table is empty in the artefact and the summary does not draw a row for it.
 */

import { D, ZERO, toMoneyString } from '@main/domain/money'
import type { Decimal } from '@main/domain/money'
import { definitionOf } from '@shared/documents'
import type {
  PreparedReturn,
  PreparedReturnIssue,
  PreparedReturnRow,
  RegimeReturns,
  ReturnFormDefinition,
  ReturnSourceDocument,
  ReturnSourcePeriod,
} from '@main/regimes/types'
import { fromTaxAmounts, grandTotalOf, type TaxAmounts } from './amounts'
import { ReturnError, type ReturnIssue } from './errors'
import { buildGstr1, type Gstr1Return } from './gstr1'
import { buildGstr3b, type Gstr3bReturn } from './gstr3b'
import type { ReturnDocument } from './types'

/** The forms this regime prepares. GSTR-2B is declared in `filings` and drafted by the portal. */
export const INDIA_RETURN_FORMS: readonly ReturnFormDefinition[] = [
  {
    id: 'gstr-1',
    label: 'GSTR-1',
    description: 'Outward supplies: every sales invoice and credit note issued in the period.',
  },
  {
    id: 'gstr-3b',
    label: 'GSTR-3B',
    description: 'The summary return: output tax, input tax credit, and the cash payable.',
  },
]

export const indiaReturns: RegimeReturns = {
  forms: INDIA_RETURN_FORMS,
  prepare(formId, input) {
    const form = INDIA_RETURN_FORMS.find((candidate) => candidate.id === formId)
    if (form === undefined) {
      throw new ReturnError(
        'RETURN_FORM_UNKNOWN',
        `There is no return called '${formId}' under these tax rules.`,
      )
    }
    const documents = input.documents.map(toReturnDocument)
    return form.id === 'gstr-1'
      ? fromGstr1(form, input.period, buildGstr1({ period: periodOf(input.period), documents }))
      : fromGstr3b(
          form,
          input.period,
          buildGstr3b({
            period: periodOf(input.period),
            outwardDocuments: documents.filter((document) => sideOf(document) === 'sales'),
            inwardDocuments: documents.filter((document) => sideOf(document) === 'purchase'),
          }),
        )
  },
}

// ---- In ----------------------------------------------------------------------

function periodOf(period: ReturnSourcePeriod): { from: string; to: string; label: string } {
  return { from: period.from, to: period.to, label: period.label }
}

function sideOf(document: ReturnDocument): 'sales' | 'purchase' {
  return definitionOf(document.kind).side
}

/**
 * A books-shaped document as the builders read one.
 *
 * Everything that exists is carried as it is; the three gap fields are null. Nothing is
 * recomputed — see the header of `types.ts` on why that is the rule.
 */
export function toReturnDocument(source: ReturnSourceDocument): ReturnDocument {
  return {
    id: source.id,
    kind: source.kind,
    number: source.number,
    date: source.date,
    isCancelled: source.isCancelled,
    counterparty: { ...source.counterparty },
    placeOfSupply: { ...source.placeOfSupply },
    corrects: source.corrects === null ? null : { ...source.corrects },
    exportDetail: source.placeOfSupply.isExport
      ? {
          taxPayment: source.exportTaxPayment,
          shippingBillNumber: null,
          shippingBillDate: null,
          portCode: null,
        }
      : null,
    roundOff: source.roundOff,
    isReverseCharge: source.isReverseCharge,
    supplyTreatment: null,
    lines: source.lines.map((line) => ({
      lineNumber: line.lineNumber,
      classificationCode: line.classificationCode,
      quantity: line.quantity,
      unitCode: line.unitCode,
      uqc: null,
      taxableValue: line.taxableValue,
      ratePct: line.ratePct,
      isCharge: line.isCharge,
      itcEligibility: line.itcEligibility,
      taxes: line.taxes.map((tax) => ({ ...tax })),
    })),
  }
}

// ---- Out ---------------------------------------------------------------------

/** Every column on a row, added. The one sum a summary needs and a screen may not do. */
function taxOf(amounts: TaxAmounts): string {
  return toMoneyString(grandTotalOf(fromTaxAmounts(amounts)))
}

function sumOf(...values: readonly (TaxAmounts | undefined)[]): string {
  let total: Decimal = ZERO
  for (const value of values) {
    if (value !== undefined) total = total.plus(grandTotalOf(fromTaxAmounts(value)))
  }
  return toMoneyString(total)
}

/**
 * The issues a person reads, without the one that says the return is provisional.
 *
 * That one is carried by `isProvisional` and `notice` instead, which a screen draws as a
 * badge and a notice of their own. Listing it again among the fixable problems would put
 * "the schema has not been checked" beside "this invoice has no HSN code", as though the
 * user could do something about it.
 */
function issuesOf(issues: readonly ReturnIssue[]): PreparedReturnIssue[] {
  return issues
    .filter((issue) => issue.code !== 'SCHEMA_UNVERIFIED')
    .map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      documentNumber: issue.documentNumber ?? null,
    }))
}

function isProvisional(issues: readonly ReturnIssue[]): boolean {
  return issues.some((issue) => issue.code === 'SCHEMA_UNVERIFIED')
}

function fromGstr1(
  form: ReturnFormDefinition,
  period: ReturnSourcePeriod,
  built: Gstr1Return,
): PreparedReturn {
  const rows: PreparedReturnRow[] = [
    {
      id: 'b2b',
      label: 'B2B',
      what: 'Invoices to registered customers',
      documentCount: built.b2b.invoiceCount,
      taxableValue: built.b2b.taxableValue,
      tax: taxOf(built.b2b.tax),
    },
    {
      id: 'b2cl',
      label: 'B2CL',
      what: 'Large inter-state invoices to unregistered customers',
      documentCount: built.b2cl.invoiceCount,
      taxableValue: built.b2cl.taxableValue,
      tax: taxOf(built.b2cl.tax),
    },
    {
      id: 'b2cs',
      label: 'B2CS',
      what: 'Other supplies to unregistered customers, by state and rate',
      documentCount: built.b2cs.documentCount,
      taxableValue: built.b2cs.taxableValue,
      tax: taxOf(built.b2cs.tax),
    },
    {
      id: 'cdnr',
      label: 'CDNR',
      what: 'Credit notes to registered customers',
      documentCount: built.cdnr.noteCount,
      taxableValue: built.cdnr.taxableValue,
      tax: taxOf(built.cdnr.tax),
    },
    {
      id: 'cdnur',
      label: 'CDNUR',
      what: 'Credit notes to unregistered customers and on exports',
      documentCount: built.cdnur.noteCount,
      taxableValue: built.cdnur.taxableValue,
      tax: taxOf(built.cdnur.tax),
    },
    {
      id: 'exp',
      label: 'EXP',
      what: 'Exports, with and without payment of tax',
      documentCount: built.exp.invoiceCount,
      taxableValue: built.exp.taxableValue,
      tax: taxOf(built.exp.tax),
    },
  ]

  return {
    form,
    period,
    packVersion: built.packVersion,
    isProvisional: isProvisional(built.issues),
    notice: built.notice,
    rows,
    /* As reported: every figure positive, the way each document was raised. The net of
     * credit notes is in the artefact and in the HSN summary, not in this line. */
    total: {
      id: 'reported',
      label: 'Total',
      what: 'Everything reported, as each document was raised',
      documentCount: built.reported.documentCount,
      taxableValue: built.reported.taxableValue,
      tax: taxOf(built.reported.tax),
    },
    issues: issuesOf(built.issues),
    artefact: built,
  }
}

function fromGstr3b(
  form: ReturnFormDefinition,
  period: ReturnSourcePeriod,
  built: Gstr3bReturn,
): PreparedReturn {
  const { table31, table4, payment } = built
  const rows: PreparedReturnRow[] = [
    {
      id: '3.1a',
      label: '3.1(a)',
      what: 'Outward taxable supplies',
      documentCount: null,
      taxableValue: table31.taxableOutward.taxableValue,
      tax: taxOf(table31.taxableOutward.tax),
    },
    {
      id: '3.1b',
      label: '3.1(b)',
      what: 'Zero-rated supplies: exports',
      documentCount: null,
      taxableValue: table31.zeroRated.taxableValue,
      tax: taxOf(table31.zeroRated.tax),
    },
    {
      id: '3.1c',
      label: '3.1(c)',
      what: 'Nil-rated and exempt supplies',
      documentCount: null,
      taxableValue: table31.nilRatedOrExempt.taxableValue,
      tax: taxOf(table31.nilRatedOrExempt.tax),
    },
    {
      id: '3.1d',
      label: '3.1(d)',
      what: 'Inward supplies on reverse charge',
      documentCount: null,
      taxableValue: table31.inwardReverseCharge.taxableValue,
      tax: taxOf(table31.inwardReverseCharge.tax),
    },
    {
      id: '3.1e',
      label: '3.1(e)',
      what: 'Outward supplies outside the tax altogether',
      documentCount: null,
      taxableValue: table31.nonGstOutward.taxableValue,
      tax: taxOf(table31.nonGstOutward.tax),
    },
    {
      id: '4a',
      label: '4(A)',
      what: 'Input tax credit available',
      documentCount: null,
      taxableValue: null,
      tax: taxOf(table4.available.total),
    },
    {
      id: '4b',
      label: '4(B)',
      what: 'Input tax credit reversed',
      documentCount: null,
      taxableValue: null,
      tax: taxOf(table4.reversed.total),
    },
    {
      id: '4c',
      label: '4(C)',
      what: 'Net input tax credit',
      documentCount: null,
      taxableValue: null,
      tax: taxOf(table4.net),
    },
    {
      id: '4d',
      label: '4(D)',
      what: 'Ineligible credit, reported and never claimed',
      documentCount: null,
      taxableValue: null,
      tax: sumOf(table4.ineligible.section17_5, table4.ineligible.others),
    },
    {
      id: '6.1-credit',
      label: '6.1',
      what: 'Tax paid through credit',
      documentCount: null,
      taxableValue: null,
      tax: taxOf(payment.creditUtilised),
    },
  ]

  return {
    form,
    period,
    packVersion: built.packVersion,
    isProvisional: isProvisional(built.issues),
    notice: built.notice,
    rows,
    /* What leaves the bank: the sum of the ROUNDED cells, never the rounded sum. The
     * builder already made that distinction and this only carries its answer. */
    total: {
      id: 'cash-payable',
      label: 'Cash payable',
      what: 'Tax, interest and late fee to be paid in money, to the rupee',
      documentCount: null,
      taxableValue: null,
      tax: D(payment.totalCashPayable).toFixed(2),
    },
    issues: issuesOf(built.issues),
    artefact: built,
  }
}
