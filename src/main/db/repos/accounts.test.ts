/*
 * Against a real encrypted database, not a mock.
 *
 * The rules being tested here are half in TypeScript and half in SQL triggers, and a
 * mock would only ever exercise the TypeScript half — which is the half that a future
 * caller can bypass. Every test opens a SQLCipher file, migrates it, and puts the rule
 * to the database.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DATABASE_KEY_BYTES, closeDatabase, openDatabase, type SqliteDatabase } from '../connection'
import { createQueryBuilder, type CofferDb } from '../kysely'
import { runMigrations, rollbackMigrations } from '../migrate'
import { MIGRATIONS } from '../migrations'
import type { AccountType } from '@shared/dto'

import {
  buildResolver,
  clearAccountRole,
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  setAccountRole,
  taxRoleName,
  updateAccount,
} from './accounts'
import { isRepoError, type RepoError, type RepoErrorCode } from './errors'
import { SMALL_BUSINESS_CHART } from './chart-template'
import { seedChart } from './seed-chart'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0xa5)

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase
let db: CofferDb

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-accounts-'))
  directories.push(dir)
  connection = openDatabase({ filePath: join(dir, 'company.coffer'), key: KEY })
  handles.push(connection)
  runMigrations(connection, MIGRATIONS)
  db = createQueryBuilder(connection)
})

afterEach(() => {
  for (const handle of handles.splice(0)) {
    try {
      closeDatabase(handle)
    } catch {
      /* a test may have closed it already */
    }
  }
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

/** Run something expected to fail, and return the repo error code it failed with. */
async function codeOf(action: () => Promise<unknown>): Promise<RepoErrorCode | string> {
  try {
    await action()
  } catch (error) {
    return isRepoError(error) ? error.code : `not a RepoError: ${String(error)}`
  }
  return 'no error thrown'
}

/**
 * The whole error, for the tests that need to know *which layer* refused.
 *
 * These rules are enforced twice — once in the repository and again by a trigger — and
 * a test asserting only the code cannot tell the two apart. It was not able to: turning
 * off the repository's type check changed nothing, because the trigger caught it and
 * `repoErrorFrom` mapped the message back to the same code. The difference is in
 * `details`, which only the repository populates, and in a message written as a
 * sentence rather than as a constraint name.
 */
async function failureOf(action: () => Promise<unknown>): Promise<RepoError> {
  try {
    await action()
  } catch (error) {
    if (isRepoError(error)) {
      return error
    }
    throw error
  }
  throw new Error('Expected the action to fail, and it did not.')
}

const rootGroup = (code = '1000', type: AccountType = 'asset') =>
  createAccount(db, { code, name: `Group ${code}`, type, parentId: null, isGroup: true })

describe('migration 0002', () => {
  it('creates the tables and rolls back cleanly', () => {
    const tables = connection
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
      )
      .all()
      .map((row) => row.name)
    expect(tables).toContain('accounts')
    expect(tables).toContain('account_roles')

    rollbackMigrations(connection, MIGRATIONS, { to: '0001' })

    const after = connection
      .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row) => row.name)
    expect(after).not.toContain('accounts')
    expect(after).not.toContain('account_roles')
  })
})

