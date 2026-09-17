/*
 * The aged report: a party control account as at a date, decomposed into what put money
 * on it and how old each piece is.
 *
 * The arithmetic of a bucket is in domain/reports/ageing.ts. What is here is the harder
 * half — deciding what belongs in the report at all, and as at WHEN.
 *
 * ---------------------------------------------------------------------------
 * IT IS THE ACCOUNT, NOT A LIST OF UNPAID INVOICES
 *
 * The report's claim is that its total equals the receivables (or payables) figure on the
 * balance sheet at the same date. That claim is the only reason anyone can act on it: a
 * page of open invoices that comes to a different number than the accounts is a page
 * somebody has to reconcile before they can use it, which is the work it was supposed to
 * have done.
 *
 * So the source is `journal_lines` on the control account — every one of them — and each
 * line is then attributed to whatever raised it. Three things can have:
 *
 *   a document   an invoice, a credit note, a bill, a debit note
 *   a receipt    money in or out, with whatever is unallocated standing on account
 *   neither      an opening balance, or a manual journal against the control account
 *
 * The third is not an exception to tidy away later. Opening balances are how an existing
 * business starts, `postOpeningBalances` tags them per party for exactly this report, and
 * a version of this file that only understood documents would show a newly adopted set of
 * books as owing nothing at all.
 *
 * ---------------------------------------------------------------------------
 * WHAT "AS AT" MEANS, IN THREE PLACES
 *
 * The date is not a filter on `documents.document_date`. It is a filter on the LEDGER, in
 * every place a figure comes from, and the three have to agree or the total stops tying:
 *
 *   1. A movement counts when its ENTRY is dated on or before the date. That is what
 *      makes a document cancelled next month still outstanding today: the reversal is a
 *      second entry with a later date, so it is simply not in range yet.
 *
 *   2. A MATCH counts when BOTH ends were in the books by the date. One end alone gives a
 *      readable-looking answer that is nonsense: a receipt dated in January against an
 *      invoice dated in June shows, in March, an invoice nobody has raised as part paid.
 *      There are two matching tables since 0016 — `receipt_allocations` and
 *      `document_offsets` — and the rule is the same for both, which is why one function
 *      folds them together rather than the report doing it twice.
 *
 *   3. The control balance the report checks itself against is summed over the same
 *      lines with the same filter, by `signedEffect` — the same function the balance
 *      sheet uses. Two routes to one figure, which is what makes `ties` a statement.
 *
 * WHAT AS-AT CANNOT RECOVER, said plainly: cancelling a receipt DELETES its allocations
 * (rule 2, and `cancelReceipt`), so a report as at a date before the cancellation cannot
 * know which invoices that money used to sit against. The total is unaffected — the money
 * simply appears as unallocated instead — so the page still ties, and the distribution
 * across invoices is the part that has genuinely gone. Recording it would mean giving
 * allocations a history, which rule 2 declines to do on purpose.
 *
 * ---------------------------------------------------------------------------
 * A MATCH ALWAYS OPPOSES THE END IT IS ON, AND THAT IS ONE RULE RATHER THAN TWO
 *
 * This file took allocations OFF the document and put them BACK ON the receipt, and the
 * comment beside it explained the asymmetry correctly for the world it was written in: a
 * document's movement was positive and a receipt's was negative, so bringing each of them
 * towards zero meant opposite signs.
 *
 * IT WAS THE RIGHT PAIR OF SIGNS FOR THE WRONG REASON, and 0015-1 broke it by adding the
 * two kinds it did not cover. A credit note's movement is NEGATIVE and a refund paid is
 * POSITIVE, so a refund of 400 against a credit note of 1,180 reported the note at -1,580
 * and the voucher at +800 — the note driven further from zero by money actually paid back,
 * and a fully-settled voucher showing double what it was for. MEASURED, not reasoned
 * about: both figures came off a report that still said `ties: true`, because the two
 * errors are equal and opposite and cancel at the foot. The rows were nonsense and the
 * total was right, which is the worst way for a report to be wrong.
 *
 * So the sign is now read from the END'S OWN FACING rather than from which table it came
 * out of: a match reduces what is unsettled at both of its ends, so it opposes a `charge`
 * and joins a `refund`, whether that end is a document or a voucher. `receiptFacing` is
 * what lets a voucher be described in the same word a document is — and it says the thing
 * worth saying out loud, which is that A RECEIPT MOVES RECEIVABLES THE WAY A CREDIT NOTE
 * DOES.
 *
 * AND THE TOTAL STILL TIES BY CONSTRUCTION, for a better reason than before. Every
 * matching row is applied at two ends that face opposite ways, so it contributes +a and
 * -a and vanishes from the foot — which is what "a match moves no money" means
 * arithmetically. That is asserted rather than assumed, in ageing.test.ts.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ROLE DECIDES THE ACCOUNT, WHEN OUTSTANDING.TS REFUSES TO USE IT
 *
 * outstanding.ts argues at length against reading `account_roles` and it is right, for
 * the question it is asking: WHICH LINE of an entry is the control line. The party's id
 * answers that, and goes on answering it after a role is repointed.
 *
 * This file asks a different question — WHICH ACCOUNT am I reporting on — and the role is
 * the only thing that can answer it, because "show me receivables" is a question about a
 * role rather than about a code. It follows that repointing the role moves the report to
 * the new account, and documents posted to the old one drop out of it. That is not a bug
 * being tolerated: they dropped out of the new account's balance too, and the report
 * still equals the account it names. The old account keeps its balance and stays on the
 * balance sheet, in plain sight, which is where that money should be argued about.
 */

