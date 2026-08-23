/*
 * The voucher kind table, tested where it now lives.
 *
 * What the two kinds ARE is asserted in `main/domain/receipts/types.test.ts`, which reads
 * this table through the domain's re-export and pairs each row with what the ledger does
 * with it. What is here is what belongs to the table itself, and it is almost entirely
 * one function: which voucher settles a side.
 */

import { describe, expect, it } from 'vitest'
import {
  RECEIPT_KINDS,
  receiptDefinitionOf,
  settlingKind,
  settlingKindIn,
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
  })
})

describe('settlingKind', () => {
  it('sends a sales document to a receipt and a purchase document to a payment', () => {
    expect(settlingKind('sales')).toBe('receipt')
    expect(settlingKind('purchase')).toBe('payment')
  })

  /* Every kind settles a side, and each side has one. A kind whose side nothing routes to
   * is a screen nothing can reach. */
  it('covers every kind in the table', () => {
    expect(KINDS.map((kind) => settlingKind(receiptDefinitionOf(kind).side)).sort()).toEqual(
      [...KINDS].sort(),
    )
  })
})

describe('settlingKindIn, given a table the real one cannot be', () => {
  /*
   * The guard cannot fire on the shipped table — that is the point of it — so the table
   * is an argument and a test builds the ambiguity. Written this way from the start
   * because 0013-2's mutation pass found the mirror of it in `chargeKindIn` and the
   * lesson is cheaper to apply than to relearn (CONVENTIONS §6).
   */
  const kind = (over: Partial<ReceiptKindDefinition>): ReceiptKindDefinition => ({
    kind: 'receipt',
    label: 'Receipt',
    pluralLabel: 'Receipts',
    side: 'sales',
    direction: 'in',
    ...over,
  })

  it('names the one voucher on a side', () => {
    expect(settlingKindIn([kind({}), kind({ kind: 'payment', side: 'purchase' })], 'sales')).toBe(
      'receipt',
    )
  })

  /*
   * Two vouchers on one side means "record a receipt against this invoice" has two
   * screens to go to, and a `.find` would silently pick whichever was listed first.
   */
  it('refuses a side with two vouchers', () => {
    expect(() => settlingKindIn([kind({}), kind({ kind: 'payment' })], 'sales')).toThrow(
      /2 voucher kinds settle the sales side/,
    )
  })

  /* And a side with none: an invoice with no way to record money against it, offered as
   * a button that navigates nowhere. */
  it('refuses a side with no voucher', () => {
    expect(() => settlingKindIn([kind({})], 'purchase')).toThrow(
      /0 voucher kinds settle the purchase side/,
    )
  })
})

describe('receiptDefinitionOf', () => {
  it('refuses a kind this build does not know, and says what to do', () => {
    expect(() => receiptDefinitionOf('advance' as ReceiptKind)).toThrow(/newer Coffer/)
  })
})