describe('createAccount', () => {
  it('creates a root group', async () => {
    const account = await rootGroup()
    expect(account.code).toBe('1000')
    expect(account.isGroup).toBe(true)
    expect(account.parentId).toBeNull()
    expect(account.depth).toBe(0)
  })

  it('derives the normal balance rather than storing it', async () => {
    const asset = await rootGroup('1000', 'asset')
    const income = await rootGroup('4000', 'income')
    expect(asset.normalBalance).toBe('debit')
    expect(income.normalBalance).toBe('credit')
  })

  it('trims what it is given', async () => {
    const account = await createAccount(db, {
      code: '  1100  ',
      name: '  Cash in Hand  ',
      type: 'asset',
      parentId: null,
      isGroup: false,
    })
    expect(account.code).toBe('1100')
    expect(account.name).toBe('Cash in Hand')
  })

  it('refuses a duplicate code', async () => {
    await rootGroup('1000')
    expect(await codeOf(() => rootGroup('1000'))).toBe('ACCOUNT_CODE_TAKEN')
  })

  /* A chart holding both CASH and cash is one where somebody eventually picks the
   * wrong one, and no report would show it. */
  it('refuses a duplicate code differing only in case', async () => {
    await createAccount(db, {
      code: 'CASH',
      name: 'Cash',
      type: 'asset',
      parentId: null,
      isGroup: false,
    })
    const failure = await failureOf(() =>
      createAccount(db, {
        code: 'cash',
        name: 'Cash again',
        type: 'asset',
        parentId: null,
        isGroup: false,
      }),
    )
    expect(failure.code).toBe('ACCOUNT_CODE_TAKEN')
    /* The repository caught it, not just the unique index — an index reports a
     * constraint name, and this reports the code that clashed and how it is spelled. */
    expect(failure.details).toEqual({ code: 'cash', existingCode: 'CASH' })
  })

  it('refuses a parent that does not exist', async () => {
    expect(
      await codeOf(() =>
        createAccount(db, {
          code: '1100',
          name: 'Orphan',
          type: 'asset',
          parentId: 'nope',
          isGroup: false,
        }),
      ),
    ).toBe('ACCOUNT_PARENT_NOT_FOUND')
  })

  /* Nesting under a leaf makes the leaf both a figure and a total, and every roll-up
   * double-counts it. */
  it('refuses a parent that is a leaf, in the repository and not only the trigger', async () => {
    const leafAccount = await createAccount(db, {
      code: '1100',
      name: 'Cash',
      type: 'asset',
      parentId: null,
      isGroup: false,
    })
    const failure = await failureOf(() =>
      createAccount(db, {
        code: '1110',
        name: 'Petty cash',
        type: 'asset',
        parentId: leafAccount.id,
        isGroup: false,
      }),
    )
    expect(failure.code).toBe('ACCOUNT_PARENT_NOT_GROUP')
    /* `details` is populated only on the repository path; the trigger path has none. */
    expect(failure.details).toEqual({ parentId: leafAccount.id })
    expect(failure.message).toMatch(/group/i)
  })

  /* An asset under an income group would show on the profit and loss and vanish from
   * the balance sheet. */
  it('refuses a child of a different type, in the repository and not only the trigger', async () => {
    const income = await rootGroup('4000', 'income')
    const failure = await failureOf(() =>
      createAccount(db, {
        code: '4100',
        name: 'Wrong',
        type: 'asset',
        parentId: income.id,
        isGroup: false,
      }),
    )
    expect(failure.code).toBe('ACCOUNT_TYPE_MISMATCH')
    expect(failure.details).toEqual({ parentId: income.id, type: 'asset', parentType: 'income' })
    expect(failure.message).toMatch(/asset account cannot sit under a[n]? income group/i)
  })
})

describe('the database enforces the tree rules itself', () => {
  it('rejects a leaf parent even when the repository is bypassed', async () => {
    const leafAccount = await createAccount(db, {
      code: '1100',
      name: 'Cash',
      type: 'asset',
      parentId: null,
      isGroup: false,
    })
    expect(() =>
      connection
        .prepare(
          `INSERT INTO accounts (id, code, name, type, parent_id, is_group, is_archived,
             created_at, updated_at)
           VALUES ('x', '1110', 'Sneaked in', 'asset', ?, 0, 0, '2026-04-01', '2026-04-01')`,
        )
        .run(leafAccount.id),
    ).toThrowError(/ACCOUNT_PARENT_NOT_GROUP/)
  })

  it('rejects a type mismatch even when the repository is bypassed', async () => {
    const income = await rootGroup('4000', 'income')
    expect(() =>
      connection
        .prepare(
          `INSERT INTO accounts (id, code, name, type, parent_id, is_group, is_archived,
             created_at, updated_at)
           VALUES ('x', '4100', 'Sneaked in', 'asset', ?, 0, 0, '2026-04-01', '2026-04-01')`,
        )
        .run(income.id),
    ).toThrowError(/ACCOUNT_TYPE_MISMATCH/)
  })

  it('rejects an account that is its own parent', () => {
    expect(() =>
      connection
        .prepare(
          `INSERT INTO accounts (id, code, name, type, parent_id, is_group, is_archived,
             created_at, updated_at)
           VALUES ('self', '9999', 'Ouroboros', 'asset', 'self', 1, 0, '2026-04-01', '2026-04-01')`,
        )
        .run(),
    ).toThrowError()
  })

  it('rejects a blank code or name', () => {
    expect(() =>
      connection
        .prepare(
          `INSERT INTO accounts (id, code, name, type, parent_id, is_group, is_archived,
             created_at, updated_at)
           VALUES ('b', '   ', 'Blank code', 'asset', NULL, 0, 0, '2026-04-01', '2026-04-01')`,
        )
        .run(),
    ).toThrowError()
  })
})

