/*
 * The aged report's judgements.
 *
 * Every table here is written out by value. A test that computed the expected label from
 * the same table the code reads would pass whatever either of them said, and the whole
 * point of a screen's vocabulary is that a person decided the words.
 */

import { describe, expect, it } from 'vitest'
import type { AgedBucket, AgedItem, AgedPartyRow } from '@shared/dto'
import { DOCUMENT_KINDS, TRADE_SIDES } from '@shared/documents'
import { RECEIPT_KINDS } from '@shared/receipts'
import {
  agedEmptySentence,
  agedLede,
  agedNav,
  agedScreenId,
  agedTitle,
  agedTotalLabel,
  bucketNameIn,
  bucketRangeSentence,
  columnFigure,
  dueDateFor,
  hasUnattributed,
  isOverdue,
  isUnattributed,
  itemNumberLabel,
  itemSourceLabel,
  itemTarget,
  overdueLabel,
  rowKey,
  UNATTRIBUTED_NOTE,
} from './ageing-view'

/* The table main sends, written out here rather than imported from `domain/reports`. The
 * renderer's job is to draw whatever columns arrive, and a test sharing main's constant
 * would stop proving that. */
const BUCKETS: AgedBucket[] = [
  { label: 'Not yet due', fromDays: null, toDays: 0 },
  { label: '1-30 days', fromDays: 1, toDays: 30 },
  { label: '31-60 days', fromDays: 31, toDays: 60 },
  { label: 'Over 90 days', fromDays: 91, toDays: null },
]

function item(over: Partial<AgedItem> = {}): AgedItem {
  return {
    source: 'document',
    sourceId: 'document-1',
    kind: 'sales-invoice',
    number: 'INV/2026-27/0001',
    date: '2026-04-01',
    dueDate: '2026-05-01',
    daysOverdue: 60,
    bucket: 2,
    amount: '1180.00',
    ...over,
  }
}

function row(over: Partial<AgedPartyRow> = {}): AgedPartyRow {
  return {
    partyId: 'party-1',
    partyName: 'Acme Traders',
    buckets: ['0.00', '0.00', '1180.00', '0.00'],
    onAccount: '0.00',
    total: '1180.00',
    items: [item()],
    ...over,
  }
}

// ---- What each side is called -----------------------------------------------

describe('the words for a side', () => {
  it('names the two reports', () => {
    expect(agedTitle('sales')).toBe('Aged receivables')
    expect(agedTitle('purchase')).toBe('Aged payables')
  })

  it('names the debt each side is', () => {
    expect(agedTotalLabel('sales')).toBe('Owed to the business')
    expect(agedTotalLabel('purchase')).toBe('Owed by the business')
  })

  it('gives each side its own screen id', () => {
    expect(agedScreenId('sales')).toBe('aged-sales')
    expect(agedScreenId('purchase')).toBe('aged-purchase')
  })

  /*
   * The table is keyed by `TradeSide` so a missing side will not compile — but
   * `TRADE_SIDES` is DERIVED from the kind table at runtime, and this is what proves the
   * two agree. A side reaching the rail with an empty heading is the failure.
   */
  it.each(TRADE_SIDES)('has every word %s needs', (side) => {
    expect(agedTitle(side)).not.toBe('')
    expect(agedLede(side)).not.toBe('')
    expect(agedTotalLabel(side)).not.toBe('')
    expect(agedEmptySentence(side)).not.toBe('')
  })

  it('files each on its own side, with the registers it is chasing', () => {
    expect(agedNav('sales').group).toBe('sales')
    expect(agedNav('purchase').group).toBe('purchases')
  })

  /* After the registers (1–5) and the parties (20): last in its rail. */
  it('puts it last in that rail', () => {
    expect(agedNav('sales').order).toBe(30)
    expect(agedNav('purchase').order).toBe(30)
  })
})

// ---- Overdue ----------------------------------------------------------------

describe('isOverdue', () => {
  it('is true for money past its date that is still owed', () => {
    expect(isOverdue(item({ bucket: 2, daysOverdue: 60 }))).toBe(true)
  })

  it('is true from the first day past', () => {
    expect(isOverdue(item({ bucket: 1, daysOverdue: 1 }))).toBe(true)
  })

  /* Due today is not late. An invoice on 30-day terms is not in default on day thirty. */
  it('is false on the day it falls due', () => {
    expect(isOverdue(item({ bucket: 0, daysOverdue: 0 }))).toBe(false)
  })

  it('is false before it falls due', () => {
    expect(isOverdue(item({ bucket: 0, daysOverdue: -12 }))).toBe(false)
  })

  /*
   * THE ONE THAT MATTERS. A credit note raised over a year ago has a large `daysOverdue`
   * and nobody owes it. A flag that read only the days would put a red badge on the
   * customer's own money.
   */
  it('is false for money standing to the party, however old', () => {
    expect(isOverdue(item({ source: 'receipt', bucket: null, daysOverdue: 400 }))).toBe(false)
  })
})

