/*
 * The voucher kind table, tested where it now lives.
 *
 * What the four kinds ARE is asserted in `main/domain/receipts/types.test.ts`, which reads
 * this table through the domain's re-export and pairs each row with what the ledger does
 * with it. What is here is what belongs to the table itself, and it is almost entirely
 * one pairing: which voucher settles which document.
 *
 * THE PAIRING IS DERIVED, so the tests that matter are the ones a derivation can fail
 * without looking wrong. Two of them do the work: the four pairs are pinned BY VALUE, and
 * the four vouchers are asserted to settle four DISTINCT documents — which is what a
 * transposition breaks, and what a table of four expected values alone would not notice,
 * because somebody transposing the rule would rewrite those four values to match.
 */

import { describe, expect, it } from 'vitest'
import { DOCUMENT_KINDS, definitionOf, type DocumentKind } from './documents'
import {
  RECEIPT_KINDS,
  receiptDefinitionOf,
  settledBy,
  settledByIn,
  settledDirection,
  settles,
  type ReceiptKind,
  type ReceiptKindDefinition,
} from './receipts'

const KINDS: readonly ReceiptKind[] = RECEIPT_KINDS.map((definition) => definition.kind)

describe('the words', () => {
  it('gives every kind a label and a plural of its own', () => {
    const labels = RECEIPT_KINDS.map((definition) => definition.label)
    const plurals = RECEIPT_KINDS.map((definition) => definition.pluralLabel)

    expect(new Set(labels).size).toBe(labels.length)
    expect(new Set(plurals).size).toBe(plurals.length)
  })

  it('writes a label a sentence can lower-case without losing a proper noun', () => {
    for (const definition of RECEIPT_KINDS) {
      expect(definition.label).toMatch(/^[A-Z][a-z ]+$/)
    }
  })

  /*
   * The direction is what the posting rule reads, and it is not derivable from the side.
   * A refund to a customer is money OUT on the SALES side — the case the table exists for
   * — so a rule that inferred one from the other would be right twice and wrong the day
   * a third kind arrives.
   */
  it('states the direction rather than leaving it to be inferred from the side', () => {
    expect(receiptDefinitionOf('receipt').direction).toBe('in')
    expect(receiptDefinitionOf('payment').direction).toBe('out')
    expect(receiptDefinitionOf('refund').direction).toBe('out')
    expect(receiptDefinitionOf('refund-received').direction).toBe('in')
  })

  /* THE WHOLE SQUARE, and the assertion is that it IS a square: four kinds over two sides
   * and two directions, with no pair used twice. A missing corner is a document kind with
   * no voucher that settles it, which is what 0015 exists to close. */
  it('fills every side and direction exactly once', () => {
    const pairs = RECEIPT_KINDS.map((definition) => `${definition.side}/${definition.direction}`)

    expect(new Set(pairs).size).toBe(pairs.length)
    expect([...pairs].sort()).toEqual(
      ['purchase/in', 'purchase/out', 'sales/in', 'sales/out'].sort(),
    )
  })
})

describe('what a voucher settles', () => {
  /*
   * BY VALUE, all four, because this is the pairing every other assertion is derived from.
   * The two that were not possible before 0015 are the interesting ones: a refund is
   * SALES-side and settles the credit note, not the invoice its side-mate settles.
   */
  it('pairs each voucher with the one document it settles', () => {
    expect(settles('receipt')).toBe('sales-invoice')
    expect(settles('payment')).toBe('purchase-bill')
    expect(settles('refund')).toBe('credit-note')
    expect(settles('refund-received')).toBe('debit-note')
  })

  /*
   * AND THE PART A TABLE OF FOUR VALUES CANNOT CATCH. Transpose the derivation — settle
   * refunds where charges were meant — and each of the four assertions above would have to
   * be rewritten to match, which is exactly what somebody making the change would do. This
   * one cannot be satisfied that way: four vouchers settling four DISTINCT documents,
   * which is every posting document kind, one voucher each.
   */
  it('settles every posting document kind, once each', () => {
    const settled = KINDS.map((kind) => settles(kind))
    const posting = DOCUMENT_KINDS.filter((definition) => definition.postsToLedger)

    expect(new Set(settled).size).toBe(settled.length)
    expect([...settled].sort()).toEqual(posting.map((definition) => definition.kind).sort())
  })

  it('never reaches across to the other half of the trade', () => {
    for (const kind of KINDS) {
      expect(definitionOf(settles(kind)).side).toBe(receiptDefinitionOf(kind).side)
    }
  })

  /* Money that ADDS to what the side's control account carries settles a refund; money
   * that takes it down settles a charge. Both halves pinned, or the equality inside
   * `addsToBalance` could be inverted and half the table would still read correctly. */
  it('sends money that adds to the balance at the refunds', () => {
    expect(settledDirection(receiptDefinitionOf('refund'))).toBe('refund')
    expect(settledDirection(receiptDefinitionOf('refund-received'))).toBe('refund')
    expect(settledDirection(receiptDefinitionOf('receipt'))).toBe('charge')
    expect(settledDirection(receiptDefinitionOf('payment'))).toBe('charge')
  })
})