describe('listAccounts', () => {
  beforeEach(async () => {
    const assets = await rootGroup('1000', 'asset')
    await createAccount(db, {
      code: '1300',
      name: 'Receivables',
      type: 'asset',
      parentId: assets.id,
      isGroup: false,
    })
    await createAccount(db, {
      code: '1100',
      name: 'Cash',
      type: 'asset',
      parentId: assets.id,
      isGroup: false,
    })
    await rootGroup('4000', 'income')
  })

  it('returns a parent immediately followed by its subtree, siblings by code', async () => {
    const accounts = await listAccounts(db)
    expect(accounts.map((a) => a.code)).toEqual(['1000', '1100', '1300', '4000'])
  })

  it('reports depth rather than storing it', async () => {
    const accounts = await listAccounts(db)
    expect(accounts.map((a) => a.depth)).toEqual([0, 1, 1, 0])
  })

  it('hides archived accounts by default and shows them on request', async () => {
    const cash = (await listAccounts(db)).find((a) => a.code === '1100')
    expect(cash).toBeDefined()
    await updateAccount(db, { id: cash?.id ?? '', isArchived: true })

    expect((await listAccounts(db)).map((a) => a.code)).not.toContain('1100')
    expect((await listAccounts(db, { includeArchived: true })).map((a) => a.code)).toContain('1100')
  })

  /* Dropping it would silently remove real figures from a report. Showing it at the top
   * level shows everything, and makes the situation visible. */
  it('promotes an account whose parent is hidden rather than dropping it', async () => {
    const assets = (await listAccounts(db)).find((a) => a.code === '1000')
    await updateAccount(db, { id: assets?.id ?? '', isArchived: true })

    const visible = await listAccounts(db)
    expect(visible.map((a) => a.code)).toEqual(['1100', '1300', '4000'])
    expect(visible.every((a) => a.depth === 0)).toBe(true)
  })
})

describe('updateAccount', () => {
  it('renames and renumbers', async () => {
    const account = await rootGroup('1000')
    const updated = await updateAccount(db, { id: account.id, code: '1001', name: 'Renamed' })
    expect(updated.code).toBe('1001')
    expect(updated.name).toBe('Renamed')
  })

  it('refuses a code another account holds', async () => {
    await rootGroup('1000')
    const other = await rootGroup('2000', 'liability')
    expect(await codeOf(() => updateAccount(db, { id: other.id, code: '1000' }))).toBe(
      'ACCOUNT_CODE_TAKEN',
    )
  })

  it('lets an account keep its own code', async () => {
    const account = await rootGroup('1000')
    const updated = await updateAccount(db, { id: account.id, code: '1000', name: 'Same code' })
    expect(updated.name).toBe('Same code')
  })

  it('moves an account to a new parent', async () => {
    const first = await rootGroup('1000')
    const second = await rootGroup('1500')
    const child = await createAccount(db, {
      code: '1100',
      name: 'Cash',
      type: 'asset',
      parentId: first.id,
      isGroup: false,
    })
    const moved = await updateAccount(db, { id: child.id, parentId: second.id })
    expect(moved.parentId).toBe(second.id)
  })

  /* A cycle is not a wrong number — it is a report that never terminates. */
  it('refuses a move that would make an account its own descendant', async () => {
    const grandparent = await rootGroup('1000')
    const parent = await createAccount(db, {
      code: '1100',
      name: 'Middle',
      type: 'asset',
      parentId: grandparent.id,
      isGroup: true,
    })
    expect(await codeOf(() => updateAccount(db, { id: grandparent.id, parentId: parent.id }))).toBe(
      'ACCOUNT_CYCLE',
    )
  })

  it('refuses to make an account its own parent', async () => {
    const account = await rootGroup('1000')
    expect(await codeOf(() => updateAccount(db, { id: account.id, parentId: account.id }))).toBe(
      'ACCOUNT_CYCLE',
    )
  })

  it('refuses an account that does not exist', async () => {
    expect(await codeOf(() => updateAccount(db, { id: 'nope', name: 'Ghost' }))).toBe(
      'ACCOUNT_NOT_FOUND',
    )
  })
})

