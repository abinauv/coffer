import { describe, expect, it } from 'vitest'
import type { DocumentLineDto } from '@shared/dto'
import {
  blankLine,
  canCancel,
  canDelete,
  canEdit,
  canIssue,
  isLineReady,
  lineDraftOf,
  readyLines,
  stateSentence,
  toLineInput,
  type LineDraft,
} from './invoice-editor'

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
    expect(stateSentence('draft', null)).toContain('Nothing is in the books')
  })

  it('names the number an issued invoice was given', () => {
    expect(stateSentence('issued', 'INV/2026-27/0001')).toContain('INV/2026-27/0001')
    expect(stateSentence('issued', 'INV/2026-27/0001')).toContain('cannot be edited')
  })

  /* The number is KEPT through cancellation — rule 2. Saying so is what stops somebody
   * looking for the hole in the series. */
  it('says the number is kept when the invoice was cancelled', () => {
    const sentence = stateSentence('cancelled', 'INV/2026-27/0001')

    expect(sentence).toContain('INV/2026-27/0001')
    expect(sentence).toContain('kept')
    expect(sentence).toContain('reversed')
  })
})
