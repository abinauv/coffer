/*
 * The kind table, tested where it now lives.
 *
 * Most of what this table says is asserted where it is USED — the posting engine proves
 * the sides and directions reach the right accounts, and `issuing.test.ts` proves the
 * correction mapping agrees with migration 0013's SQL. What is here is what belongs to
 * the table itself: that the words are usable, that the mapping is well defined rather
 * than merely correct today, and that a kind cannot be added in a shape the screens
 * would draw wrongly.
 */

import { describe, expect, it } from 'vitest'
import {
  chargeKindOn,
  correctionMap,
  correctsKind,
  definitionOf,
  DOCUMENT_KINDS,
  kindsOnSide,
  postsToLedger,
  type DocumentKind,
  type DocumentKindDefinition,
} from './documents'

const KINDS: readonly DocumentKind[] = DOCUMENT_KINDS.map((definition) => definition.kind)

describe('the words', () => {
  /*
   * Two kinds sharing a label means one register, one editor heading and one "New …"
   * button describe the other. The renderer builds all of those from these strings and
   * nothing else, so a duplicate is invisible in the code and obvious on the screen.
   */
  it('gives every kind a label and a plural of its own', () => {
    const labels = DOCUMENT_KINDS.map((definition) => definition.label)
    const plurals = DOCUMENT_KINDS.map((definition) => definition.pluralLabel)

    expect(new Set(labels).size).toBe(labels.length)
    expect(new Set(plurals).size).toBe(plurals.length)
  })

  /* English is irregular enough that the plural is stored rather than derived. A plural
   * equal to its singular means somebody filled the field in by copying. */
  it('never uses the singular as the plural', () => {
    for (const definition of DOCUMENT_KINDS) {
      expect(definition.pluralLabel).not.toBe(definition.label)
    }
  })

  it('writes a label a sentence can lower-case without losing a proper noun', () => {
    for (const definition of DOCUMENT_KINDS) {
      expect(definition.label).toMatch(/^[A-Z][a-z ]+$/)
    }
  })
})

describe('definitionOf', () => {
  it('answers for every kind in the table', () => {
    for (const kind of KINDS) {
      expect(definitionOf(kind).kind).toBe(kind)
    }
  })

  /*
   * A kind read off a company file written by a newer build is the only way this is
   * reached, and saying so beats rendering a document whose treatment this build does not
   * know. The type system has already narrowed every ordinary caller.
   */
  it('refuses a kind this build does not know, and says what to do', () => {
    expect(() => definitionOf('delivery-challan' as DocumentKind)).toThrow(/newer Coffer/)
  })
})

describe('the sides', () => {
  it('splits the table between the two sides with nothing left over', () => {
    expect([...kindsOnSide('sales'), ...kindsOnSide('purchase')]).toHaveLength(
      DOCUMENT_KINDS.length,
    )
  })

  it('keeps the table order within a side, which is the order a menu lists them', () => {
    expect(kindsOnSide('sales').map((definition) => definition.kind)).toEqual([
      'sales-invoice',
      'quotation',
      'credit-note',
    ])
  })
})

