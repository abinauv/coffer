/*
 * The chart of accounts.
 *
 * A tree of accounts, plus the role mapping that lets a posting rule ask for "where
 * receivables go" instead of naming code 1100. Reads return the DTO shape from
 * `@shared/dto`; the domain gets `AccountRef`s through `buildResolver`.
 *
 * WHAT IS COMPUTED AND NEVER STORED. `depth` and `normalBalance` are derived on read.
 * Depth is a fact about the tree, not about the row, and a stored depth is wrong the
 * moment an account is moved. Normal balance is a fact about the type, and storing it
 * would let a row exist claiming an asset increases on credit.
 *
 * ORDERING. Siblings sort by code, so the tree reads the way a chart of accounts is
 * conventionally printed. Sorting happens here rather than in SQL because the order is
 * a tree walk, not a column.
 */

import { randomUUID } from 'node:crypto'

import { sql } from 'kysely'

import { normalBalanceOf, type AccountRef, type AccountResolver } from '@main/domain/ledger'
import type { Account, AccountType, CreateAccountInput, UpdateAccountInput } from '@shared/dto'

import type { CofferDb } from '../kysely'
import type { AccountsTable } from '../schema'
import { RepoError, repoErrorFrom } from './errors'

type AccountRow = AccountsTable

/** A node as it comes back from the database, before the tree walk adds depth. */
interface LoadedAccount extends AccountRef {
  parentId: string | null
  isGroup: boolean
  isArchived: boolean
  description: string | null
}

function toLoaded(row: AccountRow): LoadedAccount {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    parentId: row.parent_id,
    isGroup: row.is_group === 1,
    isArchived: row.is_archived === 1,
    description: row.description,
  }
}

// ---- Reading ---------------------------------------------------------------

export interface ListAccountsOptions {
  /** Include archived accounts. Off by default — a picker should not offer them. */
  includeArchived?: boolean
}

/**
 * Every account, in tree order: a parent immediately followed by its subtree, siblings
 * by code.
 *
 * Returned flat with a `depth` rather than nested, because every consumer either
 * indents a list or filters it, and a nested shape makes both harder than the flat one
 * makes rendering a tree.
 *
 * Archived accounts keep their place in the tree when included. A group whose children
 * are all archived is still shown — it has history, and hiding it would leave a hole in
 * a report that footed correctly a moment ago.
 */
export async function listAccounts(
  db: CofferDb,
  options: ListAccountsOptions = {},
): Promise<Account[]> {
  const rows = await db.selectFrom('accounts').selectAll().execute()
  const roles = await loadRoles(db)
  const loaded = rows.map(toLoaded)

  const visible = options.includeArchived === true ? loaded : loaded.filter((a) => !a.isArchived)

  return walkTree(visible, roles)
}

/** One account, or null. Archived or not — `getAccount` never hides anything. */
export async function getAccount(db: CofferDb, id: string): Promise<Account | null> {
  const row = await db.selectFrom('accounts').selectAll().where('id', '=', id).executeTakeFirst()
  if (row === undefined) {
    return null
  }
  const roles = await loadRoles(db)
  const depth = await depthOf(db, row.parent_id)
  return toDto(toLoaded(row), depth, roles)
}

/**
 * Walk the tree depth-first, assigning depth and collecting roles.
 *
 * An account whose parent is not in `accounts` — because the parent was archived and
 * archived accounts were filtered out — is treated as a root rather than dropped.
 * Dropping it would silently remove real figures from a report; showing it at the top
 * level shows everything and makes the situation visible.
 */
function walkTree(accounts: LoadedAccount[], roles: Map<string, string[]>): Account[] {
  const byParent = new Map<string | null, LoadedAccount[]>()
  const present = new Set(accounts.map((account) => account.id))

  for (const account of accounts) {
    const key = account.parentId !== null && present.has(account.parentId) ? account.parentId : null
    const siblings = byParent.get(key)
    if (siblings === undefined) {
      byParent.set(key, [account])
    } else {
      siblings.push(account)
    }
  }

  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }))
  }

  const ordered: Account[] = []
  const visit = (parentId: string | null, depth: number): void => {
    for (const account of byParent.get(parentId) ?? []) {
      ordered.push(toDto(account, depth, roles))
      visit(account.id, depth + 1)
    }
  }
  visit(null, 0)
  return ordered
}

function toDto(account: LoadedAccount, depth: number, roles: Map<string, string[]>): Account {
  return {
    id: account.id,
    code: account.code,
    name: account.name,
    type: account.type,
    normalBalance: normalBalanceOf(account.type),
    parentId: account.parentId,
    isGroup: account.isGroup,
    isArchived: account.isArchived,
    description: account.description,
    depth,
    roles: roles.get(account.id) ?? [],
  }
}

