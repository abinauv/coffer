import { describe, expect, it } from 'vitest'
import { DOCUMENT_KINDS, type DocumentKind } from '@shared/documents'
import type { Account, Document, DocumentLineDto, ItemSummary } from '@shared/dto'
import {
  blankLine,
  canCancel,
  canDelete,
  canEdit,
  canIssue,
  clearItem,
  isBlankDraft,
  isLineReady,
  itemSideFor,
  lineDraftOf,
  lineFromItem,
  linesFrom,
  postableAccounts,
  readyLines,
  stateSentence,
  toLineInput,
  type LineDraft,
} from './document-editor'

const KINDS: readonly DocumentKind[] = DOCUMENT_KINDS.map((definition) => definition.kind)

function draft(over: Partial<LineDraft> = {}): LineDraft {
  return { ...blankLine(), description: 'Ball bearing 6203', unitPrice: '500.00', ...over }
}

/** An item as `items.list` sends one. Every default filled in, so a test can null one. */
function item(over: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: 'item-2',
    code: 'SEAL-25',
    name: 'Oil seal 25x40',
    kind: 'goods',
    unitCode: 'KGS',
    classificationCode: '4016',
    taxRatePct: '12.000',
    salePrice: '90.00',
    purchasePrice: null,
    salesAccountId: null,
    purchaseAccountId: null,
    isSold: true,
    isPurchased: true,
    isCharge: false,
    isArchived: false,
    ...over,
  }
}

function account(over: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    code: '5210',
    name: 'Courier and Postage',
    type: 'expense',
    normalBalance: 'debit',
    parentId: null,
    isGroup: false,
    isArchived: false,
    description: null,
    depth: 2,
    roles: [],
    ...over,
  }
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

  /*
   * THE HALF THAT WAS MISSING UNTIL 0017, AND THE REASON THIS BATCH EXISTS. `itemId`,
   * `unitCode`, `isCharge` and `accountId` have been on `DocumentLineInput` since the
   * contract was written and this function did not send any of them, so a document opened
   * and saved came back with its lines unlinked from the item master.
   */
  it('sends the item the line was picked from', () => {
    expect(toLineInput(draft({ itemId: 'item-2' })).itemId).toBe('item-2')
  })

  it('sends the unit a quantity is counted in', () => {
    expect(toLineInput(draft({ unitCode: 'KGS' })).unitCode).toBe('KGS')
  })

  /* What sends the line to `freight-outward` or `freight-inward` instead of to sales or
   * purchases (posting.ts). Absent is not "unknown" — the repository writes
   * `isCharge === true ? 1 : 0`, so absent IS false and there is no third state. */
  it('marks a charge line, and says nothing at all about an ordinary one', () => {
    expect(toLineInput(draft({ isCharge: true })).isCharge).toBe(true)
    expect(toLineInput(draft({ isCharge: false }))).not.toHaveProperty('isCharge')
  })

  /* An account named on the line beats the role default — `valueAccountFor` looks here
   * first. It is what makes an expense on a purchase bill reachable at all. */
  it('sends an account named on the line', () => {
    expect(toLineInput(draft({ accountId: 'acc-courier' })).accountId).toBe('acc-courier')
  })

  /*
   * NOTHING PICKED SENDS NOTHING, which is the pair to the four above. Absent and null are
   * the same thing at this boundary — the handler's `optional` reads null as absent — and
   * a save replaces every line, so there is no stored value an omission could fail to
   * clear. A free-text line's input is byte for byte what it was before this batch.
   */
  it('leaves out every picked field the user picked nothing for', () => {
    const input = toLineInput(draft())

    expect(input).not.toHaveProperty('itemId')
    expect(input).not.toHaveProperty('unitCode')
    expect(input).not.toHaveProperty('isCharge')
    expect(input).not.toHaveProperty('accountId')
  })

  /* And all four together, because a line is sent as one thing. */
  it('sends all four of them at once when all four were chosen', () => {
    const input = toLineInput(
      draft({ itemId: 'item-2', unitCode: 'KGS', isCharge: true, accountId: 'acc-courier' }),
    )

    expect(input).toMatchObject({
      itemId: 'item-2',
      unitCode: 'KGS',
      isCharge: true,
      accountId: 'acc-courier',
    })
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

  /*
   * THE DROP, AT THE LEVEL WHERE IT HAPPENED. This function read six of a stored line's
   * ten fields, so the four it skipped were gone the moment a document was opened — and
   * `toLineInput` could not send back what the form had never been given. The editor's own
   * test asserts the same thing across the IPC boundary; this one names the function.
   */
  it('reads the item, the unit, the charge flag and the account off a stored line', () => {
    const stored: DocumentLineDto = {
      id: 'line-1',
      lineNumber: 1,
      itemId: 'item-2',
      description: 'Oil seal 25x40',
      quantity: '2.000',
      unitCode: 'KGS',
      unitPrice: '90.00',
      discount: '0.00',
      taxableAmount: '180.00',
      ratePct: '12.000',
      classificationCode: '4016',
      isCharge: true,
      accountId: 'acc-courier',
      taxes: [],
    }

    expect(lineDraftOf(stored)).toMatchObject({
      itemId: 'item-2',
      unitCode: 'KGS',
      isCharge: true,
      accountId: 'acc-courier',
    })
  })

  /* And a nil in any of them is an empty picker rather than the word null, for the reason
   * the classification is: `''` is what a `<select>`'s empty option carries. */
  it('reads a line that picked nothing as empty pickers, not as nulls', () => {
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

    expect(lineDraftOf(stored)).toMatchObject({ itemId: '', unitCode: '', accountId: '' })
  })

  it('starts a new row picking nothing at all', () => {
    expect(blankLine()).toMatchObject({
      itemId: '',
      unitCode: '',
      isCharge: false,
      accountId: '',
    })
  })
})

