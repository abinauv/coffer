/*
 * The document contract — what a trade document is, and what happens when one is issued.
 *
 * A document is the thing a user actually works with: an invoice, a quotation, a credit
 * note, a bill. The ledger is what a document *becomes*. Phase 1 built the second half
 * first, deliberately (ARCHITECTURE §6.1), so this file has only one job — to say
 * precisely how a document reaches the ledger, and what may happen to it afterwards.
 *
 * Types and pure definitions only: no I/O, no clock, and nothing that knows a tax regime
 * exists. `CGST` does not appear here and neither does `HSN`. A tax component reaches
 * this file as a code, a label and an amount, the same way it reaches the chart of
 * accounts (`db/repos/tax-accounts.ts`), and for the same reason.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR RULES
 *
 * 1. A DOCUMENT IS A DRAFT UNTIL IT IS ISSUED, AND FROZEN AFTERWARDS. A draft may be
 *    edited freely and deleted outright; nothing outside it depends on it. From the
 *    moment it is issued it may not be edited at all — not the figures, not the party,
 *    not "just the narration". This is ledger invariant 3 seen from the document side,
 *    and it is also plain GST law: an issued tax invoice is corrected by a credit note,
 *    never by editing the invoice, because the customer already holds a copy and the
 *    return may already be filed.
 *
 * 2. THE NUMBER IS ALLOCATED AT ISSUE, AND NEVER RELEASED. A draft has no number. This
 *    is not a detail of when a field is filled in — rule 46(b) requires an invoice series
 *    to be consecutive for a financial year, and a number handed to a draft that is later
 *    abandoned leaves a gap that somebody has to explain. Cancelling an issued document
 *    keeps its number for exactly the same reason, which is why cancelling and deleting
 *    are different operations rather than one operation with a flag.
 *
 * 3. ISSUING IS ONE TRANSACTION. A document that posts writes its journal entry in the
 *    same transaction that changes its status and allocates its number. There is no
 *    "issued but not yet posted" state and no background job that catches up, because
 *    either of those is a window in which the sales register and the trial balance
 *    disagree and no query can tell you which one is wrong.
 *
 * 4. NOTHING THAT CAN BE DERIVED IS STORED. A document has no `grand_total` column. Its
 *    figures are a fold over its lines (`totals.ts`), computed when asked — the same rule
 *    as CONVENTIONS §1 applies to account balances, for the same reason: a stored total
 *    is a second source of truth that will disagree with the first one, silently, on a
 *    date nobody can identify.
 *
 *    The one thing that IS stored is the tax the regime returned, per line, per
 *    component. That is not a derived figure — it is the regime's answer as of the
 *    document's own date, and rates change. An invoice must reprint years later exactly
 *    as it was taxed and exactly as it was filed, which it cannot do if the tax is
 *    recomputed from today's rates. See `DocumentLineTax`.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS OUTSTANDING IS A LEDGER FACT, NOT A DOCUMENT FACT
 *
 * How much an invoice still has against it does not live here and is not a column. It is
 * the movement its entry made on the party's control account, less whatever has been
 * allocated to it. Two things fall out of reading it that way and both matter:
 *
 *   - A cancelled invoice's entry is reversed, so its outstanding goes to zero without
 *     anybody writing code to make it.
 *   - An aged receivables report and the balance sheet cannot disagree, because they are
 *     the same sum with a different grouping.
 *
 * ---------------------------------------------------------------------------
 * ONE TABLE FOR EVERY TRADE DOCUMENT
 *
 * A quotation, an invoice, a credit note, a bill and a debit note differ in three things:
 * which side of the trade they sit on, whether they add to or reduce what is owed, and
 * which accounts their posting rule reaches for. They do not differ in shape. A party,
 * a date, lines with a quantity and a rate, tax per line, a place of supply — that is all
 * five of them.
 *
 * So `DOCUMENT_KINDS` below is a table of those three differences, and everything else is
 * shared. Five tables would mean five copies of the tax summary, five copies of the
 * numbering, and a Phase 3 that is a schema change rather than a posting rule.
 */

import type { Decimal } from '@main/domain/money'
import type { SourceDocumentType } from '@main/domain/ledger'
import type { ExportTaxPayment, ItcEligibility } from '@shared/dto'
import {
  definitionOf,
  DOCUMENT_KINDS,
  postsToLedger,
  type DocumentKind,
  type DocumentKindDefinition,
  type PostingKind,
} from '@shared/documents'
import { RECEIPT_KINDS, type ReceiptKind } from '@shared/receipts'
import type { DateString } from '@shared/scalars'