import { ZERO, toMoneyString, type Decimal } from '@main/domain/money'
import {
  controlRoleFor,
  definitionOf,
  type DocumentDirection,
  type DocumentKind,
  type TradeSide,
} from '@main/domain/documents'
import { signedEffect, type AccountType } from '@main/domain/ledger'
import { receiptDefinitionOf, receiptFacing, type ReceiptKind } from '@main/domain/receipts'
import { AGE_BUCKETS, ageItems, type AgeableItem, type PlacedItem } from '@main/domain/reports'
import { sql } from 'kysely'

import type { AgedItem, AgedItemSource, AgedPartyRow, AgedReport, DateString } from '@shared/dto'

import type { CofferDb } from '../kysely'
import { fromPaise, paiseSum } from './balances'
import { RepoError } from './errors'

export interface AgedReportOptions {
  side: TradeSide
  /** Inclusive. Everything the ledger holds up to and including this day. */
  asAtDate: DateString
}

/**
 * A movement and its reversal are one thing, and this is the expression that says so.
 *
 * `COALESCE(reverses_entry_id, id)` folds a reversal into the entry it reverses, so a
 * cancelled document nets to nothing with no `status` filter anywhere — the argument at
 * the top of outstanding.ts, written here in SQL because this side has to group by it.
 *
 * It also makes the attribution work: a cancellation entry belongs to no document, and
 * without the fold its lines would show up as an unexplained journal against the party.
 */
const OWNER_ENTRY = sql<string>`COALESCE(journal_entries.reverses_entry_id, journal_entries.id)`

/** The control account a side reports on, resolved through its role. */
interface ControlAccount {
  id: string
  code: string
  name: string
  type: AccountType
}

/** What a group of lines is attributed to, once the owning entry has been looked up. */
interface OwnerDescription {
  source: AgedItemSource
  sourceId: string
  kind: string | null
  number: string
  date: DateString
  /** Stamped at issue on a document that charges on terms; the raising date otherwise. */
  dueDate: DateString
}

/** One thing standing against a party, before it has been aged. */
interface SourceItem extends AgeableItem, OwnerDescription {}

/**
 * The aged report for one side of the trade, as at a date.
 *
 * Everything is fetched first and grouped afterwards. The alternative — a query per party
 * — would be the shape `listDocuments` already refuses for its lines, and worse here:
 * every one of those queries would be a separate read of the same journal, so two parties
 * on one page could be computed from different snapshots.
 */