describe('itemSideFor', () => {
  /* A total record over the two sides (CONVENTIONS §1.9), so a third side would not
   * compile rather than silently taking whichever branch was written last. */
  it('asks for what is sold on a sale and what is bought on a purchase', () => {
    expect(itemSideFor('sales')).toBe('sold')
    expect(itemSideFor('purchase')).toBe('purchased')
  })
})

describe('lineFromItem', () => {
  /*
   * A COPY, NOT A REFERENCE — which `dto.ts` states twice and this proves once. Every
   * field on an item is a DEFAULT for a line, so the picker fills the boxes and lets go:
   * the line stores its own description, price and rate, and repricing the item next year
   * cannot rewrite an invoice already issued.
   */
  it('fills the line from the item and keeps the item as what the line is', () => {
    const filled = lineFromItem(blankLine(), item(), 'sales')

    expect(filled).toMatchObject({
      itemId: 'item-2',
      description: 'Oil seal 25x40',
      unitCode: 'KGS',
      unitPrice: '90.00',
      ratePct: '12.000',
      classificationCode: '4016',
      isCharge: false,
    })
  })

  /* THE POINT OF THE COPY. Editing what was printed does not change what the line IS. */
  it('is still that item after the description is rewritten', () => {
    const filled = lineFromItem(blankLine(), item(), 'sales')
    const edited = { ...filled, description: 'Oil seal, as agreed on the phone' }

    expect(toLineInput(edited).itemId).toBe('item-2')
    expect(toLineInput(edited).description).toBe('Oil seal, as agreed on the phone')
  })

  /* An item that IS freight brings its own flag, which is what sends the line to the
   * freight account rather than to sales. */
  it('takes the charge flag from the item', () => {
    expect(lineFromItem(blankLine(), item({ isCharge: true }), 'sales').isCharge).toBe(true)
  })

  /*
   * A NULL ON THE ITEM IS A STATEMENT AND CLEARS THE BOX. "This one has no unit" is an
   * answer, and leaving the previous item's unit behind would put a figure on a tax
   * document that belongs to something else — the specific way a second pick lies.
   */
  it('clears what the item says it has none of', () => {
    const seeded = lineFromItem(blankLine(), item(), 'sales')
    const second = lineFromItem(
      seeded,
      item({ id: 'item-3', unitCode: null, classificationCode: null, taxRatePct: null }),
      'sales',
    )

    expect(second).toMatchObject({ unitCode: '', classificationCode: '', ratePct: '' })
  })

  /*
   * THE PRICE IS THE ONE ASYMMETRY, AND IT IS DELIBERATE. `ItemSummary` — what a picker is
   * fed — carries a sale price and no purchase price, and that is the better answer
   * anyway: a line on a purchase bill costs what the supplier BILLED, and offering a
   * stored standard cost there puts a figure on screen that agrees with nobody's paper.
   */
  it('takes the sale price on a sale and leaves a bill price alone', () => {
    const typed = { ...blankLine(), unitPrice: '84.50' }

    expect(lineFromItem(typed, item(), 'sales').unitPrice).toBe('90.00')
    expect(lineFromItem(typed, item(), 'purchase').unitPrice).toBe('84.50')
  })

  /* An item with no standard price states nothing about one either, so a price already
   * typed survives being told which item it was. */
  it('keeps a typed price when the item has no standard one', () => {
    const typed = { ...blankLine(), unitPrice: '84.50' }

    expect(lineFromItem(typed, item({ salePrice: null }), 'sales').unitPrice).toBe('84.50')
  })

  /* The quantity and the discount are facts about THIS supply. An item has no opinion
   * about how many were sold or what was knocked off. */
  it('never touches the quantity or the discount', () => {
    const typed = { ...blankLine(), quantity: '12', discount: '50.00' }
    const filled = lineFromItem(typed, item(), 'sales')

    expect(filled.quantity).toBe('12')
    expect(filled.discount).toBe('50.00')
  })

  /* The row keeps its key, or React swaps two rows' contents under the user. */
  it('keeps the row it filled in', () => {
    const row = blankLine()

    expect(lineFromItem(row, item(), 'sales').key).toBe(row.key)
  })
})

