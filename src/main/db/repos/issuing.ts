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
 * It is also refused outright while money has been allocated against the document — see
 * `assertNotAllocated` and 0012 — and while another document has been OFFSET against it,
 * which is `assertNotOffset` and 0016. Those are the things a cancel can be told no for, and
 * the reason is that outstanding is a ledger fact: reversing the entry takes the
 * movement to nothing, and allocations still pointing at it would take an invoice's
 * outstanding below zero with money that has to belong somewhere else.
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
 * WHICH KINDS THIS CAN ISSUE
 *
 * All five. Four have a posting rule and a quotation needs none, and `postingRuleFor` is
 * where that fact lives — this file has never held a list of kinds and does not start now.
 *
 * A QUOTATION IS ISSUED WITHOUT POSTING ANYTHING, and that is not a special case bolted
 * on — it is what the domain contract has said since it was written: "every kind is
 * issued; only the kinds with a `sourceType` are also posted". 0008 disagreed by
 * constraint and 0010 corrected it. So a quotation takes a number from its series, gets a
 * status and an issue stamp, and writes no journal entry; cancelling one has nothing to
 * reverse. The number is still spent, because rule 2 does not care whether the series was
 * a tax series.
 *
 * What that costs in this file is one branch, on `postsToLedger`. UNTIL THE OTHER THREE
 * RULES WERE WRITTEN THAT BRANCH CARRIED A SECOND JOB: `postingRuleFor` answered null both
 * for a quotation, which never posts, and for a credit note, whose rule nobody had written
 * — opposite meanings behind one null, and branching on the wrong one would have silently
 * issued an unposted credit note. There is one null left and the two questions have
 * collapsed into one. The branch stays on `postsToLedger` because that is the one with a
 * meaning a reader can check against the contract.
 *
 * ---------------------------------------------------------------------------
 * A DOCUMENT SOMETHING CORRECTS CANNOT BE CANCELLED
 *
 * The second thing a cancel is told no for, and it is the same argument as the first. A
 * credit note against a cancelled invoice credits a customer for a supply the books say
 * never happened; money allocated against a cancelled invoice belongs somewhere nobody
 * chose. Both leave a figure that is real and unattached, and in both the remedy is one
 * step the user can take: cancel the correction, or take the allocation off the receipt.
 */