export async function agedReport(db: CofferDb, options: AgedReportOptions): Promise<AgedReport> {
  const account = await controlAccountFor(db, options.side)
  const { asAtDate } = options

  const [groups, settled, controlPaise] = await Promise.all([
    movementsByOwner(db, account.id, asAtDate),
    settledAsAt(db, asAtDate),
    controlBalancePaise(db, account.id, asAtDate),
  ])

  /*
   * ONE ADDITION, AND ITS SIGN CAME OFF THE END'S OWN FACING — see the header. Every
   * match is applied at both of its ends, opposing each of them, so a receipt half
   * applied to an invoice reduces the invoice AND comes back as half a credit rather than
   * being counted twice; and the two contributions cancel at the foot, which is what
   * makes `ties` a statement about the arithmetic rather than about this loop.
   */
  const open: { partyId: string | null; ownerEntryId: string; amount: Decimal }[] = []
  for (const group of groups) {
    const owed = signedEffect(
      account.type,
      fromPaise(group.debitPaise),
      fromPaise(group.creditPaise),
    )
    const amount = owed.plus(settled.get(group.ownerEntryId) ?? ZERO)

    /* Settled in full, or cancelled, or reversed. Not a row — there is nothing to say
     * about it, and an aged report listing every invoice ever paid is a register. */
    if (amount.isZero()) continue
    open.push({ partyId: group.partyId, ownerEntryId: group.ownerEntryId, amount })
  }

  const owners = await describeOwners(
    db,
    open.map((entry) => entry.ownerEntryId),
  )
  const items: SourceItem[] = open.map((entry) => ({
    ...owners.get(entry.ownerEntryId)!,
    partyId: entry.partyId,
    amount: entry.amount,
  }))

  const names = await partyNames(
    db,
    items.map((item) => item.partyId),
  )
  const ageing = ageItems(AGE_BUCKETS, asAtDate, items)

  const controlBalance = signedEffect(
    account.type,
    fromPaise(controlPaise.debitPaise),
    fromPaise(controlPaise.creditPaise),
  )

  return {
    side: options.side,
    asAtDate,
    accountId: account.id,
    accountCode: account.code,
    accountName: account.name,
    buckets: AGE_BUCKETS.map((bucket) => ({ ...bucket })),
    parties: ageing.parties.map((party) => toPartyRow(party, names)),
    totals: {
      buckets: ageing.totals.buckets.map(toMoneyString),
      onAccount: toMoneyString(ageing.totals.onAccount),
      overdue: toMoneyString(ageing.totals.overdue),
      total: toMoneyString(ageing.totals.total),
    },
    controlBalance: toMoneyString(controlBalance),
    ties: ageing.totals.total.equals(controlBalance),
  }
}

// ---- What the report is made of --------------------------------------------

/**
 * Every line on the control account as at the date, grouped by party and by what raised
 * it.
 *
 * `party_id` is grouped rather than filtered, so a line naming nobody comes back under a
 * null party instead of vanishing. It is a mistake in the books when it happens — every
 * posting rule that touches a control account carries the party — and this report is the
 * only page in the product that would ever show it. Dropping it would also be the one
 * thing that could make the foot disagree with the account.
 */
async function movementsByOwner(
  db: CofferDb,
  accountId: string,
  asAtDate: DateString,
): Promise<
  { partyId: string | null; ownerEntryId: string; debitPaise: number; creditPaise: number }[]
> {
  return db
    .selectFrom('journal_lines')
    .innerJoin('journal_entries', 'journal_entries.id', 'journal_lines.entry_id')
    .select([
      'journal_lines.party_id as partyId',
      OWNER_ENTRY.as('ownerEntryId'),
      paiseSum('journal_lines.debit').as('debitPaise'),
      paiseSum('journal_lines.credit').as('creditPaise'),
    ])
    .where('journal_lines.account_id', '=', accountId)
    .where('journal_entries.entry_date', '<=', asAtDate)
    .groupBy(['journal_lines.party_id', OWNER_ENTRY])
    .execute()
}

/**
 * Everything that has settled anything as at the date, as a SIGNED ADJUSTMENT per owning
 * entry.
 *
 * SIGNED HERE RATHER THAN AT THE CALL SITE, which is the whole shape of the fix. The
 * caller has an entry id and a movement and nothing else — it cannot know whether that
 * movement was an invoice or a credit note without looking the owner up, and the version
 * of this file that decided the sign by which TABLE the figure came out of was wrong for
 * two of the four kinds. Each row here already knows its own end's kind, so the facing is
 * read where it is free.
 *
 * THREE QUERIES AND ONE MAP. An allocation is read through both of its ends and an offset
 * through both of its, which is four contributions from two tables — and every one of
 * them is `against(facing)`, so there is no place left for a sign to be decided by
 * anything but the end it lands on.
 */
