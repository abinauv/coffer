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
 * THE ENTRY A SALES INVOICE MAKES
 *
 *   Dr  Accounts receivable        grand total     — carrying the customer's id
 *       Cr  Sales                                  the goods and services, net of discount
 *       Cr  Freight outward                        anything flagged as a charge
 *       Cr  Output CGST / SGST / IGST              one line per component
 *       Cr  Round off                              what rounding added, if anything
 *
 * WHY RECEIVABLE TAKES THE GRAND TOTAL. It is what the customer owes, which is what the
 * document says at the bottom. Any other figure makes the receivables ledger disagree
 * with the paper the customer is holding, and the difference is a rounding line nobody
 * can find. The party's id rides on this line and no other, which is what makes an aged
 * report a grouping of the same rows the balance sheet totals.
 *
 * WHY REVENUE TAKES THE TAXABLE VALUE. Turnover is what was charged for the supply, not
 * what was collected — the tax is the government's money passing through, and a business
 * that reported it as income would overstate turnover by the rate of GST. `taxableAmount`
 * is already net of discount, because a trade discount given on the invoice reduces the
 * value of the supply itself (see `DocumentLine.discount`).
 *
 * ---------------------------------------------------------------------------
 * WHY A CHARGE IS NOT SALES
 *
 * Freight, packing and insurance recovered from the customer are taxable at the same rate
 * as the supply they sit on, and they are not turnover. `isCharge` says which lines those
 * are, and their value posts to `freight-outward` rather than to `sales`.
 *
 * `freight-outward` is an EXPENSE account in the shipped chart, so crediting it nets the
 * recovery against the freight actually paid. That is the treatment this codebase takes
 * and it is a deliberate choice rather than an accident of which roles happen to exist:
 * the alternative is a separate income account, which reports the same profit and puts a
 * figure in turnover that no invoice line called a sale. A business that wants it shown
 * separately names an account on the line, which is what `DocumentLine.accountId` is for.
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