describe('correctsKind', () => {
  it('points a refund at the charge on its own side', () => {
    expect(correctsKind('credit-note')).toBe('sales-invoice')
    expect(correctsKind('debit-note')).toBe('purchase-bill')
  })

  it('gives nothing for a kind that corrects nothing', () => {
    expect(correctsKind('sales-invoice')).toBeNull()
    expect(correctsKind('purchase-bill')).toBeNull()
    expect(correctsKind('quotation')).toBeNull()
  })

  /*
   * THE ASSERTION THE FIRST VERSION OF THIS RULE COULD NOT MAKE.
   *
   * A quotation is `sales` and `charge` too, so "the charge kind on the same side" has
   * two answers and `.find` silently returns whichever the table lists first. Migration
   * 0013's test derived it exactly that way and passed for that reason alone. What makes
   * it well defined is that a quotation posts nothing — there is no supply to correct —
   * and this is what pins that rather than the ordering.
   */
  it('never points at a kind that reaches no ledger', () => {
    for (const kind of KINDS) {
      const corrected = correctsKind(kind)
      if (corrected !== null) {
        expect(postsToLedger(corrected)).toBe(true)
      }
    }
  })

  it('never points at itself, or at another refund', () => {
    for (const kind of KINDS) {
      const corrected = correctsKind(kind)
      if (corrected !== null) {
        expect(corrected).not.toBe(kind)
        expect(definitionOf(corrected).direction).toBe('charge')
        expect(definitionOf(corrected).side).toBe(definitionOf(kind).side)
      }
    }
  })

  /* Exactly the refund kinds have an answer. A charge with one would be a document that
   * corrects something, which is not what "charge" means. */
  it('answers for exactly the refund kinds', () => {
    expect(KINDS.filter((kind) => correctsKind(kind) !== null)).toEqual(
      KINDS.filter((kind) => definitionOf(kind).direction === 'refund'),
    )
  })
})

describe('chargeKindOn', () => {
  /* What a receipt settles and what a credit note corrects are the same fact asked from
   * two ends — 0013-3 is where the second caller arrived. */
  it('names the one posting charge kind on each side', () => {
    expect(chargeKindOn('sales')).toBe('sales-invoice')
    expect(chargeKindOn('purchase')).toBe('purchase-bill')
  })

  it('agrees with what a refund on that side corrects', () => {
    for (const kind of KINDS.filter((each) => definitionOf(each).direction === 'refund')) {
      expect(correctsKind(kind)).toBe(chargeKindOn(definitionOf(kind).side))
    }
  })
})

describe('correctionMap, given a table the real one cannot be', () => {
  /*
   * WHY THIS TAKES AN ARGUMENT AT ALL. The guard it exercises cannot fire on the shipped
   * table — that is the point of the guard — so a mutation removing it survived the whole
   * suite, and the choice was between accepting an untestable line and letting a test
   * build the table it guards against. The second is cheap and says what the rule is.
   */
  const kind = (over: Partial<DocumentKindDefinition>): DocumentKindDefinition => ({
    kind: 'sales-invoice',
    label: 'Sales invoice',
    pluralLabel: 'Sales invoices',
    side: 'sales',
    direction: 'charge',
    postsToLedger: true,
    ...over,
  })

  it('maps a refund to the one charge on its side', () => {
    const map = correctionMap([kind({}), kind({ kind: 'credit-note', direction: 'refund' })])

    expect(map.get('credit-note')).toBe('sales-invoice')
  })

  /*
   * THE AMBIGUITY, WHICH TAKING THE FIRST MATCH WOULD HIDE. Two charge kinds that both
   * post on one side means "the invoice this corrects" has two answers, and a `.find`
   * would quietly return whichever was listed first — making the rule table order.
   */
  it('refuses a side with two charges that post', () => {
    expect(() =>
      correctionMap([
        kind({}),
        kind({ kind: 'quotation' }),
        kind({ kind: 'credit-note', direction: 'refund' }),
      ]),
    ).toThrow(/credit-note names 2 kinds on the sales side/)
  })

  /* And a side with none: a refund that corrects nothing that exists is a link the
   * database would refuse, offered by a picker with nothing in it. */
  it('refuses a side with no charge that posts', () => {
    expect(() =>
      correctionMap([
        kind({ postsToLedger: false }),
        kind({ kind: 'credit-note', direction: 'refund' }),
      ]),
    ).toThrow(/credit-note names 0 kinds on the sales side/)
  })

  /* A table with no refunds in it maps nothing, rather than being a case somebody has to
   * remember to guard. */
  it('maps nothing when nothing corrects anything', () => {
    expect(correctionMap([kind({})]).size).toBe(0)
  })
})
