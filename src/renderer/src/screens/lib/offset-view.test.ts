/*
 * The offset panel's vocabulary, and the two things it refuses to hold.
 *
 * The assertions worth reading are the ones about what is NOT in offset-view.ts. It has
 * no copy of `draftAllocations` and no copy of `settleInFull` — the last describe block
 * pins that as a test, because a second copy of either is what somebody adds when the
 * import looks like a layering violation and is not.
 *
 * Every question about the kind table is asked BY ITERATING IT rather than by listing
 * kinds, so a sixth kind is covered by these tests on the day it is added rather than on
 * the day somebody remembers to extend them. The by-value assertions sit beside the
 * iterations rather than instead of them: a rule derived from the table and an answer
 * pinned to a string catch different mistakes, and only the second can kill a mutant that
 * changes what the user reads.
 */

import { describe, expect, it } from 'vitest'

import { correctsKind, definitionOf, DOCUMENT_KINDS, type DocumentKind } from '@shared/documents'
import type { DocumentOffsetDto, OpenDocument } from '@shared/dto'

import { draftAllocations, settleInFull } from './receipt-view'

import { canOffset, isOffsetEditable, offsetsLabel, toOffsetInputs } from './offset-view'

const KINDS: readonly DocumentKind[] = DOCUMENT_KINDS.map((definition) => definition.kind)

/** Every state a document arrives in, and one this build does not know. */
const STATUSES: readonly string[] = ['draft', 'issued', 'cancelled', 'superseded']

describe('which kinds may be set against something', () => {
  /*
   * ITERATED OVER THE TABLE, with the expectation read off the same two fields the
   * function reads and written out independently of it. A kind added later is answered
   * for without this test being touched, and an inverted condition — `charge` where
   * `refund` was meant — fails on three rows rather than passing because the two new
   * kinds happened to be the ones nobody listed.
   *
   * THE LOOP ASSERTS BOTH ANSWERS APPEAR. A table that stopped producing one of them
   * would leave this passing over a question it no longer asks, which is the shape of a
   * measurement going missing rather than coming back clean.
   */
  it('answers for every kind in the table, from what the row declares', () => {
    const expected = DOCUMENT_KINDS.map((definition) => ({
      kind: definition.kind,
      allowed: definition.direction === 'refund' && definition.postsToLedger,
    }))

    for (const row of expected) {
      expect(canOffset(row.kind)).toBe(row.allowed)
    }

    expect(expected.some((row) => row.allowed)).toBe(true)
    expect(expected.some((row) => !row.allowed)).toBe(true)
  })

  /* The same answers pinned by value, which is what a mutation has to survive to be
   * called equivalent. The three refusals are three different reasons — see below. */
  it('lets the two notes offset and nothing else', () => {
    expect(canOffset('credit-note')).toBe(true)
    expect(canOffset('debit-note')).toBe(true)
    expect(canOffset('sales-invoice')).toBe(false)
    expect(canOffset('purchase-bill')).toBe(false)
    expect(canOffset('quotation')).toBe(false)
  })

  /*
   * THE INPUT THE DIRECTION TEST ALONE EXCLUDES. A sales invoice posts to the ledger, so
   * `postsToLedger` lets it through and only `direction === 'refund'` refuses it — and it
   * is the refusal that matters most, because an invoice is the end of the match that
   * does NOT own the set. Letting it through would give two screens the same set to
   * replace, and the last save would drop the other's rows silently.
   *
   * There is no matching input for `postsToLedger` alone: both refund kinds in the
   * shipped table post, so that half is an equivalent mutant here and offset-view.ts says
   * so beside the code. `postingKindIn` is where the same condition is exercised, because
   * it is handed a table.
   */
  it('refuses a kind that posts but is what gets settled', () => {
    expect(definitionOf('sales-invoice').postsToLedger).toBe(true)
    expect(canOffset('sales-invoice')).toBe(false)
  })

  /*
   * THE INVARIANT `offsetsLabel` RESTS ON, checked against a mapping derived somewhere
   * else. `correctsKind` comes from `correctionMap`, which counts the charge kinds on a
   * side rather than taking the first — so this says the panel is offered exactly where
   * there is a kind to head it with, and never where the heading would have to throw.
   */
  it('may offset exactly the kinds that have something to correct', () => {
    for (const kind of KINDS) {
      expect(canOffset(kind)).toBe(correctsKind(kind) !== null)
    }
  })
})

