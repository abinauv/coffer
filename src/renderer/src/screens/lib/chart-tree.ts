/*
 * Filtering and reading the chart of accounts.
 *
 * `ledger.listAccounts` returns the tree already flattened and in order, each row
 * carrying its depth — so the screen indents a list rather than walking a structure. What
 * is left is search, and search over a tree has one rule worth stating:
 *
 *   A MATCH KEEPS ITS ANCESTORS. Showing `Bank Account` without `Current Assets` above it
 *   leaves the reader unable to tell where in the chart it sits, and the indentation
 *   would be a lie — a row indented twice under nothing. Ancestors are shown even when
 *   they do not match, which is why they are marked so the screen can grey them.
 */

import type { Account } from '@shared/dto'

export interface ChartRow {
  account: Account
  /** False for a row kept only because something beneath it matched. */
  isMatch: boolean
}

/**
 * The rows to show for a search.
 *
 * An empty query returns everything, matching nothing — nothing is highlighted when
 * nothing was asked for.
 */
export function filterChart(accounts: readonly Account[], query: string): ChartRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') {
    return accounts.map((account) => ({ account, isMatch: false }))
  }

  const byId = new Map(accounts.map((account) => [account.id, account]))
  const keep = new Set<string>()
  const matched = new Set<string>()

  for (const account of accounts) {
    if (!matchesAccount(account, needle)) continue
    matched.add(account.id)

    /* The account, then every ancestor up to the root. Bounded by the tree, and the
     * `seen` set means a cycle could not loop forever even if one existed. */
    const seen = new Set<string>()
    let current: Account | undefined = account
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id)
      keep.add(current.id)
      current = current.parentId === null ? undefined : byId.get(current.parentId)
    }
  }

  return accounts
    .filter((account) => keep.has(account.id))
    .map((account) => ({ account, isMatch: matched.has(account.id) }))
}

function matchesAccount(account: Account, needle: string): boolean {
  return (
    account.code.toLowerCase().includes(needle) ||
    account.name.toLowerCase().includes(needle) ||
    account.roles.some((role) => role.toLowerCase().includes(needle))
  )
}

/**
 * Accounts a new one may be created under: groups only, and never an archived one.
 *
 * A leaf cannot hold children — nesting under one makes it both a figure and a total, and
 * every roll-up above double-counts it. The database refuses it too; offering it in a
 * picker would just mean showing the user an error they could not have avoided.
 */
export function possibleParents(accounts: readonly Account[]): Account[] {
  return accounts.filter((account) => account.isGroup && !account.isArchived)
}

/**
 * Parents a new account of this type may sit under.
 *
 * A child carries its parent's type, so the list narrows as soon as the type is chosen.
 * An empty result is a real answer — a chart with no income group has nowhere to put a
 * new income account until one is made.
 */
export function parentsForType(accounts: readonly Account[], type: string): Account[] {
  return possibleParents(accounts).filter((account) => account.type === type)
}

/** How a row is labelled for a screen reader and a picker: '1210 · Bank Account'. */
export function accountLabel(account: Account): string {
  return `${account.code} · ${account.name}`
}

/** Every account that may take a posting: leaves, not archived. */
export function postableAccounts(accounts: readonly Account[]): Account[] {
  return accounts.filter((account) => !account.isGroup && !account.isArchived)
}
