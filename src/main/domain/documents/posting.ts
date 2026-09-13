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
 * REVERSE CHARGE: TWO POSTINGS FROM ONE BILL, AND ONLY ON ONE SIDE
 *
 * Where the BUYER discharges the tax, the seller does not collect it. Two things follow
 * and neither is symmetric between the sides.
 *
 * THE PARTY IS MOVED BY THE TOTAL LESS THE TAX. That is what the party actually owes or
 * is owed: the supplier is paid the value of the goods, and the tax goes to the
 * authority from the other end. Moving the control account by the grand total would put
 * money on a statement that nobody is ever going to pay.
 *
 * ON THE PURCHASE SIDE THE TAX POSTS TWICE. This business is the recipient: it OWES the
 * output tax and it MAY CLAIM the same figure as input credit. Both are true at once and
 * both are real — one is a liability to the authority and the other is an asset
 * recoverable from it — so the tax lands on both sides of the balance sheet and nets to
 * nothing in profit, which is exactly what a reverse charge does. Posting only the credit
 * would show a business reclaiming tax it never owed; posting only the liability would
 * show one paying tax it never gets back.
 *
 * ON THE SALES SIDE IT POSTS NOTHING AT ALL. This business supplies, the customer
 * discharges, and no figure on the document is this business's liability. The value still
 * counts as turnover, which is why the value lines are unchanged.
 *
 * `REVERSE_CHARGE_LEVIES` is that pair of sentences as a total record over `TradeSide`,
 * so a third side would not compile until somebody answered for it.
 *
 * ---------------------------------------------------------------------------
 * INELIGIBLE INPUT TAX IS NOT AN ASSET, SO IT IS NOT POSTED AS ONE
 *
 * Input tax reaches the input tax account because it is RECOVERABLE — money owed back by
 * the authority. Where credit is blocked it is not recoverable, and an account holding it
 * is an asset the business will never realise. It is part of what the thing cost, so it
 * posts to the LINE'S OWN VALUE ACCOUNT and is carried in the expense beside the goods.
 *
 * A LINE AT A TIME, WHICH IS THE WHOLE REASON THE COLUMN IS ON THE LINE. One bill can
 * carry a laptop and a staff car; the credit is available on the first and blocked on the
 * second; and they arrive on one piece of paper with one number. A document-level answer
 * would have to be wrong about one of the two lines.
 *
 * A LINE THAT RECORDS NOTHING IS TREATED AS ELIGIBLE, and that is a decision rather than
 * a default falling out of the types. It is what the books already assert — an ineligible
 * purchase would have been costed into the expense rather than posted to input tax — and
 * it is the only answer that leaves a document written before migration 0021 posting
 * exactly as it did. It is the one conditional in `creditIsAvailable`, and it is written
 * as one so that a reader can see where the assumption is.
 *
 * IT INTERACTS WITH REVERSE CHARGE AND THE INTERACTION IS THE RIGHT ONE. A blocked
 * reverse-charge purchase still OWES the output tax — that is a liability to the
 * authority and no eligibility rule touches it — and the input leg is costed into the
 * expense instead of claimed. So the tax stops netting to nothing and becomes a real cost,
 * which is precisely what a blocked credit means.
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
} from '@main/domain/ledger'
import { PostingError } from '@main/domain/ledger'

import type { ItcEligibility } from '@shared/dto'

