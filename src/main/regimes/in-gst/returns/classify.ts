/*
 * Which section of GSTR-1 a document belongs in, and what has to be true of a document
 * before it may be in a return at all.
 *
 * ═══ THE THREE FACTS EVERY SECTION IS BUILT FROM ═══════════════════════════════════
 *
 * Registered or not, inside the country or not, correcting something or not. Each is one
 * named predicate below, because each of them ALONE decides a document's section, and a
 * compound condition written inline is a condition no test can take apart.
 *
 * B2CL is the one that has to be taken apart. It is three conditions at once —
 * unregistered AND inter-state AND above the threshold — and a fixture that fails two of
 * them at a time proves nothing about either. What each excludes ON ITS OWN:
 *
 *   unregistered        excludes an inter-state supply above the threshold to a party
 *                       WITH a GSTIN. That is B2B, invoice by invoice under their number.
 *   inter-state         excludes an intra-state supply above the threshold to a party
 *                       with no GSTIN. That is B2CS, aggregated — value is irrelevant
 *                       within a state.
 *   above the threshold excludes an inter-state supply to a party with no GSTIN for one
 *                       rupee less. That is B2CS too, and it is the boundary the pack
 *                       value moves.
 *
 * `classify.test.ts` builds all three rows, and a fourth that satisfies all three.
 *
 * ═══ ORDER, AND WHY IT IS NOT A CHAIN OF EQUAL TESTS ═══════════════════════════════
 *
 * Export is asked first because an export is unregistered by construction — an overseas
 * customer has no GSTIN — so asking about registration first would file every export as
 * a B2C supply and nothing in the totals would look wrong.
 *
 * Correction is asked second, because a credit note against a registered person is CDNR
 * and not B2B, and the two carry different columns: a note has an original to name.
 *
 * The remaining three are the ordinary case.
 */

import { D, sum, tryParseDecimalString, type Decimal } from '@main/domain/money'
import { compareDates, isDateString, isWithin } from '@main/domain/time'
import {
  correctsKind,
  definitionOf,
  type DocumentDirection,
  type DocumentKind,
  type TradeSide,
} from '@shared/documents'
import type { DecimalString } from '@shared/scalars'
import { ReturnError } from './errors'
import type { ReturnDocument, ReturnLine, ReturnPeriod } from './types'

/** The value sections of GSTR-1. HSN and DOC_ISSUE are summaries, not places to put one. */
export type Gstr1SectionId = 'B2B' | 'B2CL' | 'B2CS' | 'CDNR' | 'CDNUR' | 'EXP'

// ---- The three facts -------------------------------------------------------

/**
 * Whether the counterparty holds a registration.
 *
 * A blank string counts as no registration, not as one: a party record with an empty
 * GSTIN field is exactly the party the B2C sections exist for, and treating '' as a
 * registration would file a B2B row with no number in it.
 */
export function isRegisteredCounterparty(document: ReturnDocument): boolean {
  const gstin = document.counterparty.registrationNumber
  return gstin !== null && gstin.trim() !== ''
}

/** Whether the supply leaves India. Answered by the regime, carried, never re-derived. */
export function isExportSupply(document: ReturnDocument): boolean {
  return document.placeOfSupply.isExport
}

/**
 * Whether the supply crosses a state line.
 *
 * The negation of `isIntraJurisdiction` rather than a comparison of two state codes,
 * because `placeOfSupply()` has already made that judgement — and it deliberately
 * resolves an unknown state to INTER-state, which is the conservative answer and the one
 * a return has to inherit rather than second-guess.
 */
export function isInterStateSupply(document: ReturnDocument): boolean {
  return !document.placeOfSupply.isIntraJurisdiction
}

/**
 * Whether this kind of document corrects another.
 *
 * `correctsKind` and not a list of kinds. The mapping is derived from the document table
 * — the refund kind on each side corrects the charge kind on that side — so a sixth kind
 * added to `shared/documents.ts` is classified here without this file being touched. A
 * hardcoded `kind === 'credit-note' || kind === 'debit-note'` would be the same rule
 * written a second time, which is the shape this codebase has deleted four times.
 */
export function isCorrection(kind: DocumentKind): boolean {
  return correctsKind(kind) !== null
}

// ---- Figures off a document ------------------------------------------------

/** Sum of the line taxable values. Exact — nothing is rounded. */
export function taxableValueOf(document: ReturnDocument): Decimal {
  return sum(document.lines.map((line) => D(line.taxableValue)))
}

