/*
 * Recording money, and saying what it settles.
 *
 * Read the three rules at the top of src/main/domain/receipts/types.ts, then 0012. This
 * file is rule 1 doing its work: `createReceipt` is not "save a receipt" followed by a
 * posting step, because there is no state between the two — the number is allocated, the
 * entry is written and the row is inserted in ONE transaction, or none of it happened.
 *
 * It is `issuing.ts` and `documents.ts` collapsed into one file, and that is not laziness
 * — it is the shape of the thing. Those are two files because drafting and issuing are
 * two operations separated by time, and a receipt has no draft to separate.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER IS THE ONE ISSUING USES, AND FOR THE SAME REASON
 *
 * Period, then number, then entry, then row. The entry's narration and its
 * `source.number` both carry the number, so there is no entry to build until the counter
 * has moved — and `allocateNumber` has no undo and must not grow one, because a released
 * number is a gap in a series rule 50 wants consecutive. The rollback takes its place.
 *
 * ---------------------------------------------------------------------------
 * ALLOCATIONS ARE REPLACED WHOLESALE, NEVER PATCHED
 *
 * `allocateReceipt` takes the whole list and an empty one un-allocates everything. That
 * is what the record IS: a statement about which invoices this money pays, and half a
 * statement is not a smaller version of it. It also means the four triggers in 0012 only
 * have to hold on INSERT, which is why `receipt_allocations_immutable` can refuse every
 * UPDATE outright.
 *
 * ---------------------------------------------------------------------------
 * CANCELLING A RECEIPT DELETES ITS ALLOCATIONS. CANCELLING A DOCUMENT IS REFUSED.
 *
 * The asymmetry is deliberate and it is the subtlest thing in the file.
 *
 * Cancelling a receipt un-does the money. The invoices it was matched against correctly
 * go back to unpaid, and deleting the rows is what makes that true everywhere at once —
 * the alternative, leaving them and filtering on the receipt's status in every reader, is
 * a filter somebody forgets, which is how ledger invariant 2 puts it.
 *
 * Cancelling a DOCUMENT is the other way round: the money still exists and still belongs
 * to the party. Detaching it silently would turn it into on-account money nobody decided
 * to create, and the user would find it only by wondering why a customer's balance no
 * longer matched their own list. So it is refused, here and in a trigger, and the user
 * un-allocates first — which is one action and an explicit decision about where their
 * money goes.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE CHECKS THAT 0012 DOES NOT
 *
 * The cap on a DOCUMENT — that no more is allocated to one than it put on the party's
 * account. 0012's header says why it is not a trigger; what belongs here is the other
 * half of that argument, which is that this layer can say the sentence properly. "INV/
 * 2026-27/0007 has 2,000.00 outstanding and 5,000.00 was allocated to it" is something a
 * user can act on, and `SQLITE_CONSTRAINT_TRIGGER` is not.
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'

import { D, ZERO, parseMoney, toMoneyString, type Decimal } from '@main/domain/money'
import { definitionOf, type DocumentKind } from '@main/domain/documents'
import { isPostingError, type AccountingPeriodRef, type EntryDraft } from '@main/domain/ledger'
import {
  receiptDefinitionOf,
  receiptPostingRuleFor,
  type PostableReceipt,
  type ReceiptKind,
} from '@main/domain/receipts'
import type {
  AllocateReceiptInput,
  AllocationInput,
  CancelReceiptInput,
  CreateReceiptInput,
  DateString,
  ListReceiptsInput,
  Receipt,
  ReceiptAllocationDto,
  ReceiptStatusDto,
  ReceiptSummary,
} from '@shared/dto'

import type { CofferDb } from '../kysely'
import { buildResolver } from './accounts'
import { RepoError, repoErrorFrom, type RepoErrorCode } from './errors'
import { postEntry, reverseEntry } from './journal'
import { allocateNumber, defaultSeriesFor } from './numbering'
import { allocatedToDocument, documentMovement, type DocumentControl } from './outstanding'
import { assertPartiesActive } from './parties'
import { periodRefForDate } from './periods'
import { inTransaction } from './transaction'

/** The same ceiling `listDocuments` uses, and exported for the same reason: to cross it. */
export const MAX_RECEIPT_PAGE = 500