async function settledAsAt(db: CofferDb, asAtDate: DateString): Promise<Map<string, Decimal>> {
  const total = new Map<string, Decimal>()
  const add = (entryId: string, amount: Decimal): void => {
    total.set(entryId, (total.get(entryId) ?? ZERO).plus(amount))
  }

  for (const row of await allocationsAsAt(db, asAtDate, 'documents')) {
    add(row.ownerEntryId, against(definitionOf(row.kind as DocumentKind).direction, row.amount))
  }
  for (const row of await allocationsAsAt(db, asAtDate, 'receipts')) {
    const facing = receiptFacing(receiptDefinitionOf(row.kind as ReceiptKind))
    add(row.ownerEntryId, against(facing, row.amount))
  }
  for (const row of await offsetsAsAt(db, asAtDate)) {
    add(row.chargeEntryId, against('charge', row.amount))
    add(row.refundEntryId, against('refund', row.amount))
  }
  return total
}

/**
 * How a match moves the end it is on.
 *
 * It always OPPOSES it: a charge is positive in the account's signing and a match reduces
 * it, a refund is negative and a match brings it up. Two lines, and they are the reason
 * this report ties — applied at two ends facing opposite ways, one row contributes
 * nothing at all to the foot.
 */
function against(facing: DocumentDirection, amount: Decimal): Decimal {
  return facing === 'charge' ? amount.negated() : amount
}

/**
 * What has been allocated as at the date, through one end of the match.
 *
 * TWO CALLS, ONE QUERY, AND THAT IS THE POINT. The document side and the receipt side
 * must count exactly the same rows or the report cannot tie — so the two differ in their
 * GROUP BY and in nothing else, rather than being two queries that would need to be kept
 * in step by whoever edits one of them next.
 *
 * Both entry dates are tested, which is the rule in the header: a match is between two
 * things, and it is not in force until both of them are in the books.
 *
 * THE KIND RIDES ALONG because the sign depends on it. It is functionally determined by
 * the entry — one entry is one document or one voucher — so grouping by both changes no
 * row and saves a second lookup.
 */
async function allocationsAsAt(
  db: CofferDb,
  asAtDate: DateString,
  end: 'documents' | 'receipts',
): Promise<{ ownerEntryId: string; kind: string; amount: Decimal }[]> {
  const entryId = sql.ref(`${end}.entry_id`)
  const kind = sql.ref(`${end}.kind`)

  const rows = await db
    .selectFrom('receipt_allocations')
    .innerJoin('receipts', 'receipts.id', 'receipt_allocations.receipt_id')
    .innerJoin('journal_entries as receipt_entry', 'receipt_entry.id', 'receipts.entry_id')
    .innerJoin('documents', 'documents.id', 'receipt_allocations.document_id')
    .innerJoin('journal_entries as document_entry', 'document_entry.id', 'documents.entry_id')
    .select([
      sql<string>`${entryId}`.as('ownerEntryId'),
      sql<string>`${kind}`.as('kind'),
      paiseSum('receipt_allocations.amount').as('paise'),
    ])
    .where('receipt_entry.entry_date', '<=', asAtDate)
    .where('document_entry.entry_date', '<=', asAtDate)
    .groupBy([sql`${entryId}`, sql`${kind}`])
    .execute()

  return rows.map((row) => ({
    ownerEntryId: row.ownerEntryId,
    kind: row.kind,
    amount: fromPaise(row.paise),
  }))
}

/**
 * What has been offset as at the date, with BOTH ends named on one row.
 *
 * One row rather than two calls, where allocations take two. The difference is that both
 * ends of an offset are documents, so one query already has both entry ids in hand and
 * splitting it would be two reads of one table that have to agree — the exact thing the
 * two allocation calls go out of their way to guarantee by sharing a query body.
 *
 * NO KIND COLUMN, because the column names carry it: the charge end is a charge and the
 * refund end is a refund, which is what 0016's kind trigger enforces on the way in. That
 * is the one place in this file where a facing is written down rather than looked up, and
 * it is sound because the database refuses every row where it would not be.
 */
