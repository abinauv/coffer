/*
 * The receipts service — money in and out, and what it settles.
 *
 * The shortest service in the application, and that is the interesting thing about it.
 * `documents/` exists because a document has to be taxed, and the tax is the regime's
 * answer, and there is exactly one layer allowed to ask for it. A receipt carries no tax
 * — settling an invoice moves money that was already taxed when the supply happened — so
 * this layer has nothing to decide and does not pretend otherwise. It is `OpenBooks` and
 * a clock, in front of the repository.
 *
 * NOTHING HERE ASKS A REGIME, and nothing here should. If a phase later wants a receipt
 * voucher that carries tax on an advance, that is a DOCUMENT with lines — Rule 50's
 * receipt voucher is a printed document, not this row — and it belongs in the other
 * table and the other service.
 *
 * ---------------------------------------------------------------------------
 * THE CLOCK, AND WHY IT IS AN ARGUMENT
 *
 * `now` is the wall clock and is passed in, exactly as `documents/` passes it: it is the
 * audit stamp on the row, not the date the money moved. Those two are different and are
 * kept apart everywhere — a receipt back-dated into last month posts as of last month and
 * was RECORDED today, and a `created_at` that agreed with the receipt date would lose the
 * only evidence of which.
 *
 * ---------------------------------------------------------------------------
 * WHAT `open` IS FOR, AND THE ARGUMENT THAT IS EASY TO FORGET
 *
 * `open` answers "which of this party's documents still have something on them", which is
 * the list a receipt editor puts in front of a user. It takes `exceptReceiptId` so that
 * an editor opening an EXISTING receipt sees the invoices that receipt is already
 * settling, with that money back on them. Without it the screen would offer a list that
 * does not contain the invoice it is displaying a line for, and the user could not reduce
 * an allocation they had made.
 */

import { toMoneyString } from '@main/domain/money'
import type { ReceiptKind } from '@main/domain/receipts'
import type {
  AllocateReceiptInput,
  CancelReceiptInput,
  CreateReceiptInput,
  DocumentSettlement,
  ListReceiptsInput,
  OpenDocument,
  OpenDocumentsInput,
  Receipt,
  ReceiptSummary,
} from '@shared/dto'

import { OpenBooks, type OpenCompanyHandle } from '../books/open-books'
import type { CofferDb } from '../db/kysely'
import { RepoError } from '../db/repos/errors'
import { openDocumentsFor, settlementFor } from '../db/repos/outstanding'
import {
  allocateReceipt,
  cancelReceipt,
  createReceipt,
  getReceipt,
  listReceipts,
} from '../db/repos/receipts'

export class ReceiptsService {
  private readonly books: OpenBooks

  constructor(companies: OpenCompanyHandle) {
    this.books = new OpenBooks(companies)
  }

  async list(input: ListReceiptsInput = {}): Promise<ReceiptSummary[]> {
    return listReceipts(this.books.db(), input)
  }

  async get(id: string): Promise<Receipt | null> {
    return getReceipt(this.books.db(), id)
  }

  async create(input: CreateReceiptInput): Promise<Receipt> {
    return createReceipt(this.books.db(), input, new Date().toISOString())
  }

  async allocate(input: AllocateReceiptInput): Promise<Receipt> {
    return allocateReceipt(this.books.db(), input, new Date().toISOString())
  }

  async cancel(input: CancelReceiptInput): Promise<Receipt> {
    return cancelReceipt(this.books.db(), input, new Date().toISOString())
  }

  /**
   * What has been paid against one document, and what is left.
   *
   * Refuses a document these books do not have rather than answering zeros. An invoice
   * that is not there and an invoice with nothing outstanding are different facts, and a
   * screen given the second for the first would show a paid invoice that does not exist.
   */
  async settlement(documentId: string): Promise<DocumentSettlement> {
    const db = this.books.db()
    const document = await requireDocument(db, documentId)
    const result = await settlementFor(db, document)

    return {
      documentId,
      movement: toMoneyString(result.movement),
      allocated: toMoneyString(result.allocated),
      outstanding: toMoneyString(result.outstanding),
      receipts: result.receipts.map((receipt) => ({
        receiptId: receipt.receiptId,
        number: receipt.number,
        date: receipt.date,
        amount: toMoneyString(receipt.amount),
      })),
    }
  }

  /**
   * A party's documents with something still against them, oldest first.
   *
   * The kind arrives as a string off IPC, so the cast is the question — and the picker
   * itself is the answer, because `openDocumentsFor` puts it through `settles()`, which
   * goes through `receiptDefinitionOf` and throws for anything this build does not know.
   * There WAS a `requireKind` guard on the line above; a mutation pass found it could be
   * deleted with nothing failing, because it asked the same function the same question
   * one line earlier. The 2.1a-2 finding: when a mutation survives because two things
   * agree, ask whether one of them should exist.
   *
   * IT USED TO PASS A SIDE, worked out here. It passes the kind now and lets the picker
   * decide, because a side no longer answers which documents a voucher settles — a
   * receipt and a refund share one.
   */
  async open(input: OpenDocumentsInput): Promise<OpenDocument[]> {
    const rows = await openDocumentsFor(this.books.db(), {
      partyId: input.partyId,
      kind: input.kind as ReceiptKind,
      exceptReceiptId: input.exceptReceiptId,
    })

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      number: row.number,
      date: row.date,
      grandTotal: toMoneyString(row.grandTotal),
      outstanding: toMoneyString(row.outstanding),
    }))
  }
}

export function createReceiptsService(companies: OpenCompanyHandle): ReceiptsService {
  return new ReceiptsService(companies)
}

/**
 * The document a settlement was asked about, reduced to what deciding it needs.
 *
 * Read here rather than in `settlementFor`, which takes the row it needs as an argument
 * so that `db/repos/outstanding.ts` stays a file of arithmetic over rows a caller has
 * already fetched — the same shape `documentTotals` and every posting rule take.
 */
async function requireDocument(db: CofferDb, id: string) {
  const row = await db
    .selectFrom('documents')
    .select(['id', 'kind', 'party_id', 'entry_id'])
    .where('id', '=', id)
    .executeTakeFirst()

  if (row === undefined) {
    throw new RepoError('DOCUMENT_NOT_FOUND', 'That document is not in these books.', { id })
  }
  return { id: row.id, kind: row.kind, partyId: row.party_id, entryId: row.entry_id }
}