// ---- Reading ---------------------------------------------------------------

/**
 * Receipts in a register, newest first.
 *
 * Ordered by date and then by number rather than by when the row was written, exactly as
 * `listDocuments` is: a receipt back-dated into last month belongs where its date says.
 */
export async function listReceipts(
  db: CofferDb,
  input: ListReceiptsInput = {},
): Promise<ReceiptSummary[]> {
  let query = db
    .selectFrom('receipts')
    .innerJoin('parties', 'parties.id', 'receipts.party_id')
    .select([
      'receipts.id as id',
      'receipts.kind as kind',
      'receipts.status as status',
      'receipts.number as number',
      'receipts.receipt_date as receipt_date',
      'receipts.party_id as party_id',
      'receipts.amount as amount',
      'parties.name as party_name',
    ])

  if (input.kind !== undefined) query = query.where('receipts.kind', '=', input.kind)
  if (input.status !== undefined) query = query.where('receipts.status', '=', input.status)
  if (input.partyId !== undefined) query = query.where('receipts.party_id', '=', input.partyId)
  if (input.fromDate !== undefined) {
    query = query.where('receipts.receipt_date', '>=', input.fromDate)
  }
  if (input.toDate !== undefined) query = query.where('receipts.receipt_date', '<=', input.toDate)

  /* The blank guard saves four LIKEs and is not a rule — `.trim()` would reduce an
   * all-space term to '%%', which matches everything. Same note as `listDocuments`. */
  if (input.search !== undefined && input.search.trim() !== '') {
    const term = `%${input.search.trim()}%`
    query = query.where((eb) =>
      eb.or([
        eb(sql<string>`receipts.number COLLATE NOCASE`, 'like', term),
        eb(sql<string>`parties.name COLLATE NOCASE`, 'like', term),
        eb(sql<string>`receipts.reference COLLATE NOCASE`, 'like', term),
        eb(sql<string>`receipts.narration COLLATE NOCASE`, 'like', term),
      ]),
    )
  }

  const rows = await query
    .orderBy('receipts.receipt_date', 'desc')
    .orderBy('receipts.number', 'desc')
    .orderBy('receipts.created_at', 'desc')
    .limit(Math.min(input.limit ?? MAX_RECEIPT_PAGE, MAX_RECEIPT_PAGE))
    .offset(input.offset ?? 0)
    .execute()

  /* One query for every allocation on the page rather than one per receipt. What is
   * allocated is a fold, because there is no stored figure to read instead (rule 3). */
  const allocated = await allocatedByReceipt(
    db,
    rows.map((row) => row.id),
  )

  return rows.map((row) => {
    const sum = allocated.get(row.id) ?? ZERO
    return {
      id: row.id,
      kind: row.kind,
      status: row.status as ReceiptStatusDto,
      number: row.number,
      date: row.receipt_date,
      partyId: row.party_id,
      partyName: row.party_name,
      amount: row.amount,
      allocated: toMoneyString(sum),
      unallocated: toMoneyString(D(row.amount).minus(sum)),
    }
  })
}