describe('deleteAccount', () => {
  it('removes an account nothing refers to', async () => {
    const account = await rootGroup('1000')
    await deleteAccount(db, account.id)
    expect(await getAccount(db, account.id)).toBeNull()
  })

  it('refuses one with children', async () => {
    const parent = await rootGroup('1000')
    await createAccount(db, {
      code: '1100',
      name: 'Cash',
      type: 'asset',
      parentId: parent.id,
      isGroup: false,
    })
    expect(await codeOf(() => deleteAccount(db, parent.id))).toBe('ACCOUNT_HAS_CHILDREN')
  })

  it('refuses one that fills a role', async () => {
    const account = await createAccount(db, {
      code: '1100',
      name: 'Cash',
      type: 'asset',
      parentId: null,
      isGroup: false,
    })
    await setAccountRole(db, 'cash', account.id)
    expect(await codeOf(() => deleteAccount(db, account.id))).toBe('ACCOUNT_IN_USE')
  })

  it('refuses one that is not there', async () => {
    expect(await codeOf(() => deleteAccount(db, 'nope'))).toBe('ACCOUNT_NOT_FOUND')
  })
})

describe('roles', () => {
  let cash: Awaited<ReturnType<typeof createAccount>>
  let bank: Awaited<ReturnType<typeof createAccount>>

  beforeEach(async () => {
    cash = await createAccount(db, {
      code: '1100',
      name: 'Cash',
      type: 'asset',
      parentId: null,
      isGroup: false,
    })
    bank = await createAccount(db, {
      code: '1200',
      name: 'Bank',
      type: 'asset',
      parentId: null,
      isGroup: false,
    })
  })

  it('maps a role to an account and reports it back', async () => {
    await setAccountRole(db, 'cash', cash.id)
    const listed = (await listAccounts(db)).find((a) => a.id === cash.id)
    expect(listed?.roles).toEqual(['cash'])
  })

  it('repoints a role rather than mapping it twice', async () => {
    await setAccountRole(db, 'cash', cash.id)
    await setAccountRole(db, 'cash', bank.id)

    const accounts = await listAccounts(db)
    expect(accounts.find((a) => a.id === cash.id)?.roles).toEqual([])
    expect(accounts.find((a) => a.id === bank.id)?.roles).toEqual(['cash'])
  })

  it('lets one account fill several roles', async () => {
    await setAccountRole(db, 'cash', cash.id)
    await setAccountRole(db, 'bank', cash.id)
    const listed = (await listAccounts(db)).find((a) => a.id === cash.id)
    expect(listed?.roles).toEqual(['bank', 'cash'])
  })

  it('clears a role', async () => {
    await setAccountRole(db, 'cash', cash.id)
    await clearAccountRole(db, 'cash')
    const listed = (await listAccounts(db)).find((a) => a.id === cash.id)
    expect(listed?.roles).toEqual([])
  })

  /* A group is a total. It can no more fill a role than it can take a posting. */
  it('refuses a group', async () => {
    const group = await rootGroup('1000')
    expect(await codeOf(() => setAccountRole(db, 'cash', group.id))).toBe('ACCOUNT_IS_GROUP')
  })

  it('refuses an archived account', async () => {
    await updateAccount(db, { id: cash.id, isArchived: true })
    expect(await codeOf(() => setAccountRole(db, 'cash', cash.id))).toBe('ACCOUNT_ARCHIVED')
  })

  /* The same break as deleting it, through the reversible door: nothing could post there. */
  it('will not archive an account that fills a role', async () => {
    await setAccountRole(db, 'cash', cash.id)
    expect(await codeOf(() => updateAccount(db, { id: cash.id, isArchived: true }))).toBe(
      'ACCOUNT_IN_USE',
    )
    expect((await listAccounts(db)).find((a) => a.id === cash.id)?.isArchived).toBe(false)
  })

  it('still renames an account that fills a role, and restores one that is archived', async () => {
    await setAccountRole(db, 'cash', cash.id)
    expect((await updateAccount(db, { id: cash.id, name: 'Cash in hand' })).name).toBe(
      'Cash in hand',
    )
    await updateAccount(db, { id: bank.id, isArchived: true })
    expect((await updateAccount(db, { id: bank.id, isArchived: false })).isArchived).toBe(false)
  })

  it('refuses an account that does not exist', async () => {
    expect(await codeOf(() => setAccountRole(db, 'cash', 'nope'))).toBe('ACCOUNT_NOT_FOUND')
  })

  it('rejects a group even when the repository is bypassed', async () => {
    const group = await rootGroup('1000')
    expect(() =>
      connection
        .prepare(
          `INSERT INTO account_roles (role, account_id, updated_at)
           VALUES ('cash', ?, '2026-04-01')`,
        )
        .run(group.id),
    ).toThrowError(/ACCOUNT_IS_GROUP/)
  })
})

