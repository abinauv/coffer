/*
 * The kinds of trade document, and the words for them.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS IN `shared/` AND NOT IN `domain/`, WHICH IS WHERE IT WAS
 *
 * Gate 2.0 put this table in `main/domain/documents/types.ts`, and that was right while
 * the only thing reading it was the posting rule. It stopped being right the moment the
 * screens needed it: a register has to be titled, a party has to be called a customer or
 * a vendor, and a credit note has to know which kind of document it may correct. The
 * renderer cannot import `@main/*` — the two tsconfigs do not overlap and the Vite
 * aliases do not either — so the choice was between a channel serving a constant and a
 * second copy of the table in the renderer.
 *
 * A second copy is the shape this codebase has deleted four times. Two tables agreeing
 * today is not a property anything tests, and the day they disagree is the day a screen
 * calls a vendor a customer while the posting rule debits receivables.
 *
 * So the table moves down to where both sides can reach it. `shared/` is where the
 * boundary types already live and it depends on nothing — no Electron, no database, no
 * regime. Domain still owns what the LEDGER does with a kind (see `sourceTypeOf` in
 * `main/domain/documents/types.ts`); this file owns only what a kind IS.
 *
 * ---------------------------------------------------------------------------
 * WHY `postsToLedger` IS A FIELD HERE AND `sourceType` IS NOT
 *
 * The domain's version of this table carried `sourceType: SourceDocumentType | null`, and
 * its header argued — correctly — that a separate `postsToLedger: boolean` would be a
 * second place for one fact to be wrong. That argument is why `levy` was deleted at gate
 * 2.0 and it has not changed.
 *
 * What changed is where the boundary falls. `SourceDocumentType` is the LEDGER's
 * enumeration: it has `manual`, `opening-balance`, `year-end-close` and `stock-adjustment`
 * in it, none of which is a document a user raises. Moving it here to keep one field
 * would drag the ledger's vocabulary into a module the renderer imports, which is a worse
 * trade than the one it avoids.
 *
 * So this file states the fact the renderer needs — whether issuing it reaches the books
 * — and the domain derives the ledger's name for it. The two are joined AT COMPILE TIME
 * rather than by a test: `PostingKind` is `Extract`ed from the rows where `postsToLedger`
 * is literally `true`, and the domain's source-type record is keyed by exactly that type.
 * A kind flipped to `true` here does not compile until the domain gives it a source type,
 * and a kind flipped to `false` makes its source type an excess property. There is no
 * state in which the two disagree and still build.
 *
 * That is why the table below is written twice over: `KINDS` is `as const satisfies`, so
 * the rows keep their literal `true` and are still checked against the interface, and
 * `DOCUMENT_KINDS` is the same value widened for everyone else. Annotating the const
 * directly would widen `true` to `boolean` and take the compile-time link away.
 */

/**
 * Every kind of trade document Coffer knows.
 *
 * Closed on purpose: an unrecognised kind in a company file means the file was written by
 * a newer build, and the right response is to say so rather than to render a document
 * whose treatment this build does not know.
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
 * The other way round, and there are only two ways round.
 *
 * Written once because 0015 needs it twice and the second spelling is where a
 * transposition hides: what a voucher SETTLES is the opposite of the way it moves the
 * account, and what an offset matches is a document facing the opposite way from the one
 * it is on. A `=== 'charge' ? 'refund' : 'charge'` at each call site is the same
 * three-token rule written out again, and one of them eventually gets typed backwards.
 */
export function opposite(direction: DocumentDirection): DocumentDirection {
  return direction === 'charge' ? 'refund' : 'charge'
}

export interface DocumentKindDefinition {
  kind: DocumentKind
  /** What the user sees, singular. */
  label: string
  /** What the user sees for many of them. English is irregular enough to need this. */
  pluralLabel: string
  side: TradeSide
  direction: DocumentDirection
  /**
   * Whether issuing this kind writes a journal entry.
   *
   * False only for a quotation, and that is the whole of the difference between issuing
   * and posting — see the note on `DocumentStatus` in the domain. A screen reads this to
   * know whether "nothing is in the books until it is issued" is a true sentence to show.
   */
  postsToLedger: boolean
}

/**
 * The table. Adding a kind means adding a row, a source type in the domain, and a posting
 * rule; nothing else.
 *
 * Order is the order a menu lists them: what a business does most often, first.
 */
