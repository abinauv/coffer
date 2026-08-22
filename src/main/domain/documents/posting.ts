/*
 * How a trade document becomes a journal entry.
 *
 * This is where `PostingRule`, `AccountResolver` and `documentTotals` stop being
 * contracts and do the work they were designed for. Read the four rules at the top of
 * ./types.ts first, and the five invariants in domain/ledger/types.ts — this file is
 * where the two meet, and every decision below is a consequence of one of them.
 *
 * PURE, AND THAT IS THE POINT. Same document and same context, same entry, every time.
 * No clock, no database, no id generation. So the test for an accounting treatment is a
 * document written down beside the entry it must produce, and a change in treatment
 * cannot happen without one of those tests going red.
 *
 * ---------------------------------------------------------------------------
 * ONE ENGINE, FOUR TREATMENTS, AND WHY THERE IS NOT A FILE EACH
 *
 * Every posting document makes the same shape of entry:
 *
 *   the party's control account takes the grand total, on one side
 *   the value, the tax and the rounding take it back, on the other
 *
 * What differs between the four is only WHICH accounts and WHICH WAY ROUND, and both of
 * those are already written down in `DOCUMENT_KINDS` as `side` and `direction`. So this
 * file reads them out of the table rather than branching on the kind, and the four rules
 * below are four rows rather than four functions:
 *
 *   KIND            SIDE      DIR      CONTROL             VALUE             TAX
 *   sales invoice   sales     charge   Dr receivable       Cr sales          Cr output
 *   credit note     sales     refund   Cr receivable       Dr sales returns  Dr output
 *   purchase bill   purchase  charge   Cr payable          Dr purchases      Dr input
 *   debit note      purchase  refund   Dr payable          Cr purch returns  Cr input
 *
 * Read down the CONTROL column and the rule is not "sales means debit": it is that the
 * control account is DEBITED when the document moves the balance in the party's favour
 * to us — a sale we have made, or a purchase we are sending back. `controlIsDebit` says
 * that in one line, out of the two fields, and the table above is its test.
 *
 * WHAT THIS BUYS. A sixth kind gets a correct posting rule by adding a row to
 * `DOCUMENT_KINDS`, and a sixth kind on a side or in a direction this engine has never
 * seen FAILS TO COMPILE, because the role lookups below are total records over the two
 * unions. That was the point of one table for five kinds, and this is where it is paid.
 *
 * ---------------------------------------------------------------------------
 * WHY CONTROL TAKES THE GRAND TOTAL
 *
 * It is what the party owes or is owed, which is what the document says at the bottom.
 * Any other figure makes the receivables ledger disagree with the paper the customer is
 * holding, and the difference is a rounding line nobody can find. The party's id rides
 * on this line and no other, which is what makes an aged report a grouping of the same
 * rows the balance sheet totals.
 *
 * WHY VALUE TAKES THE TAXABLE AMOUNT. Turnover is what was charged for the supply, not
 * what was collected — the tax is the government's money passing through, and a business
 * that reported it as income would overstate turnover by the rate of GST. `taxableAmount`
 * is already net of discount, because a trade discount given on the invoice reduces the
 * value of the supply itself (see `DocumentLine.discount`).
 *
 * ---------------------------------------------------------------------------
 * A RETURN IS A CONTRA ACCOUNT, NOT A NEGATIVE SALE
 *
 * A credit note debits `sales-returns` rather than debiting `sales`. Both report the same
 * profit and the second one is a worse answer: turnover for the year would come out net
 * of returns with no way to see how large they were, and "how much did we sell and how
 * much came back" is a question a business asks about its own quality. The shipped chart
 * has `Sales Returns` as income and `Purchase Returns` as expense for exactly this — each
 * sits beside the account it reduces and nets against it in the accounts.
 *
 * TAX ON A RETURN GOES BACK THE WAY IT CAME. A credit note DEBITS the output tax account,
 * reducing a liability that was raised too high; a debit note CREDITS the input tax
 * account, giving back credit that was claimed too much. Neither one reaches for a
 * separate reversal account, because there is no such thing — a return adjusts the very
 * liability the invoice created, and GSTR-1 reports it against the original invoice for
 * that reason.
 *
 * ---------------------------------------------------------------------------
 * WHY A CHARGE IS NOT VALUE, AND WHY THE TWO SIDES TREAT ONE DIFFERENTLY
 *
 * Freight, packing and insurance are taxable at the same rate as the supply they sit on,
 * and they are not turnover. `isCharge` says which lines those are.
 *
 * On the SALES side they post to `freight-outward`, which is an EXPENSE account in the
 * shipped chart, so crediting it nets what was recovered from the customer against the
 * freight actually paid. The alternative is a separate income account, which reports the
 * same profit and puts a figure in turnover that no invoice line called a sale.
 *
 * On the PURCHASE side they post to `freight-inward`, which is under Cost of Sales. That
 * is not the same treatment wearing a mirror: carriage a supplier charges on their own
 * bill is part of what the goods cost (AS-2 puts freight inwards in the cost of purchase),
 * where outward freight is a selling cost being recovered. The two roles differ because
 * the two facts differ, and a business that wants either shown elsewhere names an account
 * on the line, which is what `DocumentLine.accountId` is for.
 *
 * ---------------------------------------------------------------------------
 * WHY TAX GROUPS BY COMPONENT AND THE PRINTED SUMMARY DOES NOT
 *
 * `documentTotals().taxSummary` is keyed by component AND rate, because an invoice
 * carrying 18% goods and 5% freight has to print `CGST @ 9%` and `CGST @ 2.5%` as two
 * lines a customer can check. The LEDGER does not: both are CGST collected, they go to
 * one account, and two credits to the same account on one entry would be a distinction
 * the trial balance immediately loses anyway. So the posting groups by component code
 * alone. The two groupings are different questions about the same figures, and the sum
 * across either is identical — which is the property worth testing.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE REFUSES TO DO
 *
 * It does not decide the tax. The document arrives carrying what the regime already
 * answered, per line and per component, as of the document's own date (rule 4). Asking a
 * regime again here would recompute a filed return's figures with today's rates.
 *
 * It does not number anything, does not set a status, and does not look at whether the
 * period is open. Those are the repository's, inside the one transaction that issues a
 * document (rule 3) — a rule that could refuse a posting for a reason the document knows
 * nothing about would be a second place where "can this be issued?" is answered.
 *
 * It does not read `originalDocumentId`. A credit note that names the invoice it corrects
 * and one that does not post identically, because the link is a fact for a return and for
 * a reader, not an instruction to the ledger. Nothing here would be different if it were
 * null, which is why nothing here looks.
 */

