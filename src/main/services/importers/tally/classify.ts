/*
 * WHAT A TALLY LEDGER IS, AND WHAT A TALLY VOUCHER IS. Both answered from tables.
 *
 * ---------------------------------------------------------------------------
 * 1. A LEDGER'S ROLE IS ITS PARENT CHAIN, NEVER ITS NAME.
 *
 * Tally has no field saying "this is a customer". What it has is a tree: every ledger
 * names a PARENT, every group names a parent, and the chain ends at one of a small fixed
 * set of primary groups. A ledger under `Sundry Debtors` is a customer; one under
 * `Bank Accounts` is a bank; one under `Indirect Expenses` is an expense. The ledger's own
 * name says nothing at all — `Kumar & Co` is a customer, a supplier or a rent account
 * depending only on where it hangs.
 *
 * SO THE CHAIN IS WALKED, and the walk is the whole of this half of the file. It is not a
 * lookup of the ledger's immediate parent: a real chart is `ABC Traders` under
 * `Karnataka Customers` under `South Zone` under `Sundry Debtors`, three hops, and every
 * hop is a group somebody invented. A one-hop lookup gets `Karnataka Customers`,
 * recognises nothing, and reports a customer as unplaceable.
 *
 * A CHAIN THAT DOES NOT REACH A GROUP THIS BUILD KNOWS IS REPORTED, in three distinguishable
 * ways, because the three send the user to different fixes:
 *   - it names a group NOT IN THIS EXPORT     -> export the masters too, or map the ledger
 *   - it reaches a TOP-LEVEL group we do not
 *     recognise                                -> tell Coffer what that group is
 *   - it LOOPS                                 -> the export is damaged; nothing can fix it
 *     here
 * A loop is not hypothetical. A group whose parent is itself is a state Tally's own data
 * entry permits, and a walker without a visited set does not report it — it hangs.
 *
 * ---------------------------------------------------------------------------
 * WHY A CUSTOMER LEDGER BECOMES A PARTY AND NOT AN ACCOUNT
 *
 * This is the single biggest structural difference between the two products, and it is
 * settled in `docs/data-model.md`: Tally gives every customer its own ledger account under
 * `Sundry Debtors`, and Coffer keeps ONE control account per side with `party_id` on the
 * line. So a chart of four hundred customers imported as four hundred accounts would be a
 * balance sheet with four hundred lines on it and an aged report that could disagree with
 * the control account.
 *
 * `TallyGroupRule.party` is what carries that: a rule with a side turns every ledger under
 * it into a `StagedParty`, and its opening balance into an opening balance against the
 * CONTROL ROLE with a `partySourceId` on it — which is exactly the shape
 * `postOpeningBalances` wants, and the shape that produces a real aged report on day one.
 *
 * ---------------------------------------------------------------------------
 * 2. A VOUCHER TYPE IS A FREE STRING, AND MOST FILES CONTAIN ONE NOBODY HAS SEEN.
 *
 * Tally ships about twenty voucher types and every company invents more: `Cash Sales`,
 * `Export Invoice`, `Branch Transfer`, `GST Sales - 18%`. They are ordinary, they are not
 * guessable from the name (`Cash Sales` is a Sales voucher; `Sales Order` is not a sale at
 * all), and a table keyed on the shipped twenty would silently drop the ones that matter
 * most to whoever invented them.
 *
 * So the table is an ARGUMENT with a default, three things can happen, and all three are
 * visible in the batch:
 *   MAPPED       -> a document kind, or a money direction plus a default side
 *   IGNORED      -> a type Coffer's import model has no home for, with the reason on it.
 *                   A Journal is the case: `ImportBatch` carries documents, vouchers and
 *                   opening balances, and a journal between two ledgers is none of them.
 *                   Reported per voucher, as a WARNING, naming the voucher — because the
 *                   user has to re-enter those by hand and a count is not enough to do it
 *                   from.
 *   UNKNOWN      -> nobody has decided anything. An ERROR, and the fix is one line of
 *                   table: `[...TALLY_VOUCHER_TYPES, { names: ['Cash Sales'], target: ... }]`.
 *
 * ---------------------------------------------------------------------------
 * 3. A RECEIPT'S KIND IS A DIRECTION TIMES A SIDE, LOOKED UP IN `RECEIPT_KINDS`.
 *
 * Tally has no refund voucher. A refund to a customer is a PAYMENT voucher whose party is
 * a debtor, and a refund from a supplier is a RECEIPT voucher whose party is a creditor.
 * So the voucher type gives the DIRECTION the money went and the party's parent chain
 * gives the SIDE of the trade, and the kind is whichever row of `RECEIPT_KINDS` holds both.
 *
 * This is CONVENTIONS §9 measured twice already: `receiptPostingRuleFor` was
 * `kind === 'receipt' ? ... : ...` and would have posted a customer's refund into accounts
 * payable, where no statement of theirs would ever have shown it. A lookup by the two
 * facts cannot make that mistake, and `tallyReceiptKind` takes the table as an argument so
 * a test can hand it one with two answers and watch it report rather than choose.
 */

