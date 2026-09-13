/*
 * The HSN summary: what was supplied in the period, by classification code rather than
 * by document.
 *
 * ── THE KEY IS THREE THINGS, AND ALL THREE ARE NEEDED ──────────────────────────────
 *
 * Code, UQC, and rate. Not the code alone: the same HSN can be sold at two rates (a
 * concessional supply beside a standard one) and in two units, and a row that collapsed
 * either would report a quantity nobody can reconcile against the stock register and a
 * rate nobody can multiply back.
 *
 * ── UQC, WHICH IS THE GAP THIS SECTION EXISTS TO SURFACE ───────────────────────────
 *
 * `units_of_measure.regime_code` has existed since migration 0006 for exactly this and
 * has never been written to. 0006's own comment says "nothing in Phase 2 reads it" — this
 * is the thing that reads it. Three cases, and they are genuinely different:
 *
 *   a unit with a regime code       files under it. 'BAGS' -> 'BAG'.
 *   a line with NO unit at all      is a service or a lump-sum charge. It files as 'NA',
 *                                   which is the portal's own value for one, and raises
 *                                   nothing — there is no mapping missing.
 *   a unit with no regime code      is the gap. The row is produced with a null UQC and
 *                                   an issue at severity ERROR, because the portal will
 *                                   not take the row without one.
 *
 * The middle case is why this is not one null check. Reporting a service's missing UQC as
 * an unmapped unit would put an error on every consultancy invoice ever raised, and an
 * error that fires on everything is one people learn to click past.
 *
 * ── WHAT THIS SECTION DELIBERATELY DOES NOT CARRY ──────────────────────────────────
 *
 * A description. The return has a column for one and there is no honest value to put in
 * it: an HSN row gathers many lines, so a description would be whichever line was met
 * first — table order wearing the costume of a rule, which is the failure `correctionMap`
 * was rewritten to avoid. Whatever renders this can look the description up from the
 * classification list, where it is a fact about the code rather than about a line.
 *
 * ── SIGNS ──────────────────────────────────────────────────────────────────────────
 *
 * A credit note enters NEGATIVE, so a period's HSN total is the net supply. A returned
 * consignment was not supplied. The value sections do the opposite and carry every figure
 * positive, because they report documents rather than supply — see the
 * `hsn-summary-nets-corrections` decision, which names both halves.
 */

import { D, sum, toMoneyString, toQuantityString, ZERO, type Decimal } from '@main/domain/money'
import type { DecimalString } from '@shared/scalars'
import {
  addTotals,
  sumTotals,
  toTaxAmounts,
  totalsOfComponents,
  zeroTotals,
  negateTotals,
  type TaxAmounts,
  type TaxTotals,
} from './amounts'
import { signOf } from './classify'
import { issue, type ReturnIssue } from './errors'
import type { ReturnDocument, ReturnLine } from './types'

/** The UQC a line with no unit files under. The portal's own value for "not applicable". */
export const UQC_NOT_APPLICABLE = 'NA'

/** One row of the HSN summary. */
export interface HsnRow {
  /** HSN or SAC. Null when the line carried none — reported, never dropped. */
  readonly classificationCode: string | null
  /** The unit as the portal knows it. Null when the unit has no mapping — see the header. */
  readonly uqc: string | null
  /** The full rate, 3dp. */
  readonly ratePct: DecimalString
  /** Quantity, 3dp. Net of returns. */
  readonly quantity: DecimalString
  /** Money, 2dp. Net of returns. */
  readonly taxableValue: DecimalString
  readonly tax: TaxAmounts
}

/** The HSN summary, and what was doubtful about building it. */
export interface HsnSummary {
  readonly rows: readonly HsnRow[]
  /** The sum of the rows above, and nothing else. Never re-derived from the documents. */
  readonly taxableValue: DecimalString
  readonly tax: TaxAmounts
  readonly issues: readonly ReturnIssue[]
}

interface Bucket {
  classificationCode: string | null
  uqc: string | null
  ratePct: string
  quantity: Decimal
  taxableValue: Decimal
  tax: TaxTotals
}

/**
 * The UQC for one line, and the issue it raises where there is one.
 *
 * Split out because the three-case rule in the header is the whole of what makes this
 * section hard, and a test that can call it directly can pin each case on its own.
 */
export function uqcOf(
  document: ReturnDocument,
  line: ReturnLine,
): { uqc: string | null; issue: ReturnIssue | null } {
  const mapped = line.uqc?.trim()
  if (mapped !== undefined && mapped !== '') {
    return { uqc: mapped.toUpperCase(), issue: null }
  }

  const unit = line.unitCode?.trim()
  if (unit === undefined || unit === '') {
    /* No unit at all — a service, or a lump-sum charge. Nothing is missing. */
    return { uqc: UQC_NOT_APPLICABLE, issue: null }
  }

  return {
    uqc: null,
    issue: issue(
      'UQC_NOT_MAPPED',
      'error',
      `The unit '${unit}' has no UQC, so the HSN row for it cannot be filed. Set the ` +
        "unit's regime code — the portal takes a fixed list, and 'BAGS' files as 'BAG'.",
      {
        documentId: document.id,
        documentNumber: document.number,
        section: 'HSN',
        value: unit,
      },
    ),
  }
}

