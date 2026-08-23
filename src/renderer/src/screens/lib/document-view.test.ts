import { describe, expect, it } from 'vitest'
import { DOCUMENT_KINDS, type DocumentKind } from '@shared/documents'
import {
  editorScreenId,
  emptyRegisterSentence,
  isCounterpartyAuthored,
  PAGE_SIZE,
  partyLabel,
  partyReferenceHint,
  partyReferenceLabel,
  partyRoleFor,
  registerLede,
  registerNav,
  registerScreenId,
  statusFilters,
  statusLabel,
  statusTone,
} from './document-view'

const KINDS: readonly DocumentKind[] = DOCUMENT_KINDS.map((definition) => definition.kind)

describe('statusLabel', () => {
  it('names the three states a document can be in', () => {
    expect(statusLabel('draft')).toBe('Draft')
    expect(statusLabel('issued')).toBe('Issued')
    expect(statusLabel('cancelled')).toBe('Cancelled')
  })

  /* A kind of status this build does not know is shown as it arrived rather than as a
   * blank cell — the same rule `accountTypeLabel` follows. */
  it('shows an unknown status rather than hiding it', () => {
    expect(statusLabel('superseded')).toBe('superseded')
  })
})

describe('statusTone', () => {
  /*
   * THE ASSERTION WORTH HAVING. Cancelling is the correct way to undo an issued
   * invoice — the entry is reversed, the number is kept, the series has no hole. A red
   * badge against it would put a warning on the one action that fixes a mistake
   * properly, and make well-kept books look alarming.
   */
  it('never marks a cancelled document as a problem', () => {
    expect(statusTone('cancelled')).not.toBe('negative')
    expect(statusTone('cancelled')).not.toBe('warning')
    expect(statusTone('cancelled')).toBe('neutral')
  })

  it('gives the draft the accent, because it is the row with something left to do', () => {
    expect(statusTone('draft')).toBe('accent')
    expect(statusTone('issued')).toBe('positive')
  })

  it('does not colour a status it does not know', () => {
    expect(statusTone('superseded')).toBe('neutral')
  })
})

describe('statusFilters', () => {
  it('offers no filter first, then the three states', () => {
    expect(statusFilters().map((filter) => filter.value)).toEqual([
      '',
      'draft',
      'issued',
      'cancelled',
    ])
  })

  it('labels the unfiltered option as all rather than as nothing', () => {
    expect(statusFilters()[0]?.label).toBe('All')
  })
})

describe('the register constants', () => {
  /* A page has to be smaller than the repository's own cap of 500, or the extra row that
   * answers "is there another page" is the row the repository truncated and Next never
   * appears. */
  it('asks for a page the repository will not truncate', () => {
    expect(PAGE_SIZE + 1).toBeLessThan(500)
  })
})

describe('where each kind lives', () => {
  /*
   * TEN IDS, ALL DIFFERENT. Two screens collide silently: `createScreenRegistry` keys by
   * `area/id` and the second registration simply replaces the first, so a duplicate id
   * would give one kind two sidebar entries that open the same screen — and nothing would
   * throw. Asserted as a set size rather than pairwise, so a sixth kind is covered.
   */
  it('gives every kind a register and an editor, and no two the same', () => {
    const ids = [...KINDS.map(registerScreenId), ...KINDS.map(editorScreenId)]
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(10)
  })

  /* An id built from a kind must not accidentally BE another kind's id — the register
   * suffix is what keeps the editor for 'credit-note' distinct from anything else. */
  it('never gives a register the id of an editor', () => {
    for (const kind of KINDS) {
      expect(KINDS.map(editorScreenId)).not.toContain(registerScreenId(kind))
    }
  })

  it('files a kind under the sidebar group its side names', () => {
    expect(registerNav('sales-invoice').group).toBe('sales')
    expect(registerNav('credit-note').group).toBe('sales')
    expect(registerNav('purchase-bill').group).toBe('purchases')
    expect(registerNav('debit-note').group).toBe('purchases')
  })

  /*
   * Two entries in one group sharing an order fall back to the label, which sorts
   * "Credit notes" above "Sales invoices" — a sidebar that lists the correction before
   * the thing it corrects. Orders are unique WITHIN a group, and deliberately not across
   * groups: 1 under Sales and 1 under Purchases are different lists.
   */
  it('orders each group without a tie', () => {
    for (const group of ['sales', 'purchases']) {
      const orders = KINDS.map(registerNav)
        .filter((nav) => nav.group === group)
        .map((nav) => nav.order)
      expect(new Set(orders).size).toBe(orders.length)
    }
  })

  it('never takes the top slot, which the parties hold', () => {
    for (const kind of KINDS) {
      expect(registerNav(kind).order).toBeGreaterThan(0)
    }
  })

  it('labels the sidebar entry with the plural from the shared table', () => {
    expect(registerNav('purchase-bill').label).toBe('Purchase bills')
    expect(registerNav('quotation').label).toBe('Quotations')
  })
})