import { ZERO, type Decimal } from '@main/domain/money'
import type {
  AccountRef,
  AccountResolver,
  AccountRole,
  EntryDraft,
  EntryLineDraft,
  PostingContext,
  PostingRule,
  SourceDocumentType,
} from '@main/domain/ledger'
import { PostingError } from '@main/domain/ledger'

import { documentTotals } from './totals'
import {
  DOCUMENT_KINDS,
  definitionOf,
  levyOf,
  type DocumentDirection,
  type DocumentKind,
  type DocumentKindDefinition,
  type DocumentLine,
  type TaxLevy,
  type TradeDocument,
  type TradeSide,
} from './types'

/**
 * A document that is ready to post.
 *
 * `number` is non-null and `partyId` is present, which a draft cannot promise. The
 * repository proves both before calling — a rule that had to cope with a numberless
 * invoice would be a rule describing a state rule 2 says cannot reach the ledger.
 */
export interface PostableDocument extends TradeDocument {
  number: string
}

/**
 * A kind that reaches the ledger, with the null narrowed away.
 *
 * `sourceType: null` is what "never posts" means (see the note on it in ./types.ts), so
 * a definition with a rule is exactly a definition without that null. Narrowing it once,
 * here, is what lets `source` below be assigned rather than asserted — the alternative is
 * a `!` on every use, which tells the next reader nothing about why it is safe.
 */
interface PostingKindDefinition extends DocumentKindDefinition {
  sourceType: SourceDocumentType
}

function posts(definition: DocumentKindDefinition): definition is PostingKindDefinition {
  return definition.sourceType !== null
}

// ---- Which accounts, and which way round ------------------------------------

