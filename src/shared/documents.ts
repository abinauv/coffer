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
 * The kind of document this one may correct, or null when it corrects nothing.
 *
 * THE RULE IS "THE CHARGE KIND ON THE SAME SIDE THAT POSTS", and the last three words are
 * load-bearing. A quotation is also `sales` and also `charge`, so without them the rule
 * has two answers on the sales side. Excluding it is not a patch to make the answer come
 * out right: there is nothing to correct, because a quotation makes no supply, raises no
 * tax and moves no balance.
 *
 * BUILT BY COUNTING THE MATCHES RATHER THAN BY TAKING THE FIRST, which is the part worth
 * reading. Migration 0013's test asserted this mapping in the ambiguous form — derived
 * inline with a `.find` — and it passed only because `sales-invoice` is listed above
 * `quotation`. A `.find` cannot tell "one answer" from "the first of two", so the rule it
 * implements is table order, and no assertion downstream can see the difference. This
 * collects every match and refuses more than one.
 *
 * The refusal is at module load, so an ambiguity added to the table is a crash at boot
 * rather than a wrong picker at click time — the same argument `requireRule` makes in the
 * posting engine. It cannot fire on a shipped build: the table is a constant.
 *
 * WHICH IS ALSO WHY IT TAKES THE TABLE AS AN ARGUMENT. A guard against a state the real
 * table cannot reach is a guard no test can exercise and no mutation can kill — the
 * mutation pass found exactly that, and the answer was not to accept an untestable line
 * but to let a test hand it the table it is guarding against.
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
      .map((definition) => {
        const charges = kinds.filter(
          (each) =>
            each.side === definition.side && each.direction === 'charge' && each.postsToLedger,
        )
        const [charge, ...rest] = charges
        if (charge === undefined || rest.length > 0) {
          throw new Error(
            `${definition.kind} may correct ${String(charges.length)} kinds on the ` +
              `${definition.side} side. Exactly one posting charge kind per side, or a ` +
              'correction has no subject.',
          )
        }
        return [definition.kind, charge.kind]
      }),
  )
}

const CORRECTS = correctionMap(DOCUMENT_KINDS)

/** The kind of document this one may correct, or null when it corrects nothing. */
export function correctsKind(kind: DocumentKind): DocumentKind | null {
  return CORRECTS.get(kind) ?? null
}
