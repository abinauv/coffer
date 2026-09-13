/*
 * The two lists that say what is not settled here, and the pack value that should not be
 * in a binary at all.
 *
 * WHY A LIST OF DECISIONS NEEDS A TEST. A comment saying "we chose X" costs nothing and
 * decays silently; the point of `RETURN_DECISIONS` is that each entry is PINNED by a test
 * asserting the behaviour, so changing the behaviour goes red and the entry has to be
 * revisited. `PINNED_BY` below is the join between the two, and asserting that its keys
 * are exactly the decision ids is what stops somebody adding a decision with nothing
 * behind it.
 *
 * It is a hand-maintained map and not a scan of the test files, deliberately: a scan
 * would pass on a decision id that merely APPEARED in a comment somewhere, which is the
 * absence-of-a-string failure this project has already been bitten by.
 */

import { describe, expect, it } from 'vitest'
import { BUNDLED_COMPLIANCE_PACK } from '../compliance-pack'
import { PROVISIONAL_NOTICE, RETURN_DECISIONS, RETURN_MODEL_GAPS } from './provisional'
import { blockingCount, isReturnError, issue, ReturnError } from './errors'
import { resolveExport } from './gstr1'
import { buildGstr3b } from './gstr3b'
import { doc, EXPORT_AE, igst, INTRA_TN, line, NOVEMBER_2027, pair } from './__fixtures__/builders'

/** Decision id -> the test that pins the behaviour it describes. */
const PINNED_BY: Readonly<Record<string, string>> = {
  'b2cl-threshold-is-strictly-greater':
    'classify.test.ts — "BELOW THE THRESHOLD alone excludes it" and "one paisa over"',
  'b2cl-invoice-value-includes-tax':
    'classify.test.ts — "invoice value is taxable plus tax PLUS the round-off"',
  'utgst-files-in-the-state-tax-column':
    'amounts.test.ts — "files UTGST where SGST goes"; hsn.test.ts — "files UTGST where SGST goes"',
  'exports-infer-payment-from-tax-charged':
    'gstr1.test.ts — the four "exports, and the flavour the data model does not record" cases',
  'unregistered-notes-all-go-to-cdnur':
    'classify.test.ts — "a note to an unregistered party is CDNUR whatever its value"',
  'hsn-summary-nets-corrections':
    'hsn.test.ts — "corrections enter the summary negative"; gstr1.test.ts — "the NET total equals the HSN summary"',
  'cancelled-documents-appear-only-in-doc-issue':
    'gstr1.test.ts — "a cancelled document" reaches no value section but is counted in table 13',
  'outward-reverse-charge-carries-no-liability':
    'gstr3b.test.ts — "reports an OUTWARD reverse-charge supply at value and charges no tax on it"',
  'rcm-credit-is-claimed-in-the-same-period':
    'gstr3b.test.ts — "puts an inward reverse-charge supply in 3.1(d) and its credit in 4(A)(3)"',
  'igst-credit-is-spent-before-any-other':
    'gstr3b.test.ts — "spends IGST credit on the IGST liability first" and the two never-cross cases',
  'igst-remainder-goes-to-cgst-before-sgst':
    'gstr3b.test.ts — "spends the IGST remainder on CGST before SGST" and the sgst-first case',
  'reverse-charge-tax-is-always-paid-in-cash':
    'gstr3b.test.ts — "pays that tax in CASH, refusing to set the credit it just created against it"',
  'gstr1-rounds-nowhere':
    'gstr1.test.ts — every section equals the sum of its rows at 2dp; amounts.test.ts — "does not round anything a section row carries"',
  'gstr3b-rounds-only-the-cash-payable':
    'gstr3b.test.ts — "the total is the sum of the ROUNDED heads, which is not the rounded sum"',
}

