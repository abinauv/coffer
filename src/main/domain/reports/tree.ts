/*
 * Turning a chart of accounts and a set of balances into the rows of a report.
 *
 * Pure, and the only place the shape of a financial statement is decided. The repository
 * supplies the accounts and the sums; everything about which rows appear, in what order,
 * at what indent and carrying which total is worked out here, where it can be tested
 * without a database.
 *
 * ---------------------------------------------------------------------------
 * A GROUP'S FIGURE IS ITS DESCENDANTS' AND NOTHING ELSE
 *
 * Never a stored subtotal — invariant 4 — and never a figure of its own either. That is
 * not a convention here, it follows from two database triggers that already hold:
 * `accounts_parent_must_be_group` makes anything with children a group, and
 * `accounts_no_group_with_postings` refuses a posting to a group. So an account with
 * children provably has no lines against it, and adding an own-amount to a rolled-up
 * total could not double-count even if it were written.
 *
 * ---------------------------------------------------------------------------
 * EVERY AMOUNT IS SIGNED IN ITS OWN NORMAL DIRECTION
 *
 * Balances arrive from `signedEffect`, so a figure is positive when the account holds
 * what it usually holds. An asset in credit — an overdrawn bank — is a negative asset
 * rather than a liability, because moving it would misstate both sides and nothing in
 * the ledger says it should move.
 *
 * A child carries its parent's type (another trigger), so every account in a subtree
 * shares one normal direction and the sums add without a sign conversion anywhere.
 */

import { ZERO, type Decimal } from '../money'
import type { AccountType } from '../ledger'

/** What a report needs to know about an account. A slice of the chart, nothing more. */
export interface ReportAccount {
  id: string
  code: string
  name: string
  type: AccountType
  parentId: string | null
  isGroup: boolean
}

export interface ReportLine {
  accountId: string
  code: string
  name: string
  type: AccountType
  /** 0 for a root of the section, 1 for its children, and so on. */
  depth: number
  isGroup: boolean
  /** The subtree total for a group; the account's own balance for a leaf. */
  amount: Decimal
}

export interface BuildOptions {
  /** Only accounts of these types. A section of a statement is one or two of them. */
  types: readonly AccountType[]
  /**
   * Keep an account nothing has been posted to.
   *
   * Off by default. A seeded chart carries forty-odd accounts and a young company has
   * posted to six of them; a statement listing thirty-four zeroes buries the figures
   * that matter under the ones that do not.
   *
   * NOTE WHAT THIS DOES *NOT* DROP. The test is whether anything was posted in the
   * subtree, not whether the subtree totals zero. A group holding +2,000 of petty cash
   * and -2,000 of bank totals nothing and must still appear, with both children under
   * it: that is four thousand rupees the user has to be able to see. Dropping on the
   * total was the first rule written here, and it made real money disappear from a
   * balance sheet that still balanced — which is the worst shape a bug can take.
   */
  includeZero?: boolean
}

export interface ReportTree {
  lines: ReportLine[]
  /** The sum of the roots — the section total. */
  total: Decimal
}

/**
 * Build one section of a statement.
 *
 * Rows come back flattened in tree order — a parent immediately followed by its
 * descendants — carrying the depth to indent by. A report is read top to bottom, and a
 * nested structure would only be flattened again by whatever drew it.
 */
export function buildReportTree(
  accounts: readonly ReportAccount[],
  balances: ReadonlyMap<string, Decimal>,
  options: BuildOptions,
): ReportTree {
  const wanted = new Set(options.types)
  const included = accounts.filter((account) => wanted.has(account.type))

  const childrenOf = new Map<string | null, ReportAccount[]>()
  const byId = new Map(included.map((account) => [account.id, account]))

  for (const account of included) {
    /*
     * An account whose parent was filtered out by type is treated as a root rather than
     * dropped. A child carries its parent's type, so this should not arise — but the
     * alternative to defending against it is a figure vanishing from a statement with
     * nothing to indicate it, which is the worst outcome available here.
     */
    const key = account.parentId !== null && byId.has(account.parentId) ? account.parentId : null
    const siblings = childrenOf.get(key)
    if (siblings === undefined) childrenOf.set(key, [account])
    else siblings.push(account)
  }

  for (const siblings of childrenOf.values()) {
    siblings.sort(byCode)
  }

  /* Totals first, bottom-up, so a parent knows what its subtree holds before deciding
   * whether to draw itself. `posted` is tracked separately from the total, because a
   * subtree can have plenty in it and still add to nothing. */
  const totals = new Map<string, Decimal>()
  const posted = new Set<string>()
  const seen = new Set<string>()

  const totalOf = (account: ReportAccount): Decimal => {
    const cached = totals.get(account.id)
    if (cached !== undefined) return cached
    /* A cycle cannot exist — moves are cycle-checked — but recursing forever is a hang
     * with no error, so it is refused rather than trusted. */
    if (seen.has(account.id)) return ZERO
    seen.add(account.id)

    const children = childrenOf.get(account.id) ?? []
    let total: Decimal = ZERO

    if (children.length === 0) {
      const own = balances.get(account.id)
      if (own !== undefined) {
        total = own
        /* Present in the map at all means a line was posted here in the range. A
         * balance of exactly zero still counts: an account that took a receipt and a
         * payment of the same amount has a history, and hiding it is hiding both. */
        posted.add(account.id)
      }
    } else {
      for (const child of children) {
        total = total.plus(totalOf(child))
        if (posted.has(child.id)) posted.add(account.id)
      }
    }

    totals.set(account.id, total)
    return total
  }

  for (const account of included) totalOf(account)

  const includeZero = options.includeZero ?? false
  const lines: ReportLine[] = []

  const emit = (account: ReportAccount, depth: number): void => {
    const amount = totals.get(account.id) ?? ZERO
    if (!includeZero && !posted.has(account.id)) return

    lines.push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      depth,
      isGroup: account.isGroup,
      amount,
    })

    for (const child of childrenOf.get(account.id) ?? []) {
      emit(child, depth + 1)
    }
  }

  const roots = childrenOf.get(null) ?? []
  let total: Decimal = ZERO
  for (const root of roots) {
    emit(root, 0)
    total = total.plus(totals.get(root.id) ?? ZERO)
  }

  return { lines, total }
}

/**
 * Account code order, numerically where both codes are numeric.
 *
 * A chart numbered 100, 200, … 1000 sorts as 100, 1000, 200 under a plain string
 * comparison, which puts a group's children in an order the user did not choose and
 * cannot correct. Codes are text — they may be `1200-A` — so the comparison falls back
 * to string order when either side is not a plain number.
 */
function byCode(a: ReportAccount, b: ReportAccount): number {
  const left = Number(a.code)
  const right = Number(b.code)
  if (a.code.trim() !== '' && b.code.trim() !== '' && !isNaN(left) && !isNaN(right)) {
    if (left !== right) return left - right
  }
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0
}

/**
 * The profit sitting in the ledger that no year-end close has moved yet.
 *
 * The accounting equation only closes with this in it. Summing every line's
 * `debit - credit` gives zero because every entry balances, and regrouping by type turns
 * that into `assets = liabilities + equity + (income - expenses)`. The last bracket is
 * this figure, and a balance sheet without it is short by exactly the profit.
 *
 * Cumulative from inception needs no special case: a year-end close moves each closed
 * year into retained earnings, which is equity, and leaves income and expenses at zero.
 * Whatever is left in them is therefore the profit since the last close, which is what
 * belongs on the face of the sheet.
 */
export function profitInEquity(income: Decimal, expenses: Decimal): Decimal {
  return income.minus(expenses)
}
