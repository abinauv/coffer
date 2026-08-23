import { describe, expect, it } from 'vitest'
import { DOCUMENT_KINDS, type DocumentKind } from '@shared/documents'
import type { Document, DocumentLineDto } from '@shared/dto'
import {
  blankLine,
  canCancel,
  canDelete,
  canEdit,
  canIssue,
  isBlankDraft,
  isLineReady,
  lineDraftOf,
  linesFrom,
  readyLines,
  stateSentence,
  toLineInput,
  type LineDraft,
} from './document-editor'

const KINDS: readonly DocumentKind[] = DOCUMENT_KINDS.map((definition) => definition.kind)

function draft(over: Partial<LineDraft> = {}): LineDraft {
  return { ...blankLine(), description: 'Ball bearing 6203', unitPrice: '500.00', ...over }
}

describe('toLineInput', () => {
  /*
   * THE ASSERTION THIS MODULE EXISTS FOR. `taxableAmount` and `taxes` are the regime's
   * answer and are not on `DocumentLineInput` at all — the repository's `TaxedLineInput`
   * is the shape that carries them, and only src/main/documents may build one. A screen
   * that invented either would be putting a figure in the books that no regime computed.
   */
  it('sends no taxable amount and no tax, because neither is the screen to know', () => {
    const input = toLineInput(draft({ quantity: '2', unitPrice: '500.00' }))

    expect(input).not.toHaveProperty('taxableAmount')
    expect(input).not.toHaveProperty('taxes')
    expect(Object.keys(input).sort()).toEqual([
      'classificationCode',
      'description',
      'discount',
      'quantity',
      'unitPrice',
    ])
  })

  it('trims what was typed', () => {
    const input = toLineInput(draft({ description: '  Ball bearing  ', quantity: ' 2 ' }))

    expect(input.description).toBe('Ball bearing')
    expect(input.quantity).toBe('2')
  })

  /* A discount is a figure and its absence is zero — the repository takes a decimal
   * string, not a blank. */
  it('sends a missing discount as zero', () => {
    expect(toLineInput(draft({ discount: '' })).discount).toBe('0')
    expect(toLineInput(draft({ discount: '50' })).discount).toBe('50')
  })

  /*
   * A MISSING RATE IS LEFT ABSENT, WHICH IS NOT THE SAME CHOICE AS THE DISCOUNT ABOVE.
   * `DocumentLineInput.ratePct` documents absent as nil-rated — a rate, and one the
   * regime decides the treatment of. Sending '0' would be the screen asserting a rate it
   * was never given.
   */
  it('leaves a missing rate absent rather than calling it zero', () => {
    expect(toLineInput(draft({ ratePct: '' }))).not.toHaveProperty('ratePct')
    expect(toLineInput(draft({ ratePct: '18' })).ratePct).toBe('18')
  })

  it('sends a missing classification as null rather than as a blank string', () => {
    expect(toLineInput(draft({ classificationCode: '' })).classificationCode).toBeNull()
    expect(toLineInput(draft({ classificationCode: ' 8471 ' })).classificationCode).toBe('8471')
  })
})

describe('isLineReady', () => {
  it('needs a description, a quantity and a price', () => {
    expect(isLineReady(draft())).toBe(true)
    expect(isLineReady(draft({ description: '   ' }))).toBe(false)
    expect(isLineReady(draft({ quantity: '' }))).toBe(false)
    expect(isLineReady(draft({ unitPrice: '' }))).toBe(false)
  })

  /* A SHAPE CHECK, NOT A VALUE CHECK. Whether '2.5.1' is a decimal string is main's
   * question, and its refusal is a sentence written for the user. */
  it('does not judge whether a figure is a figure', () => {
    expect(isLineReady(draft({ quantity: 'two' }))).toBe(true)
  })

  it('keeps only the finished rows', () => {
    const rows = [draft(), draft({ description: '' }), draft({ unitPrice: '10' })]

    expect(readyLines(rows)).toHaveLength(2)
  })
})