/**
 * The HSN summary for a period's documents.
 *
 * Takes documents that have already been checked by `assertReturnable` — this function
 * refuses nothing and only reports.
 */
export function buildHsnSummary(documents: readonly ReturnDocument[]): HsnSummary {
  const buckets = new Map<string, Bucket>()
  const issues: ReturnIssue[] = []
  const unmappedUnits = new Set<string>()
  const missingCodes = new Set<string>()

  for (const document of documents) {
    if (document.isCancelled) {
      continue
    }
    const sign = signOf(document.kind)

    for (const line of document.lines) {
      const resolved = uqcOf(document, line)
      if (resolved.issue !== null && !unmappedUnits.has(resolved.issue.value ?? '')) {
        unmappedUnits.add(resolved.issue.value ?? '')
        issues.push(resolved.issue)
      }

      const code = line.classificationCode?.trim()
      const classificationCode = code === undefined || code === '' ? null : code.toUpperCase()
      if (classificationCode === null && !missingCodes.has(document.id)) {
        missingCodes.add(document.id)
        issues.push(
          issue(
            'CLASSIFICATION_CODE_MISSING',
            'error',
            `${document.number} has a line with no HSN or SAC. Its value is in the summary ` +
              'under a blank code, which the portal will reject.',
            { documentId: document.id, documentNumber: document.number, section: 'HSN' },
          ),
        )
      }

      /* The rate is keyed by its own decimal form so that '18' and '18.000' are one row:
       * two documents can carry the same rate written differently and a string key would
       * split them, which is the trap `taxSummaryOf` in domain/documents names. */
      const ratePct = D(line.ratePct).toString()
      const key = [classificationCode ?? '', resolved.uqc ?? '', ratePct].join('|')

      const lineTax = totalsOfComponents(line.taxes)
      const signedTax = sign === 1 ? lineTax : negateTotals(lineTax)
      const signedQuantity = D(line.quantity).times(sign)
      const signedTaxable = D(line.taxableValue).times(sign)

      const existing = buckets.get(key)
      if (existing === undefined) {
        buckets.set(key, {
          classificationCode,
          uqc: resolved.uqc,
          ratePct,
          quantity: signedQuantity,
          taxableValue: signedTaxable,
          tax: signedTax,
        })
      } else {
        existing.quantity = existing.quantity.plus(signedQuantity)
        existing.taxableValue = existing.taxableValue.plus(signedTaxable)
        existing.tax = addTotals(existing.tax, signedTax)
      }
    }
  }

  const rows = [...buckets.values()].sort(compareBuckets).map((bucket): HsnRow => ({
    classificationCode: bucket.classificationCode,
    uqc: bucket.uqc,
    ratePct: bucket.ratePct,
    quantity: toQuantityString(bucket.quantity),
    taxableValue: toMoneyString(bucket.taxableValue),
    tax: toTaxAmounts(bucket.tax),
  }))

  /* THE TOTAL IS THE SUM OF THE ROWS AS EMITTED, not a second fold over the documents.
   * Two folds is two answers, and the one nobody printed is the one that stays wrong. */
  const taxableValue = sum(rows.map((row) => row.taxableValue))
  const tax = sumTotals([...buckets.values()].sort(compareBuckets).map((bucket) => bucket.tax))

  return {
    rows,
    taxableValue: toMoneyString(taxableValue),
    tax: toTaxAmounts(rows.length === 0 ? zeroTotals() : tax),
    issues,
  }
}

/**
 * Row order: code, then UQC, then rate. A row with no code sorts last.
 *
 * Deterministic because a return diffed against last month's is how somebody checks their
 * own work, and a section that reordered itself between two runs would make every row
 * look changed.
 */
function compareBuckets(a: Bucket, b: Bucket): number {
  const byCode = compareNullableText(a.classificationCode, b.classificationCode)
  if (byCode !== 0) {
    return byCode
  }
  const byUqc = compareNullableText(a.uqc, b.uqc)
  if (byUqc !== 0) {
    return byUqc
  }
  return D(a.ratePct).comparedTo(D(b.ratePct))
}

/** Text order with nulls last, so a missing code is at the bottom where it is noticed. */
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
  return a < b ? -1 : 1
}

/** The zero a caller needs when a period has no lines at all. */
export function emptyHsnSummary(): HsnSummary {
  return {
    rows: [],
    taxableValue: toMoneyString(ZERO),
    tax: toTaxAmounts(zeroTotals()),
    issues: [],
  }
}