async function offsetsAsAt(
  db: CofferDb,
  asAtDate: DateString,
): Promise<{ chargeEntryId: string; refundEntryId: string; amount: Decimal }[]> {
  const rows = await db
    .selectFrom('document_offsets')
    .innerJoin('documents as charge', 'charge.id', 'document_offsets.charge_document_id')
    .innerJoin('journal_entries as charge_entry', 'charge_entry.id', 'charge.entry_id')
    .innerJoin('documents as refund', 'refund.id', 'document_offsets.refund_document_id')
    .innerJoin('journal_entries as refund_entry', 'refund_entry.id', 'refund.entry_id')
    .select([
      'charge_entry.id as chargeEntryId',
      'refund_entry.id as refundEntryId',
      paiseSum('document_offsets.amount').as('paise'),
    ])
    .where('charge_entry.entry_date', '<=', asAtDate)
    .where('refund_entry.entry_date', '<=', asAtDate)
    .groupBy(['charge_entry.id', 'refund_entry.id'])
    .execute()

  return rows.map((row) => ({
    chargeEntryId: row.chargeEntryId,
    refundEntryId: row.refundEntryId,
    amount: fromPaise(row.paise),
  }))
}

/** The account's whole balance as at the date, party or no party. */
async function controlBalancePaise(
  db: CofferDb,
  accountId: string,
  asAtDate: DateString,
): Promise<{ debitPaise: number; creditPaise: number }> {
  const row = await db
    .selectFrom('journal_lines')
    .innerJoin('journal_entries', 'journal_entries.id', 'journal_lines.entry_id')
    .select([
      paiseSum('journal_lines.debit').as('debitPaise'),
      paiseSum('journal_lines.credit').as('creditPaise'),
    ])
    .where('journal_lines.account_id', '=', accountId)
    .where('journal_entries.entry_date', '<=', asAtDate)
    .executeTakeFirst()

  return { debitPaise: row?.debitPaise ?? 0, creditPaise: row?.creditPaise ?? 0 }
}

// ---- Attributing a movement to what raised it -------------------------------

/**
 * What each owning entry is, as far as a reader is concerned.
 *
 * Looked up ONLY for the entries that survived the netting above, which is what keeps
 * this bounded: a file with thirty thousand paid invoices has thirty thousand entries on
 * its receivables account and perhaps two hundred with anything still against them.
 * Describing all of them would make the report grow with the history rather than with
 * what is owed.
 *
 * A document, then a receipt, then the entry itself. The order is not a preference: an
 * entry cannot be both, and the last arm is the one that always answers, so it is the
 * fallback rather than a fourth case.
 */