// ---- Kinds ----------------------------------------------------------------

/*
 * THE TABLE ITSELF LIVES IN `@shared/documents`, and it moved there in 0013-2.
 *
 * It was here while the posting rule was the only thing reading it. The screens then
 * needed the same facts — what to call a credit note, whether a party is a customer or a
 * vendor, which kind a refund may correct — and the renderer cannot import `@main/*`. A
 * second copy in the renderer is the shape this codebase has deleted four times, so the
 * table went down to the one module both sides can reach. `shared/` depends on nothing.
 *
 * WHAT STAYED HERE IS WHAT THE LEDGER DOES WITH A KIND. `SourceDocumentType` has
 * `manual`, `opening-balance` and `year-end-close` in it, none of which is a document a
 * user raises, and putting that union in a module the renderer imports would be a worse
 * trade than the duplication it avoids. So shared says whether a kind reaches the books
 * and this file says what the ledger calls it — joined at compile time by `PostingKind`,
 * not by a test. See `SOURCE_TYPES` below and the header of `@shared/documents`.
 */

export type {
  DocumentDirection,
  DocumentKind,
  DocumentKindDefinition,
  PostingKind,
  TradeSide,
} from '@shared/documents'

export {
  chargeKindOn,
  chargesOnTerms,
  correctionMap,
  correctsKind,
  definitionOf,
  DOCUMENT_KINDS,
  kindsOnSide,
  opposite,
  postingKindIn,
  postingKindOn,
  postsToLedger,
} from '@shared/documents'

/**
 * Which side of the tax a document gives rise to.
 *
 * The same word the chart of accounts uses (`db/repos/tax-accounts.ts`): output tax is
 * owed to the authority and is a liability, input tax is reclaimable and is an asset.
 *
 * NOT A FIELD ON THE TABLE, and it was one until a mutation showed why it should not be.
 * A sales document levies output tax and a purchase document gives input credit — that is
 * what the two words mean — and a document that never posts levies nothing. Both facts
 * are already in the table, so storing the levy as well is a second place for it to be
 * wrong, and no test could tell the two apart while they happened to agree. See `levyOf`.
 */
export type TaxLevy = 'output' | 'input'

/**
 * What the ledger records each posting kind as.
 *
 * KEYED BY `PostingKind`, WHICH IS THE POINT. That type is `Extract`ed from the rows of
 * the shared table whose `postsToLedger` is literally `true`, so this record is total over
 * exactly the kinds that post: a kind flipped to `true` there does not compile until it
 * appears here, and a kind flipped to `false` makes its entry an excess property. The two
 * facts cannot disagree and still build, which is what the single `sourceType` field
 * bought before the table moved.
 *
 * The values repeat the kind names today and are not the same thing. A source type says
 * what an ENTRY came from and the union covers `manual`, `year-end-close` and other things
 * no user raises; that they coincide for these four is a fact about this ledger, not an
 * identity to be derived.
 */
const SOURCE_TYPES: Readonly<Record<PostingKind, SourceDocumentType>> = {
  'sales-invoice': 'sales-invoice',
  'credit-note': 'credit-note',
  'purchase-bill': 'purchase-bill',
  'debit-note': 'debit-note',
}

/**
 * True of exactly the kinds `SOURCE_TYPES` is keyed by.
 *
 * An unchecked predicate, and sound by construction rather than by inspection:
 * `PostingKind` is DEFINED as the kinds whose `postsToLedger` is `true`, and
 * `postsToLedger()` reads that same field off that same table. There is no third value
 * for the two to disagree about.
 */
function isPostingKind(kind: DocumentKind): kind is PostingKind {
  return postsToLedger(kind)
}

/** What the ledger records this kind as, or null when issuing it posts nothing. */
export function sourceTypeOf(kind: DocumentKind): SourceDocumentType | null {
  return isPostingKind(kind) ? SOURCE_TYPES[kind] : null
}

/** A kind that posts, carrying the source type the ledger records it as. */
export interface PostingKindDefinition extends DocumentKindDefinition {
  kind: PostingKind
  sourceType: SourceDocumentType
}

/**
 * Every kind that posts, in table order.
 *
 * The posting engine builds its rules from this rather than filtering the whole table and
 * asserting the result: a definition in here has a non-null `sourceType` as a matter of
 * type, so the three places the entry needs one do not each carry a null check for a case
 * the filter has already removed.
 */