import { documentTotals } from './totals'
import {
  definitionOf,
  levyOf,
  type DocumentKind,
  type DocumentLine,
  type TradeDocument,
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

export const salesInvoiceRule: PostingRule<PostableDocument> = {
  source: 'sales-invoice',
  label: 'Sales invoice',
  toEntry: (document, context) => toEntry(document, context),
}

/**
 * The rule that turns a document of this kind into an entry, or null when there is none.
 *
 * TWO DIFFERENT NULLS, AND THE CALLER HAS TO TELL THEM APART. A quotation has no rule
 * because it never posts — `sourceType` is null and always will be, and issuing one is
 * not blocked on anybody writing code. A credit note has no rule because the rule is not
 * written yet. Both come back null here; `postsToLedger` is what separates them, and the
 * repository says different sentences to the user for each.
 *
 * A lookup rather than a `switch` in the repository, because "which rule posts this kind"
 * is a fact about the domain. A `switch` in `db/` would be a second table of document
 * kinds, kept in step by whoever remembers.
 */
export function postingRuleFor(kind: DocumentKind): PostingRule<PostableDocument> | null {
  return kind === 'sales-invoice' ? salesInvoiceRule : null
}

function toEntry(document: PostableDocument, context: PostingContext): EntryDraft {
  const definition = definitionOf(document.kind)
  if (definition.sourceType !== 'sales-invoice') {
    /*
     * A plain Error, not a `PostingError`. Every `LedgerErrorCode` is a sentence for a
     * user about their books, and none of them says "the wrong rule was called" — which
     * is a wiring mistake nobody can act on and which no UI should offer to fix. The
     * same line `definitionOf` draws for an unknown kind.
     */
    throw new Error(
      `The sales invoice posting rule was given a ${definition.label.toLowerCase()}. ` +
        'Each document kind has its own rule; see postingRuleFor.',
    )
  }

  const totals = documentTotals(document)
  const { accounts } = context
  const revenue = new Buckets()
  const tax = new Buckets()

  for (const line of document.lines) {
    revenue.add(revenueAccountFor(line, accounts), line.taxableAmount)
  }

  /*
   * Grouped by component code, not by code and rate. The account is a property of the
   * component — output CGST is one liability however many rates fed it.
   */
  const levy = levyOf(document.kind)
  for (const line of document.lines) {
    for (const component of line.taxes) {
      tax.add(taxAccountFor(component.code, levy, accounts), component.amount)
    }
  }

  const lines: EntryLineDraft[] = []

  /*
   * Skipped when the grand total is nothing, the same way a bucket that comes to nothing
   * is skipped. Invariant 5 refuses a line that is neither a debit nor a credit, so a
   * zero receivable line is not a harmless no-op — it is an `AMBIGUOUS_LINE` refusal
   * arriving at a user who was told their invoice would not post, with no line on it to
   * point at. The same bug the year-end close had, and found the same way.
   *
   * An invoice can reach zero with real lines on it — a rebate line cancelling the goods
   * line it corrects — and when it does, the customer owes nothing and a receivable
   * movement of nothing is the correct posting. Whatever is left balances among itself,
   * because the total it was measured against is zero.
   */
  if (!totals.grandTotal.isZero()) {
    lines.push({
      accountId: required(accounts.forRole('accounts-receivable'), 'accounts-receivable').id,
      debit: totals.grandTotal,
      credit: ZERO,
      /* The whole reason a control line carries one — see 0005. */
      partyId: document.partyId,
    })
  }

  for (const bucket of [...revenue.entries(), ...tax.entries()]) {
    lines.push(credit(bucket))
  }

  /*
   * Rounding, if the document rounds. `roundOff` is already signed to post: positive
   * means the customer pays more than the lines add up to, so the difference is a credit.
   * It is taken from the document's own frozen policy rather than from a setting read
   * today, so reprinting an invoice years later cannot restate it (rule 4).
   */
  if (!totals.roundOff.isZero()) {
    const account = required(accounts.forRole('round-off'), 'round-off')
    lines.push({
      accountId: account.id,
      debit: totals.roundOff.isNegative() ? totals.roundOff.negated() : ZERO,
      credit: totals.roundOff.isPositive() ? totals.roundOff : ZERO,
    })
  }

  return {
    date: document.date,
    narration: narrationFor(document),
    source: { type: 'sales-invoice', id: document.id, number: document.number },
    lines,
  }
}

function credit(bucket: Bucket): EntryLineDraft {
  /*
   * A negative bucket becomes a debit rather than a negative credit. It is a real case
   * and not a defensive flourish: an invoice may carry a line whose value is negative —
   * a rebate shown as a line rather than as a discount — and invariant 5 refuses a line
   * that is a credit of minus something.
   */
  return {
    accountId: bucket.account.id,
    debit: bucket.amount.isNegative() ? bucket.amount.negated() : ZERO,
    credit: bucket.amount.isNegative() ? ZERO : bucket.amount,
  }
}

/**
 * Where one line's value posts.
 *
 * An explicit account on the line wins, because it is a decision somebody made about
 * this line. Otherwise a charge goes to `freight-outward` and everything else to `sales`
 * — see the header on why a charge is not turnover.
 */
function revenueAccountFor(line: DocumentLine, accounts: AccountResolver): AccountRef {
  if (line.accountId !== null) {
    const named = accounts.byId(line.accountId)
    if (named === null) {
      throw new PostingError(
        'ACCOUNT_NOT_FOUND',
        'A line on this invoice posts to an account that no longer exists. ' +
          'Point it at another one, or clear it to use the default.',
        { accountId: line.accountId, lineNumber: line.lineNumber },
      )
    }
    return named
  }

  const role: AccountRole = line.isCharge ? 'freight-outward' : 'sales'
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
  levy: 'output' | 'input' | null,
  accounts: AccountResolver,
): AccountRef {
  if (levy === null) {
    /* Unreachable for a sales invoice, whose definition always carries a levy. Thrown
     * rather than defaulted, because a tax posted on the wrong side of the balance sheet
     * is a figure that looks entirely plausible in every report. */
    throw new PostingError('ROLE_UNMAPPED', 'This document kind levies no tax.', { componentCode })
  }

  const account = accounts.forTaxComponent(componentCode, levy)
  if (account === null) {
    throw new PostingError(
      'ROLE_UNMAPPED',
      `These books have no account for ${componentCode} collected on sales. ` +
        'Add one under Duties and Taxes before issuing this invoice.',
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
 * raised it wanted said. Otherwise the number, which is the thing anybody looking at a
 * ledger line actually wants to find the paper by.
 */
function narrationFor(document: PostableDocument): string {
  const own = document.narration.trim()
  return own === '' ? `Sales invoice ${document.number}` : own
}