/** Sum of every tax component on every line, whatever column it files in. */
export function taxValueOf(document: ReturnDocument): Decimal {
  return sum(document.lines.flatMap((line: ReturnLine) => line.taxes.map((tax) => D(tax.amount))))
}

/**
 * What the document is worth: taxable value, plus tax, plus the whole-rupee round-off.
 *
 * This is the "invoice value" the return asks for and the figure the B2CL threshold is
 * compared against — see the `b2cl-invoice-value-includes-tax` decision. The round-off is
 * in it because it is on the paper: the customer paid the rounded figure, and an invoice
 * value forty paise away from what was banked is one nobody can reconcile.
 */
export function invoiceValueOf(document: ReturnDocument): Decimal {
  return taxableValueOf(document).plus(taxValueOf(document)).plus(D(document.roundOff))
}

/**
 * Which way a document moves money, as a multiplier.
 *
 * A TOTAL RECORD over the two directions, not a comparison — CONVENTIONS §1.9. There are
 * two directions today and the record does not compile if a third arrives, where a
 * `=== 'charge' ? 1 : -1` would silently give the new one the refund's sign.
 */
const SIGN_OF_DIRECTION: Readonly<Record<DocumentDirection, 1 | -1>> = {
  charge: 1,
  refund: -1,
}

/** +1 for an invoice, -1 for a credit note. What the HSN summary and GSTR-3B net by. */
export function signOf(kind: DocumentKind): 1 | -1 {
  return SIGN_OF_DIRECTION[definitionOf(kind).direction]
}

// ---- The threshold ---------------------------------------------------------

/**
 * Whether an invoice value clears the B2CL threshold.
 *
 * STRICTLY GREATER. The rule is written as "more than", and a round-figure invoice for
 * exactly the threshold is an ordinary thing to raise — see the
 * `b2cl-threshold-is-strictly-greater` decision, and the fixture that sits on it.
 */
export function isAboveThreshold(invoiceValue: Decimal, threshold: DecimalString): boolean {
  return invoiceValue.greaterThan(parseThreshold(threshold))
}

/**
 * The threshold as a number, refused loudly rather than silently coerced to zero.
 *
 * `tryParseDecimalString` rather than `D`, so that a threshold which is not a decimal at
 * all comes back as ONE refusal with this module's code on it. `D` would throw a
 * `MoneyError` from a layer below, and a caller catching `ReturnError` to say "your pack
 * is wrong" would miss exactly the pack that was most wrong.
 */
export function parseThreshold(threshold: DecimalString): Decimal {
  const value = tryParseDecimalString(threshold)
  if (value === null || !value.isFinite() || value.isNegative()) {
    throw new ReturnError(
      'RETURN_PACK_VALUE_INVALID',
      `The B2CL threshold '${threshold}' is not a usable amount. A threshold that read as ` +
        'zero would move every unregistered inter-state supply into B2CL without a word.',
    )
  }
  return value
}

// ---- The section -----------------------------------------------------------

/**
 * Where this document is reported.
 *
 * Read the header before changing the order of these tests.
 */
export function sectionOf(document: ReturnDocument, threshold: DecimalString): Gstr1SectionId {
  const correcting = isCorrection(document.kind)

  /* Export first: an overseas customer has no GSTIN, so every later test would answer
   * "unregistered" and file a shipment as a counter sale. */
  if (isExportSupply(document)) {
    return correcting ? 'CDNUR' : 'EXP'
  }

  if (isRegisteredCounterparty(document)) {
    return correcting ? 'CDNR' : 'B2B'
  }

  /* Unregistered. Every note against one is listed rather than netted into B2CS — see
   * the `unregistered-notes-all-go-to-cdnur` decision, which is about not destroying the
   * only trace of a document. */
  if (correcting) {
    return 'CDNUR'
  }

  return isInterStateSupply(document) && isAboveThreshold(invoiceValueOf(document), threshold)
    ? 'B2CL'
    : 'B2CS'
}

// ---- What a document has to satisfy to be in a return at all ---------------

/**
 * The period, checked before anything is filtered by it.
 *
 * A range whose end precedes its start is a refusal and not an empty return: an empty
 * return for a period that cannot exist reads exactly like a quiet month, and the two
 * have to be distinguishable.
 */
export function assertPeriod(period: ReturnPeriod): void {
  if (!isDateString(period.from) || !isDateString(period.to)) {
    throw new ReturnError(
      'RETURN_PERIOD_INVALID',
      `A return period needs two dates; got '${period.from}' to '${period.to}'.`,
    )
  }
  if (compareDates(period.from, period.to) > 0) {
    throw new ReturnError(
      'RETURN_PERIOD_INVALID',
      `The period ends before it starts: ${period.from} to ${period.to}.`,
    )
  }
}