export const POSTING_KINDS: readonly PostingKindDefinition[] = DOCUMENT_KINDS.flatMap(
  (definition) =>
    isPostingKind(definition.kind)
      ? [{ ...definition, kind: definition.kind, sourceType: SOURCE_TYPES[definition.kind] }]
      : [],
)

/**
 * Which side of the tax this kind gives rise to, or null when it raises none.
 *
 * Derived from two facts the table already holds rather than stored beside them — see the
 * note on `TaxLevy`. A quotation shows tax so the customer can see the price, and that
 * tax lands nowhere, because nothing has been supplied.
 */
export function levyOf(kind: DocumentKind): TaxLevy | null {
  if (!postsToLedger(kind)) {
    return null
  }
  return definitionOf(kind).side === 'sales' ? 'output' : 'input'
}

// ---- Status ----------------------------------------------------------------

/**
 * Where a document is in its life.
 *
 * `issued` rather than `posted`, and the distinction is not cosmetic: in this codebase
 * "posted" means specifically "written to the ledger" (ledger invariant 2), and a
 * quotation is issued without posting anything. Every kind is issued; only the kinds with
 * a `sourceType` are also posted, and that is a property of the kind rather than a second
 * status somebody has to keep in step.
 *
 * There is no `paid`. What a document has against it is a ledger fact — see the note at
 * the top of this file — and a status column would be a stored balance wearing a
 * different hat, going stale the first time a receipt is edited.
 */
export type DocumentStatus = 'draft' | 'issued' | 'cancelled'

export const DOCUMENT_STATUSES: readonly DocumentStatus[] = [
  'draft',
  'issued',
  'cancelled',
] as const

/** Only a draft may be changed. Rule 1. */
export function isEditable(status: DocumentStatus): boolean {
  return status === 'draft'
}

/** Only a draft may be deleted, because only a draft has no number to leave a gap. */
export function isDeletable(status: DocumentStatus): boolean {
  return status === 'draft'
}

/** A number exists from the moment a document is issued, and survives cancellation. */
export function hasNumber(status: DocumentStatus): boolean {
  return status !== 'draft'
}

/**
 * Whether a document in this state still counts.
 *
 * A cancelled document is kept, listed and printable — its number may not be reused and
 * an auditor will ask what happened to it — but it contributes nothing to a register, a
 * total or a return.
 */
export function isLive(status: DocumentStatus): boolean {
  return status === 'issued'
}

// ---- Place of supply -------------------------------------------------------

/**
 * Where the supply is treated as taking place, as the document records it.
 *
 * Deliberately NOT the regime's `PlaceOfSupply`. That type carries `isIntraJurisdiction`
 * and `isExport`, which are the regime's *conclusions* — reading them back off a stored
 * document would let a regime's rules leak into `domain/`, and would also freeze a
 * derived answer next to the facts it was derived from, where the two can disagree.
 *
 * What is stored is the fact: which jurisdiction, which country. It is stored rather than
 * looked up from the party because a party's address changes and a document's place of
 * supply does not.
 */
export interface SupplyPlace {
  /** Sub-national code where the regime has one. Null where the concept does not apply. */
  jurisdictionCode: string | null
  /** ISO 3166-1 alpha-2, lower case. */
  countryCode: string
}

// ---- Rounding --------------------------------------------------------------

/**
 * How a document's grand total is rounded, recorded on the document itself.
 *
 * Indian invoices are conventionally rounded to the rupee with the difference posted to
 * a round-off account; plenty of businesses do not round at all, and an exporter billing
 * in a currency with no such convention certainly does not.
 *
 * WHY THIS IS ON THE DOCUMENT AND NOT ONLY IN SETTINGS. Rule 4 says the totals are
 * derived, which means they are derived again every time the document is opened —
 * possibly years later, by which time the company setting may have changed. Freezing the
 * policy with the document is what makes a derived total stable, and it costs one column.
 */
export type RoundingPolicy = 'whole-unit' | 'none'

// ---- Lines -----------------------------------------------------------------

/**
 * One tax component as it landed on one line, stored verbatim.
 *
 * Structurally the regime's `TaxComponent` with `Decimal` in place of the decimal string,
 * and that is the point: the regime computes, the document records, and nothing in
 * between re-derives. `code` is what the return quotes and what
 * `AccountResolver.forTaxComponent` looks the account up by, so it must survive the round
 * trip through storage unchanged and un-normalised.
 */
