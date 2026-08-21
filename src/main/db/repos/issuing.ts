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
 * A QUOTATION IS ISSUED WITHOUT POSTING ANYTHING, and that is not a special case bolted
 * on — it is what the domain contract has said since it was written: "every kind is
 * issued; only the kinds with a `sourceType` are also posted". 0008 disagreed by
 * constraint and 0010 corrected it. So a quotation takes a number from its series, gets a
 * status and an issue stamp, and writes no journal entry; cancelling one has nothing to
 * reverse. The number is still spent, because rule 2 does not care whether the series was
 * a tax series.
 *
 * What that costs in this file is one branch, and it is worth naming why the branch is on
 * `postsToLedger` rather than on `postingRuleFor` returning null. Those two nulls mean
 * opposite things: a credit note has no rule because nobody has written it, and a
 * quotation has no rule because there is nothing to write. Branching on the second and
 * treating the first the same way would silently issue an unposted credit note.
 */

import { D } from '@main/domain/money'
import {
  isPostingError,
  type AccountingPeriodRef,
  type EntryDraft,
  type PostingContext,
} from '@main/domain/ledger'
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
import { homeJurisdictionCode } from './company-profile'
import { getDocument, toDomainLine } from './documents'
import { RepoError, type RepoErrorCode } from './errors'
import { postEntry, reverseEntry } from './journal'
import { allocateNumber, defaultSeriesFor } from './numbering'
import { periodRefForDate } from './periods'
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
    const rule = postsToLedger(kind) ? requireRule(kind) : null
    assertHasSomethingOnIt(document)

    const seriesId = input.seriesId ?? (await requireDefaultSeries(trx, kind, document))

    /*
     * The period is read before the counter moves, because the fiscal year the number is
     * scoped by comes from it — there is no allocation to make until this has answered.
     *
     * IT DOES NOT ASK WHETHER THE PERIOD IS OPEN, and that is deliberate. Whether a month
     * will take a posting is the ledger's question and `postEntry` asks it a few lines
     * below, where the answer belongs; asking it here as well would be a second place that
     * decides whether a document may be issued. It also would not change anything a caller
     * can see — measured, not assumed: a mutation swapping the two survived the whole
     * suite, because `postEntry` refuses the closed month either way and the transaction
     * takes the allocation back with it.
     *
     * What that leaves is exactly right for a quotation, which never reaches the ledger at
     * all: a closed month is no reason to refuse to quote a customer, and the books still
     * have to reach the date for the counter to be scoped.
     */
    const period = await requireCoveringPeriod(trx, document.date)
    const number = await allocateNumber(trx, seriesId, period.fiscalYearLabel)

    let entryId: string | null = null
    if (rule !== null) {
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

      const draft = buildEntry(rule.toEntry, postable, await postingContextFor(trx, period))

      entryId = (await postEntry(trx, draft)).entryId
    }

    await trx
      .updateTable('documents')
      .set({
        status: 'issued',
        number,
        series_id: seriesId,
        entry_id: entryId,
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

    const kind = definitionOf(document.kind as DocumentKind).kind

    if (document.entryId === null && postsToLedger(kind)) {
      /*
       * Unreachable, and kept. 0010 CHECKs that an issued document of a kind that posts
       * has an entry, which is rule 3 written as a constraint, so nothing can reach this
       * branch through SQLite.
       *
       * A DELIBERATE MUTATION SURVIVOR: removing this guard changes no test, and cannot,
       * because no test can construct the state. It stays because of what the alternative
       * does if a file ever IS in that state — a corrupted database, a build that wrote to
       * the table another way — which is to cancel the document and leave its posting in
       * the books, silently, in exactly the state the CHECK exists to forbid. A plain
       * Error rather than a `RepoError`: no user can act on it (CONVENTIONS §5).
       */
      throw new Error(
        `${document.number ?? document.id} is issued and has no journal entry. ` +
          'Rule 3 says that state cannot exist; something wrote to documents directly.',
      )
    }

    /*
     * A quotation has nothing to reverse, so cancelling it is the status and the stamp
     * and nothing else. It keeps its number like every other kind: rule 2 does not care
     * whether the series was a tax series.
     */
    const date: DateString = input.date ?? document.date
    if (document.entryId !== null) {
      await reverseEntry(trx, {
        entryId: document.entryId,
        date,
        narration: reversalNarration(document, input.narration),
      })
    }

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
 * The posting rule for a kind that posts, or the sentence explaining why there is none.
 *
 * Only ever called for a kind `postsToLedger` says true of, so the only reason to be
 * missing a rule is that nobody has written it yet. `postingRuleFor` also returns null for
 * a quotation, and that null means something completely different — it means there is
 * nothing to write — which is why the branch is above rather than in here. A single
 * function answering both would have to re-derive which case it was in.
 */
function requireRule(kind: DocumentKind): { toEntry: ToEntry } {
  const rule = postingRuleFor(kind)
  if (rule !== null) return rule

  throw new RepoError(
    'DOCUMENT_KIND_UNSUPPORTED',
    `${definitionOf(kind).pluralLabel} cannot be issued yet — how one posts is not built.`,
    { kind },
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

/**
 * The period covering a date, open or not.
 *
 * Which fiscal year a document falls in, and nothing more. Whether that period will take
 * a posting is `requirePostablePeriod`'s question and `postEntry`'s to ask — see the note
 * at the call site for why issuing does not ask it twice.
 */
async function requireCoveringPeriod(db: CofferDb, date: DateString): Promise<AccountingPeriodRef> {
  const period = await periodRefForDate(db, date)
  if (period === null) {
    throw new RepoError('NO_PERIOD', `The books have no period covering ${date}.`, { date })
  }
  return period
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

/**
 * Everything a posting rule may consult, assembled from these books.
 *
 * Three reads and no decisions. It is a function of its own, and exported, because it is
 * the only place `PostingContext` is built for a real document — a rule that needs
 * something new gets it added here, which is the alternative CONVENTIONS §1.2 exists to
 * offer: `domain/` takes what it needs as an argument and never imports a repository.
 *
 * `homeJurisdictionCode` comes from the company profile (0011), and until 0011 there was
 * nowhere for it to come from and this passed null. No rule reads it yet. The sales
 * invoice rule never will — the document carries the place of supply the regime already
 * decided from, and re-deriving it at posting time would be a second answer to a settled
 * question — but a rule that has to know whether a supply was intra-jurisdiction without
 * being told is what the field is on the context for. Null still means what it meant: a
 * profile nobody has filled in, or a country with no sub-national jurisdictions.
 */
export async function postingContextFor(
  db: CofferDb,
  period: AccountingPeriodRef,
): Promise<PostingContext> {
  return {
    accounts: await buildResolver(db),
    period,
    homeJurisdictionCode: await homeJurisdictionCode(db),
  }
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