describe('what settles a document', () => {
  it('is the inverse of what a voucher settles, both ways round', () => {
    for (const kind of KINDS) {
      expect(settledBy(settles(kind))).toBe(kind)
    }
    for (const definition of DOCUMENT_KINDS.filter((each) => each.postsToLedger)) {
      const voucher = settledBy(definition.kind)
      expect(voucher).not.toBeNull()
      expect(settles(voucher as ReceiptKind)).toBe(definition.kind)
    }
  })

  /*
   * NOTHING SETTLES A QUOTATION, and answering null rather than 'receipt' is the whole of
   * why this replaced a side lookup. A quotation offers a price and creates no obligation;
   * the old answer was a real voucher kind that every caller happened to gate away before
   * using it.
   */
  it('answers nothing for a document that posts nothing', () => {
    expect(settledBy('quotation')).toBeNull()
  })

  it('refuses a kind this build does not know', () => {
    expect(() => settledBy('proforma' as DocumentKind)).toThrow(/newer Coffer/)
  })
})

describe('settledByIn, given a table the real one cannot be', () => {
  /*
   * The guard cannot fire on the shipped table — that is the point of it — so the table is
   * an argument and a test builds the ambiguity. Written this way from the start because
   * 0013-2's mutation pass found the mirror of it in `postingKindIn` and the lesson is
   * cheaper to apply than to relearn (CONVENTIONS §6).
   */
  const kind = (over: Partial<ReceiptKindDefinition>): ReceiptKindDefinition => ({
    kind: 'receipt',
    label: 'Receipt',
    pluralLabel: 'Receipts',
    side: 'sales',
    direction: 'in',
    ...over,
  })

  it('names the one voucher that settles a side facing that way', () => {
    const table = [kind({}), kind({ kind: 'refund', direction: 'out' })]

    expect(settledByIn(table, 'sales', 'charge', 'a sales invoice')).toBe('receipt')
    expect(settledByIn(table, 'sales', 'refund', 'a credit note')).toBe('refund')
  })

  /*
   * Two vouchers settling one document means "record money against this" has two screens
   * to go to, and a `.find` would silently pick whichever was listed first.
   */
  it('refuses a document two vouchers settle', () => {
    expect(() =>
      settledByIn([kind({}), kind({ kind: 'payment' })], 'sales', 'charge', 'a sales invoice'),
    ).toThrow(/a sales invoice is settled by 2 voucher kinds/)
  })

  /* And a document with none: an invoice with no way to record money against it, offered
   * as a button that navigates nowhere. */
  it('refuses a document nothing settles', () => {
    expect(() => settledByIn([kind({})], 'purchase', 'charge', 'a purchase bill')).toThrow(
      /a purchase bill is settled by 0 voucher kinds/,
    )
  })

  /* The side is read as well as the direction. A table with the right facing on the wrong
   * side answers nothing, rather than answering for the other half of the trade. */
  it('does not reach across to the other side', () => {
    expect(() =>
      settledByIn(
        [kind({ kind: 'refund', direction: 'out' })],
        'purchase',
        'refund',
        'a debit note',
      ),
    ).toThrow(/a debit note is settled by 0 voucher kinds/)
  })
})

describe('receiptDefinitionOf', () => {
  it('refuses a kind this build does not know, and says what to do', () => {
    expect(() => receiptDefinitionOf('advance' as ReceiptKind)).toThrow(/newer Coffer/)
  })
})