import { normaliseHeading } from '../csv'

import {
  RECEIPT_KINDS,
  type MoneyDirection,
  type ReceiptKind,
  type ReceiptKindDefinition,
} from '@shared/receipts'
import type { DocumentKind, TradeSide } from '@shared/documents'
import type { AccountRole, AccountType } from '@main/domain/ledger'

// ---- Groups ---------------------------------------------------------------

/**
 * What a ledger under one group is.
 *
 * `party` is the side of the trade a ledger under this group belongs to, and its presence
 * is what turns a ledger into a `StagedParty` instead of a `StagedAccount`. `role` is the
 * semantic slot the posting engine reads; `type` is the account type, which every group
 * has because every group sits somewhere on a balance sheet or a profit and loss.
 *
 * `names` is a LIST for the reason `LedgerSynonym.aliases` is: Tally's own group names are
 * spelled differently across releases (`Cash-in-Hand`, `Cash-in-hand`) and a company may
 * have renamed one. Resolution counts the matches rather than taking the first, so a table
 * where two rules claim one name is reported and not silently decided by order.
 */
export interface TallyGroupRule {
  readonly names: readonly string[]
  readonly type: AccountType
  readonly role?: AccountRole
  readonly party?: TradeSide
  /**
   * A ledger under this group carries a figure Coffer works out for itself.
   *
   * `Duties & Taxes` is the group this exists for, and naming no component is the point
   * (CONVENTIONS §1.6). What matters here is arithmetic, not tax: the levy on a Tally sales
   * voucher is one of its ledger entries, and Coffer's own documents service computes the
   * levy from the LINES at write time. An entry under a recomputed group that also became
   * a line would therefore be charged twice — once as a line and once as the levy on it —
   * and the invoice would come out higher than the one the customer was given.
   *
   * It is kept off the lines and the voucher's own total still carries it, because
   * `statedTotal` is the party's side of the voucher and that is the gross. Which is
   * exactly what `statedTotal` is for: the write step compares it against what Coffer
   * computed and says so.
   */
  readonly recomputed?: boolean
}

/**
 * Tally's primary groups and the sub-groups that carry a meaning of their own.
 *
 * Every entry is a group Tally itself ships, not a guess at what one might be called: the
 * cost of a wrong entry is a ledger classified onto the wrong side of a balance sheet that
 * still balances, which is strictly worse than a ledger the user gets asked about.
 *
 * DELIBERATELY ABSENT, and each for a reason:
 *   `Duties & Taxes` HAS NO ROLE, only a type. Which tax component a ledger under it is
 *                    is the regime's answer (CONVENTIONS §1.6) and this module may not name
 *                    one. The type is enough to keep it off a document's LINES, which is
 *                    what stops an imported invoice being taxed twice — see `vouchers.ts`.
 *   `Sales Accounts` and `Purchase Accounts` carry roles; `Direct Incomes` and
 *                    `Direct Expenses` do not, because a ledger under Direct Expenses is
 *                    an ordinary expense account and mapping every one of them onto the
 *                    single `purchases` role would collapse a company's cost structure
 *                    into one line.
 *   `Stock-in-Hand`  is the stock ASSET. `Opening Stock` is an expense in a trading
 *                    account and is not a group at all; `LEDGER_SYNONYMS` leaves it out
 *                    for the same reason.
 *   `Suspense A/c`   is Tally's own, and it is given the `suspense` role because Coffer
 *                    has that slot and because a balance sitting in it is exactly what the
 *                    role is for. It is typed as an asset: Tally shows it on the balance
 *                    sheet and its sign decides which side it prints on.
 */