describe('when the panel may be edited', () => {
  it('is editable on an issued note, whichever side it is on', () => {
    expect(isOffsetEditable('credit-note', 'issued')).toBe(true)
    expect(isOffsetEditable('debit-note', 'issued')).toBe(true)
  })

  /*
   * THE INPUT THE STATUS TEST ALONE EXCLUDES: the right end of the match in the wrong
   * state. A draft has posted nothing and has no number, and a cancelled note's movement
   * has been reversed to nothing — `setOffsets` refuses both, so a panel offering a
   * picker here would be offering a save that can only fail.
   */
  it('refuses a note that is not issued, whatever else is true of it', () => {
    expect(isOffsetEditable('credit-note', 'draft')).toBe(false)
    expect(isOffsetEditable('credit-note', 'cancelled')).toBe(false)
    expect(isOffsetEditable('debit-note', 'draft')).toBe(false)
    expect(isOffsetEditable('debit-note', 'cancelled')).toBe(false)
  })

  /* A status this build does not know is not a state it may write against. */
  it('refuses a status it does not recognise', () => {
    expect(isOffsetEditable('credit-note', 'superseded')).toBe(false)
    expect(isOffsetEditable('credit-note', '')).toBe(false)
  })

  /* THE INPUT THE KIND TEST ALONE EXCLUDES, and every state of it: an invoice is issued
   * far more often than not, so the status test can never be what saves this. */
  it('refuses every state of a document that cannot offset at all', () => {
    for (const kind of KINDS.filter((each) => !canOffset(each))) {
      for (const status of STATUSES) {
        expect(isOffsetEditable(kind, status)).toBe(false)
      }
    }

    expect(isOffsetEditable('sales-invoice', 'issued')).toBe(false)
    expect(isOffsetEditable('purchase-bill', 'issued')).toBe(false)
  })

  /* Editing is a narrower question than offering the panel: everything editable can
   * offset, and the reverse does not hold. */
  it('never offers editing where offsetting itself is refused', () => {
    for (const kind of KINDS) {
      for (const status of STATUSES) {
        if (isOffsetEditable(kind, status)) expect(canOffset(kind)).toBe(true)
      }
    }
  })
})