describe('blankLine and lineDraftOf', () => {
  /* Keys are what stop two rows swapping contents when one above them is removed. */
  it('gives every row a key of its own', () => {
    const keys = [blankLine().key, blankLine().key, blankLine().key]

    expect(new Set(keys).size).toBe(3)
  })

  it('starts a new row at one, because that is what most lines are', () => {
    expect(blankLine().quantity).toBe('1')
    expect(blankLine().description).toBe('')
  })

  it('reads a stored line back into the form, nulls and all', () => {
    const stored: DocumentLineDto = {
      id: 'line-1',
      lineNumber: 1,
      itemId: null,
      description: 'Ball bearing 6203',
      quantity: '2.000',
      unitCode: null,
      unitPrice: '500.00',
      discount: '0.00',
      taxableAmount: '1000.00',
      ratePct: '18.000',
      classificationCode: null,
      isCharge: false,
      accountId: null,
      taxes: [],
    }

    const row = lineDraftOf(stored)

    expect(row.description).toBe('Ball bearing 6203')
    expect(row.quantity).toBe('2.000')
    expect(row.ratePct).toBe('18.000')
    /* An absent classification is an empty box, not the word null. */
    expect(row.classificationCode).toBe('')
  })
})

describe('what may be done in each state', () => {
  /*
   * The table from src/main/domain/documents/types.ts, mirrored so a button that would be
   * refused is never offered:
   *
   *   draft      edit, delete, issue
   *   issued     cancel
   *   cancelled  nothing
   */
  it('lets a draft be edited, issued and deleted', () => {
    expect(canEdit('draft')).toBe(true)
    expect(canIssue('draft')).toBe(true)
    expect(canDelete('draft')).toBe(true)
    expect(canCancel('draft')).toBe(false)
  })

  /*
   * AN ISSUED INVOICE IS NEVER DELETED AND NEVER EDITED. It has a number that was
   * reported, an entry in the ledger and a place in a series — removing it leaves a gap
   * that reads as a document somebody hid. Cancelling is the only way back.
   */
  it('lets an issued invoice be cancelled and nothing else', () => {
    expect(canCancel('issued')).toBe(true)
    expect(canEdit('issued')).toBe(false)
    expect(canDelete('issued')).toBe(false)
    expect(canIssue('issued')).toBe(false)
  })

  it('offers nothing at all on a cancelled one', () => {
    expect(canEdit('cancelled')).toBe(false)
    expect(canIssue('cancelled')).toBe(false)
    expect(canCancel('cancelled')).toBe(false)
    expect(canDelete('cancelled')).toBe(false)
  })
})

describe('stateSentence', () => {
  it('says a draft is not in the books', () => {
    expect(stateSentence('sales-invoice', 'draft', null)).toContain('Nothing is in the books')
  })

  it('names the number an issued document was given', () => {
    const sentence = stateSentence('sales-invoice', 'issued', 'INV/2026-27/0001')

    expect(sentence).toContain('INV/2026-27/0001')
    expect(sentence).toContain('cannot be edited')
  })

  /* The number is KEPT through cancellation — rule 2. Saying so is what stops somebody
   * looking for the hole in the series. */
  it('says the number is kept when the document was cancelled', () => {
    const sentence = stateSentence('credit-note', 'cancelled', 'CRN/2026-27/0001')

    expect(sentence).toContain('CRN/2026-27/0001')
    expect(sentence).toContain('kept')
    expect(sentence).toContain('reversed')
  })

  /*
   * THE ONE KIND THAT NEEDS ITS OWN WORDS, AND WHY THE FUNCTION TAKES A KIND. "Nothing is
   * in the books until it is issued" is false of a quotation in the direction that costs
   * something: issuing one still puts nothing there. A user taught that issuing is what
   * posts would be surprised by their first credit note.
   */
  it('never promises a quotation reaches the books', () => {
    for (const status of ['draft', 'issued', 'cancelled'] as const) {
      expect(stateSentence('quotation', status, 'QTN/2026-27/0001')).not.toContain(
        'until it is issued',
      )
    }
    expect(stateSentence('quotation', 'draft', null)).toContain('never reaches the books')
    expect(stateSentence('quotation', 'cancelled', 'QTN/1')).not.toContain('reversed')
  })

  /* Every other kind shares the invoice's sentences, which is the argument for one
   * editor. A kind quietly given different words would mean the rules had diverged. */
  it('says the same thing for every kind that posts', () => {
    const posting = KINDS.filter((kind) => kind !== 'quotation')
    const sentences = posting.map((kind) => stateSentence(kind, 'draft', null))

    expect(new Set(sentences).size).toBe(1)
  })

  /* A draft has no number and must not be described as if it had one. */
  it('stands in for the number a draft does not have, in its own words', () => {
    expect(stateSentence('debit-note', 'issued', null)).toContain('a numbered debit note')
  })
})