async function depthOf(db: CofferDb, parentId: string | null): Promise<number> {
  let depth = 0
  let current = parentId
  /* Bounded by the tree, and the tree cannot cycle — `assertNoCycle` is what keeps that
   * true, and the bound below is the belt to its braces. */
  while (current !== null && depth < MAX_DEPTH) {
    const parent = await db
      .selectFrom('accounts')
      .select('parent_id')
      .where('id', '=', current)
      .executeTakeFirst()
    if (parent === undefined) {
      break
    }
    current = parent.parent_id
    depth += 1
  }
  return depth
}

/** Deep enough for any real chart of accounts, shallow enough to bound a walk. */
const MAX_DEPTH = 32

// ---- Writing ---------------------------------------------------------------

export async function createAccount(db: CofferDb, input: CreateAccountInput): Promise<Account> {
  const code = input.code.trim()
  const name = input.name.trim()

  await assertCodeFree(db, code, null)
  const parent = await requireParent(db, input.parentId, input.type)

  const now = new Date().toISOString()
  const id = randomUUID()

  try {
    await db
      .insertInto('accounts')
      .values({
        id,
        code,
        name,
        type: input.type,
        parent_id: parent?.id ?? null,
        is_group: input.isGroup ? 1 : 0,
        is_archived: 0,
        description: input.description?.trim() ?? null,
        created_at: now,
        updated_at: now,
      })
      .execute()
  } catch (error) {
    throw repoErrorFrom(error, 'ACCOUNT_CODE_TAKEN')
  }

  const created = await getAccount(db, id)
  if (created === null) {
    /* Unreachable: the insert above succeeded inside the same connection. */
    throw new RepoError('ACCOUNT_NOT_FOUND', 'The account vanished immediately after creation.')
  }
  return created
}

/**
 * Change what may be changed.
 *
 * `type` is absent from the input on purpose. Every figure already posted to an account
 * was classified by its type, so changing it silently reclassifies history — a balance
 * that was on the balance sheet yesterday appears on the profit and loss today, and
 * nothing in the books records that it moved. Create the account you meant and move the
 * balance across with a journal, which leaves a trail.
 */
export async function updateAccount(db: CofferDb, input: UpdateAccountInput): Promise<Account> {
  const existing = await db
    .selectFrom('accounts')
    .selectAll()
    .where('id', '=', input.id)
    .executeTakeFirst()
  if (existing === undefined) {
    throw new RepoError('ACCOUNT_NOT_FOUND', 'That account is not in this chart of accounts.', {
      id: input.id,
    })
  }

  const changes: Partial<AccountRow> = { updated_at: new Date().toISOString() }

  if (input.code !== undefined) {
    const code = input.code.trim()
    await assertCodeFree(db, code, input.id)
    changes.code = code
  }
  if (input.name !== undefined) {
    changes.name = input.name.trim()
  }
  if (input.description !== undefined) {
    changes.description = input.description?.trim() ?? null
  }
  if (input.isArchived !== undefined) {
    if (input.isArchived && existing.is_archived === 0) await assertFillsNoRole(db, input.id)
    changes.is_archived = input.isArchived ? 1 : 0
  }
  if (input.parentId !== undefined) {
    const parent = await requireParent(db, input.parentId, existing.type)
    await assertNoCycle(db, input.id, parent?.id ?? null)
    changes.parent_id = parent?.id ?? null
  }

  try {
    await db.updateTable('accounts').set(changes).where('id', '=', input.id).execute()
  } catch (error) {
    throw repoErrorFrom(error, 'ACCOUNT_CODE_TAKEN')
  }

  const updated = await getAccount(db, input.id)
  if (updated === null) {
    /* Unreachable: the row was read at the top of this function. */
    throw new RepoError('ACCOUNT_NOT_FOUND', 'The account vanished during the update.')
  }
  return updated
}

/**
 * Remove an account entirely.
 *
 * Only ever possible for one nothing refers to. An account that has been posted to is
 * removed by archiving it, not by deleting it — the postings are the books, and a
 * dangling account id in them would be unrecoverable.
 *
 * `journal_lines.account_id` is `ON DELETE RESTRICT` as well, so the posting check below
 * is the sentence rather than the enforcement. It is here because "FOREIGN KEY
 * constraint failed" does not tell somebody that the answer is to archive it instead.
 */