import { documentTotals, type DocumentTotals } from './totals'
import {
  POSTING_KINDS,
  definitionOf,
  levyOf,
  type DocumentDirection,
  type DocumentKind,
  type DocumentKindDefinition,
  type DocumentLine,
  type PostingKindDefinition,
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

/**
 * The control account a side's documents move.
 *
 * EXPORTED FOR THE AGED REPORT, which is the second reader of this table and the reason
 * it stopped being private. An aged report is one control account decomposed by what put
 * money on it, so it has to ask the posting rules WHICH account that is rather than
 * deciding for itself — a second copy of these two rows would let the report age an
 * account nothing posts to and show every party at nil.
 *
 * Note what it does NOT do: it does not decide which line of an entry is the control
 * line. That is the party's id, for the reasons at the top of db/repos/outstanding.ts,
 * and remains true through any remapping of the role.
 */
export function controlRoleFor(side: TradeSide): AccountRole {
  return CONTROL_ROLES[side]
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
 * Which tax legs a document raises when the BUYER discharges the tax, by side.
 *
 * A total record over `TradeSide` (CONVENTIONS §1.9), because the two sides are not
 * mirror images and a conditional would make them look like one. On the purchase side
 * this business is the recipient — it owes the output tax and may claim the input credit,
 * two postings from one bill. On the sales side it is the supplier and owes nothing, so
 * the list is empty and the tax lands nowhere.
 */
const REVERSE_CHARGE_LEVIES: Readonly<Record<TradeSide, readonly TaxLevy[]>> = {
  sales: [],
  purchase: ['input', 'output'],
}

/**
 * Which side a tax leg lands on, from what the leg IS and which way the document faces.
 *
 * Input tax is an ASSET recoverable from the authority and output tax is a LIABILITY owed
 * to it, so a charge increases each on its own side and a refund decreases it. Written as
 * a total record over both unions rather than as "opposite the control account", which is
 * the same answer for every ordinary document and stops being one under reverse charge:
 * a bill under reverse charge carries BOTH legs, and they cannot both be opposite the
 * same control line.
 *
 * That it reproduces the old rule exactly for the four ordinary treatments is the
 * property worth testing, and the table in this file's header is that test.
 */
const TAX_IS_DEBIT: Readonly<Record<TaxLevy, Readonly<Record<DocumentDirection, boolean>>>> = {
  input: { charge: true, refund: false },
  output: { charge: false, refund: true },
}

/**
 * Whether credit may be taken, as a total record over the union.
 *
 * The two ineligible members answer the same way HERE and are kept apart because a return
 * reports them in different places — collapsing them into a boolean column would lose
 * which of the two a figure was, and no query could recover it.
 */
const CREDIT_IS_AVAILABLE: Readonly<Record<ItcEligibility, boolean>> = {
  eligible: true,
  'ineligible-17-5': false,
  'ineligible-other': false,
}

/**
 * Whether this line's input tax is recoverable.
 *
 * THE NULL ARM IS THE ONE DECISION IN THIS FUNCTION and is written as a conditional on
 * purpose, so that a reader can see exactly where the assumption is. A line that records
 * nothing is treated as eligible: it is what the books already assert, and it is the only
 * answer under which a document written before migration 0021 posts as it always did.
 */
function creditIsAvailable(eligibility: ItcEligibility | null): boolean {
  return eligibility === null ? true : CREDIT_IS_AVAILABLE[eligibility]
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
 * value would be a second way of saying what the table already says, and the two could
 * drift. Absence here means exactly "does not post", because `POSTING_KINDS` is the
 * filter — and a definition in it carries a non-null `sourceType` AS A MATTER OF TYPE, so
 * `ruleFor` assigns it rather than asserting it. See `POSTING_KINDS` in ./types.ts.
 */
const RULES: ReadonlyMap<DocumentKind, PostingRule<PostableDocument>> = new Map(
  POSTING_KINDS.map((definition) => [definition.kind, ruleFor(definition)]),
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

  for (const line of document.lines) {
    values.add(valueAccountFor(line, definition, accounts), line.taxableAmount)
  }

  /*
   * Grouped by component code, not by code and rate. The account is a property of the
   * component — output CGST is one liability however many rates fed it.
   *
   * Kept per LEVY rather than in one bucket, because a bill under reverse charge raises
   * both legs and they land on opposite sides of the entry. An ordinary document has one
   * levy and one bucket, exactly as before.
   */
  const taxByLevy = new Map<TaxLevy, Buckets>()
  const bucketFor = (levy: TaxLevy): Buckets => {
    const existing = taxByLevy.get(levy)
    if (existing !== undefined) return existing
    const created = new Buckets()
    taxByLevy.set(levy, created)
    return created
  }

  const levies = leviesOf(document, definition)
  for (const line of document.lines) {
    for (const component of line.taxes) {
      for (const levy of levies) {
        /*
         * Blocked input tax is not recoverable, so it is not an asset — it is part of what
         * the line cost, and it joins the line's own value bucket rather than reaching for
         * a tax account. It lands on the same side the value does, always: input tax on a
         * charge is a debit and so is the value, and both flip together on a refund.
         */
        if (levy === 'input' && !creditIsAvailable(line.itcEligibility)) {
          values.add(valueAccountFor(line, definition, accounts), component.amount)
          continue
        }
        bucketFor(levy).add(taxAccountFor(component.code, levy, accounts), component.amount)
      }
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
  const controlAmount = controlAmountOf(document, totals)
  if (!controlAmount.isZero()) {
    lines.push(
      place(accountFor(definition, accounts), controlAmount, controlDebit, document.partyId),
    )
  }

  for (const bucket of values.entries()) {
    lines.push(place(bucket.account, bucket.amount, !controlDebit))
  }

  for (const [levy, buckets] of taxByLevy) {
    const isDebit = TAX_IS_DEBIT[levy][definition.direction]
    for (const bucket of buckets.entries()) {
      lines.push(place(bucket.account, bucket.amount, isDebit))
    }
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

/**
 * Which tax legs this document raises.
 *
 * The ordinary answer is one: the levy the kind implies. Under reverse charge it is what
 * `REVERSE_CHARGE_LEVIES` says for the side, which is two on the purchase side and none
 * on the sales side.
 *
 * `levyOf` cannot be null for a kind with a rule — a rule exists exactly when a source
 * type does — but the null arm is answered rather than asserted away, because a tax
 * posted on the wrong side of the balance sheet is a figure that looks plausible in every
 * report and `taxAccountFor` is where that sentence is already written.
 */
function leviesOf(
  document: PostableDocument,
  definition: PostingKindDefinition,
): readonly TaxLevy[] {
  if (document.isReverseCharge) {
    return REVERSE_CHARGE_LEVIES[definition.side]
  }

  const levy = levyOf(definition.kind)
  if (levy === null) {
    /*
     * Unreachable, and kept — it used to sit inside `taxAccountFor` and moved here when
     * the levy became a list. `levyOf` answers null only for a kind with no source type,
     * and a rule exists exactly when a source type does, so no document reaching this
     * function can produce it. It stays for what the alternative would do: a tax posted on
     * a side nobody chose is a figure that looks entirely plausible in every report.
     */
    throw new PostingError(
      'ROLE_UNMAPPED',
      `A ${definition.label.toLowerCase()} levies no tax, so its components have nowhere to go.`,
      { kind: definition.kind },
    )
  }
  return [levy]
}

/**
 * What the party's control account moves by.
 *
 * The grand total in the ordinary case — it is what the document says at the bottom, and
 * anything else makes the party's ledger disagree with the paper they are holding.
 *
 * UNDER REVERSE CHARGE IT IS THE GRAND TOTAL LESS THE TAX, on BOTH sides, and the
 * symmetry here is real where the tax legs' was not. The party pays or is paid the value
 * of the supply; the tax goes to the authority from the other end and never passes
 * through this account. Taking the tax off the control line is what makes the entry
 * balance once the tax has been posted to two accounts (purchase) or to none (sales).
 */
function controlAmountOf(document: PostableDocument, totals: DocumentTotals): Decimal {
  return document.isReverseCharge ? totals.grandTotal.minus(totals.totalTax) : totals.grandTotal
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
  levy: TaxLevy,
  accounts: AccountResolver,
): AccountRef {
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