const KINDS = [
  {
    kind: 'sales-invoice',
    label: 'Sales invoice',
    pluralLabel: 'Sales invoices',
    side: 'sales',
    direction: 'charge',
    postsToLedger: true,
  },
  {
    kind: 'quotation',
    label: 'Quotation',
    pluralLabel: 'Quotations',
    side: 'sales',
    direction: 'charge',
    postsToLedger: false,
  },
  {
    kind: 'credit-note',
    label: 'Credit note',
    pluralLabel: 'Credit notes',
    side: 'sales',
    direction: 'refund',
    postsToLedger: true,
  },
  {
    kind: 'purchase-bill',
    label: 'Purchase bill',
    pluralLabel: 'Purchase bills',
    side: 'purchase',
    direction: 'charge',
    postsToLedger: true,
  },
  {
    kind: 'debit-note',
    label: 'Debit note',
    pluralLabel: 'Debit notes',
    side: 'purchase',
    direction: 'refund',
    postsToLedger: true,
  },
] as const satisfies readonly DocumentKindDefinition[]

/**
 * A kind that reaches the ledger, as a type.
 *
 * Read off the table's literal `true`s, which is what makes the domain's source-type
 * record impossible to get wrong. See the header.
 */
export type PostingKind = Extract<(typeof KINDS)[number], { postsToLedger: true }>['kind']

/**
 * The table, as everything outside this file sees it.
 *
 * WIDENED ON PURPOSE. `KINDS` above is `as const` so that `PostingKind` can be read off
 * its literal `true`s; leaving that type on the export would give every caller a
 * five-member union of frozen object literals, and `definition.label` would be the string
 * `'Sales invoice'` rather than a label. The literal tuple is an implementation detail of
 * one type, and this is the value.
 */
export const DOCUMENT_KINDS: readonly DocumentKindDefinition[] = KINDS

const BY_KIND: ReadonlyMap<DocumentKind, DocumentKindDefinition> = new Map(
  DOCUMENT_KINDS.map((definition) => [definition.kind, definition]),
)

/**
 * Every side of the trade, in the order the table first mentions each.
 *
 * DERIVED, NOT WRITTEN OUT. `TradeSide` is a type and a type has no values at runtime, so
 * something has to enumerate them for a validator to check against and for a screen to
 * offer — and a hand-written pair would be a second list agreeing with the table by
 * inspection, which is the shape this file's header spends four paragraphs deleting.
 */
export const TRADE_SIDES: readonly TradeSide[] = [
  ...new Set(DOCUMENT_KINDS.map((definition) => definition.side)),
]

/**
 * The definition for a kind.
 *
 * Throws rather than returning null. Every caller has a `DocumentKind`, which the type
 * system already narrowed to one of five strings — a null here would be unreachable, and
 * a null-check on every call site would be noise that hides the one case that is real: a
 * kind read from a company file written by a newer build.
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
  return definitionOf(kind).postsToLedger
}

/** Every kind on one side of the trade, in table order. For a menu or a list filter. */
export function kindsOnSide(side: TradeSide): readonly DocumentKindDefinition[] {
  return DOCUMENT_KINDS.filter((definition) => definition.side === side)
}

/**
 * Raising one of these puts somebody in debt, so it is the kind that falls due.
 *
 * The predicate `postingKindIn` filters by, minus the side — written once because 0014
 * needed the same three words with the side left off, and two spellings of one rule is
 * how `correctsKind` came to depend on table order.
 *
 * A quotation is `charge` and does not qualify: it offers a price and creates no
 * obligation, so there is nothing for terms to run from. A credit note is `refund` and
 * does not qualify either — it CANCELS an obligation, and 0015's work is saying which one
 * rather than giving it a due date of its own.
 */
function postsAs(definition: DocumentKindDefinition, direction: DocumentDirection): boolean {
  return definition.direction === direction && definition.postsToLedger
}

/**
 * Whether this kind carries a due date.
 *
 * The renderer asks so it knows whether to draw the column, and issuing asks so it knows
 * whether to stamp one — one question with one answer rather than a `kind === ` test on
 * each side of the boundary. Migration 0014 enumerates the same two kinds in SQL, where a
 * trigger cannot import a union, and a test asserts the two lists agree.
 */
