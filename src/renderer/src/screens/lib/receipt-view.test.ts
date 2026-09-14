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

import { RECEIPT_KINDS, type ReceiptKind } from '@shared/receipts'

import {
  accountHint,
  accountLabel,
  amountHint,
  canAllocate,
  canCancel,
  draftAllocations,
  editorScreenId,
  emptyRegisterSentence,
  isStruckStatus,
  newSentence,
  PAGE_SIZE,
  partyLabel,
  partyRoleFor,
  registerLede,
  registerNav,
  registerScreenId,
  settleInFull,
  settlesLabel,
  stateSentence,
  statusFilters,
  statusLabel,
  statusTone,
  toAllocationInputs,
} from './receipt-view'

const KINDS: readonly ReceiptKind[] = RECEIPT_KINDS.map((definition) => definition.kind)

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
  it('draws a page small enough to sit under the toolbar', () => {
    expect(PAGE_SIZE).toBe(50)
  })
})

describe('where each kind lives', () => {
  /*
   * Two ids per kind, all different. `createScreenRegistry` keys by `area/id` and the
   * second registration silently replaces the first, so a duplicate would give one kind
   * two rail entries opening the same screen — and nothing would throw.
   *
   * COUNTED OFF THE TABLE rather than pinned at eight, so 0015 adding two kinds did not
   * need this number edited — which is the point: an assertion that has to be rewritten
   * every time the table grows is one somebody rewrites without reading.
   */
  it('gives every kind a register and an editor, and no two the same', () => {
    const ids = [...KINDS.map(registerScreenId), ...KINDS.map(editorScreenId)]

    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(KINDS.length * 2)
  })

  /*
   * AND NO TWO REGISTERS IN THE SAME PLACE IN THE SIDEBAR. The nav order is a hand-written
   * record keyed by kind, so 0015's two new kinds had to be given a slot each — and the
   * failure mode of getting one wrong is two entries at the same order in the same group,
   * which renders in whatever order the registry happened to build them.
   */
  it('gives every kind its own place in its own group', () => {
    const slots = KINDS.map((kind) => {
      const nav = registerNav(kind)
      return `${nav.group}/${String(nav.order)}`
    })

    expect(new Set(slots).size).toBe(slots.length)
  })

  /*
   * THE ONE ID THAT IS NOT FREE TO CHANGE. An invoice's "Record a receipt" has navigated
   * to `workspace/receipt` since 0012, and the document editor still builds that route
   * from the kind rather than from a literal. Renaming this breaks it silently — the
   * router simply finds no screen.
   */
  it('keeps the receipt editor at the route an invoice already sends to', () => {
    expect(editorScreenId('receipt')).toBe('receipt')
    expect(editorScreenId('payment')).toBe('payment')
  })

  it('files each register under the group its side names', () => {
    expect(registerNav('receipt').group).toBe('sales')
    expect(registerNav('payment').group).toBe('purchases')
  })

  /* Last in its group, after the documents: a voucher is what happens TO a document. The
   * document registers hold 1..3 on each side. */
  it('sits below every document register in its group', () => {
    for (const kind of KINDS) {
      expect(registerNav(kind).order).toBeGreaterThan(2)
    }
  })

  it('labels the rail entry with the plural from the shared table', () => {
    expect(registerNav('payment').label).toBe('Payments')
    expect(registerNav('receipt').label).toBe('Receipts')
  })
})

