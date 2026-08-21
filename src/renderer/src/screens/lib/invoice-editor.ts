/*
 * The invoice editor's shapes and rules — everything about it that is not React.
 *
 * NOTHING HERE COMPUTES MONEY, and the editor is the screen where that costs something
 * visible. A user typing a quantity expects a line total to follow, and this cannot
 * produce one: `quantity x unitPrice - discount` is money arithmetic, and the taxable
 * amount, the tax and the grand total are the regime's answer, asked in main
 * (CONVENTIONS §1.7, and src/main/documents/service.ts).
 *
 * What the screen does instead is save the draft and show what came back. The figures on
 * screen are always ones main computed; while there are unsaved edits they are marked as
 * belonging to the last saved version rather than quietly redrawn. A stale figure that
 * says it is stale is honest. A fresh-looking figure the renderer worked out is not.
 */

import type { DocumentLineDto, DocumentLineInput, DocumentStatusDto } from '@shared/dto'

/** A line as the form holds it: strings, because that is what an input carries. */
export interface LineDraft {
  /** Stable across re-orders and edits, so React keys do not swap two rows' contents. */
  key: string
  description: string
  quantity: string
  unitPrice: string
  discount: string
  ratePct: string
  classificationCode: string
}

let nextKey = 0

/** A new blank row. The key is local to this session and never sent anywhere. */
export function blankLine(): LineDraft {
  nextKey += 1
  return {
    key: `line-${String(nextKey)}`,
    description: '',
    quantity: '1',
    unitPrice: '',
    discount: '',
    ratePct: '',
    classificationCode: '',
  }
}

/** A stored line, as the form holds it. */
export function lineDraftOf(line: DocumentLineDto): LineDraft {
  nextKey += 1
  return {
    key: `line-${String(nextKey)}`,
    description: line.description,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    discount: line.discount,
    ratePct: line.ratePct,
    classificationCode: line.classificationCode ?? '',
  }
}

/**
 * A form row as the contract's line input.
 *
 * NO `taxableAmount` AND NO `taxes` — they are not optional fields left out, they are not
 * on `DocumentLineInput` at all. `CreateTaxedDocumentInput` is the shape that carries
 * them and only the service in main may build one. A blank discount is '0' because a
 * discount is a figure and the absence of one is zero, but a blank RATE is left absent:
 * `DocumentLineInput.ratePct` documents absent as nil-rated, which is a rate, and the
 * regime is what decides what nil-rated attracts.
 */
export function toLineInput(line: LineDraft): DocumentLineInput {
  return {
    description: line.description.trim(),
    quantity: line.quantity.trim(),
    unitPrice: line.unitPrice.trim(),
    discount: line.discount.trim() === '' ? '0' : line.discount.trim(),
    ...(line.ratePct.trim() === '' ? {} : { ratePct: line.ratePct.trim() }),
    classificationCode:
      line.classificationCode.trim() === '' ? null : line.classificationCode.trim(),
  }
}

/**
 * Whether a row has enough on it to send.
 *
 * A SHAPE CHECK, NOT A VALUE CHECK. That a quantity is a decimal string, that a line's
 * figures agree, that the document balances — all of that is main's, and its refusals
 * are sentences written for the user. This only stops the screen sending a row the user
 * has plainly not finished, which would come back as an error about a blank description
 * they can see is blank.
 */
export function isLineReady(line: LineDraft): boolean {
  return (
    line.description.trim() !== '' && line.quantity.trim() !== '' && line.unitPrice.trim() !== ''
  )
}

/** A document with no finished line is not one main can be asked to tax. */
export function readyLines(lines: readonly LineDraft[]): readonly LineDraft[] {
  return lines.filter(isLineReady)
}

// ---- What may be done to a document in each state ---------------------------

/*
 * The four verbs, and which state each reaches. These mirror the document rules in
 * src/main/domain/documents/types.ts rather than restating them: main refuses anything
 * else, and a button that is offered and then refused is worse than one that is not
 * offered. Read as a table:
 *
 *   draft      edit, delete, issue
 *   issued     cancel
 *   cancelled  nothing
 */

/** A draft is the only thing that can be edited. Issuing is what ends that. */
export function canEdit(status: DocumentStatusDto): boolean {
  return status === 'draft'
}

/** Issuing allocates the number and posts the entry — one transaction, or none of it. */
export function canIssue(status: DocumentStatusDto): boolean {
  return status === 'draft'
}

/**
 * Cancelling reverses what was posted and KEEPS the number, so the series has no hole.
 * Only an issued document has anything to reverse.
 */
export function canCancel(status: DocumentStatusDto): boolean {
  return status === 'issued'
}

/**
 * Deleting reaches a draft and nothing else.
 *
 * An issued document is cancelled, never removed — it has a number that was reported, an
 * entry in the ledger, and a place in a series. Removing it would leave a gap that reads
 * as a document somebody hid.
 */
export function canDelete(status: DocumentStatusDto): boolean {
  return status === 'draft'
}

/** What the status line says the document is, in a sentence rather than a word. */
export function stateSentence(status: DocumentStatusDto, number: string | null): string {
  if (status === 'issued') {
    return `Issued as ${number ?? 'a numbered invoice'}. It is in the books and cannot be edited.`
  }
  if (status === 'cancelled') {
    return `Cancelled. ${number ?? 'The number'} is kept and what it posted has been reversed.`
  }
  return 'A draft. Nothing is in the books until it is issued.'
}