export function chargesOnTerms(kind: DocumentKind): boolean {
  return postsAs(definitionOf(kind), 'charge')
}

/**
 * THE ONE KIND ON A SIDE THAT POSTS AND FACES A GIVEN WAY, and the phrase is load-bearing
 * in four places, which is why it is a function rather than four filters.
 *
 * A credit note corrects the sales-side CHARGE. A receipt settles it. A refund settles the
 * sales-side REFUND. Every one of them means "the posting kind on that side facing that
 * way", and none of them means anything else — so a fifth caller gets the same answer
 * rather than a fifth filter that agrees by inspection.
 *
 * THE DIRECTION BECAME AN ARGUMENT IN 0015 and it was `'charge'` written into the filter
 * before that. Nothing was wrong with it while the only voucher on a side settled the only
 * charge on it; a refund settles the credit note instead, and a function that can only
 * find charges cannot answer for one.
 *
 * `postsToLedger` IS THE PART WORTH READING TWICE. A quotation is also `sales` and also
 * `charge`, so without it the rule has two answers on the sales side. Excluding it is not
 * a patch to make the answer come out right: a quotation makes no supply, raises no tax
 * and moves no balance, so there is nothing to correct and nothing to settle.
 *
 * FOUND BY COUNTING THE MATCHES RATHER THAN BY TAKING THE FIRST. Migration 0013's test
 * asserted this mapping in the ambiguous form — derived inline with a `.find` — and it
 * passed only because `sales-invoice` is listed above `quotation`. A `.find` cannot tell
 * "one answer" from "the first of two", so the rule it implements is table order, and no
 * assertion downstream can see the difference.
 *
 * The refusal is at module load, so an ambiguity added to the table is a crash at boot
 * rather than a wrong picker at click time — the same argument `requireRule` makes in the
 * posting engine. It cannot fire on a shipped build: the table is a constant.
 *
 * WHICH IS ALSO WHY IT TAKES THE TABLE AS AN ARGUMENT. A guard against a state the real
 * table cannot reach is a guard no test can exercise and no mutation can kill — 0013-2's
 * mutation pass found exactly that, and the answer was not to accept an untestable line
 * but to let a test hand it the table it is guarding against.
 */
export function postingKindIn(
  kinds: readonly DocumentKindDefinition[],
  side: TradeSide,
  direction: DocumentDirection,
  /** Named in the refusal, so a crash at boot says which row could not be resolved. */
  asking: string,
): DocumentKind {
  const matches = kinds.filter((each) => each.side === side && postsAs(each, direction))
  const [only, ...rest] = matches
  if (only === undefined || rest.length > 0) {
    throw new Error(
      `${asking} names ${String(matches.length)} ${direction} kinds on the ${side} side. ` +
        'Exactly one posting kind per side and direction, or there is nothing to correct ' +
        'and nothing to settle.',
    )
  }
  return only.kind
}

/** The one kind on a side that posts and faces this way. */
export function postingKindOn(side: TradeSide, direction: DocumentDirection): DocumentKind {
  return postingKindIn(DOCUMENT_KINDS, side, direction, `the ${side} side`)
}

/**
 * What puts a party in debt on this side: the kind a credit note corrects and a receipt
 * settles.
 *
 * The named half of `postingKindOn`, kept because "the charge kind on this side" is the
 * phrase three rules are written in and `postingKindOn(side, 'charge')` reads as an
 * argument rather than as a fact.
 */
export function chargeKindOn(side: TradeSide): DocumentKind {
  return postingKindOn(side, 'charge')
}

/**
 * Which kind each refund kind may correct.
 *
 * This is the same mapping migration 0013 enumerates in SQL, where a CHECK cannot import
 * a union. A test in the documents suite asserts the two agree.
 */
export function correctionMap(
  kinds: readonly DocumentKindDefinition[],
): ReadonlyMap<DocumentKind, DocumentKind> {
  return new Map(
    kinds
      .filter((definition) => definition.direction === 'refund')
      .map((definition) => [
        definition.kind,
        postingKindIn(kinds, definition.side, 'charge', definition.kind),
      ]),
  )
}

const CORRECTS = correctionMap(DOCUMENT_KINDS)

/** The kind of document this one may correct, or null when it corrects nothing. */
export function correctsKind(kind: DocumentKind): DocumentKind | null {
  return CORRECTS.get(kind) ?? null
}
