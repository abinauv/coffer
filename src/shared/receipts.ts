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

import type { TradeSide } from './documents'

/**
 * Money in, or money out.
 *
 * Closed on purpose, like `DocumentKind`: an unrecognised kind in a company file means
 * the file was written by a newer build.
 */
export type ReceiptKind = 'receipt' | 'payment'

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

/** The table. Adding a kind means a row, a treatment in the domain, and a posting rule. */
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
]

const BY_KIND: ReadonlyMap<ReceiptKind, ReceiptKindDefinition> = new Map(
  RECEIPT_KINDS.map((definition) => [definition.kind, definition]),
)

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

/** Which document kinds a voucher of this kind can be allocated against. */
export function settlesSide(kind: ReceiptKind): TradeSide {
  return receiptDefinitionOf(kind).side
}

/**
 * The voucher kind that settles documents on a side, from a table.
 *
 * COUNTED, NOT FOUND, and the argument is `chargeKindIn`'s in the mirror: "the voucher
 * that settles the purchase side" has to be one voucher, and a `.find` would answer
 * "whichever is listed first" while looking identical. An invoice screen sends a user to
 * this kind's editor, so being wrong here means offering to record a payment against a
 * customer's invoice.
 *
 * The table is an argument so that a test can build the ambiguity the real table cannot
 * have — the 0013-2 lesson applied on the day it was written rather than after the next
 * mutation pass finds the same hole.
 */
export function settlingKindIn(
  kinds: readonly ReceiptKindDefinition[],
  side: TradeSide,
): ReceiptKind {
  const matches = kinds.filter((definition) => definition.side === side)
  const [only, ...rest] = matches
  if (only === undefined || rest.length > 0) {
    throw new Error(
      `${String(matches.length)} voucher kinds settle the ${side} side. Exactly one, or an ` +
        'invoice has no single screen to send somebody to.',
    )
  }
  return only.kind
}

/** The voucher kind that settles documents on a side. */
export function settlingKind(side: TradeSide): ReceiptKind {
  return settlingKindIn(RECEIPT_KINDS, side)
}
