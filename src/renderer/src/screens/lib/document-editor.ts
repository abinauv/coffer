/*
 * The document editor's shapes and rules — everything about it that is not React.
 *
 * WAS `invoice-editor.ts`. One editor now serves all five kinds (0013-2), so the pieces
 * that used to say "invoice" say what the kind is called instead — read off the shared
 * table, never written out here.
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

import { definitionOf, type DocumentKind } from '@shared/documents'
import type { Document, DocumentLineDto, DocumentLineInput, DocumentStatusDto } from '@shared/dto'

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

/**
 * Whether nothing has been typed into the lines yet.
 *
 * What guards the line copy in a correction: picking the invoice a credit note corrects
 * fills the lines in, and it must never do that over work. STRICTER THAN `isLineReady`,
 * deliberately — a row with a description and no price is not ready to send and is
 * plainly something somebody was in the middle of typing.
 *
 * `quantity` is not looked at, because `blankLine` starts it at 1 and a user who has
 * touched only the quantity has typed nothing that would be lost.
 */
export function isBlankDraft(lines: readonly LineDraft[]): boolean {
  return lines.every(
    (line) =>
      line.description.trim() === '' &&
      line.unitPrice.trim() === '' &&
      line.discount.trim() === '' &&
      line.ratePct.trim() === '' &&
      line.classificationCode.trim() === '',
  )
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

/**
 * What the status line says the document is, in a sentence rather than a word.
 *
 * THE QUOTATION GETS DIFFERENT WORDS AND THAT IS THE POINT OF THE PARAMETER. "Nothing is
 * in the books until it is issued" is false of a quotation in the direction that matters:
 * issuing one still puts nothing there. Saying it anyway would teach a user that issuing
 * is what posts, and the first credit note they raise would surprise them.
 *
 * Every other sentence is shared, because every other kind behaves identically — which is
 * the whole argument for one editor.
 *
 * THE DUE DATE IS SAID ONLY WHILE THE DOCUMENT IS ISSUED, which is not the same as "only
 * where there is one". A cancelled invoice keeps the date it was stamped with — the column
 * is frozen, and 0014 argues for that — but nothing is owed on it any more, so repeating
 * the date beside the word "Cancelled" would be stating a deadline that has stopped
 * existing. A draft has none at all: it has no number either, and for the same reason.
 */
export function stateSentence(
  kind: DocumentKind,
  status: DocumentStatusDto,
  number: string | null,
  dueDate: string | null,
): string {
  const definition = definitionOf(kind)
  const posts = definition.postsToLedger
  const named = number ?? `a numbered ${definition.label.toLowerCase()}`

  if (status === 'issued') {
    const due = dueDate === null ? '' : ` Due ${dueDate}.`
    return posts
      ? `Issued as ${named}.${due} It is in the books and cannot be edited.`
      : `Issued as ${named}.${due} It has been sent and cannot be edited, and it puts nothing in the books.`
  }
  if (status === 'cancelled') {
    return posts
      ? `Cancelled. ${number ?? 'The number'} is kept and what it posted has been reversed.`
      : `Cancelled. ${number ?? 'The number'} is kept, so the series has no hole.`
  }
  return posts
    ? 'A draft. Nothing is in the books until it is issued.'
    : 'A draft. Issuing it allocates its number and nothing else — a quotation never reaches the books.'
}

// ---- Correcting a document --------------------------------------------------

/**
 * The lines of a document a correction is being raised against.
 *
 * COPIED AS TYPED, NOT AS COMPUTED. What crosses is the description, the quantity, the
 * price, the discount and the rate — the five things a person entered. Nothing derived
 * comes with them: not the taxable amount, not the tax, not a total. Those are the
 * regime's answer and the service asks for them again on save, against the CORRECTION's
 * own date, which is right rather than merely convenient — a return raised after a rate
 * change is taxed at the rate in force when the goods went back.
 *
 * So this is a starting point for a full return, which is the common case, and the user
 * edits it down for a partial one. The editor only offers it into an empty draft, so it
 * can never overwrite lines somebody typed.
 */
export function linesFrom(document: Document): LineDraft[] {
  return document.lines.length === 0 ? [blankLine()] : document.lines.map(lineDraftOf)
}