export const TALLY_GROUPS: readonly TallyGroupRule[] = [
  {
    names: ['Sundry Debtors', 'Sundry Debtor'],
    type: 'asset',
    role: 'accounts-receivable',
    party: 'sales',
  },
  {
    names: ['Sundry Creditors', 'Sundry Creditor'],
    type: 'liability',
    role: 'accounts-payable',
    party: 'purchase',
  },
  { names: ['Bank Accounts', 'Bank Account'], type: 'asset', role: 'bank' },
  { names: ['Cash-in-Hand', 'Cash in Hand'], type: 'asset', role: 'cash' },
  { names: ['Sales Accounts', 'Sales Account'], type: 'income', role: 'sales' },
  { names: ['Purchase Accounts', 'Purchase Account'], type: 'expense', role: 'purchases' },
  { names: ['Stock-in-Hand', 'Stock in Hand'], type: 'asset', role: 'stock' },
  { names: ['Suspense A/c', 'Suspense Account'], type: 'asset', role: 'suspense' },
  { names: ['Duties & Taxes', 'Duties and Taxes'], type: 'liability', recomputed: true },
  { names: ['Direct Incomes', 'Direct Income'], type: 'income' },
  { names: ['Indirect Incomes', 'Indirect Income'], type: 'income' },
  { names: ['Direct Expenses', 'Direct Expense'], type: 'expense' },
  { names: ['Indirect Expenses', 'Indirect Expense'], type: 'expense' },
  { names: ['Fixed Assets', 'Fixed Asset'], type: 'asset' },
  { names: ['Current Assets', 'Current Asset'], type: 'asset' },
  { names: ['Investments', 'Investment'], type: 'asset' },
  { names: ['Deposits (Asset)', 'Deposits'], type: 'asset' },
  { names: ['Loans & Advances (Asset)', 'Loans and Advances (Asset)'], type: 'asset' },
  { names: ['Misc. Expenses (ASSET)', 'Misc Expenses (ASSET)'], type: 'asset' },
  { names: ['Branch / Divisions', 'Branch/Divisions'], type: 'asset' },
  { names: ['Current Liabilities', 'Current Liability'], type: 'liability' },
  { names: ['Loans (Liability)', 'Loans'], type: 'liability' },
  { names: ['Secured Loans', 'Secured Loan'], type: 'liability' },
  { names: ['Unsecured Loans', 'Unsecured Loan'], type: 'liability' },
  { names: ['Bank OD A/c', 'Bank OCC A/c', 'Bank OD Account'], type: 'liability' },
  { names: ['Provisions', 'Provision'], type: 'liability' },
  { names: ['Capital Account', 'Capital Accounts'], type: 'equity' },
  { names: ['Reserves & Surplus', 'Reserves and Surplus'], type: 'equity' },
]

/** Where a parent chain ended up. `chain` is every group it walked, outermost last. */
export type TallyLedgerRole =
  | {
      readonly kind: 'party'
      readonly side: TradeSide
      readonly role: AccountRole
      readonly type: AccountType
      /** The group the chain landed on, as the file spells it. */
      readonly group: string
      readonly chain: readonly string[]
    }
  | {
      readonly kind: 'account'
      readonly role: AccountRole | null
      readonly type: AccountType
      /** See `TallyGroupRule.recomputed`. An entry on one of these is never a line. */
      readonly recomputed: boolean
      readonly group: string
      readonly chain: readonly string[]
    }
  | { readonly kind: 'unresolved'; readonly because: string; readonly chain: readonly string[] }
  | {
      readonly kind: 'ambiguous'
      readonly candidates: readonly string[]
      readonly group: string
      readonly chain: readonly string[]
    }

/**
 * Walk a parent chain until it reaches a group this build classifies.
 *
 * `groupParents` maps a group's key (`normaliseHeading` of its name) to the name of ITS
 * parent, and is built from the `GROUP` masters the export contains. A chain step that
 * finds no entry there has left the export; a chain step whose entry is blank has reached
 * a top-level group. The two are different failures with different fixes, so they are
 * different messages.
 *
 * @param startingParent the ledger's own `PARENT`, as the file spells it.
 */
