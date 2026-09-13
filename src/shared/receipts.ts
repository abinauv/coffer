/*
 * The kinds of money voucher, and the words for them.
 *
 * The same move `shared/documents.ts` made in 0013-2, for the same reason and one batch
 * later: `RECEIPT_KINDS` lived in `main/domain/receipts` where the posting rule reads it,
 * and the screens need the same facts — what to call a payment, whether the party is a
 * customer or a vendor, whether the money came in or went out. The renderer cannot import
 * `@main/*`, so the choice was a channel serving a constant or a second copy of the
 * table, and a second copy is the shape this codebase keeps deleting.
 *
 * WHAT STAYED IN THE DOMAIN IS WHAT THE LEDGER DOES WITH A KIND. `controlRole` is an
 * `AccountRole` and `sourceType` is a `SourceDocumentType`; both are the ledger's
 * vocabulary and neither is anything a screen can use. See `receiptTreatmentOf` in
 * `main/domain/receipts/types.ts`.
 *
 * ---------------------------------------------------------------------------
 * NO `postsToLedger` HERE, AND THAT IS NOT AN OVERSIGHT
 *
 * The document table carries one because a quotation exists. Every receipt kind posts —
 * that is what a receipt IS, a statement about money that has already moved — so a field
 * saying so would be a column of `true` and a second place for a fact with no second
 * value. The document table's own header makes the same argument about `levy`.
 *
 * The consequence is that the domain's treatment record is keyed by `ReceiptKind`
 * directly rather than by an `Extract`ed subset: every kind needs a control account and a
 * source type, so the record is total over the union and a kind added here does not
 * compile until the domain says what it posts.
 */

import {
  definitionOf,
  opposite,
  postingKindOn,
  type DocumentDirection,
  type DocumentKind,
  type TradeSide,
} from './documents'

/**
 * Money in, or money out.
 *
 * Closed on purpose, like `DocumentKind`: an unrecognised kind in a company file means
 * the file was written by a newer build.
 */
export type ReceiptKind = 'receipt' | 'payment' | 'refund' | 'refund-received'

/**
 * Which way the money went.
 *
 * The posting rule reads THIS and never the kind, so a kind added later gets its debits
 * and credits the right way round by declaring itself rather than by being remembered in
 * a condition. A refund to a customer is the case that makes it worth having: money out,
 * on the sales side, which no `kind === 'receipt'` test can be made to answer correctly.
 */
export type MoneyDirection = 'in' | 'out'

export interface ReceiptKindDefinition {
  kind: ReceiptKind
  /** What the user sees, singular. */
  label: string
  /** What the user sees for many of them. */
  pluralLabel: string
  /** Which half of the trade it belongs to, and therefore which documents it settles. */
  side: TradeSide
  /** Whether the business received the money or parted with it. */
  direction: MoneyDirection
}

/**
 * The table. Adding a kind means a row, a treatment in the domain, and a posting rule.
 *
 * FOUR ROWS AS OF 0015, WHICH IS THE WHOLE SQUARE: two sides by two directions, and the
 * two that were missing are the ones a refund needs. `posting.ts` predicted both and
 * needed no change to post them, which is what reading `direction` rather than `kind` was
 * for.
 *
 * A refund is not a payment and the difference is the control account, not the party. A
 * payment moves what the business OWES; a refund to a customer moves what it is OWED, the
 * other way — money going back out against a credit note. Calling it a payment would file
 * a customer's refund in accounts payable, where no statement of theirs would ever show
 * it.
 */
export const RECEIPT_KINDS: readonly ReceiptKindDefinition[] = [
  {
    kind: 'receipt',
    label: 'Receipt',
    pluralLabel: 'Receipts',
    side: 'sales',
    direction: 'in',
  },
  {
    kind: 'payment',
    label: 'Payment',
    pluralLabel: 'Payments',
    side: 'purchase',
    direction: 'out',
  },
  {
    kind: 'refund',
    label: 'Refund paid',
    pluralLabel: 'Refunds paid',
    side: 'sales',
    direction: 'out',
  },
  {
    kind: 'refund-received',
    label: 'Refund received',
    pluralLabel: 'Refunds received',
    side: 'purchase',
    direction: 'in',
  },
]

const BY_KIND: ReadonlyMap<ReceiptKind, ReceiptKindDefinition> = new Map(
  RECEIPT_KINDS.map((definition) => [definition.kind, definition]),
)

/**
 * Whether a string is a voucher kind this build knows.
 *
 * `isDocumentKind`'s twin, and it is needed for the same reason and in the same places:
 * a report or a dashboard holds a `kind` as a `string`, has to decide which of the two
 * tables it belongs to, and must not cast. See the note beside `isDocumentKind`.
 */
export function isReceiptKind(value: string): value is ReceiptKind {
  return RECEIPT_KINDS.some((definition) => definition.kind === value)
}

/**
 * The definition for a kind.
 *
 * Throws rather than returning null, for the reason `definitionOf` in `./documents` does:
 * every caller holds a `ReceiptKind`, so a miss here is a company file a newer build
 * wrote and not something a null-check on every call site would help with.
 */
export function receiptDefinitionOf(kind: ReceiptKind): ReceiptKindDefinition {
  const definition = BY_KIND.get(kind)
  if (definition === undefined) {
    throw new Error(`Unknown receipt kind '${kind}'. This file may need a newer Coffer.`)
  }
  return definition
}

/** Which half of the trade a voucher of this kind belongs to. */
export function settlesSide(kind: ReceiptKind): TradeSide {
  return receiptDefinitionOf(kind).side
}