describe('what each kind is called', () => {
  it('asks for customers on the sales side and vendors on the purchase side', () => {
    expect(partyRoleFor('sales')).toBe('customer')
    expect(partyRoleFor('purchase')).toBe('vendor')
    expect(partyLabel('purchase')).toBe('Vendor')
  })

  /*
   * READ OFF THE DOCUMENT TABLE, NOT WRITTEN OUT HERE. `settlesLabel` goes through
   * `settles`, the same function the picker filters on and migration 0015's trigger
   * enumerates — so a sixth document kind cannot leave this screen calling a bill an
   * invoice, and the allocation heading cannot drift from what the picker actually lists.
   *
   * IT TOOK A SIDE UNTIL 0015 AND COULD NOT HAVE ANSWERED FOR A REFUND. A refund and a
   * receipt are both sales-side, so a heading keyed on the side would print "Sales
   * invoice" over a list of credit notes — the screen agreeing with the wrong half of the
   * rule, which is the version of this bug that looks right.
   */
  it('names what each voucher settles from the document table', () => {
    expect(settlesLabel('receipt')).toBe('Sales invoice')
    expect(settlesLabel('payment')).toBe('Purchase bill')
    expect(settlesLabel('refund')).toBe('Credit note')
    expect(settlesLabel('refund-received')).toBe('Debit note')
  })

  /* Four vouchers, four different headings. A transposition inside `settles` would have
   * to survive this as well as the four values above. */
  it('gives no two vouchers the same heading', () => {
    const labels = KINDS.map((kind) => settlesLabel(kind))

    expect(new Set(labels).size).toBe(labels.length)
  })

  it('says money arrived for a receipt and was paid for a payment', () => {
    expect(amountHint('receipt')).toContain('What arrived')
    expect(amountHint('payment')).toContain('What you paid')
  })

  /*
   * THE SENTENCE THAT STOPS A NEGATIVE. Both kinds warn that money the other way is the
   * other kind — and each has to name the OTHER one, or the warning tells a user to
   * record the thing they were already recording.
   */
  it('points each kind at the other for money going the wrong way', () => {
    expect(amountHint('receipt')).toContain('is a payment')
    expect(amountHint('payment')).toContain('is a receipt')
  })

  it('says which way the money crossed the account', () => {
    expect(accountLabel('receipt')).toContain('landed in')
    expect(accountLabel('payment')).toContain('came out of')
    expect(accountHint('receipt')).not.toBe(accountHint('payment'))
  })

  it('says a receipt was taken and a payment was made', () => {
    expect(registerLede('receipt')).toContain('taken')
    expect(registerLede('payment')).toContain('made')
  })

  it('writes a different lede and a different empty state for each kind', () => {
    expect(new Set(KINDS.map(registerLede)).size).toBe(KINDS.length)
    expect(new Set(KINDS.map(emptyRegisterSentence)).size).toBe(KINDS.length)
  })

  /*
   * MONEY ON ACCOUNT IS NOT AN UNFINISHED JOB, and the empty register is where a user
   * learns it. It also has to name the right document: telling somebody a payment does
   * not need an invoice is true and useless.
   */
  it('says a voucher needs no document, naming the one it would settle', () => {
    expect(emptyRegisterSentence('payment')).toContain('purchase bill')
    expect(emptyRegisterSentence('payment')).toContain('vendor')
    expect(emptyRegisterSentence('receipt')).toContain('sales invoice')
  })

  /*
   * THE HALF THAT TELLS THEM WHAT TO DO, and `toContain('on account')` did not reach it —
   * a mutation truncating the sentence to "sits on account." survived, because the phrase
   * being asserted was the part that stayed. Money nobody has matched is ordinary, and
   * what a user needs is that it waits for them rather than that it exists.
   */
  it('says unmatched money waits to be told what it pays', () => {
    for (const kind of KINDS) {
      expect(emptyRegisterSentence(kind)).toContain('until you say what it pays')
    }
  })

  /* There is no draft on either side — rule 1. A new voucher says so before it exists. */
  it('says recording it posts it, whichever way the money went', () => {
    for (const kind of KINDS) {
      expect(newSentence(kind)).toContain('there is no draft')
    }
    expect(newSentence('receipt')).toContain('already arrived')
    expect(newSentence('payment')).toContain('already left')
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
    expect(isStruckStatus('cancelled')).toBe(true)
    expect(isStruckStatus('posted')).toBe(false)
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