export interface DocumentLineTax {
  /** The regime's own code, e.g. 'CGST'. Stored as given. */
  code: string
  /** What prints on the document, e.g. 'CGST @ 9%'. */
  label: string
  ratePct: Decimal
  amount: Decimal
}

/**
 * A line of a trade document.
 *
 * Amounts are `Decimal` — full precision in memory, decimal strings only at the storage
 * boundary, exactly as the ledger does it (CONVENTIONS §1).
 */
export interface DocumentLine {
  id: string
  /** 1-based, and the order the user put them in. Not a sort key derived from anything. */
  lineNumber: number
  /** Null for a free-text line, which is a thing every business needs occasionally. */
  itemId: string | null
  /**
   * What prints. Defaulted from the item and then editable, and stored rather than
   * looked up — renaming an item must not silently rewrite last year's invoices.
   */
  description: string
  quantity: Decimal
  /** The unit as text, e.g. 'NOS', 'KG'. Null for a line with no meaningful quantity. */
  unitCode: string | null
  unitPrice: Decimal
  /**
   * Reduction agreed at the time of supply, already taken out of `taxableAmount`.
   *
   * A trade discount given on the invoice reduces the value the tax is charged on. A
   * discount agreed afterwards does not — that is a credit note, and it is a separate
   * document precisely because the tax has to move with it.
   */
  discount: Decimal
  /**
   * `quantity x unitPrice - discount`, at money scale. What tax is charged on.
   *
   * Stored rather than recomputed on read, and this is the one deliberate exception to
   * rule 4: it is the number handed to the regime, and the multiplication that produced
   * it rounds. Recomputing it later from a rate with more decimal places than the line
   * shows would give a different answer than the tax was actually calculated from.
   */
  taxableAmount: Decimal
  /** Full tax rate as a percentage, e.g. '18'. Three decimal places — see CONVENTIONS §3. */
  ratePct: Decimal
  /** HSN, SAC, or whatever the regime classifies by. Null where none applies. */
  classificationCode: string | null
  /**
   * A charge — freight, packing, insurance — rather than goods or services.
   *
   * Taxable like anything else, and the regime is told so via `TaxableLine.isCharge`.
   * What changes is where the value posts: a charge is not sales revenue and putting it
   * there overstates turnover in every report and in the return.
   */
  isCharge: boolean
  /**
   * Where this line's value posts, overriding the kind's default.
   *
   * Null means the role the kind implies — `sales` for a sales document, `purchases` for
   * a purchase one. A freight charge names `freight-outward`'s account here; an item with
   * its own revenue account names that. An id rather than a role, because the override is
   * a choice about this line and roles are a company-wide mapping.
   */
  accountId: string | null
  /**
   * Whether input tax on this line may be reclaimed. Null where nothing was recorded.
   *
   * ON THE LINE AND NOT ON THE DOCUMENT, because one bill can carry a laptop and a staff
   * car. It is read by the posting rule and by nothing else in this module: an ineligible
   * line's tax is not recoverable, so it is not an asset, and it posts to the line's own
   * value account instead of to the input tax account. See `taxAccountForLine`.
   *
   * REQUIRED HERE AND OPTIONAL IN THE DTO, and the asymmetry is the point. `db/` resolves
   * the absence once, at the boundary, so the posting rule is handed a value it cannot
   * forget to look for — and `null` is a state it must answer for rather than a field it
   * may leave off.
   */
  itcEligibility: ItcEligibility | null
  /** What the regime returned for this line. Empty for an exempt or nil-rated line. */
  taxes: readonly DocumentLineTax[]
}

// ---- The document ----------------------------------------------------------

/**
 * A trade document, as the domain sees it.
 *
 * Everything a posting rule needs and nothing it does not: no created-at, no user, no
 * print history. Those exist on the row and are the repository's business.
 */