/*
 * Three total records over `TradeSide` and `DocumentDirection`. Total on purpose: a kind
 * added on a side these do not cover is a compile error here rather than a `ROLE_UNMAPPED`
 * at the moment a user tries to issue one.
 */

/** Whose balance the document moves. The only line that carries the party's id. */
const CONTROL_ROLES: Readonly<Record<TradeSide, AccountRole>> = {
  sales: 'accounts-receivable',
  purchase: 'accounts-payable',
}

/** Where the value of an ordinary line lands. A return goes to its own contra account. */
const VALUE_ROLES: Readonly<Record<TradeSide, Readonly<Record<DocumentDirection, AccountRole>>>> = {
  sales: { charge: 'sales', refund: 'sales-returns' },
  purchase: { charge: 'purchases', refund: 'purchase-returns' },
}

/**
 * Where a line flagged `isCharge` lands. Not a mirror of the other — see the header.
 *
 * Keyed by side alone rather than by side and direction, because a charge on a credit
 * note is the same freight the invoice charged, coming back. It reverses out of the same
 * account it went into, which the direction already takes care of.
 */
const CHARGE_ROLES: Readonly<Record<TradeSide, AccountRole>> = {
  sales: 'freight-outward',
  purchase: 'freight-inward',
}

/**
 * Whether the party's control account is debited.
 *
 * TRUE when the document moves the balance our way: a sale we have made (they owe us
 * more), or a purchase we are sending back (we owe them less). FALSE for the other two.
 * Written out of the two fields rather than listed per kind, so the four rows of the
 * table in the header are one expression and cannot disagree with each other.
 */
function controlIsDebit(definition: DocumentKindDefinition): boolean {
  return (definition.side === 'sales') === (definition.direction === 'charge')
}

/**
 * One credit or debit the rule is building, before it becomes a line.
 *
 * Accumulated by account so that a fifty-line invoice makes one credit to sales rather
 * than fifty. The document holds the detail; repeating it in the ledger would make the
 * day book unreadable and tell a reader nothing the invoice does not.
 */
interface Bucket {
  account: AccountRef
  amount: Decimal
}

class Buckets {
  private readonly byAccount = new Map<string, Bucket>()

  add(account: AccountRef, amount: Decimal): void {
    if (amount.isZero()) return
    const existing = this.byAccount.get(account.id)
    this.byAccount.set(
      account.id,
      existing === undefined
        ? { account, amount }
        : { account, amount: existing.amount.plus(amount) },
    )
  }

  /** In insertion order, so an entry's lines follow the document's own order. */
  entries(): readonly Bucket[] {
    return [...this.byAccount.values()]
  }
}

// ---- The rules --------------------------------------------------------------

/**
 * Every posting rule, built from the kind table at module load.
 *
 * A Map rather than a `Record<DocumentKind, …>` with a `null` for the quotation: a null
 * value would be a second way of saying what `sourceType: null` already says, and the two
 * could drift. Absence here means exactly "no `sourceType`", because that is the filter.
 */
const RULES: ReadonlyMap<DocumentKind, PostingRule<PostableDocument>> = new Map(
  DOCUMENT_KINDS.filter(posts).map((definition) => [definition.kind, ruleFor(definition)]),
)

function ruleFor(definition: PostingKindDefinition): PostingRule<PostableDocument> {
  return {
    source: definition.sourceType,
    label: definition.label,
    toEntry: (document, context) => toEntry(document, definition, context),
  }
}

/** The sales invoice rule, by name, for the callers that only ever want that one. */
export const salesInvoiceRule = requireRule('sales-invoice')
/** The credit note rule — a sales return, and the only way to correct an issued invoice. */
export const creditNoteRule = requireRule('credit-note')
/** The purchase bill rule — what a supplier's invoice does to these books. */
export const purchaseBillRule = requireRule('purchase-bill')
/** The debit note rule — goods going back to a supplier, or their bill overstated. */
export const debitNoteRule = requireRule('debit-note')

function requireRule(kind: DocumentKind): PostingRule<PostableDocument> {
  const rule = RULES.get(kind)
  if (rule === undefined) {
    /* Unreachable: every kind named above has a `sourceType`, and this runs at module
     * load, so a mistake here is a crash at boot rather than a wrong entry at issue. */
    throw new Error(`${kind} has no posting rule.`)
  }
  return rule
}

