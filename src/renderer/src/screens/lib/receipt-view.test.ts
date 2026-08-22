/*
 * The receipt screens' vocabulary and shapes.
 *
 * The assertions worth reading are the ones about what this module REFUSES to do. It has
 * no function that adds two amounts together, and `settleInFull` copies a figure main
 * sent rather than working one out — those are §1.7 stated as tests, and they are the
 * whole reason this file is separate from the component.
 */

import { describe, expect, it } from 'vitest'

import type { OpenDocument } from '@shared/dto'

import {
  PAGE_SIZE,
  RECEIPT_KIND,
  canAllocate,
  canCancel,
  draftAllocations,
  settleInFull,
  stateSentence,
  statusFilters,
  statusLabel,
  statusTone,
  toAllocationInputs,
} from './receipt-view'

const open = (over: Partial<OpenDocument> = {}): OpenDocument => ({
  id: 'doc-1',
  kind: 'sales-invoice',
  number: 'INV/2026-27/0001',
  date: '2026-04-15',
  grandTotal: '1180.00',
  outstanding: '1180.00',
  ...over,
})

describe('what the register lists', () => {
  /* One direction, on purpose. A register mixing money out into a list of money in would
   * invite reading a total that means nothing. */
  it('lists receipts and not payments', () => {
    expect(RECEIPT_KIND).toBe('receipt')
  })

  it('draws a page small enough to sit under the toolbar', () => {
    expect(PAGE_SIZE).toBe(50)
  })
})

describe('the statuses', () => {
  it('names the two a receipt can be in', () => {
    expect(statusLabel('posted')).toBe('Posted')
    expect(statusLabel('cancelled')).toBe('Cancelled')
  })

  it('says an unknown status back rather than inventing a word for it', () => {
    expect(statusLabel('superseded')).toBe('superseded')
  })

  /* Cancelled is how a bounced cheque is recorded properly. Colouring it as a problem
   * would put a red mark against the one action that corrects a mistake. */
  it('does not treat a cancelled receipt as a warning', () => {
    expect(statusTone('posted')).toBe('positive')
    expect(statusTone('cancelled')).toBe('neutral')
  })

  it('offers a filter for each, and one for neither', () => {
    expect(statusFilters().map((filter) => filter.value)).toEqual(['', 'posted', 'cancelled'])
  })
})

describe('what may be done to a receipt', () => {
  /*
   * Two verbs, not four. There is no edit and no delete anywhere in this module, and that
   * is the contract: a receipt records money that has already moved, so the only
   * correction is a cancel; and a number handed out is never released.
   */
  it('offers allocating and cancelling on a posted one', () => {
    expect(canAllocate('posted')).toBe(true)
    expect(canCancel('posted')).toBe(true)
  })

  it('offers nothing at all on a cancelled one', () => {
    expect(canAllocate('cancelled')).toBe(false)
    expect(canCancel('cancelled')).toBe(false)
  })

  it('says what state it is in, and that the money is settled but the matching is not', () => {
    expect(stateSentence('posted', 'RCT/2026-27/0001')).toContain('RCT/2026-27/0001')
    expect(stateSentence('posted', 'RCT/2026-27/0001')).toMatch(/can still change/)
    expect(stateSentence('cancelled', 'RCT/2026-27/0001')).toMatch(/reversed/)
    expect(stateSentence('cancelled', 'RCT/2026-27/0001')).toMatch(/kept/)
  })
})

describe('the allocation lines', () => {
  it('is one line per open document, blank until somebody fills it in', () => {
    expect(draftAllocations([open(), open({ id: 'doc-2' })], [])).toEqual({
      'doc-1': '',
      'doc-2': '',
    })
  })

  it('seeds a line from what the receipt already settles', () => {
    expect(
      draftAllocations(
        [open(), open({ id: 'doc-2' })],
        [{ documentId: 'doc-2', amount: '400.00' }],
      ),
    ).toEqual({ 'doc-1': '', 'doc-2': '400.00' })
  })

  /* An allocation against a document that is no longer open cannot be drawn, because
   * there is no row for it — the rows ARE the open documents. */
  it('drops an existing allocation whose document is not on the list', () => {
    expect(draftAllocations([open()], [{ documentId: 'doc-9', amount: '400.00' }])).toEqual({
      'doc-1': '',
    })
  })
})

describe('settling one in full', () => {
  /*
   * A COPY, NEVER A SUM. `outstanding` was computed in main against the ledger, so the
   * figure this puts in the box is exact by construction — and it is already net of what
   * other receipts took, which is the case anything the renderer worked out would get
   * wrong.
   */
  it('is exactly what main said was outstanding', () => {
    expect(settleInFull(open({ outstanding: '680.00' }))).toBe('680.00')
  })

  it('is the outstanding figure and not the total', () => {
    expect(settleInFull(open({ grandTotal: '1180.00', outstanding: '180.00' }))).toBe('180.00')
  })
})

describe('what is sent', () => {
  it('sends a line the user filled in', () => {
    expect(toAllocationInputs({ 'doc-1': '500.00' })).toEqual([
      { documentId: 'doc-1', amount: '500.00' },
    ])
  })

  /*
   * A BLANK IS NOT A ZERO. Main refuses an allocation of nothing — it is not a statement
   * — so a row nobody filled in is left out rather than sent as '0.00'.
   */
  it('leaves out a line nobody filled in', () => {
    expect(toAllocationInputs({ 'doc-1': '', 'doc-2': '   ', 'doc-3': '100.00' })).toEqual([
      { documentId: 'doc-3', amount: '100.00' },
    ])
  })

  /* A typed zero IS sent. The user meant something by typing it, and main answers with a
   * sentence; dropping it silently would leave them looking at a figure the books do not
   * have. */
  it('sends a zero somebody actually typed', () => {
    expect(toAllocationInputs({ 'doc-1': '0' })).toEqual([{ documentId: 'doc-1', amount: '0' }])
  })

  it('trims what it sends', () => {
    expect(toAllocationInputs({ 'doc-1': '  500.00  ' })).toEqual([
      { documentId: 'doc-1', amount: '500.00' },
    ])
  })

  it('sends nothing at all when nothing is filled in', () => {
    expect(toAllocationInputs({ 'doc-1': '', 'doc-2': '' })).toEqual([])
  })
})

describe('what this module will not do', () => {
  /*
   * §1.7 as an assertion. A helper that added the allocations up would be the renderer
   * computing money, and it would be the second answer to a question main already
   * answers — `Receipt.allocated` and `Receipt.unallocated` arrive computed.
   */
  it('exports nothing that adds two amounts together', async () => {
    const module: Record<string, unknown> = await import('./receipt-view')
    for (const forbidden of ['allocatedTotal', 'remaining', 'sumAllocations', 'unallocated']) {
      expect(Object.keys(module)).not.toContain(forbidden)
    }
  })
})
