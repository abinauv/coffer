/*
 * Issuing and cancelling — the one transaction where a document becomes a ledger fact.
 *
 * Read rule 3 at the top of domain/documents/types.ts, then 0008's CHECK on `entry_id`.
 * Everything in this file exists to make that rule true: a document that is issued has
 * posted, has a number, and got both in the same transaction, or none of it happened.
 *
 * IT IS A SEPARATE FILE FROM ./documents.ts ON PURPOSE. Drafting is one repository's
 * business. Issuing spans four — the numbering counter moves, the chart is read, the
 * posting rule runs, the journal is written and the document's row changes — and putting
 * that in the middle of draft handling would hide the one property that matters about it,
 * which is that all of it is inside a single `inTransaction`.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER IS FORCED, AND IT SPENDS THE NUMBER BEFORE IT KNOWS THE POSTING WORKS
 *
 * The number is allocated, then the entry is built, then the entry is written. It cannot
 * be the other way round: `PostableDocument.number` is non-null because the entry's
 * narration and its `source.number` both carry it, so there is no entry to build until
 * the counter has moved.
 *
 * That is only safe because of the transaction. `allocateNumber` has no undo and must not
 * grow one — a released number is a gap in a series rule 46(b) wants consecutive. What
 * takes its place is the rollback: a posting that fails takes the counter back with it,
 * and the number is not spent on a document that does not exist. This is the reason
 * `postEntry` and `allocateNumber` both go through ./transaction.ts rather than opening
 * transactions of their own, and the reason a change to either of them that reintroduces
 * `db.transaction()` would break issuing at runtime and nowhere else.
 *
 * ---------------------------------------------------------------------------
 * CANCELLING IS A REVERSAL, NEVER AN UNDO
 *
 * The entry stays. A second entry mirrors it (invariant 3), the document keeps its number
 * (rule 2) and its status becomes `cancelled`. What the document has outstanding goes to
 * zero without any code being written to make it, because outstanding was never a column
 * — it is the movement on the party's control account, and the two entries now net.
 *
 * The reversal posts as of the DOCUMENT'S OWN DATE by default, not today. An invoice
 * cancelled before anything is filed should leave the month it was raised in, as if it
 * had not been. Once that period is closed it cannot, and `PERIOD_CLOSED` says so rather
 * than the reversal silently landing in a later month — which is the difference between a
 * return that ties and one that does not.
 *
 * ---------------------------------------------------------------------------
 * WHICH KINDS THIS CAN ISSUE, AND WHY THE OTHERS ARE REFUSED WITH A SENTENCE
 *
 * A sales invoice. That is the only kind with a posting rule so far, and `postingRuleFor`
 * is where that fact lives. A credit note, a purchase bill and a debit note are drafts a
 * user can already create, so the refusal has to be a code with a message rather than a
 * thrown programmer error — the user did nothing wrong.
 *
 * A quotation is refused for a different reason and gets a different sentence. It never
 * posts, so 0008's CHECK makes `issued` unreachable for it and no posting rule would
 * help; where a sent quotation sits in a document's life is a question 0008 deferred and
 * this file does not answer. Both share `DOCUMENT_KIND_UNSUPPORTED`, because from the
 * caller's side they are the same refusal: not this build, not this document.
 */

import { D } from '@main/domain/money'
import { isPostingError, type EntryDraft, type PostingContext } from '@main/domain/ledger'
import {
  definitionOf,
  postingRuleFor,
  postsToLedger,
  type DocumentKind,
  type PostableDocument,
} from '@main/domain/documents'
import type { CancelDocumentInput, DateString, Document, IssueDocumentInput } from '@shared/dto'

import type { CofferDb } from '../kysely'
import { buildResolver } from './accounts'
import { getDocument, toDomainLine } from './documents'
import { RepoError, type RepoErrorCode } from './errors'
import { postEntry, reverseEntry } from './journal'
import { allocateNumber, defaultSeriesFor } from './numbering'
import { requirePostablePeriod } from './periods'
import { inTransaction } from './transaction'

/**
 * Issue a draft: allocate its number, post its entry, and change its status. One
 * transaction, or nothing.
 *
 * Nothing about the document itself changes — only the columns that record the
 * transition. What is issued is exactly the draft that was there, which is why
 * `IssueDocumentInput` carries no date and no lines: issuing is not a save, and a caller
 * that wants something different edits the draft first.
 */