export function classifyTallyLedger(
  startingParent: string,
  groupParents: ReadonlyMap<string, string>,
  rules: readonly TallyGroupRule[] = TALLY_GROUPS,
): TallyLedgerRole {
  const chain: string[] = []
  const seen = new Set<string>()
  let name = startingParent

  for (;;) {
    const key = normaliseHeading(name)
    if (key === '') {
      return {
        kind: 'unresolved',
        because:
          chain.length === 0
            ? 'it names no parent group, so nothing in this export says what it is.'
            : `the chain reaches ${JSON.stringify(chain[chain.length - 1] ?? '')}, which names no ` +
              'parent, and Coffer does not recognise it as one of Tally’s own groups.',
        chain,
      }
    }
    if (seen.has(key)) {
      return {
        kind: 'unresolved',
        because:
          `the parent groups loop back to ${JSON.stringify(name)} ` +
          `(${[...chain, name].join(' -> ')}), so the chain never ends.`,
        chain,
      }
    }
    seen.add(key)
    chain.push(name)

    /* `filter` and a count, never `.find`: two rules claiming one group name is a table
     * somebody has to fix, and taking the first would make the answer table order while
     * looking like a rule (CONVENTIONS §9). The table is an argument so a test can build
     * that collision — the shipped one cannot. */
    const matches = rules.filter((rule) =>
      rule.names.some((candidate) => normaliseHeading(candidate) === key),
    )
    const [only, ...rest] = matches
    if (rest.length > 0) {
      return {
        kind: 'ambiguous',
        candidates: matches.map(
          (rule) => `${rule.type}${rule.role === undefined ? '' : ` (${rule.role})`}`,
        ),
        group: name,
        chain,
      }
    }
    if (only !== undefined) {
      if (only.party !== undefined && only.role !== undefined) {
        return {
          kind: 'party',
          side: only.party,
          role: only.role,
          type: only.type,
          group: name,
          chain,
        }
      }
      return {
        kind: 'account',
        role: only.role ?? null,
        type: only.type,
        recomputed: only.recomputed ?? false,
        group: name,
        chain,
      }
    }

    const next = groupParents.get(key)
    if (next === undefined) {
      return {
        kind: 'unresolved',
        because:
          `it is under ${JSON.stringify(name)}, and this export has no group of that name to ` +
          'say what that is. Export the masters as well, or choose an account for it.',
        chain,
      }
    }
    name = next
  }
}

// ---- Voucher types --------------------------------------------------------

/**
 * What one Tally voucher type becomes.
 *
 * `receipt` carries a DIRECTION and a DEFAULT SIDE rather than a `ReceiptKind`, because
 * the kind is the direction crossed with the party's side and the party is not known until
 * the voucher's entries have been read. The default side is what a payment means when the
 * export brings no masters and the party's chain cannot be walked — it is used, and it is
 * reported when it is used.
 */
export type TallyVoucherTarget =
  | { readonly kind: 'document'; readonly documentKind: DocumentKind }
  | {
      readonly kind: 'receipt'
      readonly direction: MoneyDirection
      readonly defaultSide: TradeSide
    }
  | { readonly kind: 'ignore'; readonly because: string }

export interface TallyVoucherTypeRule {
  readonly names: readonly string[]
  readonly target: TallyVoucherTarget
}

/**
 * The shipped table.
 *
 * SIX TYPES MAP AND THE REST OF TALLY'S OWN ARE IGNORED WITH A REASON. Ignoring is not the
 * same as not knowing, and the difference is the whole of decision 2 in the header: an
 * ignored type is a decision Coffer made, written down here, visible in the batch as a
 * warning naming the voucher; an unknown one is a question the user has to answer.
 *
 * A `Contra` is bank-to-bank and has no party at all, so no `StagedReceipt` can describe
 * it. A `Journal` is two ledgers and no party. The order and stock vouchers move no money.
 * All of them are real, ordinary vouchers and none of them has a home in `ImportBatch` —
 * which is a limit of what this import carries, stated, rather than a gap that shows up as
 * a missing month.
 */
export const TALLY_VOUCHER_TYPES: readonly TallyVoucherTypeRule[] = [
  { names: ['Sales'], target: { kind: 'document', documentKind: 'sales-invoice' } },
  { names: ['Purchase'], target: { kind: 'document', documentKind: 'purchase-bill' } },
  { names: ['Credit Note'], target: { kind: 'document', documentKind: 'credit-note' } },
  { names: ['Debit Note'], target: { kind: 'document', documentKind: 'debit-note' } },
  { names: ['Receipt'], target: { kind: 'receipt', direction: 'in', defaultSide: 'sales' } },
  { names: ['Payment'], target: { kind: 'receipt', direction: 'out', defaultSide: 'purchase' } },
  {
    names: ['Journal'],
    target: {
      kind: 'ignore',
      because:
        'a journal moves money between two ledgers with no party and no document, and an ' +
        'import carries documents, vouchers and opening balances. Enter it in Coffer by hand.',
    },
  },
  {
    names: ['Contra'],
    target: {
      kind: 'ignore',
      because:
        'a contra moves money between two of your own accounts, so there is no party for a ' +
        'receipt to name. Enter it in Coffer by hand.',
    },
  },
  {
    names: ['Sales Order', 'Purchase Order', 'Quotation'],
    target: {
      kind: 'ignore',
      because: 'an order commits nothing to the books until it is billed.',
    },
  },
  {
    names: ['Delivery Note', 'Receipt Note', 'Rejections In', 'Rejections Out'],
    target: {
      kind: 'ignore',
      because:
        'it moves stock without moving money, and this import does not carry stock movements.',
    },
  },
  {
    names: ['Stock Journal', 'Physical Stock'],
    target: {
      kind: 'ignore',
      because: 'it adjusts stock quantities, which this import does not carry.',
    },
  },
  {
    names: ['Memorandum'],
    target: { kind: 'ignore', because: 'Tally does not post a memorandum voucher either.' },
  },
]