export async function deleteAccount(db: CofferDb, id: string): Promise<void> {
  const children = await db
    .selectFrom('accounts')
    .select('id')
    .where('parent_id', '=', id)
    .executeTakeFirst()
  if (children !== undefined) {
    throw new RepoError(
      'ACCOUNT_HAS_CHILDREN',
      'This group still holds accounts. Move them to another group first.',
      { id },
    )
  }

  const posting = await db
    .selectFrom('journal_lines')
    .select('id')
    .where('account_id', '=', id)
    .executeTakeFirst()
  if (posting !== undefined) {
    throw new RepoError(
      'ACCOUNT_IN_USE',
      'This account has been posted to. Archive it instead — the postings are the books.',
      { id },
    )
  }

  await assertFillsNoRole(db, id)

  const result = await db.deleteFrom('accounts').where('id', '=', id).executeTakeFirst()
  if (result.numDeletedRows === 0n) {
    throw new RepoError('ACCOUNT_NOT_FOUND', 'That account is not in this chart of accounts.', {
      id,
    })
  }
}

// ---- Roles -----------------------------------------------------------------

/**
 * Refuses to take an account out of use while the software depends on it.
 *
 * Deleting one that fills a role was always refused. ARCHIVING ONE WAS NOT, and it is the
 * same break reached by the reversible door: an archived account accepts no posting, so
 * archiving the receivables account would make every invoice fail to issue with a sentence
 * about an account nobody on the invoice screen can see. Once the chart of accounts could
 * archive (5c), that door was a click away.
 */
async function assertFillsNoRole(db: CofferDb, id: string): Promise<void> {
  const role = await db
    .selectFrom('account_roles')
    .select('role')
    .where('account_id', '=', id)
    .executeTakeFirst()
  if (role !== undefined) {
    throw new RepoError(
      'ACCOUNT_IN_USE',
      'The software posts through this account, and no screen can move that to another account yet, so it cannot be archived.',
      { id, role: role.role },
    )
  }
}

async function loadRoles(db: CofferDb): Promise<Map<string, string[]>> {
  const rows = await db.selectFrom('account_roles').select(['role', 'account_id']).execute()
  const byAccount = new Map<string, string[]>()
  for (const row of rows) {
    const existing = byAccount.get(row.account_id)
    if (existing === undefined) {
      byAccount.set(row.account_id, [row.role])
    } else {
      existing.push(row.role)
    }
  }
  for (const roles of byAccount.values()) {
    roles.sort()
  }
  return byAccount
}

/** Point a semantic slot at an account, replacing whatever filled it before. */
export async function setAccountRole(db: CofferDb, role: string, accountId: string): Promise<void> {
  const account = await db
    .selectFrom('accounts')
    .select(['id', 'is_group', 'is_archived'])
    .where('id', '=', accountId)
    .executeTakeFirst()
  if (account === undefined) {
    throw new RepoError('ACCOUNT_NOT_FOUND', 'That account is not in this chart of accounts.', {
      accountId,
    })
  }
  if (account.is_group === 1) {
    throw new RepoError(
      'ACCOUNT_IS_GROUP',
      'A group totals the accounts inside it and holds nothing itself. Choose one of those accounts.',
      {
        accountId,
      },
    )
  }
  if (account.is_archived === 1) {
    throw new RepoError(
      'ACCOUNT_ARCHIVED',
      'An archived account accepts nothing new. Put it back in use from Accounts → Chart of accounts first.',
      {
        accountId,
      },
    )
  }

  const now = new Date().toISOString()
  try {
    await db
      .insertInto('account_roles')
      .values({ role, account_id: accountId, updated_at: now })
      .onConflict((conflict) =>
        conflict.column('role').doUpdateSet({ account_id: accountId, updated_at: now }),
      )
      .execute()
  } catch (error) {
    throw repoErrorFrom(error, 'ACCOUNT_NOT_FOUND')
  }
}

/** Leave a slot unfilled. A rule asking for it then fails with `ROLE_UNMAPPED`. */
export async function clearAccountRole(db: CofferDb, role: string): Promise<void> {
  await db.deleteFrom('account_roles').where('role', '=', role).execute()
}

// ---- The resolver ----------------------------------------------------------

/**
 * Load the whole chart into an `AccountResolver` for the domain to use.
 *
 * One read, then pure lookups. A posting rule runs in `domain/` and must not reach a
 * database, so everything it could ask for is fetched first. A chart of accounts is a
 * few hundred rows at most — loading it whole costs less than the round trips would.
 *
 * Archived accounts are included. A rule posting to an archived account should fail
 * with `ACCOUNT_ARCHIVED`, which it cannot do if the resolver pretends the account was
 * never there.
 */