describe('overdueLabel', () => {
  it('counts the days', () => {
    expect(overdueLabel(item({ bucket: 2, daysOverdue: 60 }))).toBe('60 days overdue')
  })

  it('says one day in the singular', () => {
    expect(overdueLabel(item({ bucket: 1, daysOverdue: 1 }))).toBe('1 day overdue')
  })

  it('says nothing at all where nothing is late', () => {
    expect(overdueLabel(item({ bucket: 0, daysOverdue: 0 }))).toBeNull()
    expect(overdueLabel(item({ bucket: null, daysOverdue: 90 }))).toBeNull()
  })
})

// ---- The due column ---------------------------------------------------------

describe('dueDateFor', () => {
  it('gives the date for money that is owed', () => {
    expect(dueDateFor(item({ bucket: 1, dueDate: '2026-05-01' }))).toBe('2026-05-01')
  })

  /*
   * A receipt carries the day the money arrived as its due date, and only as a sort key.
   * Printing it under "Due" would say money already banked falls payable on the day it
   * was banked.
   */
  it('gives nothing for money standing to the party', () => {
    expect(dueDateFor(item({ source: 'receipt', bucket: null, dueDate: '2026-05-20' }))).toBeNull()
  })
})

// ---- The columns ------------------------------------------------------------

describe('bucketNameIn', () => {
  it('names the column an item fell in', () => {
    expect(bucketNameIn(BUCKETS, 0)).toBe('Not yet due')
    expect(bucketNameIn(BUCKETS, 3)).toBe('Over 90 days')
  })

  it('calls a credit what it is rather than a column', () => {
    expect(bucketNameIn(BUCKETS, null)).toBe('On account')
  })

  /*
   * Unreachable from a report main produced — it builds both arrays from one table — and
   * testable only because the columns are an argument. The answer must not be a real
   * column: falling back to `buckets[0]` would file a ninety-day debt under "Not yet due".
   */
  it('says a row is unplaced rather than filing it under the wrong column', () => {
    expect(bucketNameIn(BUCKETS, 9)).toBe('Unplaced')
    expect(bucketNameIn([], 0)).toBe('Unplaced')
  })
})

describe('bucketRangeSentence', () => {
  it('says a column open at the bottom is not yet due', () => {
    expect(bucketRangeSentence({ label: 'Not yet due', fromDays: null, toDays: 0 })).toBe(
      'Not yet due as at the report date',
    )
  })

  /* PAST DUE, not old. "31-60 days" reads as an age, and on 30-day terms the two differ
   * by a month on every invoice. */
  it('says a closed column in days past due', () => {
    expect(bucketRangeSentence({ label: '31-60 days', fromDays: 31, toDays: 60 })).toBe(
      '31 to 60 days past due',
    )
  })

  it('says a column open at the top has no end', () => {
    expect(bucketRangeSentence({ label: 'Over 90 days', fromDays: 91, toDays: null })).toBe(
      '91 days or more past due',
    )
  })

  it('has an answer for a column open at both ends', () => {
    expect(bucketRangeSentence({ label: 'Everything', fromDays: null, toDays: null })).toBe(
      'Every age',
    )
  })
})

describe('columnFigure', () => {
  it('reads the figure in a column', () => {
    expect(columnFigure(['0.00', '1180.00'], 1)).toBe('1180.00')
  })

  /* NOT '0.00'. A nought is a figure, and a reader totalling the row would find it right
   * — a blank cell under a heading is visibly a hole. */
  it('gives nothing rather than a nought where a row is short a column', () => {
    expect(columnFigure(['0.00'], 3)).toBeNull()
    expect(columnFigure([], 0)).toBeNull()
  })
})

// ---- Rows -------------------------------------------------------------------

describe('rowKey', () => {
  it('keys a party by its id', () => {
    expect(rowKey(row({ partyId: 'party-7' }))).toBe('party:party-7')
  })

  it('has a key for the row that names nobody', () => {
    expect(rowKey(row({ partyId: null }))).toBe('no-party')
  })

  /* The sentinel is prefixed so no party id can collide with it. */
  it('cannot be collided with by a party called after it', () => {
    expect(rowKey(row({ partyId: 'no-party' }))).not.toBe(rowKey(row({ partyId: null })))
  })
})