import { D } from '@main/domain/money'
import {
  isPostingError,
  type AccountingPeriodRef,
  type EntryDraft,
  type PostingContext,
} from '@main/domain/ledger'
import {
  chargesOnTerms,
  definitionOf,
  dueDateFor,
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
import { assertNotAllocated, assertNotOffset } from './outstanding'
import { noPeriodCovering, periodRefForDate } from './periods'
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
    const dueDate = await dueDateAtIssue(trx, kind, document)

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
        /* `?? false` and `?? null` resolve the DTO's optionals into the domain's required
         * fields, in the one place a `PostableDocument` is built from a stored row. The
         * posting rule then has values it cannot forget to look for — a reverse-charge
         * bill posts its tax twice and credits the supplier with the net (0020), and a
         * blocked line costs its tax into the expense rather than into an asset (0021). */
        isReverseCharge: document.isReverseCharge ?? false,
        exportTaxPayment: document.exportTaxPayment ?? null,
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
        due_date: dueDate,
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

    /*
     * Money allocated against it stops the cancel, and 0012's header argues the case:
     * the money still exists and still belongs to the party, so detaching it here would
     * create on-account money nobody decided to create. A trigger says the same thing;
     * this says it with the figure in it, to a user who is looking at the invoice.
     */
    await assertNotAllocated(trx, document.id)
    /* And the same rule for the OTHER thing that settles a document. An offset is not
     * money, so it cannot be described as money the user has to go and find — but a
     * cancel would leave it settling a supply the books say never happened, which is
     * 0013's argument about a correction rather than 0012's about a receipt. */
    await assertNotOffset(trx, document.id)
    await assertNotCorrected(trx, document.id)

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
 * Refuse to cancel a document that a live credit or debit note corrects.
 *
 * 0013's trigger says the same thing and this says it with the correction's NUMBER in it,
 * to a user who is looking at the invoice and needs to know which document to deal with
 * first. The same division of labour as `assertNotAllocated`: the repository speaks with
 * the figures, the trigger is what holds if anybody writes to the table another way.
 *
 * `status <> 'cancelled'` rather than `= 'issued'`, so a correction still in DRAFT counts.
 * A draft credit note is a document somebody is in the middle of writing, and pulling the
 * invoice out from under it would leave them saving a correction against nothing.
 */
async function assertNotCorrected(db: CofferDb, documentId: string): Promise<void> {
  const corrections = await db
    .selectFrom('documents')
    .select(['number', 'kind'])
    .where('original_document_id', '=', documentId)
    .where('status', '<>', 'cancelled')
    .orderBy('created_at', 'asc')
    .execute()

  const first = corrections[0]
  if (first === undefined) return

  const label = definitionOf(first.kind as DocumentKind).label.toLowerCase()
  const named = first.number === null ? `A draft ${label}` : `${first.number}`
  throw new RepoError(
    'DOCUMENT_CORRECTED',
    `${named} corrects this document. Cancel the ${label} first — otherwise it adjusts ` +
      'a supply these books no longer say happened.',
    { documentId, corrections: corrections.length },
  )
}

/**
 * The posting rule for a kind that posts.
 *
 * A PLAIN ERROR NOW, WHERE IT USED TO BE A SENTENCE FOR THE USER. While three of the four
 * posting rules were unwritten, a credit note was a draft a user could raise and could not
 * issue — nothing they had done wrong, so `DOCUMENT_KIND_UNSUPPORTED` was a code with a
 * message and the screens showed it. All four are written; the code is gone with them.
 *
 * What is left cannot be reached from a company file: this is only called for a kind
 * `postsToLedger` says true of, and a kind has a rule exactly when it has a `sourceType`,
 * which is the same fact. So a null here means a sixth kind was added to `DOCUMENT_KINDS`
 * in a way `postingRuleFor` could not build a rule for — a wiring mistake nobody using
 * the app can act on, which is what a plain Error is for (CONVENTIONS §5).
 */
function requireRule(kind: DocumentKind): { toEntry: ToEntry } {
  const rule = postingRuleFor(kind)
  if (rule !== null) return rule

  throw new Error(
    `${definitionOf(kind).label} reaches the ledger and has no posting rule. ` +
      'A kind with a sourceType must have one; see postingRuleFor.',
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
  if (period === null) throw noPeriodCovering(date)
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
      'Add one under Company → Numbering, then issue this.',
    { kind, documentId: document.id },
  )
}

/**
 * When this document falls due, read once and stamped — see migration 0014's header.
 *
 * The party's terms are read HERE rather than at the moment the draft was saved, because
 * issuing is the event that creates the obligation and the terms in force at that moment
 * are the ones it is on. Everything after this point reads the column, so a customer moved
 * to shorter terms tomorrow re-ages nothing.
 *
 * A kind that charges nobody gets null, which is the same answer the trigger insists on:
 * there is no such thing as a quotation falling due.
 *
 * `?? null` covers two cases with one answer, deliberately. A party with no terms means
 * nothing was negotiated, and a party row that is not there at all would mean the same
 * thing to the arithmetic — but it cannot happen: `getDocument` reached this document
 * through an inner join on `parties`, and the foreign key is what makes that true rather
 * than this line.
 */
async function dueDateAtIssue(
  db: CofferDb,
  kind: DocumentKind,
  document: Document,
): Promise<DateString | null> {
  if (!chargesOnTerms(kind)) return null

  const party = await db
    .selectFrom('parties')
    .select('payment_terms_days')
    .where('id', '=', document.partyId)
    .executeTakeFirst()

  return dueDateFor(document.date, party?.payment_terms_days ?? null)
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
