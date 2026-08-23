/*
 * The receipt contract.
 *
 * Small, and every one of these is a rule from the file's header stated as an assertion —
 * so a change in treatment cannot happen without one of them going red. The ones worth
 * reading are the ones asserting a NEGATIVE: there is no draft status, there is no
 * `paid`, and nothing here can tell you what has been allocated.
 */

import { describe, expect, it } from 'vitest'

import { D, ZERO } from '@main/domain/money'

import {
  RECEIPT_KINDS,
  RECEIPT_STATUSES,
  acceptsAllocations,
  allocatedTotal,
  isCancellable,
  isLiveReceipt,
  receiptDefinitionOf,
  receiptTreatmentOf,
  settlesSide,
  type ReceiptAllocation,
  type ReceiptKind,
} from './types'

const allocation = (amount: string): ReceiptAllocation => ({
  id: `alloc-${amount}`,
  receiptId: 'r-1',
  documentId: `d-${amount}`,
  amount: D(amount),
})

describe('the two kinds', () => {
  it('are a receipt and a payment, and nothing else', () => {
    expect(RECEIPT_KINDS.map((definition) => definition.kind)).toEqual(['receipt', 'payment'])
  })

  it('move opposite control accounts in opposite directions', () => {
    expect(receiptDefinitionOf('receipt')).toMatchObject({ side: 'sales', direction: 'in' })
    expect(receiptTreatmentOf('receipt')).toMatchObject({
      controlRole: 'accounts-receivable',
      sourceType: 'receipt',
    })
    expect(receiptDefinitionOf('payment')).toMatchObject({ side: 'purchase', direction: 'out' })
    expect(receiptTreatmentOf('payment')).toMatchObject({
      controlRole: 'accounts-payable',
      sourceType: 'payment',
    })
  })

  /*
   * A receipt ALWAYS posts, which is what makes `receiptPostingRuleFor` return a rule
   * rather than a rule-or-null. `DocumentKindDefinition.sourceType` is nullable because a
   * quotation reaches no ledger; nothing here has an equivalent, and this is the
   * assertion that would notice if one were added without the callers being told.
   */
  it('all reach the ledger, so every one has a source type', () => {
    for (const definition of RECEIPT_KINDS) {
      expect(receiptTreatmentOf(definition.kind).sourceType).not.toBeNull()
    }
  })

  /*
   * The two facts 0013-3 split apart. The words live in `@shared/receipts` where a screen
   * can read them; what the LEDGER does with a kind stays in the domain. TypeScript
   * already refuses a kind with no treatment — the record is total over `ReceiptKind` —
   * so this asserts the pair is coherent, which is the half a type cannot state.
   */
  it('moves the control account its side implies', () => {
    expect(receiptTreatmentOf('receipt').controlRole).toBe('accounts-receivable')
    expect(receiptTreatmentOf('payment').controlRole).toBe('accounts-payable')
  })

  /* A voucher is recorded in the ledger under its own name, so drilling from an entry
   * back to the voucher needs no mapping table. */
  it('records a voucher under its own name', () => {
    for (const definition of RECEIPT_KINDS) {
      expect(receiptTreatmentOf(definition.kind).sourceType).toBe(definition.kind)
    }
  })

  it('says which side a kind settles', () => {
    expect(settlesSide('receipt')).toBe('sales')
    expect(settlesSide('payment')).toBe('purchase')
  })

  it('refuses a kind this build does not know', () => {
    expect(() => receiptDefinitionOf('advance' as ReceiptKind)).toThrow(/newer Coffer/)
  })

  /*
   * AND SO DOES THE TREATMENT, which is the half a mutation found nothing asserting. The
   * record is `Record<ReceiptKind, …>`, so an unknown string reaching it does not fail —
   * it answers `undefined`, and the caller then reads `.controlRole` off nothing and dies
   * with a TypeError naming neither the kind nor the file. The lookup goes through
   * `receiptDefinitionOf` first so a newer build's company file gets the sentence written
   * for it instead.
   */
  it('refuses to treat a kind this build does not know', () => {
    expect(() => receiptTreatmentOf('advance' as ReceiptKind)).toThrow(/newer Coffer/)
  })
})

describe('the statuses', () => {
  /* Rule 1 as an assertion. A draft receipt is money the books say arrived that the
   * ledger has not seen, and the way to make that unrepresentable is to have no word
   * for it. */
  it('do not include a draft', () => {
    expect(RECEIPT_STATUSES).toEqual(['posted', 'cancelled'])
    expect(RECEIPT_STATUSES).not.toContain('draft')
  })

  /* And rule 3: what a receipt has left is a sum, not a state. */
  it('do not include anything about being allocated', () => {
    expect(RECEIPT_STATUSES).not.toContain('allocated')
    expect(RECEIPT_STATUSES).not.toContain('settled')
  })

  it('counts only a posted receipt', () => {
    expect(isLiveReceipt('posted')).toBe(true)
    expect(isLiveReceipt('cancelled')).toBe(false)
  })

  it('cancels only what has not been cancelled', () => {
    expect(isCancellable('posted')).toBe(true)
    expect(isCancellable('cancelled')).toBe(false)
  })

  it('takes allocations only against a posted receipt', () => {
    expect(acceptsAllocations('posted')).toBe(true)
    expect(acceptsAllocations('cancelled')).toBe(false)
  })
})

describe('allocatedTotal', () => {
  it('is nothing when nothing has been allocated', () => {
    expect(allocatedTotal([]).equals(ZERO)).toBe(true)
  })

  it('adds the allocations it is given', () => {
    expect(allocatedTotal([allocation('1200.50'), allocation('799.50')]).toString()).toBe('2000')
  })

  /*
   * It filters nothing, and that is the contract rather than an omission. Which
   * allocations count is decided by the query that fetched them — a cancelled receipt's
   * rows are deleted rather than filtered, so there is nothing here to exclude, and an
   * arithmetic helper that tried would be reading a status it cannot see.
   */
  it('sums whatever it is handed, without judging it', () => {
    const rows = [allocation('10.00'), allocation('10.00'), allocation('10.00')]
    expect(allocatedTotal(rows).toString()).toBe('30')
  })
})