describe('isBlankDraft', () => {
  /*
   * WHAT GUARDS THE LINE COPY. Choosing the invoice a credit note corrects fills the
   * lines in, and it must never do that over work in progress.
   */
  it('is true of the row a new document starts with', () => {
    expect(isBlankDraft([blankLine()])).toBe(true)
    expect(isBlankDraft([blankLine(), blankLine()])).toBe(true)
  })

  /*
   * STRICTER THAN `isLineReady`, and this is the case that matters: a row with a
   * description and no price is not ready to SEND, and is plainly something somebody was
   * in the middle of typing. Treating "not ready" as "empty" would discard it.
   */
  it('is false of a half-typed row that is not ready to send', () => {
    const halfTyped = { ...blankLine(), description: 'Ball bearing 6203' }

    expect(isLineReady(halfTyped)).toBe(false)
    expect(isBlankDraft([halfTyped])).toBe(false)
  })

  it('is false when any row has been touched, not only the first', () => {
    expect(isBlankDraft([blankLine(), { ...blankLine(), unitPrice: '10.00' }])).toBe(false)
    expect(isBlankDraft([blankLine(), { ...blankLine(), discount: '5' }])).toBe(false)
    expect(isBlankDraft([blankLine(), { ...blankLine(), ratePct: '18' }])).toBe(false)
    expect(isBlankDraft([blankLine(), { ...blankLine(), classificationCode: '8482' }])).toBe(false)
  })

  /* The quantity starts at 1, so a user who has changed only that has typed nothing that
   * would be lost. Left out of the check on purpose. */
  it('ignores the quantity, which starts filled in', () => {
    expect(isBlankDraft([{ ...blankLine(), quantity: '3' }])).toBe(true)
  })
})

describe('linesFrom', () => {
  const original = {
    lines: [
      {
        id: 'line-1',
        lineNumber: 1,
        itemId: null,
        description: 'Ball bearing 6203',
        quantity: '10.000',
        unitCode: 'nos',
        unitPrice: '500.00',
        discount: '50.00',
        taxableAmount: '4950.00',
        ratePct: '18.000',
        classificationCode: '8482',
        isCharge: false,
        accountId: null,
        taxes: [{ code: 'CGST', label: 'CGST @ 9%', ratePct: '9.000', amount: '445.50' }],
      },
    ],
  } as unknown as Document

  /*
   * WHAT CROSSES IS WHAT A PERSON TYPED. The taxable amount and the tax are the regime's
   * answer as of the ORIGINAL's date; copying them into a correction would carry a rate
   * that may since have changed, and would be renderer-held money besides. The service
   * re-asks on save. `LineDraft` has no field for either, which is what makes this safe —
   * the assertion is here so that adding one is a decision rather than an accident.
   */
  it('copies the five figures a person typed and nothing derived', () => {
    const [line] = linesFrom(original)

    expect(line).toMatchObject({
      description: 'Ball bearing 6203',
      quantity: '10.000',
      unitPrice: '500.00',
      discount: '50.00',
      ratePct: '18.000',
      classificationCode: '8482',
    })
    expect(line).not.toHaveProperty('taxableAmount')
    expect(line).not.toHaveProperty('taxes')
  })

  /* A document with no lines is not a reason to hand back an empty table nobody can type
   * into — the editor always shows at least one row. */
  it('gives back a blank row when there is nothing to copy', () => {
    const empty = { lines: [] } as unknown as Document

    expect(linesFrom(empty)).toHaveLength(1)
    expect(isBlankDraft(linesFrom(empty))).toBe(true)
  })

  /* Keys are local to the session and must not collide with the rows already on screen,
   * or React swaps two rows' contents. */
  it('gives every copied row a key of its own', () => {
    const keys = [...linesFrom(original), ...linesFrom(original)].map((line) => line.key)

    expect(new Set(keys).size).toBe(keys.length)
  })
})