async function describeOwners(
  db: CofferDb,
  ownerEntryIds: readonly string[],
): Promise<Map<string, OwnerDescription>> {
  const described = new Map<string, OwnerDescription>()
  const ids = [...new Set(ownerEntryIds)]
  if (ids.length === 0) return described

  const [documents, receipts, entries] = await Promise.all([
    db
      .selectFrom('documents')
      .select(['id', 'kind', 'number', 'document_date', 'due_date', 'entry_id'])
      .where('entry_id', 'in', ids)
      .execute(),
    db
      .selectFrom('receipts')
      .select(['id', 'kind', 'number', 'receipt_date', 'entry_id'])
      .where('entry_id', 'in', ids)
      .execute(),
    db
      .selectFrom('journal_entries')
      .select(['id', 'entry_number', 'entry_date'])
      .where('id', 'in', ids)
      .execute(),
  ])

  for (const entry of entries) {
    described.set(entry.id, {
      source: 'journal',
      sourceId: entry.id,
      kind: null,
      number: entry.entry_number,
      date: entry.entry_date,
      dueDate: entry.entry_date,
    })
  }
  for (const receipt of receipts) {
    if (receipt.entry_id === null) continue
    described.set(receipt.entry_id, {
      source: 'receipt',
      sourceId: receipt.id,
      /*
       * A `ReceiptKind`, and it is carried for the same reason a document's is: the
       * screen has to know which editor a row opens, and it cannot work that out from
       * the report's side. `domain/receipts/types.ts` argues on purpose that a voucher's
       * control account is STATED rather than derived from its side, so a voucher on the
       * receivable account is not necessarily a receipt — a refund to a customer is money
       * out on the sales side, and guessing would open the wrong editor on the one row
       * whose whole value is that it can be opened.
       */
      kind: receipt.kind,
      number: receipt.number,
      date: receipt.receipt_date,
      /* Money that has arrived is not owed and never ages, so its due date is only ever
       * read as a sort key. Its own date is the honest one to sort by. */
      dueDate: receipt.receipt_date,
    })
  }
  for (const document of documents) {
    if (document.entry_id === null) continue
    described.set(document.entry_id, {
      source: 'document',
      sourceId: document.id,
      kind: document.kind,
      /* Issued, therefore numbered — rule 2 of the document contract. The fallback keeps
       * the DTO honest rather than pushing an assertion into a screen. */
      number: document.number ?? '',
      date: document.document_date,
      /*
       * THE FALLBACK IS THE WHOLE OF HOW A CREDIT NOTE GETS A DATE. 0014 stamps a due
       * date only on the kinds that charge on terms, so a credit note's is null — and it
       * needs none, because a credit stands to the party and never ages. What it does
       * need is something to sort by, and the day it was raised is that.
       */
      dueDate: document.due_date ?? document.document_date,
    })
  }

  return described
}

/** The names, for the parties that actually appear. Null is a line naming nobody. */
async function partyNames(
  db: CofferDb,
  partyIds: readonly (string | null)[],
): Promise<Map<string, string>> {
  const ids = [...new Set(partyIds.filter((id): id is string => id !== null))]
  if (ids.length === 0) return new Map()

  const rows = await db
    .selectFrom('parties')
    .select(['id', 'name'])
    .where('id', 'in', ids)
    .execute()
  return new Map(rows.map((row) => [row.id, row.name]))
}

/** The control account a side reports on. */
async function controlAccountFor(db: CofferDb, side: TradeSide): Promise<ControlAccount> {
  const role = controlRoleFor(side)
  const row = await db
    .selectFrom('account_roles')
    .innerJoin('accounts', 'accounts.id', 'account_roles.account_id')
    .select([
      'accounts.id as id',
      'accounts.code as code',
      'accounts.name as name',
      'accounts.type as type',
    ])
    .where('account_roles.role', '=', role)
    .executeTakeFirst()

  if (row === undefined) {
    throw new RepoError(
      'ROLE_UNMAPPED',
      `No account is mapped to ${role}, so there is no balance to age. ` +
        'Every chart Coffer creates maps one, and no screen can yet, so please report this.',
      { role, side },
    )
  }
  return { id: row.id, code: row.code, name: row.name, type: row.type as AccountType }
}

// ---- Into the shape the boundary carries ------------------------------------

function toPartyRow(
  party: {
    partyId: string | null
    items: PlacedItem<SourceItem>[]
    buckets: Decimal[]
    onAccount: Decimal
    total: Decimal
  },
  names: ReadonlyMap<string, string>,
): AgedPartyRow {
  return {
    partyId: party.partyId,
    /* A name that has gone missing is a broken foreign key, not a party without a name;
     * saying so is more use than an empty cell somebody reads as a rendering fault. */
    partyName:
      party.partyId === null
        ? 'Not attributed to a party'
        : (names.get(party.partyId) ?? 'A party no longer in these books'),
    buckets: party.buckets.map(toMoneyString),
    onAccount: toMoneyString(party.onAccount),
    total: toMoneyString(party.total),
    items: party.items.map(toItem),
  }
}

function toItem(placed: PlacedItem<SourceItem>): AgedItem {
  return {
    source: placed.item.source,
    sourceId: placed.item.sourceId,
    kind: placed.item.kind,
    number: placed.item.number,
    date: placed.item.date,
    dueDate: placed.item.dueDate,
    daysOverdue: placed.daysOverdue,
    bucket: placed.bucket,
    amount: toMoneyString(placed.item.amount),
  }
}