describe('what a party is called', () => {
  it('asks for customers on the sales side and vendors on the purchase side', () => {
    expect(partyRoleFor('sales')).toBe('customer')
    expect(partyRoleFor('purchase')).toBe('vendor')
    expect(partyLabel('sales')).toBe('Customer')
    expect(partyLabel('purchase')).toBe('Vendor')
  })

  /*
   * The reason this is not one label for both sides. A vendor's own bill number is what
   * a GSTR-2B reconciliation matches on; "their reference" invites leaving it blank, and
   * a blank one makes every purchase in the books unmatchable against what the supplier
   * filed. The two hints have to differ, and the purchase one has to say why it matters.
   */
  it('names the purchase-side reference as the supplier own number', () => {
    expect(partyReferenceLabel('purchase')).toBe('Their invoice number')
    expect(partyReferenceLabel('sales')).not.toBe(partyReferenceLabel('purchase'))
    expect(partyReferenceHint('purchase')).toContain('supplier')
    expect(partyReferenceHint('purchase')).not.toBe(partyReferenceHint('sales'))
  })
})

describe('what each register says', () => {
  /*
   * The purchase bill is the only kind the counterparty wrote, and the only one a
   * register should say was RECORDED rather than raised. Asserted over the whole table
   * rather than on the one kind, so a sixth purchase charge kind cannot appear without
   * this being reconsidered.
   */
  it('treats exactly the purchase bill as somebody else document', () => {
    expect(KINDS.filter(isCounterpartyAuthored)).toEqual(['purchase-bill'])
  })

  it('says a bill was recorded and an invoice was raised', () => {
    expect(registerLede('purchase-bill')).toContain('recorded')
    expect(registerLede('sales-invoice')).toContain('raised')
    expect(registerLede('debit-note')).toContain('raised')
  })

  /* The one sentence that must not be shared: issuing a quotation posts nothing, and a
   * lede promising drafts reach the books would teach the wrong rule. */
  it('says a quotation reaches no ledger', () => {
    expect(registerLede('quotation')).toContain('puts nothing in the ledger')
    for (const kind of KINDS.filter((each) => each !== 'quotation')) {
      expect(registerLede(kind)).not.toContain('puts nothing in the ledger')
    }
  })

  it('names the kind and the party in an empty register', () => {
    expect(emptyRegisterSentence('purchase-bill')).toContain('purchase bill')
    expect(emptyRegisterSentence('purchase-bill')).toContain('vendor')
    expect(emptyRegisterSentence('credit-note')).toContain('customer')
  })

  /* Every kind gets its own words. A lede shared between two kinds means one of them is
   * being described as the other. */
  it('writes a different lede for every kind', () => {
    const ledes = KINDS.map(registerLede)
    expect(new Set(ledes).size).toBe(ledes.length)
  })
})
