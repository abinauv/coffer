/*
 * How a receipt becomes a journal entry.
 *
 * Read the three rules at the top of ./types.ts first. This file is rule 1 doing its
 * work: a receipt exists only as something that has already posted, so `toEntry` is not
 * an optional stage in its life — it runs in the same transaction that writes the row.
 *
 * PURE, like every posting rule. Same receipt and same context, same entry, every time.
 *
 * ---------------------------------------------------------------------------
 * THE ENTRY, BOTH WAYS ROUND
 *
 *   Receipt — money in from a customer
 *     Dr  Bank or Cash              the amount
 *         Cr  Accounts receivable   the amount   — carrying the customer's id
 *
 *   Payment — money out to a vendor
 *     Dr  Accounts payable          the amount   — carrying the vendor's id
 *         Cr  Bank or Cash          the amount
 *
 * Two lines and no arithmetic. There is nothing to add up, nothing to round and no tax:
 * settling an invoice moves money that was already taxed when the supply happened, and a
 * regime that taxes an advance does it on the receipt VOUCHER, which is a document with
 * lines and belongs in the other table. Nothing here calls `computeTax`, and the seam
 * that would is not in this module at all (CONVENTIONS §1.6).
 *
 * THE PARTY'S ID RIDES ON THE CONTROL LINE AND NO OTHER. Same as the sales invoice rule,
 * and it is what makes an aged report a grouping of the same rows the balance sheet
 * totals rather than a second set of books. The bank line carries no party — the money is
 * the business's own once it has landed, and tagging it would put a customer's name on a
 * bank balance.
 *
 * ---------------------------------------------------------------------------
 * THE BANK ACCOUNT IS CHOSEN, NOT DERIVED
 *
 * `PostableReceipt.accountId` names it, and the rule looks it up rather than asking for
 * the `bank` or `cash` role. A business has one cash account and several bank accounts,
 * and the role map holds one of each — so deriving it would post every receipt to the
 * same bank however many the business banks with, and the error would be invisible in
 * every report except a reconciliation nobody has run yet.
 *
 * What the rule refuses is an account that is not there. Whether it is a bank at all is a
 * question about the chart, and the repository asks it: `db/` knows that an account is
 * archived or is a group, and the answer is a sentence about the user's own chart.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO GUARD AGAINST A ZERO AMOUNT HERE, AND THAT IS ON PURPOSE
 *
 * A receipt of nothing would produce two lines that are neither a debit nor a credit,
 * which invariant 5 refuses — and `AMBIGUOUS_LINE` is a sentence about the right problem.
 * Refusing it here would need a `LedgerErrorCode` that does not exist, and inventing one
 * for a state 0012's CHECK and the repository both turn away first would be a third
 * answer to a settled question. Compare the sales invoice rule, which DOES skip a zero
 * receivable line: an invoice can legitimately come to nothing with real lines on it, and
 * a receipt cannot come to nothing at all.
 *
 * ---------------------------------------------------------------------------
 * WHAT A REFUND WOULD TAKE, IF SOMEBODY WANTS ONE
 *
 * Money out to a CUSTOMER — a refund against a credit note. It is not a payment: a
 * payment moves accounts payable, and a refund moves receivables the other way. It is a
 * third row in `RECEIPT_KINDS` with `side: 'sales'`, `direction: 'out'` and
 * `controlRole: 'accounts-receivable'`, and this file needs no change to post it, which
 * is the whole point of reading `direction` rather than the kind.
 */

import { ZERO } from '@main/domain/money'
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

import { receiptDefinitionOf, type PostableReceipt, type ReceiptKind } from './types'

/**
 * The rule for one kind, built from its own row in `RECEIPT_KINDS`.
 *
 * A factory rather than two hand-written objects, because the two differ in exactly the
 * three things the table already holds — the source type, the label, and which way the
 * money went. Writing them out twice would be two places for the second one to be wrong.
 */
function ruleFor(kind: ReceiptKind): PostingRule<PostableReceipt> {
  const definition = receiptDefinitionOf(kind)
  return {
    source: definition.sourceType,
    label: definition.label,
    toEntry: (receipt, context) => {
      if (receipt.kind !== kind) {
        /*
         * A plain Error, not a `PostingError`, for the reason the sales invoice rule
         * gives: every `LedgerErrorCode` is a sentence for a user about their books, and
         * none of them says "the wrong rule was called". That is a wiring mistake nobody
         * can act on and no screen should offer to fix.
         */
        throw new Error(
          `The ${definition.label.toLowerCase()} posting rule was given a ` +
            `${receiptDefinitionOf(receipt.kind).label.toLowerCase()}. ` +
            'Each kind has its own rule; see receiptPostingRuleFor.',
        )
      }
      return toEntry(receipt, context)
    },
  }
}

export const receiptRule: PostingRule<PostableReceipt> = ruleFor('receipt')
export const paymentRule: PostingRule<PostableReceipt> = ruleFor('payment')

/**
 * The rule that turns a voucher of this kind into an entry.
 *
 * NEVER NULL, where `postingRuleFor` in `domain/documents` can be. That difference is the
 * contract and not an accident: every receipt kind posts, so a kind with no rule is a
 * kind that cannot exist, and returning a null here would ask every caller to handle a
 * case the type system has already closed.
 */
export function receiptPostingRuleFor(kind: ReceiptKind): PostingRule<PostableReceipt> {
  return kind === 'receipt' ? receiptRule : paymentRule
}

function toEntry(receipt: PostableReceipt, context: PostingContext): EntryDraft {
  const definition = receiptDefinitionOf(receipt.kind)
  const { accounts } = context

  const control = requiredRole(accounts.forRole(definition.controlRole), definition.controlRole)
  const money = requiredAccount(receipt.accountId, accounts)

  const isIn = definition.direction === 'in'

  const moneyLine: EntryLineDraft = {
    accountId: money.id,
    debit: isIn ? receipt.amount : ZERO,
    credit: isIn ? ZERO : receipt.amount,
  }

  const controlLine: EntryLineDraft = {
    accountId: control.id,
    debit: isIn ? ZERO : receipt.amount,
    credit: isIn ? receipt.amount : ZERO,
    /* The whole reason a control line carries one — see 0005. */
    partyId: receipt.partyId,
  }

  return {
    date: receipt.date,
    narration: narrationFor(receipt),
    source: { type: definition.sourceType, id: receipt.id, number: receipt.number },
    /* The debit first, which is the order a journal is written in and read in. */
    lines: isIn ? [moneyLine, controlLine] : [controlLine, moneyLine],
  }
}

function requiredAccount(id: string, accounts: AccountResolver): AccountRef {
  const account = accounts.byId(id)
  if (account === null) {
    throw new PostingError(
      'ACCOUNT_NOT_FOUND',
      'This receipt names a bank or cash account that no longer exists. ' +
        'Point it at another one.',
      { accountId: id },
    )
  }
  return account
}

function requiredRole(account: AccountRef | null, role: AccountRole): AccountRef {
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
 * The voucher's own narration when it has one, because that is what the person who
 * recorded it wanted said. Otherwise the kind and the number, which is what somebody
 * scanning a ledger needs in order to find the paper.
 */
function narrationFor(receipt: PostableReceipt): string {
  const own = receipt.narration.trim()
  if (own !== '') return own
  return `${receiptDefinitionOf(receipt.kind).label} ${receipt.number}`
}