describe('buildResolver', () => {
  it('looks up by id, by code and by role', async () => {
    const cash = await createAccount(db, {
      code: '1100',
      name: 'Cash',
      type: 'asset',
      parentId: null,
      isGroup: false,
    })
    await setAccountRole(db, 'cash', cash.id)

    const resolver = await buildResolver(db)
    expect(resolver.byId(cash.id)?.code).toBe('1100')
    expect(resolver.byCode('1100')?.id).toBe(cash.id)
    expect(resolver.forRole('cash')?.id).toBe(cash.id)
  })

  it('matches a code regardless of case', async () => {
    await createAccount(db, {
      code: 'CASH',
      name: 'Cash',
      type: 'asset',
      parentId: null,
      isGroup: false,
    })
    const resolver = await buildResolver(db)
    expect(resolver.byCode('cash')?.code).toBe('CASH')
  })

  it('returns null rather than throwing, so the rule decides what is fatal', async () => {
    const resolver = await buildResolver(db)
    expect(resolver.byId('nope')).toBeNull()
    expect(resolver.byCode('nope')).toBeNull()
    expect(resolver.forRole('sales')).toBeNull()
    expect(resolver.forTaxComponent('CGST', 'output')).toBeNull()
  })

  /*
   * The regime's vocabulary reaches the database as data and never as a type. This is
   * what lets each GST component have its own account while `CGST` stays out of
   * domain/ entirely.
   */
  it('finds a tax component account through its role name', async () => {
    const outputCgst = await createAccount(db, {
      code: '2210',
      name: 'Output CGST',
      type: 'liability',
      parentId: null,
      isGroup: false,
    })
    const inputCgst = await createAccount(db, {
      code: '1510',
      name: 'Input CGST',
      type: 'asset',
      parentId: null,
      isGroup: false,
    })
    await setAccountRole(db, taxRoleName('CGST', 'output'), outputCgst.id)
    await setAccountRole(db, taxRoleName('CGST', 'input'), inputCgst.id)

    const resolver = await buildResolver(db)
    expect(resolver.forTaxComponent('CGST', 'output')?.id).toBe(outputCgst.id)
    expect(resolver.forTaxComponent('cgst', 'output')?.id).toBe(outputCgst.id)
    /* Output tax is a liability and input tax is an asset. Never the same account. */
    expect(resolver.forTaxComponent('CGST', 'input')?.id).toBe(inputCgst.id)
  })

  it('includes archived accounts, so posting to one can fail for the right reason', async () => {
    const cash = await createAccount(db, {
      code: '1100',
      name: 'Cash',
      type: 'asset',
      parentId: null,
      isGroup: false,
    })
    await updateAccount(db, { id: cash.id, isArchived: true })
    const resolver = await buildResolver(db)
    expect(resolver.byId(cash.id)).not.toBeNull()
  })
})