export async function issueDocument(
  db: CofferDb,
  input: IssueDocumentInput,
  now: string,
): Promise<Document> {
  return inTransaction(db, async (trx) => {
    const document = await requireDocument(trx, input.id)
    assertDraft(document)

    const kind = definitionOf(document.kind as DocumentKind).kind
    const rule = requireRule(kind)
    assertHasSomethingOnIt(document)

    const seriesId = input.seriesId ?? (await requireDefaultSeries(trx, kind, document))

    /*
     * The period is required before the counter moves, even though `postEntry` asks for
     * it again a few lines later. Not a duplicated check: the fiscal year label the
     * number is drawn against comes from the period, so there is no allocation to make
     * until this has answered. Asking twice inside one transaction is one extra read of
     * a row nothing else can have changed.
     */
    const period = await requirePostablePeriod(trx, document.date)
    const number = await allocateNumber(trx, seriesId, period.fiscalYearLabel)

    const postable: PostableDocument = {
      id: document.id,
      kind,
      status: 'issued',
      number,
      date: document.date,
      partyReference: document.partyReference,
      partyId: document.partyId,
      placeOfSupply: {
        jurisdictionCode: document.placeOfSupplyJurisdiction,
        countryCode: document.placeOfSupplyCountry,
      },
      roundingPolicy: document.roundingPolicy,
      narration: document.narration,
      lines: document.lines.map(toDomainLine),
    }

    const draft = buildEntry(rule.toEntry, postable, {
      accounts: await buildResolver(trx),
      period,
      /*
       * Nothing reads it yet. The company's own jurisdiction has no column to come from
       * — there is no company settings table — and the sales invoice rule does not branch
       * on it, because the document already carries the place of supply the regime
       * decided from. It is on `PostingContext` for a rule that will, and a guess put
       * here would be a fact invented in `db/` about a regime `db/` may not name.
       */
      homeJurisdictionCode: null,
    })

    const posted = await postEntry(trx, draft)

    await trx
      .updateTable('documents')
      .set({
        status: 'issued',
        number,
        series_id: seriesId,
        entry_id: posted.entryId,
        issued_at: now,
        updated_at: now,
      })
      .where('id', '=', input.id)
      .execute()

    return (await getDocument(trx, input.id))!
  })
}

/**
 * Cancel an issued document: reverse its entry, and record that it was cancelled.
 *
 * Both halves in one transaction, for the reason 0008 declines to enforce this with a
 * trigger: "a cancelled document's entry is reversed" is a statement about two tables at
 * a moment the transaction is only half way through, and SQLite has no deferred triggers.
 * So this function is the only thing that makes it true, and it does both or neither.
 */
export async function cancelDocument(
  db: CofferDb,
  input: CancelDocumentInput,
  now: string,
): Promise<Document> {
  return inTransaction(db, async (trx) => {
    const document = await requireDocument(trx, input.id)
    assertIssued(document)

    if (document.entryId === null) {
      /*
       * Unreachable: 0008 CHECKs that an issued document has an entry, which is rule 3
       * written as a constraint. A throw rather than a skipped reversal, because the skip
       * would be the one path that cancels a document while leaving its posting in the
       * books — silently, and in exactly the state the CHECK exists to forbid.
       */
      throw new Error(
        `${document.number ?? document.id} is issued and has no journal entry. ` +
          'Rule 3 says that state cannot exist; something wrote to documents directly.',
      )
    }

    const date: DateString = input.date ?? document.date
    await reverseEntry(trx, {
      entryId: document.entryId,
      date,
      narration: reversalNarration(document, input.narration),
    })

    await trx
      .updateTable('documents')
      .set({ status: 'cancelled', cancelled_at: now, updated_at: now })
      .where('id', '=', input.id)
      .execute()

    return (await getDocument(trx, input.id))!
  })
}

// ---- Guards ----------------------------------------------------------------

async function requireDocument(db: CofferDb, id: string): Promise<Document> {
  const document = await getDocument(db, id)
  if (document === null) {
    throw new RepoError('DOCUMENT_NOT_FOUND', 'That document is not in these books.', { id })
  }
  return document
}

function assertDraft(document: Document): void {
  if (document.status === 'draft') return
  throw new RepoError(
    'DOCUMENT_NOT_DRAFT',
    document.status === 'cancelled'
      ? `${document.number ?? 'That document'} has been cancelled. Raise a new one.`
      : `${document.number ?? 'That document'} has already been issued.`,
    { id: document.id, status: document.status, number: document.number },
  )
}