describe('what the offsets list is called', () => {
  /*
   * READ OFF THE DOCUMENT TABLE, and pinned to the words a user reads. A credit note
   * settles sales invoices; a debit note settles purchase bills. A transposition inside
   * `correctsKind` would print one over the other, and both headings would still be real
   * words on a real screen.
   */
  it('names the charges each note settles', () => {
    expect(offsetsLabel('credit-note')).toBe('Sales invoices')
    expect(offsetsLabel('debit-note')).toBe('Purchase bills')
  })

  /* The plural, because it heads a list. The singular is what `settlesLabel` uses for a
   * field, and one is not a near-enough version of the other. */
  it('heads the list in the plural', () => {
    expect(offsetsLabel('credit-note')).toBe(definitionOf('sales-invoice').pluralLabel)
    expect(offsetsLabel('credit-note')).not.toBe(definitionOf('sales-invoice').label)
  })

  /*
   * THE MISTAKE THAT READS PLAUSIBLY. A heading taken from the note's own row — "Credit
   * notes" over the list of invoices a credit note settles — is a real label in the right
   * grammatical place, and nothing on the page contradicts it.
   */
  it("is the charge kind's word, never the note's own", () => {
    expect(offsetsLabel('credit-note')).not.toBe(definitionOf('credit-note').pluralLabel)
    expect(offsetsLabel('debit-note')).not.toBe(definitionOf('debit-note').pluralLabel)
  })

  it('gives the two notes different headings', () => {
    const headings = KINDS.filter(canOffset).map(offsetsLabel)

    expect(new Set(headings).size).toBe(headings.length)
    expect(headings.length).toBeGreaterThan(1)
  })

  /*
   * A KIND THAT CORRECTS NOTHING IS A REFUSAL, NOT A BLANK. It cannot happen through the
   * UI — the panel is drawn behind `canOffset` — so it is a screen asking the wrong end of
   * the match, and the sentence has to name the kind it was asked about and the guard that
   * should have been asked first. Silence here would draw a nameless panel over a picker
   * that can never fill.
   */
  it('refuses to head a panel for a document that settles nothing', () => {
    expect(() => offsetsLabel('sales-invoice')).toThrow(/sales invoice/)
    expect(() => offsetsLabel('sales-invoice')).toThrow(/canOffset/)
    expect(() => offsetsLabel('quotation')).toThrow(/quotation/)
    expect(() => offsetsLabel('purchase-bill')).toThrow(/purchase bill/)
  })

  /*
   * BOTH BRANCHES OVER THE WHOLE TABLE, counted so the loop cannot go vacuous: every kind
   * either heads its charges or refuses, and which one it does agrees with `canOffset`.
   * Counted rather than pinned at two and three, so a sixth kind needs no edit here.
   */
  it('either names the charges or refuses, for every kind in the table', () => {
    let headed = 0
    let refused = 0

    for (const kind of KINDS) {
      const chargeKind = correctsKind(kind)
      if (chargeKind === null) {
        expect(() => offsetsLabel(kind)).toThrow()
        refused += 1
      } else {
        expect(offsetsLabel(kind)).toBe(definitionOf(chargeKind).pluralLabel)
        headed += 1
      }
    }

    expect(headed + refused).toBe(KINDS.length)
    expect(headed).toBeGreaterThan(0)
    expect(refused).toBeGreaterThan(0)
  })
})

describe('what is sent', () => {
  /*
   * THE FIELD NAME IS THE WHOLE REASON THIS FUNCTION EXISTS. `OffsetInput` says
   * `chargeDocumentId` where `AllocationInput` says `documentId`, because an offset has a
   * document at both ends — and a payload with the other name reaches `setOffsets` as an
   * offset against `undefined`, which the repository answers with "that document is not
   * in these books" rather than with anything a user could act on.
   */
  it('names the document field for the end it is', () => {
    const [line] = toOffsetInputs({ 'inv-1': '500.00' })

    expect(line).toEqual({ chargeDocumentId: 'inv-1', amount: '500.00' })
    expect(line).toHaveProperty('chargeDocumentId', 'inv-1')
    expect(line).not.toHaveProperty('documentId')
  })

  /*
   * A BLANK IS NOT A ZERO. An offset of nothing is not a statement and main refuses one,
   * so a row nobody filled in is left out rather than sent as '0.00' — and a row of
   * spaces is a row nobody filled in.
   */
  it('leaves out a line nobody filled in', () => {
    expect(toOffsetInputs({ 'inv-1': '', 'inv-2': '   ', 'inv-3': '100.00' })).toEqual([
      { chargeDocumentId: 'inv-3', amount: '100.00' },
    ])
  })

  /*
   * AND THE OTHER HALF OF IT, WHICH IS THE HALF THAT GETS DROPPED. A typed zero IS sent.
   * The user meant something by typing it, main answers with "an offset of nothing is not
   * a statement. Take the line off instead", and silently dropping it would leave them
   * looking at a line the books do not have.
   */
  it('sends a zero somebody actually typed', () => {
    expect(toOffsetInputs({ 'inv-1': '0' })).toEqual([{ chargeDocumentId: 'inv-1', amount: '0' }])
    expect(toOffsetInputs({ 'inv-1': '0.00' })).toEqual([
      { chargeDocumentId: 'inv-1', amount: '0.00' },
    ])
  })

  it('trims what it sends', () => {
    expect(toOffsetInputs({ 'inv-1': '  500.00  ' })).toEqual([
      { chargeDocumentId: 'inv-1', amount: '500.00' },
    ])
  })

  it('sends nothing at all when nothing is filled in', () => {
    expect(toOffsetInputs({ 'inv-1': '', 'inv-2': '  ' })).toEqual([])
    expect(toOffsetInputs({})).toEqual([])
  })

  /*
   * THE FIXTURE DISAGREES WITH EVERY ORDER SOMETHING MIGHT BE SORTED INTO — not by id, not
   * by amount — so a version that sorted the lines on the way out would fail here. The
   * rows go in the order the picker drew them, which is the order main listed the open
   * charges in, and a save that reordered a user's lines would be the panel disagreeing
   * with itself the moment it redrew.
   */
  it('keeps the lines in the order the picker drew them', () => {
    expect(toOffsetInputs({ 'inv-9': '10.00', 'inv-2': '', 'inv-4': '900.00' })).toEqual([
      { chargeDocumentId: 'inv-9', amount: '10.00' },
      { chargeDocumentId: 'inv-4', amount: '900.00' },
    ])
  })
})

