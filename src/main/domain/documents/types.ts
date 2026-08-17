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
import type { DateString } from '@shared/scalars'

// ---- Kinds ----------------------------------------------------------------

/**
 * Every kind of trade document Coffer knows.
 *
 * Closed on purpose, like `SourceDocumentType`: an unrecognised kind in a company file
 * means the file was written by a newer build, and the right response is to say so rather
 * than to render a document whose posting treatment this build does not know.
 */
export type DocumentKind =
  'quotation' | 'sales-invoice' | 'credit-note' | 'purchase-bill' | 'debit-note'

/** Which half of the trade a document belongs to. Decides which party role applies. */
export type TradeSide = 'sales' | 'purchase'

/**
 * Whether a document adds to what the party owes or takes away from it.
 *
 * An invoice charges; a credit note refunds. The posting rule reads this instead of
 * branching on the kind, so a kind added later gets its debits and credits the right way
 * round by declaring itself rather than by being remembered in a `switch`.
 */
export type DocumentDirection = 'charge' | 'refund'

/**
 * Which side of the tax a document gives rise to.
 *
 * The same word the chart of accounts uses (`db/repos/tax-accounts.ts`): output tax is
 * owed to the authority and is a liability, input tax is reclaimable and is an asset.
 *
 * NOT A FIELD ON THE TABLE BELOW, and it was one until a mutation showed why it should
 * not be. A sales document levies output tax and a purchase document gives input credit
 * — that is what the two words mean — and a document that never posts levies nothing.
 * Both facts are already in the table, so storing the levy as well is a second place for
 * it to be wrong, and no test could tell the two apart while they happened to agree.
 * See `levyOf`.
 */
export type TaxLevy = 'output' | 'input'

export interface DocumentKindDefinition {
  kind: DocumentKind
  /** What the user sees, singular. */
  label: string
  /** What the user sees for many of them. English is irregular enough to need this. */
  pluralLabel: string
  side: TradeSide
  direction: DocumentDirection
  /**
   * What the ledger records this document as, or null when the document never posts.
   *
   * A quotation is the only null, and it is the reason this field exists rather than
   * `postsToLedger: boolean`. `SourceDocumentType` has no `quotation` member — nothing
   * that never reaches the ledger can be a source document — so a kind that posts is
   * exactly a kind that has one of these, and the two facts cannot drift apart.
   */
  sourceType: SourceDocumentType | null
}

/**
 * The table. Adding a kind means adding a row and a posting rule, and nothing else.
 *
 * Order is the order a menu lists them: what a business does most often, first.
 */
export const DOCUMENT_KINDS: readonly DocumentKindDefinition[] = [
  {
    kind: 'sales-invoice',
    label: 'Sales invoice',
    pluralLabel: 'Sales invoices',
    side: 'sales',
    direction: 'charge',
    sourceType: 'sales-invoice',
  },
  {
    kind: 'quotation',
    label: 'Quotation',
    pluralLabel: 'Quotations',
    side: 'sales',
    direction: 'charge',
    sourceType: null,
  },
  {
    kind: 'credit-note',
    label: 'Credit note',
    pluralLabel: 'Credit notes',
    side: 'sales',
    direction: 'refund',
    sourceType: 'credit-note',
  },
  {
    kind: 'purchase-bill',
    label: 'Purchase bill',
    pluralLabel: 'Purchase bills',
    side: 'purchase',
    direction: 'charge',
    sourceType: 'purchase-bill',
  },
  {
    kind: 'debit-note',
    label: 'Debit note',
    pluralLabel: 'Debit notes',
    side: 'purchase',
    direction: 'refund',
    sourceType: 'debit-note',
  },
] as const

const BY_KIND: ReadonlyMap<DocumentKind, DocumentKindDefinition> = new Map(
  DOCUMENT_KINDS.map((definition) => [definition.kind, definition]),
)

/**
 * The definition for a kind.
 *
 * Throws rather than returning null. Every caller has a `DocumentKind`, which the type
 * system already narrowed to one of five strings — a null here would be unreachable, and
 * a null-check on every call site would be noise that hides the one case that is real:
 * a kind read from a company file written by a newer build.
 */
export function definitionOf(kind: DocumentKind): DocumentKindDefinition {
  const definition = BY_KIND.get(kind)
  if (definition === undefined) {
    throw new Error(`Unknown document kind '${kind}'. This file may need a newer Coffer.`)
  }
  return definition
}

/** Whether issuing this kind writes a journal entry. False only for a quotation. */
export function postsToLedger(kind: DocumentKind): boolean {
  return definitionOf(kind).sourceType !== null
}

/**
 * Which side of the tax this kind gives rise to, or null when it raises none.
 *
 * Derived from two facts the table already holds rather than stored beside them — see
 * the note on `TaxLevy`. A quotation shows tax so the customer can see the price, and
 * that tax lands nowhere, because nothing has been supplied.
 */
export function levyOf(kind: DocumentKind): TaxLevy | null {
  const definition = definitionOf(kind)
  if (definition.sourceType === null) {
    return null
  }
  return definition.side === 'sales' ? 'output' : 'input'
}

/** Every kind on one side of the trade, for a menu or a list filter. */
export function kindsOnSide(side: TradeSide): DocumentKindDefinition[] {
  return DOCUMENT_KINDS.filter((definition) => definition.side === side)
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
 * How one kind of document is numbered.
 *
 * Everything about the shape of a number is data, because the shape is a business's own
 * choice and it is the first thing a user coming from another system wants to match.
 */
export interface NumberingSeries {
  id: string
  kind: DocumentKind
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
