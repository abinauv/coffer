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

import { definitionOf, type DocumentKind, type TradeSide } from '@shared/documents'
import type {
  Account,
  Document,
  DocumentLineDto,
  DocumentLineInput,
  DocumentStatusDto,
  ItemSide,
  ItemSummary,
} from '@shared/dto'

/**
 * A line as the form holds it: strings, because that is what an input carries.
 *
 * FOUR OF THESE ARE NOT TYPED IN, AND THEY WERE MISSING UNTIL 0017. `itemId`, `unitCode`,
 * `isCharge` and `accountId` have been on `DocumentLineInput` since the contract was
 * written, are validated by the handler, are stored by the repository and are HONOURED by
 * the posting rule — and the form did not hold them. So every line was free text, the item
 * master had no consumer, and — the part that was a live bug rather than a missing feature
 * — OPENING A SAVED DOCUMENT AND PRESSING SAVE DROPPED THEM. `lineDraftOf` never read them
 * off the stored line and `toLineInput` never sent them back, so a round trip through this
 * screen quietly unlinked an invoice from the items it was made of.
 *
 * They are held as the empty string rather than as null, because that is what a `<select>`
 * carries: `''` is the empty option, and a picker whose value is `null` is a React warning
 * and an uncontrolled field. `toLineInput` turns the empty string back into "absent".
 */
export interface LineDraft {
  /** Stable across re-orders and edits, so React keys do not swap two rows' contents. */
  key: string
  /**
   * The item this line IS. `''` for a free-text line, which stays entirely legal.
   *
   * IT SURVIVES EDITING THE TEXT. An item fills a line's description, unit, price, rate
   * and classification and the user may then change any of them — `dto.ts` is explicit
   * that a line stores its own copy so that repricing an item later cannot rewrite
   * history. The id is what the line IS; the description is what was PRINTED. Editing
   * what was printed does not make it a different item, and clearing this field is how a
   * user says it was never that item — see `clearItem`.
   */
  itemId: string
  description: string
  quantity: string
  /** What the quantity is counted in. `''` is none, which is a complete line. */
  unitCode: string
  unitPrice: string
  discount: string
  ratePct: string
  classificationCode: string
  /**
   * Freight, packing or insurance rather than the goods themselves.
   *
   * A boolean and not a string, because it is the one field on this row that is not typed
   * into a box. The posting rule sends a line carrying it to `freight-outward` on a sale
   * and `freight-inward` on a purchase instead of to sales or purchases; it says nothing
   * about whether the line is taxed, which is the rate's business (posting.ts, and
   * regimes/in-gst/tax.ts on the bug this project refuses to port).
   */
  isCharge: boolean
  /**
   * An account named for this line, beating both defaults above. `''` is the usual one.
   *
   * `valueAccountFor` looks here first and at the role only when it is null, so this is
   * how a bought service reaches its own expense account instead of Purchases.
   */
  accountId: string
}

let nextKey = 0

/** A new blank row. The key is local to this session and never sent anywhere. */
export function blankLine(): LineDraft {
  nextKey += 1
  return {
    key: `line-${String(nextKey)}`,
    itemId: '',
    description: '',
    quantity: '1',
    unitCode: '',
    unitPrice: '',
    discount: '',
    ratePct: '',
    classificationCode: '',
    isCharge: false,
    accountId: '',
  }
}

/**
 * A stored line, as the form holds it.
 *
 * EVERY FIELD THE LINE HAS, or the next save writes back a document missing whatever was
 * not read. That is not a hypothetical: the four fields added in 0017 were stored, drawn
 * nowhere and sent nowhere, so editing the date of an issued-then-corrected draft was
 * enough to unlink every line from its item.
 */