/** What looking a voucher type up found. Three states, and none of them is a guess. */
export type TallyVoucherLookup =
  | { readonly kind: 'found'; readonly target: TallyVoucherTarget }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly string[] }

/** The target for one voucher type. `filter` and a count, never `.find` — CONVENTIONS §9. */
export function tallyVoucherTarget(
  voucherType: string,
  rules: readonly TallyVoucherTypeRule[] = TALLY_VOUCHER_TYPES,
): TallyVoucherLookup {
  const key = normaliseHeading(voucherType)
  if (key === '') {
    return { kind: 'unknown' }
  }
  const matches = rules.filter((rule) =>
    rule.names.some((candidate) => normaliseHeading(candidate) === key),
  )
  const [only, ...rest] = matches
  if (rest.length > 0) {
    return { kind: 'ambiguous', candidates: matches.map((rule) => rule.target.kind) }
  }
  if (only === undefined) {
    return { kind: 'unknown' }
  }
  return { kind: 'found', target: only.target }
}

/** What looking a receipt kind up found. */
export type TallyReceiptLookup =
  | { readonly kind: 'one'; readonly receiptKind: ReceiptKind }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly ReceiptKind[] }

/**
 * The one voucher kind that moves money this way on this side of the trade.
 *
 * The table is an ARGUMENT because CONVENTIONS §6 is explicit that a guard the real table
 * cannot trigger is a line no test can reach: `RECEIPT_KINDS` is exactly the four
 * combinations of two directions and two sides, so it can never be ambiguous, and the
 * refusal would be unreachable and unkillable. A test hands this one a table with two rows
 * for one combination and watches it report instead of choosing.
 */
export function tallyReceiptKind(
  direction: MoneyDirection,
  side: TradeSide,
  kinds: readonly ReceiptKindDefinition[] = RECEIPT_KINDS,
): TallyReceiptLookup {
  const matches = kinds.filter(
    (definition) => definition.direction === direction && definition.side === side,
  )
  const [only, ...rest] = matches
  if (rest.length > 0) {
    return { kind: 'ambiguous', candidates: matches.map((definition) => definition.kind) }
  }
  if (only === undefined) {
    return { kind: 'none' }
  }
  return { kind: 'one', receiptKind: only.kind }
}

// ---- Bill allocations -----------------------------------------------------

/**
 * What one bill allocation does.
 *
 * Only `settles` is an allocation in Coffer's sense — money matched against a document
 * that already exists. `opens` is what a sales voucher writes to CREATE the reference the
 * later receipt will settle, and staging it as an allocation would have an invoice paying
 * itself. `unallocated` is money on account, which Coffer models properly and which needs
 * no allocation row at all.
 */
export type TallyBillTreatment = 'settles' | 'opens' | 'unallocated'

export interface TallyBillTypeRule {
  readonly names: readonly string[]
  readonly treatment: TallyBillTreatment
}

export const TALLY_BILL_TYPES: readonly TallyBillTypeRule[] = [
  { names: ['Agst Ref', 'Against Reference'], treatment: 'settles' },
  { names: ['New Ref', 'New Reference'], treatment: 'opens' },
  { names: ['Advance'], treatment: 'unallocated' },
  { names: ['On Account'], treatment: 'unallocated' },
]

export type TallyBillLookup =
  | { readonly kind: 'one'; readonly treatment: TallyBillTreatment }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly TallyBillTreatment[] }

/** What one `BILLTYPE` means. `filter` and a count, for the reason every lookup here is. */
export function tallyBillTreatment(
  billType: string,
  rules: readonly TallyBillTypeRule[] = TALLY_BILL_TYPES,
): TallyBillLookup {
  const key = normaliseHeading(billType)
  if (key === '') {
    return { kind: 'unknown' }
  }
  const matches = rules.filter((rule) =>
    rule.names.some((candidate) => normaliseHeading(candidate) === key),
  )
  const [only, ...rest] = matches
  if (rest.length > 0) {
    return { kind: 'ambiguous', candidates: matches.map((rule) => rule.treatment) }
  }
  if (only === undefined) {
    return { kind: 'unknown' }
  }
  return { kind: 'one', treatment: only.treatment }
}