/** One receipt, with what it settles. */
export async function getReceipt(db: CofferDb, id: string): Promise<Receipt | null> {
  const row = await db
    .selectFrom('receipts')
    .innerJoin('parties', 'parties.id', 'receipts.party_id')
    .innerJoin('accounts', 'accounts.id', 'receipts.account_id')
    .select([
      'receipts.id as id',
      'receipts.kind as kind',
      'receipts.status as status',
      'receipts.number as number',
      'receipts.series_id as series_id',
      'receipts.receipt_date as receipt_date',
      'receipts.party_id as party_id',
      'receipts.amount as amount',
      'receipts.account_id as account_id',
      'receipts.reference as reference',
      'receipts.narration as narration',
      'receipts.entry_id as entry_id',
      'receipts.created_at as created_at',
      'receipts.updated_at as updated_at',
      'receipts.cancelled_at as cancelled_at',
      'parties.name as party_name',
      'accounts.name as account_name',
    ])
    .where('receipts.id', '=', id)
    .executeTakeFirst()

  if (row === undefined) return null

  const allocations = await allocationsFor(db, id)
  const allocated = allocations.reduce<Decimal>(
    (total, allocation) => total.plus(D(allocation.amount)),
    ZERO,
  )

  return {
    id: row.id,
    kind: row.kind,
    status: row.status as ReceiptStatusDto,
    number: row.number,
    seriesId: row.series_id,
    date: row.receipt_date,
    partyId: row.party_id,
    partyName: row.party_name,
    amount: row.amount,
    accountId: row.account_id,
    accountName: row.account_name,
    reference: row.reference,
    narration: row.narration,
    entryId: row.entry_id,
    allocations,
    allocated: toMoneyString(allocated),
    unallocated: toMoneyString(D(row.amount).minus(allocated)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cancelledAt: row.cancelled_at,
  }
}

// ---- Writing ---------------------------------------------------------------

/**
 * Record money, post it, and say what it settles. One transaction, or nothing.
 *
 * There is no `postReceipt` beside this and there will not be one. Rule 1 says a receipt
 * exists only as something that has posted, so a second function would be a second way to
 * reach a state the first one makes unrepresentable.
 */
export async function createReceipt(
  db: CofferDb,
  input: CreateReceiptInput,
  now: string,
): Promise<Receipt> {
  const kind = requireKind(input.kind)
  const amount = requireAmount(input.amount)
  const id = randomUUID()

  await inTransaction(db, async (trx) => {
    await assertPartiesActive(trx, [input.partyId])
    await assertMoneyAccount(trx, input.accountId, kind)

    const period = await requireCoveringPeriod(trx, input.date)
    const seriesId = input.seriesId ?? (await requireDefaultSeries(trx, kind))
    const number = await allocateNumber(trx, seriesId, period.fiscalYearLabel)

    const postable: PostableReceipt = {
      id,
      kind,
      number,
      date: input.date,
      partyId: input.partyId,
      amount,
      accountId: input.accountId,
      reference: (input.reference ?? '').trim(),
      narration: (input.narration ?? '').trim(),
    }

    const draft = await buildEntry(trx, postable, period)
    const entryId = (await postEntry(trx, draft)).entryId

    await trx
      .insertInto('receipts')
      .values({
        id,
        kind,
        status: 'posted',
        number,
        series_id: seriesId,
        receipt_date: input.date,
        party_id: input.partyId,
        amount: toMoneyString(amount),
        account_id: input.accountId,
        reference: postable.reference,
        narration: postable.narration,
        entry_id: entryId,
        created_at: now,
        updated_at: now,
        cancelled_at: null,
      })
      .execute()

    await replaceAllocations(trx, id, input.partyId, kind, amount, input.allocations ?? [], now)
  })

  return (await getReceipt(db, id))!
}

/**
 * Replace what a receipt settles.
 *
 * The whole set, and an empty list un-allocates everything. Writes no entry and changes
 * no balance — rule 2 — which is why this is the one thing about a posted receipt that
 * may still be changed.
 */
export async function allocateReceipt(
  db: CofferDb,
  input: AllocateReceiptInput,
  now: string,
): Promise<Receipt> {
  return inTransaction(db, async (trx) => {
    const receipt = await requireReceipt(trx, input.id)
    if (receipt.status !== 'posted') {
      throw new RepoError(
        'RECEIPT_CANCELLED',
        `${receipt.number} has been cancelled and settles nothing.`,
        { id: receipt.id, number: receipt.number },
      )
    }

    await replaceAllocations(
      trx,
      receipt.id,
      receipt.partyId,
      requireKind(receipt.kind),
      D(receipt.amount),
      input.allocations,
      now,
    )

    await trx
      .updateTable('receipts')
      .set({ updated_at: now })
      .where('id', '=', receipt.id)
      .execute()

    return (await getReceipt(trx, receipt.id))!
  })
}

/**
 * Cancel a receipt: reverse its entry, drop what it settled, and record that it went.
 *
 * The number is kept (rule 1), so cancelling and deleting are not the same operation and
 * there is no delete. The allocations go — see the header for why that is not symmetrical
 * with cancelling a document.
 */
export async function cancelReceipt(
  db: CofferDb,
  input: CancelReceiptInput,
  now: string,
): Promise<Receipt> {
  return inTransaction(db, async (trx) => {
    const receipt = await requireReceipt(trx, input.id)
    if (receipt.status === 'cancelled') {
      throw new RepoError('RECEIPT_CANCELLED', `${receipt.number} has already been cancelled.`, {
        id: receipt.id,
        number: receipt.number,
      })
    }

    const date: DateString = input.date ?? receipt.date
    await reverseEntry(trx, {
      entryId: receipt.entryId,
      date,
      narration: reversalNarration(receipt, input.narration),
    })

    await trx.deleteFrom('receipt_allocations').where('receipt_id', '=', receipt.id).execute()

    await trx
      .updateTable('receipts')
      .set({ status: 'cancelled', cancelled_at: now, updated_at: now })
      .where('id', '=', receipt.id)
      .execute()

    return (await getReceipt(trx, receipt.id))!
  })
}

// ---- Allocations -----------------------------------------------------------

/**
 * Write one receipt's allocations, having taken the old ones away.
 *
 * Delete then insert rather than a diff, which is what makes the set a statement rather
 * than a history — and it is what lets 0012's triggers guard INSERT alone. The deletes
 * happen first so that the caps below measure against what will actually be there.
 */
async function replaceAllocations(
  db: CofferDb,
  receiptId: string,
  partyId: string,
  kind: ReceiptKind,
  receiptAmount: Decimal,
  allocations: readonly AllocationInput[],
  now: string,
): Promise<void> {
  await db.deleteFrom('receipt_allocations').where('receipt_id', '=', receiptId).execute()
  if (allocations.length === 0) return

  /*
   * TWO PASSES, AND THE ORDER IS THE POINT. Everything that can be judged without
   * touching the database is judged first — the amounts, the duplicates, and the total
   * against what the receipt holds — because the LAST of those is also a trigger, and a
   * check that runs after the insert that trips the trigger can never answer.
   *
   * That is not hypothetical: this was written the other way round, with the total
   * checked after the loop, and a mutation deleting it changed no test. The trigger
   * caught every case first and reported the same code through `repoErrorFrom`, so the
   * check was unreachable and no assertion could tell. Fifth batch running for that
   * shape; see docs/CONVENTIONS.md §6.
   */
  const seen = new Set<string>()
  const amounts: { documentId: string; amount: Decimal }[] = []
  let total = ZERO

  for (const allocation of allocations) {
    if (seen.has(allocation.documentId)) {
      /*
       * Two rows for one document add up to the same money and say it twice, and every
       * screen listing what this receipt paid would show one invoice on two lines. 0012's
       * UNIQUE would catch it; this catches it with the document named.
       */
      throw new RepoError(
        'ALLOCATION_EXCEEDS_DOCUMENT',
        'The same document is allocated to twice in one receipt. Put it on one line.',
        { documentId: allocation.documentId },
      )
    }
    seen.add(allocation.documentId)

    const amount = requireAllocationAmount(allocation.amount)
    total = total.plus(amount)
    amounts.push({ documentId: allocation.documentId, amount })
  }

  if (total.greaterThan(receiptAmount)) {
    throw new RepoError(
      'ALLOCATION_EXCEEDS_RECEIPT',
      `${toMoneyString(total)} was allocated out of a receipt for ` +
        `${toMoneyString(receiptAmount)}. Money cannot settle more than arrived.`,
      { allocated: toMoneyString(total), amount: toMoneyString(receiptAmount) },
    )
  }

  for (const { documentId, amount } of amounts) {
    const document = await requireSettleableDocument(db, documentId, partyId, kind)
    await assertWithinDocument(db, document, receiptId, amount)

    await db
      .insertInto('receipt_allocations')
      .values({
        id: randomUUID(),
        receipt_id: receiptId,
        document_id: document.id,
        amount: toMoneyString(amount),
        created_at: now,
      })
      .execute()
      .catch((error: unknown) => {
        throw repoErrorFrom(error, 'ALLOCATION_PARTY_MISMATCH')
      })
  }
}

/**
 * The document an allocation names, proved settleable by this receipt.
 *
 * Four questions, and each of them has its own sentence because they are four different
 * mistakes: it does not exist, it has not been issued, it is somebody else's, or it is on
 * the wrong side of the trade. 0012 makes three of them triggers as well.
 */
async function requireSettleableDocument(
  db: CofferDb,
  documentId: string,
  partyId: string,
  kind: ReceiptKind,
): Promise<DocumentControl & { number: string | null }> {
  const row = await db
    .selectFrom('documents')
    .select(['id', 'kind', 'status', 'number', 'party_id', 'entry_id'])
    .where('id', '=', documentId)
    .executeTakeFirst()

  if (row === undefined) {
    throw new RepoError('DOCUMENT_NOT_FOUND', 'That document is not in these books.', {
      documentId,
    })
  }
  if (row.status !== 'issued') {
    throw new RepoError(
      'DOCUMENT_NOT_ISSUED',
      row.status === 'draft'
        ? 'A draft has posted nothing, so there is nothing to settle. Issue it first.'
        : `${row.number ?? 'That document'} has been cancelled and owes nothing.`,
      { documentId, status: row.status },
    )
  }
  if (row.party_id !== partyId) {
    throw new RepoError(
      'ALLOCATION_PARTY_MISMATCH',
      `${row.number ?? 'That document'} belongs to a different party. ` +
        "One party's money cannot settle another's invoice.",
      { documentId, documentPartyId: row.party_id, receiptPartyId: partyId },
    )
  }

  const side = definitionOf(row.kind as DocumentKind).side
  if (side !== receiptDefinitionOf(kind).side) {
    throw new RepoError(
      'ALLOCATION_SIDE_MISMATCH',
      `${receiptDefinitionOf(kind).pluralLabel} settle ` +
        `${side === 'sales' ? 'purchases' : 'sales'}, not ${side}. ` +
        `${row.number ?? 'That document'} is a ${definitionOf(row.kind as DocumentKind).label.toLowerCase()}.`,
      { documentId, documentKind: row.kind, receiptKind: kind },
    )
  }

  return {
    id: row.id,
    kind: row.kind,
    partyId: row.party_id,
    entryId: row.entry_id,
    number: row.number,
  }
}

/**
 * Refuse to allocate more to a document than it put on the party's account.
 *
 * The cap 0012 declines to make a trigger, and its header says why. What this adds is the
 * figures: what the document has left, and what was asked for.
 *
 * `exceptReceiptId` IS A DELIBERATE EQUIVALENT MUTANT, recorded here so the next pass does
 * not re-investigate it. This runs after THIS receipt's old allocations have been deleted,
 * so excluding them excludes rows that no longer exist and the argument changes nothing
 * observable. It is passed anyway, because the deletion is one line away from being moved
 * and a cap that quietly counted a receipt against itself would refuse a user their own
 * money the second time they opened an allocation and pressed save.
 */
async function assertWithinDocument(
  db: CofferDb,
  document: DocumentControl & { number: string | null },
  receiptId: string,
  amount: Decimal,
): Promise<void> {
  const movement = await documentMovement(db, document)
  const already = await allocatedToDocument(db, document.id, receiptId)
  const outstanding = movement.minus(already)

  if (amount.lessThanOrEqualTo(outstanding)) return

  throw new RepoError(
    'ALLOCATION_EXCEEDS_DOCUMENT',
    `${document.number ?? 'That document'} has ${toMoneyString(outstanding)} outstanding, ` +
      `and ${toMoneyString(amount)} was allocated to it.`,
    {
      documentId: document.id,
      outstanding: toMoneyString(outstanding),
      requested: toMoneyString(amount),
    },
  )
}

async function allocationsFor(db: CofferDb, receiptId: string): Promise<ReceiptAllocationDto[]> {
  const rows = await db
    .selectFrom('receipt_allocations')
    .innerJoin('documents', 'documents.id', 'receipt_allocations.document_id')
    .select([
      'receipt_allocations.id as id',
      'receipt_allocations.document_id as document_id',
      'receipt_allocations.amount as amount',
      'documents.kind as kind',
      'documents.number as number',
      'documents.document_date as document_date',
    ])
    .where('receipt_allocations.receipt_id', '=', receiptId)
    .orderBy('documents.document_date', 'asc')
    .orderBy('documents.number', 'asc')
    .execute()

  return rows.map((row) => ({
    id: row.id,
    documentId: row.document_id,
    documentKind: row.kind,
    /* Never null in practice: only an issued document may be allocated to, and rule 2 of
     * the document contract gives every one of those a number. The fallback is here
     * because the column is nullable and a DTO that lied about it would push the
     * assertion into every screen. */
    documentNumber: row.number ?? '',
    documentDate: row.document_date,
    amount: row.amount,
  }))
}

/** What each of several receipts has allocated, in one query rather than one per row. */
async function allocatedByReceipt(
  db: CofferDb,
  receiptIds: string[],
): Promise<Map<string, Decimal>> {
  const totals = new Map<string, Decimal>()
  if (receiptIds.length === 0) return totals

  const rows = await db
    .selectFrom('receipt_allocations')
    .select(['receipt_id', 'amount'])
    .where('receipt_id', 'in', receiptIds)
    .execute()

  for (const row of rows) {
    totals.set(row.receipt_id, (totals.get(row.receipt_id) ?? ZERO).plus(D(row.amount)))
  }
  return totals
}

// ---- Guards ----------------------------------------------------------------

async function requireReceipt(db: CofferDb, id: string): Promise<Receipt> {
  const receipt = await getReceipt(db, id)
  if (receipt === null) {
    throw new RepoError('RECEIPT_NOT_FOUND', 'That receipt is not in these books.', { id })
  }
  return receipt
}

/**
 * The kind, proved to be one this build knows.
 *
 * `receiptDefinitionOf` throws a plain Error for an unknown kind, which is right for a
 * value the type system already narrowed — but this one arrives as a string off IPC, so
 * the cast is the question and the call is the answer. Same shape as `requireKind` in
 * numbering.ts, and 0012's CHECK is the floor under a row written another way.
 */
function requireKind(kind: string): ReceiptKind {
  return receiptDefinitionOf(kind as ReceiptKind).kind
}

/**
 * The amount, at money scale and worth recording.
 *
 * Zero and negative are both refused, and by the same rule rather than two: a receipt
 * says money moved, and neither of those did. A negative one is a payment, and 0012's
 * unsigned shape refuses it at the column too — the direction is `kind`, never the sign.
 */
function requireAmount(value: string): Decimal {
  let amount: Decimal
  try {
    amount = parseMoney(value)
  } catch (error) {
    throw new RepoError(
      'RECEIPT_AMOUNT_INVALID',
      `${JSON.stringify(value)} is not an amount of money.`,
      { value },
      { cause: error },
    )
  }
  if (amount.greaterThan(0)) return amount

  throw new RepoError(
    'RECEIPT_AMOUNT_INVALID',
    amount.isZero()
      ? 'A receipt records money that moved. Enter what was received.'
      : 'A receipt is never negative — money out is a payment. Record it as one.',
    { value },
  )
}

function requireAllocationAmount(value: string): Decimal {
  let amount: Decimal
  try {
    amount = parseMoney(value)
  } catch (error) {
    throw new RepoError(
      'RECEIPT_AMOUNT_INVALID',
      `${JSON.stringify(value)} is not an amount of money.`,
      { value },
      { cause: error },
    )
  }
  if (amount.greaterThan(0)) return amount

  throw new RepoError(
    'RECEIPT_AMOUNT_INVALID',
    'An allocation of nothing is not a statement. Take the line off instead.',
    { value },
  )
}

/**
 * The account money moved through, proved able to hold a posting.
 *
 * NOT a check that it is a bank or a cash account, and 0012 says why a CHECK cannot be
 * one either: `account_roles` holds one `bank` and one `cash`, and a business with four
 * bank accounts posts to three that fill no role at all. What is actually wrong is a
 * group, an archived account, or the control account the other line of this very entry
 * is about to use — which would post a receipt against itself and settle nothing while
 * balancing perfectly.
 */
async function assertMoneyAccount(
  db: CofferDb,
  accountId: string,
  kind: ReceiptKind,
): Promise<void> {
  const account = await db
    .selectFrom('accounts')
    .select(['id', 'name', 'is_group', 'is_archived'])
    .where('id', '=', accountId)
    .executeTakeFirst()

  if (account === undefined) {
    throw new RepoError('ACCOUNT_NOT_FOUND', 'That account is not in these books.', { accountId })
  }
  if (account.is_group === 1) {
    throw new RepoError(
      'RECEIPT_ACCOUNT_INVALID',
      `${account.name} is a group. Money lands in one of the accounts under it.`,
      { accountId, name: account.name },
    )
  }
  if (account.is_archived === 1) {
    throw new RepoError(
      'RECEIPT_ACCOUNT_INVALID',
      `${account.name} is archived and takes nothing new.`,
      { accountId, name: account.name },
    )
  }

  const control = await db
    .selectFrom('account_roles')
    .select('account_id')
    .where('role', '=', receiptDefinitionOf(kind).controlRole)
    .executeTakeFirst()

  if (control?.account_id === accountId) {
    throw new RepoError(
      'RECEIPT_ACCOUNT_INVALID',
      `${account.name} is the account this ${receiptDefinitionOf(kind).label.toLowerCase()} ` +
        'settles against. Choose the bank or cash account the money moved through.',
      { accountId, name: account.name },
    )
  }
}

async function requireCoveringPeriod(db: CofferDb, date: DateString): Promise<AccountingPeriodRef> {
  const period = await periodRefForDate(db, date)
  if (period === null) {
    throw new RepoError('NO_PERIOD', `The books have no period covering ${date}.`, { date })
  }
  return period
}

async function requireDefaultSeries(db: CofferDb, kind: ReceiptKind): Promise<string> {
  const series = await defaultSeriesFor(db, kind)
  if (series !== null) return series.id

  throw new RepoError(
    'SERIES_NOT_CONFIGURED',
    `These books have no numbering series for ${receiptDefinitionOf(kind).pluralLabel.toLowerCase()}. ` +
      'Set one up before recording this.',
    { kind },
  )
}

/** What the day book says about a reversal, when the caller does not say it themselves. */
function reversalNarration(receipt: Receipt, given: string | undefined): string {
  const own = given?.trim() ?? ''
  if (own !== '') return own
  return `Cancellation of ${receiptDefinitionOf(requireKind(receipt.kind)).label.toLowerCase()} ${receipt.number}`
}

/**
 * Run the posting rule, and turn what it refuses into what this layer refuses.
 *
 * The same translation `issuing.ts` does, and for the same reason: every code a
 * `PostingError` can carry is already a `RepoErrorCode` meaning the same thing, and the
 * domain's message already names the account.
 */
async function buildEntry(
  db: CofferDb,
  receipt: PostableReceipt,
  period: AccountingPeriodRef,
): Promise<EntryDraft> {
  const context = {
    accounts: await buildResolver(db),
    period,
    /* No receipt rule branches on it and none should — where a supply took place is a
     * question about a supply, and this is money. Passed because `PostingContext` is one
     * shape for every rule; see `postingContextFor` in issuing.ts, which is the document
     * side of the same argument. */
    homeJurisdictionCode: null,
  }

  try {
    return receiptPostingRuleFor(receipt.kind).toEntry(receipt, context)
  } catch (error) {
    if (isPostingError(error)) {
      throw new RepoError(error.code as RepoErrorCode, error.message, error.details, {
        cause: error,
      })
    }
    throw error
  }
}