describe('seedChart', () => {
  it('writes the whole template and maps its roles', async () => {
    const result = await seedChart(db)
    expect(result.accountsCreated).toBe(SMALL_BUSINESS_CHART.accounts.length)

    const accounts = await listAccounts(db)
    expect(accounts).toHaveLength(SMALL_BUSINESS_CHART.accounts.length)

    const expectedRoles = SMALL_BUSINESS_CHART.accounts.filter((a) => a.role !== undefined).length
    expect(result.rolesMapped).toBe(expectedRoles)
  })

  it('produces a chart every posting rule can resolve against', async () => {
    await seedChart(db)
    const resolver = await buildResolver(db)
    for (const role of ['accounts-receivable', 'sales', 'cash', 'bank', 'round-off'] as const) {
      expect(resolver.forRole(role), `role ${role} should be mapped`).not.toBeNull()
    }
  })

  it('nests children under the right parents, with the right types', async () => {
    await seedChart(db)
    const accounts = await listAccounts(db)
    const byCode = new Map(accounts.map((a) => [a.code, a]))

    const cash = byCode.get('1100')
    const currentAssets = byCode.get('1000')
    expect(cash?.depth).toBe(1)
    expect(cash?.type).toBe('asset')
    expect(cash?.parentId).toBe(currentAssets?.id)
    expect(currentAssets?.isGroup).toBe(true)

    /* Every account carries its parent's type, or the tree rules would have refused it. */
    for (const account of accounts) {
      if (account.parentId !== null) {
        const parent = accounts.find((a) => a.id === account.parentId)
        expect(parent?.type).toBe(account.type)
      }
    }
  })

  it('maps no role to a group', async () => {
    await seedChart(db)
    for (const account of await listAccounts(db)) {
      if (account.isGroup) {
        expect(account.roles).toEqual([])
      }
    }
  })

  /* Seeding twice would produce a second set of groups with clashing codes, and the
   * roles would silently repoint at the newer ones. */
  it('refuses a chart that already has accounts', async () => {
    await seedChart(db)
    expect(await codeOf(() => seedChart(db))).toBe('ACCOUNT_CODE_TAKEN')
  })

  it('adds the extra accounts a caller supplies', async () => {
    await seedChart(db, {
      extraAccounts: [
        {
          code: '2210',
          name: 'Output CGST',
          type: 'liability',
          parentCode: '2200',
          isGroup: false,
        },
      ],
    })
    const accounts = await listAccounts(db)
    expect(accounts.map((a) => a.code)).toContain('2210')
    const cgst = accounts.find((a) => a.code === '2210')
    const duties = accounts.find((a) => a.code === '2200')
    expect(cgst?.parentId).toBe(duties?.id)
  })

  /* A half-seeded chart is worse than no chart, because it looks finished. */
  it('leaves nothing behind when a template is malformed', async () => {
    const code = await codeOf(() =>
      seedChart(db, {
        extraAccounts: [
          {
            code: '9999',
            name: 'Orphan',
            type: 'asset',
            parentCode: 'no-such-parent',
            isGroup: false,
          },
        ],
      }),
    )
    expect(code).toBe('ACCOUNT_PARENT_NOT_FOUND')
    expect(await listAccounts(db)).toHaveLength(0)
  })

  it('has a template whose parents all come before their children', () => {
    const seen = new Set<string>()
    for (const account of SMALL_BUSINESS_CHART.accounts) {
      if (account.parentCode !== null) {
        expect(seen.has(account.parentCode), `${account.code} before ${account.parentCode}`).toBe(
          true,
        )
      }
      seen.add(account.code)
    }
  })

  it('has a template with no duplicate codes', () => {
    const codes = SMALL_BUSINESS_CHART.accounts.map((a) => a.code.toLowerCase())
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('has a template naming no tax regime', () => {
    for (const account of SMALL_BUSINESS_CHART.accounts) {
      expect(`${account.code} ${account.name}`).not.toMatch(/gst|vat|cess/i)
    }
  })
})