export async function buildResolver(db: CofferDb): Promise<AccountResolver> {
  const rows = await db.selectFrom('accounts').selectAll().execute()
  const roleRows = await db.selectFrom('account_roles').select(['role', 'account_id']).execute()

  const byId = new Map<string, AccountRef>()
  const byCode = new Map<string, AccountRef>()
  for (const row of rows) {
    const ref: AccountRef = { id: row.id, code: row.code, name: row.name, type: row.type }
    byId.set(ref.id, ref)
    byCode.set(ref.code.toLowerCase(), ref)
  }

  const byRole = new Map<string, AccountRef>()
  for (const row of roleRows) {
    const ref = byId.get(row.account_id)
    if (ref !== undefined) {
      byRole.set(row.role, ref)
    }
  }

  return {
    byId: (id) => byId.get(id) ?? null,
    byCode: (code) => byCode.get(code.toLowerCase()) ?? null,
    forRole: (role) => byRole.get(role) ?? null,
    /*
     * Tax component accounts are looked up by role name, built from the component code
     * the regime supplied: 'tax-output-cgst', 'tax-input-igst'. The regime's vocabulary
     * reaches the database as data and never as a type — which is what keeps `CGST` out
     * of `domain/` while still letting each component have its own account.
     */
    forTaxComponent: (componentCode, direction) =>
      byRole.get(taxRoleName(componentCode, direction)) ?? null,
  }
}

/**
 * The role name a tax component's account is mapped under.
 *
 * Typed as a template literal rather than as `string`, so a tax role is distinguishable
 * from an arbitrary one at the type level and `TemplateAccount.role` can admit these
 * without opening itself to every string in the language. The regime's vocabulary still
 * reaches the database as data — `componentCode` is whatever the regime said.
 */
export type TaxAccountRole = `tax-${'output' | 'input'}-${string}`

export function taxRoleName(componentCode: string, direction: 'output' | 'input'): TaxAccountRole {
  return `tax-${direction}-${componentCode.toLowerCase()}`
}

// ---- Guards ----------------------------------------------------------------

/**
 * Refuse a code another account already holds, ignoring case.
 *
 * `COLLATE NOCASE` rather than a plain comparison, matching the unique index exactly. A
 * case-sensitive check here would leave the index as the only thing catching `CASH`
 * against `cash` — and the index reports a constraint name, not the code that clashed.
 */
async function assertCodeFree(db: CofferDb, code: string, exceptId: string | null): Promise<void> {
  let query = db
    .selectFrom('accounts')
    .select(['id', 'code'])
    .where((eb) => eb(sql<string>`code COLLATE NOCASE`, '=', code))
  if (exceptId !== null) {
    query = query.where('id', '!=', exceptId)
  }
  const clash = await query.executeTakeFirst()
  if (clash !== undefined) {
    throw new RepoError(
      'ACCOUNT_CODE_TAKEN',
      `Account code ${clash.code} is already in use. Choose another code.`,
      {
        code,
        existingCode: clash.code,
      },
    )
  }
}

/**
 * Check a proposed parent and return it, or null for a root account.
 *
 * The two rules — a parent must be a group, and a child carries its parent's type — are
 * also triggers in migration 0002. Checked here as well so the caller gets a sentence
 * rather than a constraint name.
 */
async function requireParent(
  db: CofferDb,
  parentId: string | null,
  type: AccountType,
): Promise<{ id: string } | null> {
  if (parentId === null) {
    return null
  }
  const parent = await db
    .selectFrom('accounts')
    .select(['id', 'type', 'is_group'])
    .where('id', '=', parentId)
    .executeTakeFirst()
  if (parent === undefined) {
    throw new RepoError('ACCOUNT_PARENT_NOT_FOUND', 'That parent account does not exist.', {
      parentId,
    })
  }
  if (parent.is_group === 0) {
    throw new RepoError(
      'ACCOUNT_PARENT_NOT_GROUP',
      'Only a group can hold other accounts. Make the parent a group first.',
      { parentId },
    )
  }
  if (parent.type !== type) {
    throw new RepoError(
      'ACCOUNT_TYPE_MISMATCH',
      `A ${type} account cannot sit under a ${parent.type} group.`,
      { parentId, type, parentType: parent.type },
    )
  }
  return { id: parent.id }
}

/**
 * Refuse a move that would make an account a descendant of itself.
 *
 * SQL catches only the one-step case (`parent_id <> id`); a three-account loop needs a
 * walk. A cycle here is not a wrong number — it is a report that never terminates.
 */
async function assertNoCycle(
  db: CofferDb,
  accountId: string,
  newParentId: string | null,
): Promise<void> {
  let current = newParentId
  let steps = 0
  while (current !== null) {
    if (current === accountId) {
      throw new RepoError(
        'ACCOUNT_CYCLE',
        'That would put the account inside one of its own children.',
        { accountId, newParentId },
      )
    }
    if (steps >= MAX_DEPTH) {
      /* Already cyclic, or deeper than any real chart. Either way, refuse the move. */
      throw new RepoError('ACCOUNT_CYCLE', 'The account tree is too deep to move within.', {
        accountId,
      })
    }
    const parent = await db
      .selectFrom('accounts')
      .select('parent_id')
      .where('id', '=', current)
      .executeTakeFirst()
    if (parent === undefined) {
      return
    }
    current = parent.parent_id
    steps += 1
  }
}