export interface TradeDocument {
  id: string
  kind: DocumentKind
  status: DocumentStatus
  /** Null while draft, allocated at issue, kept through cancellation. Rule 2. */
  number: string | null
  /**
   * The date the document bears, which is also the date it posts as of.
   *
   * One date, not two. A document dated differently from its entry is a document whose
   * register and whose ledger fall in different months, and reconciling those is a job
   * nobody should be given.
   */
  date: DateString
  /**
   * The other party's own reference, where they have one — a purchase order number on a
   * sales invoice, the supplier's bill number on a purchase bill. Never Coffer's.
   */
  partyReference: string | null
  partyId: string
  placeOfSupply: SupplyPlace
  roundingPolicy: RoundingPolicy
  /** Free text that prints, and that becomes the journal entry's narration. */
  narration: string
  /**
   * Whether the BUYER discharges the tax on this supply rather than the seller.
   *
   * TWO POSTINGS FROM ONE BILL, on the purchase side. The recipient of a reverse-charge
   * supply owes the output tax to the authority AND may claim the same figure as input
   * credit, so the tax lands on both sides of the balance sheet and the supplier is
   * credited with only the net. On the sales side it is the mirror and it is not
   * symmetric: this business supplies, the customer discharges, and no tax posts here at
   * all. `posting.ts` reads it; `documentTotals` deliberately does not — what the document
   * SAYS the tax is does not change, only who owes it.
   *
   * A BOOLEAN AND NOT A NULLABLE ONE. Every supply either is under reverse charge or is
   * not; there is no third state for a posting rule to have an opinion about. The column
   * is `NOT NULL DEFAULT 0` (0020) and the DTO's `?` is resolved at the repository
   * boundary, in one place.
   */
  isReverseCharge: boolean
  /**
   * Whether a zero-rated supply left with tax paid on it, or under an undertaking.
   *
   * Null on a domestic supply. CARRIED HERE AND READ BY NOTHING IN THIS MODULE, which is
   * deliberate: the tax it decides was decided by the regime when the document was
   * drafted and is already on the lines (rule 4). It is on `TradeDocument` because a
   * return needs it off the same object the posting rule takes, and putting it anywhere
   * else would mean two shapes of "a document" for two readers.
   */
  exportTaxPayment: ExportTaxPayment | null
  lines: readonly DocumentLine[]
}

// ---- Numbering -------------------------------------------------------------

/**
 * Where a numbering counter restarts.
 *
 * `fiscal-year` is what a GST invoice series does: consecutive within a financial year,
 * starting again at 1 on 1 April. `never` is a running series for things with no such
 * requirement — a quotation, most usefully.
 */
export type NumberingReset = 'fiscal-year' | 'never'

/**
 * Everything a numbering series can number.
 *
 * Wider than `DocumentKind` since 0012, and the widening is the honest shape rather than
 * a convenience. Rule 50 wants a receipt voucher numbered consecutively for the same
 * reason rule 46(b) wants an invoice numbered, and the counter machinery underneath is
 * the one thing in this codebase that can hand the same number to two records. A second
 * copy of it kept privately for receipts would be that failure written twice.
 *
 * THE TWO EXTRA MEMBERS ARE STRING LITERALS DECLARED HERE rather than imported from
 * `domain/receipts`, and that is deliberate rather than lazy: a receipt carries a number
 * and a number comes from a series, so an import the other way round would be a cycle.
 * Nothing in this module branches on them — `numberedKindDefinition` reads the five
 * document kinds off `DOCUMENT_KINDS` and holds only what the other two add, so a
 * document kind's label is still stored in exactly one place.
 */
export type NumberedKind = DocumentKind | ReceiptKind

/**
 * What a numbering series needs to know about the thing it numbers.
 *
 * Three fields, and none of them is `side`, `direction` or `sourceType`: numbering does
 * not care what a voucher does to the ledger. `resetsYearly` is a DEFAULT and not a rule
 * — a series carries its own `resetOn`, and this only decides what a new one starts as.
 */
export interface NumberedKindDefinition {
  kind: NumberedKind
  /** What the user sees, singular. */
  label: string
  /** What the user sees for many of them. */
  pluralLabel: string
  /** Whether a new series for this kind restarts its count each fiscal year. */
  resetsYearly: boolean
}

/*
 * The ones that are not trade documents.
 *
 * READ OFF `RECEIPT_KINDS` AS OF 0015, where they were written out by hand before. The
 * labels were a second copy of two rows of that table, kept in step by nobody, and the
 * batch that added two more kinds is the one that would have found out: a series for a
 * refund would have been labelled by whichever of the two lists a screen happened to ask.
 *
 * The comment this replaces said the import would be a cycle, and it would have been —
 * `domain/receipts` imports numbering's neighbours. `@shared/receipts` is not that module
 * and imports nothing from `@main`, which is what 0013-3 moving the table there bought.
 *
 * Every voucher kind always reaches the ledger — there is no receipt that records no
 * money — so all of them reset yearly, and the branch a document kind needs has no case
 * to answer here.
 */