export function lineDraftOf(line: DocumentLineDto): LineDraft {
  nextKey += 1
  return {
    key: `line-${String(nextKey)}`,
    itemId: line.itemId ?? '',
    description: line.description,
    quantity: line.quantity,
    unitCode: line.unitCode ?? '',
    unitPrice: line.unitPrice,
    discount: line.discount,
    ratePct: line.ratePct,
    classificationCode: line.classificationCode ?? '',
    isCharge: line.isCharge,
    accountId: line.accountId ?? '',
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
 *
 * THE FOUR PICKED FIELDS ARE OMITTED WHEN NOTHING WAS PICKED, rather than sent as null.
 * The two are the same thing here and only here: the handler's `optional` reads null as
 * absent, and a save REPLACES every line, so there is no stored value for an absent field
 * to fail to clear. `isCharge` is the same story from the other end — the repository
 * writes `isCharge === true ? 1 : 0`, so absent IS false, and sending `false` would be a
 * second spelling of it.
 */
export function toLineInput(line: LineDraft): DocumentLineInput {
  return {
    ...(line.itemId === '' ? {} : { itemId: line.itemId }),
    description: line.description.trim(),
    quantity: line.quantity.trim(),
    ...(line.unitCode === '' ? {} : { unitCode: line.unitCode }),
    unitPrice: line.unitPrice.trim(),
    discount: line.discount.trim() === '' ? '0' : line.discount.trim(),
    ...(line.ratePct.trim() === '' ? {} : { ratePct: line.ratePct.trim() }),
    classificationCode:
      line.classificationCode.trim() === '' ? null : line.classificationCode.trim(),
    ...(line.isCharge ? { isCharge: true } : {}),
    ...(line.accountId === '' ? {} : { accountId: line.accountId }),
  }
}

// ---- The item master, on a line ---------------------------------------------

/**
 * Which list of items a document of this side may be made of.
 *
 * A total record over the two sides rather than a ternary (CONVENTIONS §1.9): a third
 * side would not compile here instead of quietly taking whichever branch was written
 * last. An item is both sold and bought far more often than not — the same firm's stock
 * — so this narrows a picker rather than describing what the item IS, exactly as
 * `partyRoleFor` does next door.
 */
const ITEM_SIDES: Readonly<Record<TradeSide, ItemSide>> = {
  sales: 'sold',
  purchase: 'purchased',
}

export function itemSideFor(side: TradeSide): ItemSide {
  return ITEM_SIDES[side]
}

/**
 * What price an item states for a document on this side. Null is "it states none".
 *
 * ONLY THE SALES SIDE HAS ONE, and that is a decision rather than an oversight.
 * `ItemSummary` — what `items.list` answers with, which is what a picker is fed — carries
 * `salePrice` and no purchase price at all. It is also the better answer: what a line on
 * a purchase bill costs is what the supplier BILLED, and seeding a standard cost there
 * offers a figure that agrees with nobody's paperwork and is one keystroke from being
 * accepted.
 */
const ITEM_PRICES: Readonly<Record<TradeSide, (item: ItemSummary) => string | null>> = {
  sales: (item) => item.salePrice,
  purchase: () => null,
}

/**
 * A line filled in from the item that was picked.
 *
 * A COPY, NEVER A REFERENCE. `dto.ts` states it twice — every field on an item is a
 * DEFAULT for a line, and a line stores its own description, price and rate so that
 * repricing an item later does not rewrite history. So this SEEDS the boxes and then has
 * nothing more to do with them: nothing re-reads the item on save, and the user may edit
 * any of what was filled in without the line ceasing to be that item.
 *
 * A NULL ON THE ITEM IS A STATEMENT; A FIELD IT DOES NOT CARRY IS NOT. A null unit,
 * classification or rate says "this one has none" and CLEARS the box — leaving the
 * previous item's rate on a line that is now something else is how a picker puts a wrong
 * figure on a tax document. A price on a purchase bill is the other case: the summary
 * carries none at all, so the item states nothing and the box keeps whatever is in it
 * (see `ITEM_PRICES`). The quantity and the discount are never touched either — they are
 * facts about this supply, and an item has no opinion about how many were sold.
 *
 * THE ACCOUNT OVERRIDE IS NOT SEEDED. `Item` carries `salesAccountId` and
 * `purchaseAccountId` and `ItemSummary` does not, so honouring them would mean a second
 * round trip per pick — noted for a later batch rather than half-done here.
 */
export function lineFromItem(line: LineDraft, item: ItemSummary, side: TradeSide): LineDraft {
  const price = ITEM_PRICES[side](item)
  return {
    ...line,
    itemId: item.id,
    description: item.name,
    unitCode: item.unitCode ?? '',
    ...(price === null ? {} : { unitPrice: price }),
    ratePct: item.taxRatePct ?? '',
    classificationCode: item.classificationCode ?? '',
    isCharge: item.isCharge,
  }
}

/**
 * A line that is no longer an item, with everything it printed left where it is.
 *
 * The inverse of the rule above rather than an undo: what was seeded became the line's
 * own text and figures the moment it landed, so taking the link off must not take a
 * user's description or price with it. Clearing the picker says "this was never that
 * item", not "start this line again".
 */
export function clearItem(line: LineDraft): LineDraft {
  return { ...line, itemId: '' }
}

/**
 * The accounts a line may be pointed at.
 *
 * NEVER A GROUP: a group totals its children and accepts no posting of its own, so
 * offering one is offering a save that main refuses. Archived accounts are out for the
 * ordinary reason a picker does not offer them — the same filter `ReceiptEditor` applies
 * to the same list.
 */
export function postableAccounts(accounts: readonly Account[]): readonly Account[] {
  return accounts.filter((account) => !account.isGroup && !account.isArchived)
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
 *
 * THE PICKED FIELDS COUNT AS WORK TOO. Choosing an item fills the description, so the
 * common case was already covered — but ticking a charge box, choosing a unit or naming
 * an account are each a decision somebody made, and a line copy that overwrote one would
 * be discarding work for the same reason a half-typed description would.
 */
export function isBlankDraft(lines: readonly LineDraft[]): boolean {
  return lines.every(
    (line) =>
      line.itemId === '' &&
      line.description.trim() === '' &&
      line.unitCode === '' &&
      line.unitPrice.trim() === '' &&
      line.discount.trim() === '' &&
      line.ratePct.trim() === '' &&
      line.classificationCode.trim() === '' &&
      !line.isCharge &&
      line.accountId === '',
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
 * COPIED AS ENTERED, NOT AS COMPUTED. What crosses is what a person put on the original:
 * the description, the quantity, the price, the discount and the rate they typed, and the
 * item, unit, charge flag and account they picked. Nothing derived comes with them: not
 * the taxable amount, not the tax, not a total. Those are the regime's answer and the
 * service asks for them again on save, against the CORRECTION's own date, which is right
 * rather than merely convenient — a return raised after a rate change is taxed at the
 * rate in force when the goods went back.
 *
 * THE PICKED FIELDS BELONG IN THE COPY. Goods coming back are the same item measured in
 * the same unit, and freight being credited reverses out of the account it went into —
 * `CHARGE_ROLES` is keyed by side alone for exactly that reason (posting.ts).
 *
 * So this is a starting point for a full return, which is the common case, and the user
 * edits it down for a partial one. The editor only offers it into an empty draft, so it
 * can never overwrite lines somebody typed.
 */
export function linesFrom(document: Document): LineDraft[] {
  return document.lines.length === 0 ? [blankLine()] : document.lines.map(lineDraftOf)
}