/**
 * The rule that turns a document of this kind into an entry, or null when it never posts.
 *
 * ONE NULL NOW, WHERE THERE WERE TWO. Until the other three rules were written this
 * answered null both for a quotation, which never posts and never will, and for a credit
 * note, which had no rule because nobody had written one — and the repository had to tell
 * those apart with `postsToLedger` to avoid silently issuing an unposted credit note.
 * There is no second null left: a kind either has a `sourceType` and therefore a rule, or
 * it has neither. `postsToLedger` and a non-null answer here are now the same question,
 * and `issuing.ts` still asks the first because that is the one with a meaning.
 *
 * A lookup rather than a `switch` in the repository, because "which rule posts this kind"
 * is a fact about the domain. A `switch` in `db/` would be a second table of document
 * kinds, kept in step by whoever remembers.
 */
export function postingRuleFor(kind: DocumentKind): PostingRule<PostableDocument> | null {
  return RULES.get(kind) ?? null
}

function toEntry(
  document: PostableDocument,
  definition: PostingKindDefinition,
  context: PostingContext,
): EntryDraft {
  if (document.kind !== definition.kind) {
    /*
     * A plain Error, not a `PostingError`. Every `LedgerErrorCode` is a sentence for a
     * user about their books, and none of them says "the wrong rule was called" — which
     * is a wiring mistake nobody can act on and which no UI should offer to fix. The
     * same line `definitionOf` draws for an unknown kind.
     */
    throw new Error(
      `The ${definition.label.toLowerCase()} posting rule was given a ` +
        `${definitionOf(document.kind).label.toLowerCase()}. ` +
        'Each document kind has its own rule; see postingRuleFor.',
    )
  }

  const totals = documentTotals(document)
  const { accounts } = context
  const values = new Buckets()
  const tax = new Buckets()

  for (const line of document.lines) {
    values.add(valueAccountFor(line, definition, accounts), line.taxableAmount)
  }

  /*
   * Grouped by component code, not by code and rate. The account is a property of the
   * component — output CGST is one liability however many rates fed it.
   */
  const levy = levyOf(definition.kind)
  for (const line of document.lines) {
    for (const component of line.taxes) {
      tax.add(taxAccountFor(component.code, levy, accounts), component.amount)
    }
  }

  /* Everything that is not the control account sits opposite it, whichever way it faces. */
  const controlDebit = controlIsDebit(definition)
  const lines: EntryLineDraft[] = []

  /*
   * Skipped when the grand total is nothing, the same way a bucket that comes to nothing
   * is skipped. Invariant 5 refuses a line that is neither a debit nor a credit, so a
   * zero control line is not a harmless no-op — it is an `AMBIGUOUS_LINE` refusal
   * arriving at a user who was told their invoice would not post, with no line on it to
   * point at. The same bug the year-end close had, and found the same way.
   *
   * A document can reach zero with real lines on it — a rebate line cancelling the goods
   * line it corrects — and when it does, the party owes nothing and a control movement of
   * nothing is the correct posting. Whatever is left balances among itself, because the
   * total it was measured against is zero.
   */
  if (!totals.grandTotal.isZero()) {
    lines.push(
      place(accountFor(definition, accounts), totals.grandTotal, controlDebit, document.partyId),
    )
  }

  for (const bucket of [...values.entries(), ...tax.entries()]) {
    lines.push(place(bucket.account, bucket.amount, !controlDebit))
  }

  /*
   * Rounding, if the document rounds. `roundOff` is already signed to post: adding it to
   * the net total gives the grand total, so it belongs on the same side as the value it
   * is adjusting and opposite the control line that carries the rounded figure. It is
   * taken from the document's own frozen policy rather than from a setting read today, so
   * reprinting years later cannot restate it (rule 4).
   */
  if (!totals.roundOff.isZero()) {
    const account = required(accounts.forRole('round-off'), 'round-off')
    lines.push(place(account, totals.roundOff, !controlDebit))
  }

  return {
    date: document.date,
    narration: narrationFor(document, definition),
    source: { type: definition.sourceType, id: document.id, number: document.number },
    lines,
  }
}

