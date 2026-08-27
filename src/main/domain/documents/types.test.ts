import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  NUMBERED_KINDS,
  definitionOf,
  hasNumber,
  isDeletable,
  isEditable,
  isLive,
  kindsOnSide,
  levyOf,
  numberedKindDefinition,
  POSTING_KINDS,
  postsToLedger,
  sourceTypeOf,
  type DocumentKind,
  type DocumentStatus,
  type NumberedKind,
} from './types'
import { RECEIPT_KINDS } from '@shared/receipts'

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

  /*
   * The two facts 0013-2 split apart. `postsToLedger` is stored, in `@shared/documents`
   * where a screen can read it; the ledger's name for a kind is derived here. TypeScript
   * already refuses a table where one is present without the other — `SOURCE_TYPES` is
   * keyed by `PostingKind`, which is `Extract`ed from the shared table's literal `true`s
   * — so this asserts they agree at RUNTIME, which is the half a type cannot state.
   */
  it('has a source type for exactly the kinds that post', () => {
    for (const definition of DOCUMENT_KINDS) {
      expect(sourceTypeOf(definition.kind) !== null).toBe(postsToLedger(definition.kind))
    }
  })

  it('records a posting kind in the ledger under its own name', () => {
    /* What makes drill-through work in both directions: an entry's `source_type` is the
     * document's kind, so finding the document from the entry needs no mapping table. */
    for (const definition of DOCUMENT_KINDS) {
      const sourceType = sourceTypeOf(definition.kind)
      if (sourceType !== null) {
        expect(sourceType).toBe(definition.kind)
      }
    }
  })

  /* `POSTING_KINDS` is what the posting engine builds its rules from, so a kind missing
   * from it is a kind that cannot be issued however the table reads. */
  it('lists exactly the posting kinds, in table order', () => {
    expect(POSTING_KINDS.map((definition) => definition.kind)).toEqual(
      DOCUMENT_KINDS.filter((definition) => postsToLedger(definition.kind)).map(
        (definition) => definition.kind,
      ),
    )
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

/*
 * Numbering serves more than documents since 0012. A receipt voucher is numbered for the
 * reason an invoice is — rule 50 against rule 46(b) — and both draw from the same
 * counters, which are the one thing in this codebase that can hand a number to two
 * records twice.
 */
describe('the numbered kinds', () => {
  it('are every document kind and every voucher kind, documents first', () => {
    expect(NUMBERED_KINDS.map((definition) => definition.kind)).toEqual([
      ...DOCUMENT_KINDS.map((definition) => definition.kind),
      ...RECEIPT_KINDS.map((definition) => definition.kind),
    ])
  })

  /*
   * AND THE VOUCHER WORDS COME FROM THE VOUCHER TABLE, which is 0015 deleting a second
   * copy. `VOUCHER_KINDS` used to write out two labels by hand, on the stated grounds
   * that importing the receipt table would be a cycle — true of `@main/domain/receipts`
   * and not of `@shared/receipts`, which is where 0013-3 put the table. Nobody kept the
   * copies in step because nothing ever changed either; the batch that added two kinds
   * is the one that would have found out.
   */
  it('take a voucher kind words from the receipt kinds table', () => {
    for (const definition of RECEIPT_KINDS) {
      expect(numberedKindDefinition(definition.kind)).toMatchObject({
        label: definition.label,
        pluralLabel: definition.pluralLabel,
      })
    }
  })

  /* A document kind's label lives in `DOCUMENT_KINDS` and nowhere else. If this table
   * ever held its own copy, the two would drift and a picker would disagree with a
   * settings screen about what an invoice is called. */
  it('take a document kind words from the document kinds table', () => {
    for (const definition of DOCUMENT_KINDS) {
      expect(numberedKindDefinition(definition.kind)).toMatchObject({
        label: definition.label,
        pluralLabel: definition.pluralLabel,
      })
    }
  })

  /* Read off `postsToLedger` rather than off a list, so a kind added later answers by
   * declaring itself. A quotation supplies nothing, so its numbers run on. */
  it('reset yearly for everything that reaches the ledger, and not for what does not', () => {
    for (const definition of DOCUMENT_KINDS) {
      expect(numberedKindDefinition(definition.kind).resetsYearly).toBe(
        postsToLedger(definition.kind),
      )
    }
    /* Every voucher reaches the ledger — there is no receipt that records no money — so
     * all of them reset, and this is counted rather than listed for the same reason the
     * document arm is. */
    for (const definition of RECEIPT_KINDS) {
      expect(numberedKindDefinition(definition.kind).resetsYearly).toBe(true)
    }
  })

  it('refuse a kind this build does not know', () => {
    expect(() => numberedKindDefinition('delivery-note' as NumberedKind)).toThrow(/newer Coffer/)
  })
})
