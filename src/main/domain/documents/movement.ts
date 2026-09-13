/*
 * Which documents move stock, and which way.
 *
 * ARCHITECTURE §6.4 says every stock movement posts to both ledgers. This file answers
 * the question one layer up: which documents RAISE a movement in the first place, and
 * what kind of movement it is.
 *
 * ---------------------------------------------------------------------------
 * DERIVED FROM THE KIND TABLE, NEVER LISTED
 *
 * The tempting version is a five-entry map from `DocumentKind` to `StockMovementKind`
 * with a null for the quotation. It would be correct today and it would be a second copy
 * of facts `DOCUMENT_KINDS` already holds — which side of the trade a kind sits on,
 * whether it charges or refunds, and whether it reaches the books at all. Two tables
 * agreeing today is not a property anything tests, and this codebase has deleted that
 * shape four times.
 *
 * So the movement kind is read out of the two fields that decide it:
 *
 *   SIDE       DIRECTION   DOCUMENT        STOCK
 *   sales      charge      invoice         goods leave        issue
 *   sales      refund      credit note     goods come back    sales-return
 *   purchase   charge      bill            goods arrive       receipt
 *   purchase   refund      debit note      goods go back      purchase-return
 *
 * `MOVEMENT_KINDS` is a total record over `TradeSide` and `DocumentDirection`, so a kind
 * added on a side or in a direction this table has never seen is a COMPILE error rather
 * than a document that silently moves no stock (CONVENTIONS §1.9). That is the failure
 * mode worth designing against: a stock movement that does not happen leaves a register
 * short and a balance sheet that still ties, because the entry that would have moved the
 * value did not happen either.
 *
 * ---------------------------------------------------------------------------
 * WHY "MOVES STOCK" IS EXACTLY "POSTS TO THE LEDGER"
 *
 * A quotation is the only kind that does neither, and it is not a coincidence that the
 * two answers coincide: a quotation offers a price and supplies nothing. Nothing has
 * changed hands, so there is no value to move on the balance sheet and no goods to take
 * out of the register.
 *
 * `movesStock` therefore asks `postsToLedger` rather than carrying a second flag. If the
 * two ever have to differ — a delivery note that moves stock and raises no invoice — the
 * answer is a row in `DOCUMENT_KINDS` with a field of its own, not a list here.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT DECIDE
 *
 * WHETHER A LINE MOVES ANYTHING. A document moves stock for the lines whose item keeps a
 * balance, and which items those are is a fact about the item, in `db/`. A free-text line
 * and a service line move nothing on a document that otherwise does.
 *
 * WHERE THE STOCK MOVES FROM. A register is per (item, warehouse) — 0019 §4 — and nothing
 * on a document line says which warehouse. Until `document_lines` carries one, issuing a
 * document cannot raise a movement for a company that keeps more than one place, and
 * choosing "the only warehouse there is" would be a rule that works right up until the
 * second warehouse. That column is the next migration this needs, and its absence is why
 * `issueDocument` does not yet call any of this.
 */

import type { StockMovementKind } from '@main/domain/inventory'
import {
  definitionOf,
  postsToLedger,
  type DocumentDirection,
  type DocumentKind,
  type TradeSide,
} from '@shared/documents'

/**
 * What a document of each side and direction does to the stock register.
 *
 * A total record over both unions rather than a lookup by kind, for the reason at the top
 * of this file: the two fields are what decide it, and they are already written down.
 */
export const MOVEMENT_KINDS: Readonly<
  Record<TradeSide, Readonly<Record<DocumentDirection, StockMovementKind>>>
> = {
  sales: { charge: 'issue', refund: 'sales-return' },
  purchase: { charge: 'receipt', refund: 'purchase-return' },
} as const

/**
 * Whether issuing this kind moves stock.
 *
 * The same question as `postsToLedger`, asked in the register's words — see the header
 * for why the two answers are the same fact rather than the same accident.
 */
export function movesStock(kind: DocumentKind): boolean {
  return postsToLedger(kind)
}

/** What a document of this kind does to the register, or null when it does nothing. */
export function movementKindFor(kind: DocumentKind): StockMovementKind | null {
  if (!movesStock(kind)) {
    return null
  }
  const definition = definitionOf(kind)
  return MOVEMENT_KINDS[definition.side][definition.direction]
}