/**
 * Everything that has to be true of one document before it may be reported.
 *
 * ALL OF THESE ARE REFUSALS AND NONE OF THEM IS A FILTER, which is the decision worth
 * arguing for. A document dated outside the period could be dropped instead, and a return
 * would still be produced and every total in it would still tie — and that is exactly the
 * failure this project has already shipped: a date filter that did nothing, six tests
 * passing, and nobody able to see the missing rows. A caller that queries a period gets
 * documents in it; one that does not gets told, by name and by date.
 */
export function assertReturnable(
  document: ReturnDocument,
  period: ReturnPeriod,
  side: TradeSide,
): void {
  const definition = definitionOf(document.kind)

  if (!definition.postsToLedger) {
    throw new ReturnError(
      'RETURN_DOCUMENT_MAKES_NO_SUPPLY',
      `${definition.label} ${document.number} makes no supply and reaches no ledger, so it ` +
        'has nothing to report. Quotations are not filed.',
    )
  }

  if (definition.side !== side) {
    throw new ReturnError(
      'RETURN_DOCUMENT_WRONG_SIDE',
      `${definition.label} ${document.number} is a ${definition.side} document and this ` +
        `return reports ${side}. Filtering it out here would hide a query that asked for ` +
        'the wrong thing.',
    )
  }

  if (document.number.trim() === '') {
    throw new ReturnError(
      'RETURN_DOCUMENT_UNNUMBERED',
      `A ${definition.label.toLowerCase()} dated ${document.date} has no number. A draft is ` +
        'not filed, and a return has nothing to report it under.',
    )
  }

  if (!isDateString(document.date)) {
    throw new ReturnError(
      'RETURN_DOCUMENT_OUT_OF_PERIOD',
      `${definition.label} ${document.number} has no usable date: '${document.date}'.`,
    )
  }

  if (!isWithin(document.date, period.from, period.to)) {
    throw new ReturnError(
      'RETURN_DOCUMENT_OUT_OF_PERIOD',
      `${definition.label} ${document.number} is dated ${document.date}, outside ` +
        `${period.from} to ${period.to}. Dropping it would leave a return that ties and is ` +
        'missing a supply.',
    )
  }

  assertCorrection(document, definition.kind)
}

/**
 * A correction has to correct something it may correct, and a charge must correct nothing.
 *
 * Both directions, as one biconditional rather than two checks — CONVENTIONS §3. The
 * direction people forget is the second one, and a sales invoice carrying an original
 * document would be filed in B2B with a credit note's columns.
 */
function assertCorrection(document: ReturnDocument, kind: DocumentKind): void {
  const corrects = correctsKind(kind)
  const named = document.corrects

  if (corrects === null && named !== null) {
    throw new ReturnError(
      'RETURN_CORRECTION_MISMATCH',
      `${definitionOf(kind).label} ${document.number} corrects nothing, yet names ` +
        `${named.number} as an original.`,
    )
  }

  if (corrects !== null && named !== null && named.kind !== corrects) {
    throw new ReturnError(
      'RETURN_CORRECTION_MISMATCH',
      `${definitionOf(kind).label} ${document.number} may only correct a ` +
        `${definitionOf(corrects).label.toLowerCase()}, but names a ` +
        `${definitionOf(named.kind).label.toLowerCase()}, ${named.number}.`,
    )
  }
}

/**
 * Two documents of one kind sharing a number, which no series may hand out twice.
 *
 * Checked in the return rather than only in the database because a return is where the
 * consequence lands: the portal keys a B2B row by supplier, number and date, and two rows
 * sharing all three overwrite each other silently.
 */
export function assertNumbersDistinct(documents: readonly ReturnDocument[]): void {
  const seen = new Map<string, ReturnDocument>()
  for (const document of documents) {
    const key = [document.kind, document.number.trim().toUpperCase()].join('|')
    const first = seen.get(key)
    if (first !== undefined) {
      throw new ReturnError(
        'RETURN_DOCUMENT_NUMBER_REPEATED',
        `Two documents of kind '${document.kind}' both carry the number ` +
          `${document.number} — ${first.date} and ${document.date}. The portal keys a row ` +
          'by number, so one would silently replace the other.',
      )
    }
    seen.set(key, document)
  }
}