const VOUCHER_KINDS: readonly NumberedKindDefinition[] = RECEIPT_KINDS.map((definition) => ({
  kind: definition.kind,
  label: definition.label,
  pluralLabel: definition.pluralLabel,
  resetsYearly: true,
}))

/** Everything a series may be created for, documents first. */
export const NUMBERED_KINDS: readonly NumberedKindDefinition[] = [
  ...DOCUMENT_KINDS.map((definition) => ({
    kind: definition.kind,
    label: definition.label,
    pluralLabel: definition.pluralLabel,
    /* A quotation reaches no ledger and nothing has been supplied, so its numbers run
     * on. Read off the same fact the posting rules read rather than off a second list. */
    resetsYearly: postsToLedger(definition.kind),
  })),
  ...VOUCHER_KINDS,
]

const BY_NUMBERED_KIND: ReadonlyMap<string, NumberedKindDefinition> = new Map(
  NUMBERED_KINDS.map((definition) => [definition.kind, definition]),
)

/**
 * The definition for anything a series can number.
 *
 * Throws for the reason `definitionOf` throws and with the same sentence: a kind that is
 * none of these came off a company file a newer build wrote.
 */
export function numberedKindDefinition(kind: NumberedKind): NumberedKindDefinition {
  const definition = BY_NUMBERED_KIND.get(kind)
  if (definition === undefined) {
    throw new Error(`Unknown numbered kind '${kind}'. This file may need a newer Coffer.`)
  }
  return definition
}

/**
 * How one kind of document is numbered.
 *
 * Everything about the shape of a number is data, because the shape is a business's own
 * choice and it is the first thing a user coming from another system wants to match.
 */
export interface NumberingSeries {
  id: string
  kind: NumberedKind
  /** What the user calls this series when there is more than one. */
  label: string
  /** Text before the sequence, e.g. 'INV'. May be empty. */
  prefix: string
  /** Text after the sequence. Usually empty. */
  suffix: string
  /** What joins the parts, e.g. '/' or '-'. May be empty for a run-on number. */
  separator: string
  /** Whether the fiscal year's label sits between the prefix and the sequence. */
  includeFiscalYear: boolean
  /** Zero-padded width of the sequence: 4 gives '0001'. */
  width: number
  resetOn: NumberingReset
}

/** What the counter has reached, for one series in one scope. */
export interface NumberingCounter {
  seriesId: string
  /**
   * The fiscal year the counter belongs to, or null for a series that never resets.
   *
   * The label rather than a date range, because the label is what appears in the number
   * and a counter keyed by something the number does not show is a counter that can
   * disagree with what is printed.
   */
  fiscalYearLabel: string | null
  /** The next sequence to hand out. Starts at 1. */
  nextSequence: number
}

// ---- Failures --------------------------------------------------------------

/**
 * Why a document operation was refused.
 *
 * Expected, actionable failures that cross IPC as an `AppError` code, never as an
 * exception (CONVENTIONS §5). Posting failures keep their own codes in `LedgerErrorCode`
 * — a document that cannot post because its period is closed reports `PERIOD_CLOSED`,
 * which is the ledger's answer and should not be restated here in different words.
 */
export type DocumentErrorCode =
  /** No document with that id. */
  | 'DOCUMENT_NOT_FOUND'
  /** An edit or a delete against a document that is no longer a draft. Rule 1. */
  | 'DOCUMENT_NOT_DRAFT'
  /** An issue against a document that has already been issued. */
  | 'DOCUMENT_ALREADY_ISSUED'
  /** A cancel against a document that is already cancelled. */
  | 'DOCUMENT_ALREADY_CANCELLED'
  /** A cancel against a draft, which is deleted rather than cancelled. */
  | 'DOCUMENT_NOT_ISSUED'
  /** An issue with no lines, or with every line at zero. */
  | 'DOCUMENT_EMPTY'
  /** A quantity or a price that is not a number, or is negative. */
  | 'INVALID_LINE_AMOUNT'
  /** A discount larger than the line it is taken off. */
  | 'DISCOUNT_EXCEEDS_LINE'
  /** The document names a party that does not exist. */
  | 'PARTY_NOT_FOUND'
  /** The document names an archived party. */
  | 'PARTY_ARCHIVED'
  /** The document names an item that does not exist. */
  | 'ITEM_NOT_FOUND'
  /** No numbering series is configured for this kind. */
  | 'SERIES_NOT_FOUND'
  /** The number the series produced is already on another document. */
  | 'NUMBER_TAKEN'
  /** The number the series produced is not one the regime accepts. */
  | 'NUMBER_INVALID'