describe('RETURN_DECISIONS', () => {
  it('every decision is pinned by a test, and every pin names a decision', () => {
    expect(RETURN_DECISIONS.map((each) => each.id).sort()).toEqual(Object.keys(PINNED_BY).sort())
  })

  it('every decision says what was decided, why, what else it could have been, and what would settle it', () => {
    for (const decision of RETURN_DECISIONS) {
      expect(decision.decided.length, decision.id).toBeGreaterThan(20)
      expect(decision.because.length, decision.id).toBeGreaterThan(20)
      expect(decision.alternative.length, decision.id).toBeGreaterThan(20)
      expect(decision.settledBy.length, decision.id).toBeGreaterThan(10)
    }
  })

  it('has no duplicate ids', () => {
    const ids = RETURN_DECISIONS.map((each) => each.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('RETURN_MODEL_GAPS', () => {
  it('names, for every gap, where the column belongs and what happens meanwhile', () => {
    for (const gap of RETURN_MODEL_GAPS) {
      expect(gap.wants.length, gap.id).toBeGreaterThan(10)
      expect(gap.neededFor.length, gap.id).toBeGreaterThan(0)
      expect(gap.interim.length, gap.id).toBeGreaterThan(20)
      /* "Nothing" is not an interim answer. Every gap has a stated behaviour. */
      expect(gap.interim.toLowerCase(), gap.id).not.toBe('nothing')
    }
  })

  it('has no duplicate ids', () => {
    const ids = RETURN_MODEL_GAPS.map((each) => each.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('lists the gaps a caller wiring these functions up has to fill', () => {
    expect(RETURN_MODEL_GAPS.map((each) => each.id)).toEqual([
      /* `export-tax-payment`, `reverse-charge` and `itc-eligibility` were the first three
       * and are gone: migrations 0020 and 0021 gave each of them a column, `computeTax`
       * honours the first, the posting rule posts the second twice and costs the third
       * into the expense where credit is blocked. Deleted rather than marked done, for
       * the reason the note below gives. */
      'itc-reversals',
      'uqc',
      'supply-treatment',
      'import-and-isd-credit',
      'non-gst-supplies',
      'outward-debit-note',
      'party-registration-type',
      'shipping-bill',
      /* `b2cl-threshold-in-the-compliance-pack` was here and is gone: the threshold sits
       * on `IndiaCompliancePack.returns` now, which is what the gap asked for. A gap that
       * has been filled is deleted rather than marked done — a list of things still owed
       * that carries things already delivered stops being read. */
      'document-issue-ranges',
    ])
  })

  it('says the UQC column already exists and is simply never populated', () => {
    const uqc = RETURN_MODEL_GAPS.find((each) => each.id === 'uqc')
    expect(uqc?.wants).toContain('units_of_measure.regime_code')
    expect(uqc?.interim).toContain('this is the thing that reads it')
  })

  /*
   * THE ABSENCE OF THE OLD NAME IS NOT THE PRESENCE OF THE NEW ONE (CONVENTIONS §6), so
   * the three deleted gaps get an assertion that the thing which replaced them is really
   * there — not merely that the ids have gone. Each of these reads the shape the return
   * now takes, so deleting the column, the line field or the honouring of the flag makes
   * one of them fail rather than leaving a list that is quietly wrong.
   */
  it('has really filled the three it deleted, not merely stopped listing them', () => {
    const ids = new Set(RETURN_MODEL_GAPS.map((each) => each.id))
    expect(ids.has('export-tax-payment')).toBe(false)
    expect(ids.has('reverse-charge')).toBe(false)
    expect(ids.has('itc-eligibility')).toBe(false)

    /* An export that states its flavour is taken at its word rather than inferred. */
    const stated = resolveExport(
      doc({
        placeOfSupply: EXPORT_AE,
        exportDetail: {
          taxPayment: 'without-payment',
          shippingBillNumber: 'SB-1',
          shippingBillDate: '2027-11-12',
          portCode: 'INMAA1',
        },
        lines: [line({ ratePct: '18', taxes: igst('0.00') })],
      }),
    )
    expect(stated.taxPayment).toBe('without-payment')
    expect(stated.issues.map((each) => each.code)).toEqual([])

    /* Credit eligibility is a fact about a LINE, so one bill can say both things. */
    const mixed = buildGstr3b({
      period: NOVEMBER_2027,
      outwardDocuments: [],
      inwardDocuments: [
        doc({
          kind: 'purchase-bill',
          number: 'BILL-MIXED',
          placeOfSupply: INTRA_TN,
          isReverseCharge: false,
          lines: [
            line({ taxableValue: '1000.00', taxes: pair('90.00'), itcEligibility: 'eligible' }),
            line({
              lineNumber: 2,
              taxableValue: '2000.00',
              taxes: pair('180.00'),
              itcEligibility: 'ineligible-17-5',
            }),
          ],
        }),
      ],
    })
    expect(mixed.table4.available.allOther.cgst).toBe('90.00')
    expect(mixed.table4.ineligible.section17_5.cgst).toBe('180.00')
  })
})

describe('the notice every artefact carries', () => {
  it('says the figures are right and the shape is not confirmed', () => {
    expect(PROVISIONAL_NOTICE).toContain('correct to the paisa')
    expect(PROVISIONAL_NOTICE).toContain('has not been checked against the portal')
    expect(PROVISIONAL_NOTICE).toContain('check it before you upload it')
  })
})

/*
 * THE RETURN FIGURES ARE PART OF THE COMPLIANCE PACK NOW, where the gap list said they
 * belonged. They lived in a `ReturnsPack` of their own for one batch, echoing this pack's
 * version so that "which rules am I running?" could not have two answers; there is one
 * pack, so there is one version, and the echo has become an identity.
 */
describe('the return figures the pack carries', () => {
  it('needs no version of its own, because it is not a second pack', () => {
    expect(Object.keys(BUNDLED_COMPLIANCE_PACK.returns).sort()).toEqual([
      'b2clInvoiceValueThreshold',
      'note',
    ])
  })

  it('carries the B2CL threshold as a decimal string, at money scale', () => {
    expect(BUNDLED_COMPLIANCE_PACK.returns.b2clInvoiceValueThreshold).toBe('100000.00')
  })

  it('names the earlier figure, because a return for an earlier period needs it', () => {
    expect(BUNDLED_COMPLIANCE_PACK.returns.note).toContain('2,50,000')
  })
})

describe('issues and refusals', () => {
  it('an issue carries what it is about', () => {
    const raised = issue('UQC_NOT_MAPPED', 'error', 'no UQC', {
      documentNumber: 'INV-1',
      section: 'HSN',
      value: 'BAGS',
    })
    expect(raised).toEqual({
      code: 'UQC_NOT_MAPPED',
      severity: 'error',
      message: 'no UQC',
      documentNumber: 'INV-1',
      section: 'HSN',
      value: 'BAGS',
    })
  })

  it('counts only the issues that would stop a filing', () => {
    expect(
      blockingCount([
        issue('SCHEMA_UNVERIFIED', 'warning', 'a'),
        issue('UQC_NOT_MAPPED', 'error', 'b'),
        issue('EXPORT_SHIPPING_BILL_MISSING', 'error', 'c'),
      ]),
    ).toBe(2)
    expect(blockingCount([])).toBe(0)
  })

  it('a ReturnError is recognisable and carries its code', () => {
    const error = new ReturnError('RETURN_PERIOD_INVALID', 'nope')
    expect(isReturnError(error)).toBe(true)
    expect(error.name).toBe('ReturnError')
    expect(error.code).toBe('RETURN_PERIOD_INVALID')
    expect(isReturnError(new Error('nope'))).toBe(false)
    expect(isReturnError(null)).toBe(false)
  })
})