describe('clearItem', () => {
  /*
   * TAKING THE LINK OFF IS NOT AN UNDO. What was seeded became the line's own text the
   * moment it landed — that is what "a copy, not a reference" means — so saying it was
   * never that item must not take the user's description and price with it.
   */
  it('stops being an item without emptying what was printed', () => {
    const filled = lineFromItem(blankLine(), item(), 'sales')
    const cleared = clearItem(filled)

    expect(cleared.itemId).toBe('')
    expect(cleared).toMatchObject({
      description: 'Oil seal 25x40',
      unitPrice: '90.00',
      unitCode: 'KGS',
      ratePct: '12.000',
      classificationCode: '4016',
    })
  })
})

describe('postableAccounts', () => {
  /*
   * NEVER A GROUP. A group totals its children and accepts no posting of its own, so
   * offering one is offering a save main refuses. The fixture lists the group FIRST, so a
   * filter that was deleted would leave it as the option a `<select>` falls back to.
   */
  it('offers neither a group nor an archived account', () => {
    const chart = [
      account({ id: 'acc-group', code: '5000', name: 'Direct Expenses', isGroup: true }),
      account({ id: 'acc-old', code: '5900', name: 'Closed Expense', isArchived: true }),
      account({ id: 'acc-courier' }),
    ]

    expect(postableAccounts(chart).map((row) => row.id)).toEqual(['acc-courier'])
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
    expect(stateSentence('sales-invoice', 'draft', null, null)).toContain('Nothing is in the books')
  })

  it('names the number an issued document was given', () => {
    const sentence = stateSentence('sales-invoice', 'issued', 'INV/2026-27/0001', null)

    expect(sentence).toContain('INV/2026-27/0001')
    expect(sentence).toContain('cannot be edited')
  })

  /* The number is KEPT through cancellation — rule 2. Saying so is what stops somebody
   * looking for the hole in the series. */
  it('says the number is kept when the document was cancelled', () => {
    const sentence = stateSentence('credit-note', 'cancelled', 'CRN/2026-27/0001', null)

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
      expect(stateSentence('quotation', status, 'QTN/2026-27/0001', null)).not.toContain(
        'until it is issued',
      )
    }
    expect(stateSentence('quotation', 'draft', null, null)).toContain('never reaches the books')
    expect(stateSentence('quotation', 'cancelled', 'QTN/1', null)).not.toContain('reversed')
  })

  /* Every other kind shares the invoice's sentences, which is the argument for one
   * editor. A kind quietly given different words would mean the rules had diverged. */
  it('says the same thing for every kind that posts', () => {
    const posting = KINDS.filter((kind) => kind !== 'quotation')
    const sentences = posting.map((kind) => stateSentence(kind, 'draft', null, null))

    expect(new Set(sentences).size).toBe(1)
  })

  /* A draft has no number and must not be described as if it had one. */
  it('stands in for the number a draft does not have, in its own words', () => {
    expect(stateSentence('debit-note', 'issued', null, null)).toContain('a numbered debit note')
  })

  it('says when an issued invoice falls due', () => {
    const sentence = stateSentence('sales-invoice', 'issued', 'INV/2026-27/0001', '2026-05-15')

    expect(sentence).toContain('Due 2026-05-15')
    /* And still says the rest of it, rather than replacing the sentence. */
    expect(sentence).toContain('INV/2026-27/0001')
    expect(sentence).toContain('cannot be edited')
  })

  /*
   * A CANCELLED DOCUMENT KEEPS ITS DUE DATE AND MUST NOT ANNOUNCE IT. The column is frozen
   * — 0014 argues for that, and the number is kept on the same argument — but nothing is
   * owed on a cancelled invoice by any date, and printing one beside the word "Cancelled"
   * states a deadline that has stopped existing.
   */
  it('says nothing about a due date once the document is cancelled', () => {
    const sentence = stateSentence('sales-invoice', 'cancelled', 'INV/2026-27/0001', '2026-05-15')

    expect(sentence).not.toContain('2026-05-15')
    expect(sentence).not.toContain('Due')
  })

  /* A quotation has none at all, and the sentence must not grow a gap where one would go
   * — the clause carries its own leading space, so a missing date must leave none behind. */
  it('leaves no hole in the sentence for a kind that never falls due', () => {
    const sentence = stateSentence('quotation', 'issued', 'QTN/1', null)

    expect(sentence).not.toContain('Due')
    expect(sentence).not.toContain('  ')
    expect(sentence).toContain('QTN/1. It has been sent')
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

  /*
   * PICKING IS TYPING. Choosing an item fills the description and was covered already, but
   * a unit, a charge box and an account are each a decision somebody made with an empty
   * description beside it — and the line copy this guards would have overwritten all three
   * without noticing.
   */
  it('is false when a row has picked something, even with nothing typed', () => {
    expect(isBlankDraft([{ ...blankLine(), itemId: 'item-2' }])).toBe(false)
    expect(isBlankDraft([{ ...blankLine(), unitCode: 'KGS' }])).toBe(false)
    expect(isBlankDraft([{ ...blankLine(), isCharge: true }])).toBe(false)
    expect(isBlankDraft([{ ...blankLine(), accountId: 'acc-courier' }])).toBe(false)
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

  /*
   * AND THE PICKED FIELDS COME WITH THEM. Goods coming back are the same item measured in
   * the same unit, and freight being credited reverses out of the account it went into —
   * `CHARGE_ROLES` is keyed by side alone for exactly that reason (posting.ts). A copy
   * that dropped them would put a credit note's lines on different accounts than the
   * invoice they undo.
   */
  it('carries the item, the unit, the charge flag and the account across', () => {
    const picked = {
      lines: [
        {
          ...original.lines[0],
          itemId: 'item-2',
          unitCode: 'KGS',
          isCharge: true,
          accountId: 'acc-courier',
        },
      ],
    } as unknown as Document

    expect(linesFrom(picked)[0]).toMatchObject({
      itemId: 'item-2',
      unitCode: 'KGS',
      isCharge: true,
      accountId: 'acc-courier',
    })
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