function assertIssued(document: Document): void {
  if (document.status === 'issued') return
  if (document.status === 'cancelled') {
    throw new RepoError(
      'DOCUMENT_ALREADY_CANCELLED',
      `${document.number ?? 'That document'} has already been cancelled.`,
      { id: document.id, number: document.number },
    )
  }
  throw new RepoError(
    'DOCUMENT_NOT_ISSUED',
    'A draft is deleted rather than cancelled — it has no number to keep and nothing in ' +
      'the ledger to reverse.',
    { id: document.id, status: document.status },
  )
}

/**
 * The posting rule for a kind, or the sentence explaining why there is none.
 *
 * The two nulls `postingRuleFor` returns mean different things and get different words —
 * see the header. `postsToLedger` is what tells them apart, and it is the domain's answer
 * rather than a list of kinds repeated here.
 */
function requireRule(kind: DocumentKind): { toEntry: ToEntry } {
  const rule = postingRuleFor(kind)
  if (rule !== null) return rule

  const definition = definitionOf(kind)
  throw new RepoError(
    'DOCUMENT_KIND_UNSUPPORTED',
    postsToLedger(kind)
      ? `${definition.pluralLabel} cannot be issued yet — how one posts is not built.`
      : `A ${definition.label.toLowerCase()} does not post to the ledger, and how it is ` +
          'issued is not settled. Keep it as a draft for now.',
    { kind, postsToLedger: postsToLedger(kind) },
  )
}

/**
 * Refuse a document with nothing on it.
 *
 * Nothing on it means no lines at all, or lines that are all zero — no value and no tax.
 * NOT "the total comes to zero": an invoice carrying a rebate line that cancels the goods
 * line it corrects has real lines and a real posting, and what that posts is the posting
 * rule's business rather than this one's.
 *
 * A rule about the TRANSITION, which is why it is here and not a CHECK in 0008. A draft
 * is created empty and filled in — that is what a draft is for — so a constraint on the
 * row would refuse the first thing every user does.
 */
function assertHasSomethingOnIt(document: Document): void {
  const somethingOnIt = document.lines.some(
    (line) =>
      !D(line.taxableAmount).isZero() ||
      line.taxes.some((component) => !D(component.amount).isZero()),
  )
  if (somethingOnIt) return

  throw new RepoError(
    'DOCUMENT_EMPTY',
    'There is nothing on this document to issue. Add a line with a value on it.',
    { id: document.id, lineCount: document.lines.length },
  )
}

async function requireDefaultSeries(
  db: CofferDb,
  kind: DocumentKind,
  document: Document,
): Promise<string> {
  const series = await defaultSeriesFor(db, kind)
  if (series !== null) return series.id

  throw new RepoError(
    'SERIES_NOT_CONFIGURED',
    `These books have no numbering series for ${definitionOf(kind).pluralLabel.toLowerCase()}. ` +
      'Set one up before issuing.',
    { kind, documentId: document.id },
  )
}

/** What the day book says about a reversal, when the caller does not say it themselves. */
function reversalNarration(document: Document, given: string | undefined): string {
  const own = given?.trim() ?? ''
  if (own !== '') return own

  const label = definitionOf(document.kind as DocumentKind).label.toLowerCase()
  return `Cancellation of ${label} ${document.number ?? ''}`.trim()
}

type ToEntry = (document: PostableDocument, context: PostingContext) => EntryDraft

/**
 * Run the posting rule, and turn what it refuses into what this layer refuses.
 *
 * `PostingError` carries a `LedgerErrorCode`, and every code it can raise from here —
 * `ROLE_UNMAPPED`, `ACCOUNT_NOT_FOUND` — is already a `RepoErrorCode` meaning the same
 * thing. The message is kept as the domain wrote it: rewriting it here would be a second
 * sentence about the same failure, and the domain's already names the account.
 */
function buildEntry(
  toEntry: ToEntry,
  document: PostableDocument,
  context: PostingContext,
): EntryDraft {
  try {
    return toEntry(document, context)
  } catch (error) {
    if (isPostingError(error)) {
      throw new RepoError(error.code as RepoErrorCode, error.message, error.details, {
        cause: error,
      })
    }
    throw error
  }
}