describe('isUnattributed', () => {
  it('marks the row whose lines name no party', () => {
    expect(isUnattributed(row({ partyId: null }))).toBe(true)
  })

  it('marks nothing else', () => {
    expect(isUnattributed(row())).toBe(false)
  })

  it('says whether a report has one at all', () => {
    expect(hasUnattributed([row(), row({ partyId: null })])).toBe(true)
    expect(hasUnattributed([row(), row({ partyId: 'party-2' })])).toBe(false)
    expect(hasUnattributed([])).toBe(false)
  })

  it('has a sentence explaining what such a row is', () => {
    expect(UNATTRIBUTED_NOTE).toContain('no party against it')
  })
})

describe('itemNumberLabel', () => {
  it('uses the number where there is one', () => {
    expect(itemNumberLabel(item({ number: 'INV/2026-27/0004' }))).toBe('INV/2026-27/0004')
  })

  /* A blank cell reads as a number that failed to load, and a button with no label cannot
   * be clicked on purpose. */
  it('names the absence rather than leaving the cell empty', () => {
    expect(itemNumberLabel(item({ number: '' }))).toBe('Unnumbered')
  })
})

// ---- Where a row opens ------------------------------------------------------

describe('itemTarget', () => {
  it('opens a document in its own editor', () => {
    expect(itemTarget(item({ kind: 'sales-invoice', sourceId: 'document-9' }))).toEqual({
      screenId: 'sales-invoice',
      params: { id: 'document-9' },
    })
  })

  /*
   * THE REASON `kind` CROSSES IPC FOR A RECEIPT TOO. The report's side does not answer
   * this: a refund to a customer is money out on the sales side, and `domain/receipts`
   * states on purpose that a voucher's control account is declared rather than derived.
   */
  it('opens a receipt and a payment in their own editors', () => {
    expect(itemTarget(item({ source: 'receipt', kind: 'receipt', sourceId: 'receipt-1' }))).toEqual(
      { screenId: 'receipt', params: { id: 'receipt-1' } },
    )
    expect(itemTarget(item({ source: 'receipt', kind: 'payment', sourceId: 'receipt-2' }))).toEqual(
      { screenId: 'payment', params: { id: 'receipt-2' } },
    )
  })

  it.each(DOCUMENT_KINDS.map((definition) => definition.kind))('opens a %s', (kind) => {
    expect(itemTarget(item({ source: 'document', kind }))).not.toBeNull()
  })

  it.each(RECEIPT_KINDS.map((definition) => definition.kind))('opens a %s', (kind) => {
    expect(itemTarget(item({ source: 'receipt', kind }))).not.toBeNull()
  })

  /* An opening balance and a manual correction both arrive this way and neither has an
   * editor in this product. Null is the answer, not a failure. */
  it('has nowhere to send a journal entry', () => {
    expect(itemTarget(item({ source: 'journal', kind: null }))).toBeNull()
  })

  /* A company file written by a newer build. A route to a screen that does not resolve is
   * a blank page rather than a message. */
  it('refuses a kind these books do not know', () => {
    expect(itemTarget(item({ source: 'document', kind: 'proforma-invoice' }))).toBeNull()
  })

  /* The kind has to belong to the source. Without the pairing, a receipt id would be sent
   * to a document editor that would look it up and find nothing. */
  it('refuses a kind that belongs to the other table', () => {
    expect(itemTarget(item({ source: 'document', kind: 'receipt' }))).toBeNull()
    expect(itemTarget(item({ source: 'receipt', kind: 'sales-invoice' }))).toBeNull()
  })
})

describe('itemSourceLabel', () => {
  it("uses a document kind's own label", () => {
    expect(itemSourceLabel(item({ source: 'document', kind: 'sales-invoice' }))).toBe(
      'Sales invoice',
    )
    expect(itemSourceLabel(item({ source: 'document', kind: 'credit-note' }))).toBe('Credit note')
  })

  it("uses a voucher kind's own label", () => {
    expect(itemSourceLabel(item({ source: 'receipt', kind: 'receipt' }))).toBe('Receipt')
    expect(itemSourceLabel(item({ source: 'receipt', kind: 'payment' }))).toBe('Payment')
  })

  /* Not an error. An opening balance is how an existing business starts. */
  it('names a journal entry for what it is', () => {
    expect(itemSourceLabel(item({ source: 'journal', kind: null }))).toBe('Journal entry')
  })

  it('has a word for a source with no kind at all', () => {
    expect(itemSourceLabel(item({ source: 'receipt', kind: null }))).toBe('Voucher')
    expect(itemSourceLabel(item({ source: 'document', kind: null }))).toBe('Document')
  })

  /* Its own name is more use to whoever is reading than a word this build invented. */
  it('shows an unknown kind by its own name', () => {
    expect(itemSourceLabel(item({ source: 'document', kind: 'proforma-invoice' }))).toBe(
      'proforma-invoice',
    )
  })
})