/*
 * ---------------------------------------------------------------------------
 * WHICH DOCUMENT A VOUCHER MAY SETTLE, AND WHY IT IS DERIVED RATHER THAN LISTED
 *
 * ONE SENTENCE, AND THE WHOLE OF 0015 HANGS OFF IT: an allocation matches two movements
 * on ONE control account that point OPPOSITE WAYS. A receipt settles an invoice because
 * the invoice put money on receivables and the receipt takes it off. That is all an
 * allocation ever says, and it is all that is checked.
 *
 * Until 0015 the rule could be spelled "the same side", because each side had exactly one
 * voucher and the direction never had a second value to get wrong. It has one now, and
 * "same side" stopped being enough on the day a refund appeared: a refund paid and a
 * receipt taken are both sales-side vouchers moving the same account in OPPOSITE
 * directions, so a rule that only compares sides would let a refund settle an invoice —
 * a customer's balance going UP while one of their invoices is marked paid.
 *
 * DERIVED, NOT DECLARED, and that is the one judgement here worth arguing. `controlRole`
 * on the treatment record next door IS declared, on the stated grounds that deriving it
 * from `side` would be two facts agreeing by coincidence. This is the opposite case: the
 * derivation is not a coincidence, it is the MEANING. A row saying "a receipt settles
 * credit notes" would be a nonsense no test could catch, because there would be nothing
 * left to check it against.
 */

/**
 * WHICH WAY A VOUCHER OF THIS KIND MOVES THE PARTY'S CONTROL ACCOUNT, in the same
 * vocabulary a document uses for it.
 *
 * The primary fact of the four below, and the one worth saying out loud: A RECEIPT MOVES
 * RECEIVABLES THE WAY A CREDIT NOTE DOES. Both take money off what the customer owes, so
 * both face `refund`; an invoice and a refund paid both put money on, so both face
 * `charge`. Once a voucher and a document are described in one word, everything else in
 * 0015 is a comparison of two of them — what a voucher settles, what an offset may match,
 * and which way a matching row moves each end.
 *
 * THE EQUALITY RATHER THAN A FOUR-ARMED LOOKUP is deliberate: it is the same fact twice,
 * once per side, and writing it out as four cases is how the fourth one ends up
 * transposed. Money OUT on the SALES side puts money on — that is a refund paid — and
 * money IN on the PURCHASE side does the same, because what it lands on is what the
 * business owes.
 */
export function receiptFacing(definition: ReceiptKindDefinition): DocumentDirection {
  return (definition.side === 'sales') === (definition.direction === 'out') ? 'charge' : 'refund'
}

/**
 * Which of a side's documents a voucher of this kind settles: the charges, or the refunds.
 *
 * DERIVED FROM THE FACING BY NEGATION, which is the sentence at the top of this section
 * turned into code: an allocation matches two movements that point opposite ways, so a
 * voucher settles whatever faces the other way from itself. It is not a second table and
 * it is not a second rule — it is the rule, read backwards.
 */
export function settledDirection(definition: ReceiptKindDefinition): DocumentDirection {
  return opposite(receiptFacing(definition))
}

/**
 * The one document kind a voucher of this kind settles, and its picker lists.
 *
 * Total over `ReceiptKind`: every voucher posts, and every side has both a charge and a
 * refund kind that posts, so there is no voucher with nothing to settle. `settledBy` is
 * this function backwards and a test asserts the round trip.
 */
export function settles(kind: ReceiptKind): DocumentKind {
  const definition = receiptDefinitionOf(kind)
  return postingKindOn(definition.side, settledDirection(definition))
}

/**
 * The voucher kind that settles a document of this kind, from a table.
 *
 * COUNTED, NOT FOUND, and the argument is `postingKindIn`'s in the mirror: "the voucher
 * that settles a credit note" has to be one voucher, and a `.find` would answer
 * "whichever is listed first" while looking identical. A document screen sends a user to
 * this kind's editor, so being wrong here means offering to record a payment against a
 * customer's invoice.
 *
 * The table is an argument so that a test can build the ambiguity the real table cannot
 * have — the 0013-2 lesson applied on the day it was written rather than after the next
 * mutation pass finds the same hole.
 */
export function settledByIn(
  kinds: readonly ReceiptKindDefinition[],
  side: TradeSide,
  direction: DocumentDirection,
  /** Named in the refusal, so a crash at boot says which document could not be resolved. */
  asking: string,
): ReceiptKind {
  const matches = kinds.filter(
    (definition) => definition.side === side && settledDirection(definition) === direction,
  )
  const [only, ...rest] = matches
  if (only === undefined || rest.length > 0) {
    throw new Error(
      `${asking} is settled by ${String(matches.length)} voucher kinds. Exactly one, or ` +
        'there is no single screen to send somebody to.',
    )
  }
  return only.kind
}

/**
 * The voucher kind that settles this document, or null where nothing settles it.
 *
 * NULL FOR A QUOTATION, which is new and is a correction. The side-only version answered
 * `'receipt'` for one — a quotation is sales-side — and every caller happened to gate the
 * answer behind `postsToLedger` before using it. A quotation offers a price and creates
 * no obligation, so there is nothing to settle, and saying so here is one place instead
 * of one gate per caller.
 */
export function settledBy(kind: DocumentKind): ReceiptKind | null {
  const definition = definitionOf(kind)
  if (!definition.postsToLedger) return null
  return settledByIn(RECEIPT_KINDS, definition.side, definition.direction, definition.label)
}