/**
 * One line, on the side asked for, with a negative amount folded into the other side.
 *
 * The fold is a real case and not a defensive flourish. A document may carry a line whose
 * value is negative — a rebate shown as a line rather than as a discount — and a whole
 * document can come out negative the same way; invariant 5 refuses a line that is a credit
 * of minus something. Doing it here rather than at each call site is what makes the four
 * treatments one engine: the caller says which side it means, and never how to write it.
 */
function place(
  account: AccountRef,
  amount: Decimal,
  isDebit: boolean,
  partyId?: string,
): EntryLineDraft {
  const debits = isDebit !== amount.isNegative()
  const magnitude = amount.isNegative() ? amount.negated() : amount
  return {
    accountId: account.id,
    debit: debits ? magnitude : ZERO,
    credit: debits ? ZERO : magnitude,
    ...(partyId === undefined ? {} : { partyId }),
  }
}

/** The party control account this kind moves. */
function accountFor(definition: PostingKindDefinition, accounts: AccountResolver): AccountRef {
  const role = CONTROL_ROLES[definition.side]
  return required(accounts.forRole(role), role)
}

/**
 * Where one line's value posts.
 *
 * An explicit account on the line wins, because it is a decision somebody made about
 * this line. Otherwise a charge goes to the side's freight account and everything else to
 * the side and direction's value account — see the header on why a charge is not turnover
 * and why the two sides do not treat one identically.
 */
function valueAccountFor(
  line: DocumentLine,
  definition: PostingKindDefinition,
  accounts: AccountResolver,
): AccountRef {
  if (line.accountId !== null) {
    const named = accounts.byId(line.accountId)
    if (named === null) {
      throw new PostingError(
        'ACCOUNT_NOT_FOUND',
        `A line on this ${definition.label.toLowerCase()} posts to an account that no ` +
          'longer exists. Point it at another one, or clear it to use the default.',
        { accountId: line.accountId, lineNumber: line.lineNumber },
      )
    }
    return named
  }

  const role = line.isCharge
    ? CHARGE_ROLES[definition.side]
    : VALUE_ROLES[definition.side][definition.direction]
  return required(accounts.forRole(role), role)
}

/**
 * Where one tax component posts.
 *
 * Keyed by the regime's own component code and by direction, never by an account code —
 * a regime has as many components as it has, and naming CGST here would put GST in
 * `domain/` (CONVENTIONS §1.6).
 */
function taxAccountFor(
  componentCode: string,
  levy: TaxLevy | null,
  accounts: AccountResolver,
): AccountRef {
  if (levy === null) {
    /* Unreachable for any kind with a rule, since a rule exists exactly when a
     * `sourceType` does and `levyOf` answers null only for the kinds without one. Thrown
     * rather than defaulted, because a tax posted on the wrong side of the balance sheet
     * is a figure that looks entirely plausible in every report. */
    throw new PostingError('ROLE_UNMAPPED', 'This document kind levies no tax.', { componentCode })
  }

  const account = accounts.forTaxComponent(componentCode, levy)
  if (account === null) {
    throw new PostingError(
      'ROLE_UNMAPPED',
      levy === 'output'
        ? `These books have no account for ${componentCode} collected on sales. ` +
            'Add one under Duties and Taxes before issuing this.'
        : `These books have no account for ${componentCode} paid on purchases. ` +
            'Add one under Taxes Recoverable before issuing this.',
      { componentCode, levy },
    )
  }
  return account
}

function required(account: AccountRef | null, role: AccountRole): AccountRef {
  if (account === null) {
    throw new PostingError(
      'ROLE_UNMAPPED',
      `No account is mapped to ${role}. Point one at it in the chart of accounts.`,
      { role },
    )
  }
  return account
}

/**
 * What the day book says this entry is.
 *
 * The document's own narration when it has one, because that is what the person who
 * raised it wanted said. Otherwise the kind and the number, which is the thing anybody
 * looking at a ledger line actually wants to find the paper by.
 */
function narrationFor(document: PostableDocument, definition: PostingKindDefinition): string {
  const own = document.narration.trim()
  return own === '' ? `${definition.label} ${document.number}` : own
}
