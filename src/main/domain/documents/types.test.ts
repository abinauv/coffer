import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  definitionOf,
  hasNumber,
  isDeletable,
  isEditable,
  isLive,
  kindsOnSide,
  levyOf,
  postsToLedger,
  type DocumentKind,
  type DocumentStatus,
} from './types'

describe('the kinds table', () => {
  it('has a definition for every kind, reachable by its own key', () => {
    for (const definition of DOCUMENT_KINDS) {
      expect(definitionOf(definition.kind)).toBe(definition)
    }
  })

  it('refuses a kind it does not know rather than returning a default', () => {
    /* Reachable only from a company file written by a newer build. Silently treating it
     * as a sales invoice would post an unknown document as one. */
    expect(() => definitionOf('lorry-receipt' as DocumentKind)).toThrow(/newer Coffer/)
  })

  it('names each kind once', () => {
    const kinds = DOCUMENT_KINDS.map((definition) => definition.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it('gives each kind a singular and a plural a screen can use', () => {
    for (const definition of DOCUMENT_KINDS) {
      expect(definition.label.length).toBeGreaterThan(0)
      expect(definition.pluralLabel.length).toBeGreaterThan(0)
    }
    /* Not `label + 's'` — 'Sales invoice' pluralises on the second word. */
    expect(definitionOf('sales-invoice').pluralLabel).toBe('Sales invoices')
  })
})

describe('which kinds reach the ledger', () => {
  it('posts everything except a quotation', () => {
    const posting = DOCUMENT_KINDS.filter((definition) => postsToLedger(definition.kind))
    expect(posting.map((definition) => definition.kind)).toEqual([
      'sales-invoice',
      'credit-note',
      'purchase-bill',
      'debit-note',
    ])
    expect(postsToLedger('quotation')).toBe(false)
  })

  it('derives "posts" from the source type rather than carrying a second flag', () => {
    for (const definition of DOCUMENT_KINDS) {
      expect(postsToLedger(definition.kind)).toBe(definition.sourceType !== null)
    }
  })

  it('records a posting kind in the ledger under its own name', () => {
    /* What makes drill-through work in both directions: an entry's `source_type` is the
     * document's kind, so finding the document from the entry needs no mapping table. */
    for (const definition of DOCUMENT_KINDS) {
      if (definition.sourceType !== null) {
        expect(definition.sourceType).toBe(definition.kind)
      }
    }
  })
})

describe('the tax levy', () => {
  it('puts output tax on the sales side and input tax on the purchase side', () => {
    expect(levyOf('sales-invoice')).toBe('output')
    expect(levyOf('credit-note')).toBe('output')
    expect(levyOf('purchase-bill')).toBe('input')
    expect(levyOf('debit-note')).toBe('input')
  })

  it('gives a quotation no levy, because nothing has been supplied', () => {
    expect(levyOf('quotation')).toBeNull()
  })

  it('raises a levy on exactly the kinds that post', () => {
    /* The two go together by construction, not by two fields being kept in step. Tax
     * that arises with no entry to hold it is tax that appears in a return and on no
     * balance sheet. */
    for (const definition of DOCUMENT_KINDS) {
      expect(levyOf(definition.kind) === null).toBe(!postsToLedger(definition.kind))
    }
  })

  it('is not stored on the table it is derived from', () => {
    /*
     * It was, until a mutation showed that swapping `sourceType !== null` for
     * `levy !== null` in `postsToLedger` broke nothing: the two were null on exactly the
     * same rows, so no test could tell which one was being read. A field that agrees
     * with a derivation is a second place for it to be wrong, and the day they disagree
     * is the day a kind is added.
     */
    for (const definition of DOCUMENT_KINDS) {
      expect(definition).not.toHaveProperty('levy')
    }
  })
})

describe('what each kind does', () => {
  it('charges on an invoice or a bill and refunds on a note', () => {
    expect(definitionOf('sales-invoice').direction).toBe('charge')
    expect(definitionOf('purchase-bill').direction).toBe('charge')
    expect(definitionOf('credit-note').direction).toBe('refund')
    expect(definitionOf('debit-note').direction).toBe('refund')
  })

  it('groups the kinds by side without losing any', () => {
    expect(kindsOnSide('sales').map((definition) => definition.kind)).toEqual([
      'sales-invoice',
      'quotation',
      'credit-note',
    ])
    expect(kindsOnSide('purchase').map((definition) => definition.kind)).toEqual([
      'purchase-bill',
      'debit-note',
    ])
    expect(kindsOnSide('sales').length + kindsOnSide('purchase').length).toBe(DOCUMENT_KINDS.length)
  })
})

describe('the statuses', () => {
  it('lists exactly the three a document can be in', () => {
    expect(DOCUMENT_STATUSES).toEqual(['draft', 'issued', 'cancelled'])
  })

  it('lets a draft be changed, and nothing else', () => {
    expect(DOCUMENT_STATUSES.filter(isEditable)).toEqual(['draft'])
  })

  it('lets a draft be deleted, and nothing else', () => {
    /* Rule 2: anything that has left draft holds a number, and deleting it would leave a
     * gap in a series that has to be consecutive. Cancelling is the operation instead. */
    expect(DOCUMENT_STATUSES.filter(isDeletable)).toEqual(['draft'])
  })

  it('gives a number to everything that has left draft, cancelled included', () => {
    expect(DOCUMENT_STATUSES.filter(hasNumber)).toEqual(['issued', 'cancelled'])
  })

  it('counts only an issued document towards a register or a return', () => {
    expect(DOCUMENT_STATUSES.filter(isLive)).toEqual(['issued'])
  })

  it('never makes a numbered document editable', () => {
    /* The two rules read together: a number is a promise to somebody outside the
     * business, and it is made at the moment editing stops. */
    for (const status of DOCUMENT_STATUSES) {
      expect(hasNumber(status) && isEditable(status)).toBe(false)
    }
  })

  it('has no status that is neither editable nor numbered', () => {
    for (const status of DOCUMENT_STATUSES) {
      expect(isEditable(status) || hasNumber(status)).toBe(true)
    }
  })

  it('treats an unknown status as not live rather than as live', () => {
    /* Same reasoning as the kinds table: a status this build does not know comes from a
     * newer one, and the safe reading is that it does not belong in a return. */
    expect(isLive('superseded' as DocumentStatus)).toBe(false)
    expect(isEditable('superseded' as DocumentStatus)).toBe(false)
  })
})