describe('what this module deliberately does not hold', () => {
  const offsetRow = (over: Partial<DocumentOffsetDto> = {}): DocumentOffsetDto => ({
    offsetId: 'off-1',
    documentId: 'inv-1',
    documentKind: 'sales-invoice',
    documentNumber: 'INV/2026-27/0001',
    documentDate: '2026-04-15',
    amount: '400.00',
    ...over,
  })

  const openCharge = (over: Partial<OpenDocument> = {}): OpenDocument => ({
    id: 'inv-1',
    kind: 'sales-invoice',
    number: 'INV/2026-27/0001',
    date: '2026-04-15',
    grandTotal: '1180.00',
    outstanding: '1180.00',
    ...over,
  })

  /*
   * THE REUSE, ASSERTED RATHER THAN ASSUMED. The panel imports `draftAllocations` and
   * `settleInFull` from receipt-view.ts because an offset needs exactly the shapes a
   * receipt's allocations already have — `DocumentOffsetDto` structurally satisfies the
   * `{ documentId, amount }` the first reads, and the charge picker is filled with
   * `OpenDocument`s. This test is here so that the claim is checked by something other
   * than the next reader's judgement: if either signature drifts, the copy nobody wants
   * gets written because the import stopped compiling.
   *
   * THE OPEN CHARGES ARE OUT OF ORDER AND THE SEED IS FOR THE SECOND OF THEM, so a
   * version that keyed by position rather than by document would come back wrong.
   */
  it("reuses the receipt editor's shapes instead of copying them", () => {
    const drafts = draftAllocations(
      [openCharge({ id: 'inv-7' }), openCharge({ id: 'inv-2' })],
      [offsetRow({ documentId: 'inv-2', amount: '400.00' })],
    )

    expect(drafts).toEqual({ 'inv-7': '', 'inv-2': '400.00' })
    expect(toOffsetInputs(drafts)).toEqual([{ chargeDocumentId: 'inv-2', amount: '400.00' }])
    expect(settleInFull(openCharge({ outstanding: '680.00' }))).toBe('680.00')
  })

  /*
   * §1.7 AS AN ASSERTION, and the deletions this batch is meant to avoid. Nothing here
   * adds two amounts together — what is left of a note comes back from `setOffsets` as
   * `DocumentSettlement.outstanding` — and nothing here is an offset-shaped copy of a
   * function receipt-view.ts already exports.
   */
  it('exports nothing that adds up money and no copy of what it reuses', async () => {
    const module: Record<string, unknown> = await import('./offset-view')

    for (const forbidden of [
      'draftOffsets',
      'draftAllocations',
      'settleInFull',
      'offsetInFull',
      'offsetTotal',
      'remaining',
      'sumOffsets',
    ]) {
      expect(Object.keys(module)).not.toContain(forbidden)
    }
  })
})
