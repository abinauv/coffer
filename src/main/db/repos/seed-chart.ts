/*
 * Seeding a new company's chart of accounts.
 *
 * Runs once, at creation, inside one transaction. A half-seeded chart — groups but no
 * leaves, or accounts but no roles — is worse than no chart at all, because it looks
 * finished.
 */

import { RepoError } from './errors'
import { createAccount, setAccountRole } from './accounts'
import { SMALL_BUSINESS_CHART, type ChartTemplate, type TemplateAccount } from './chart-template'
import type { CofferDb } from '../kysely'

export interface SeedChartOptions {
  /** Defaults to the general small-business chart. */
  template?: ChartTemplate
  /**
   * Accounts to add beyond the template — in practice the tax component accounts, one
   * per component the company's regime levies, parented on the `Duties and Taxes`
   * group. Supplied by the caller because the template knows nothing of any regime.
   */
  extraAccounts?: readonly TemplateAccount[]
}

export interface SeedChartResult {
  templateId: string
  accountsCreated: number
  rolesMapped: number
}

/**
 * Write a template into an empty chart of accounts.
 *
 * Refuses a chart that already has accounts in it. Seeding twice would produce a second
 * set of groups with clashing codes, and the roles would silently repoint at the newer
 * ones — so the first invoice would post to a different account from the one the trial
 * balance was reconciled against.
 */
export async function seedChart(
  db: CofferDb,
  options: SeedChartOptions = {},
): Promise<SeedChartResult> {
  return db.transaction().execute((trx) => seedChartWithin(trx, options))
}

/**
 * The same work, for a caller that already has a transaction open.
 *
 * `setUpBooks` needs the chart and the first fiscal periods to land together — a company
 * with accounts and nowhere to post them is exactly as unusable as one with neither — so
 * it opens one transaction and calls this. Kept as a separate export rather than nesting
 * `seedChart` inside another transaction, because that would rely on savepoint semantics
 * where a plain function call is unambiguous.
 */
export async function seedChartWithin(
  trx: CofferDb,
  options: SeedChartOptions = {},
): Promise<SeedChartResult> {
  const template = options.template ?? SMALL_BUSINESS_CHART
  const accounts = [...template.accounts, ...(options.extraAccounts ?? [])]

  const existing = await trx.selectFrom('accounts').select('id').executeTakeFirst()
  if (existing !== undefined) {
    throw new RepoError(
      'ACCOUNT_CODE_TAKEN',
      'This company already has a chart of accounts. Seeding again would duplicate it.',
      { templateId: template.id },
    )
  }

  /* Codes are what the template refers to parents by; ids are what the database uses.
   * Built as we go, which is why a parent must appear before its children. */
  const idByCode = new Map<string, string>()
  let rolesMapped = 0

  for (const account of accounts) {
    let parentId: string | null = null
    if (account.parentCode !== null) {
      const found = idByCode.get(account.parentCode)
      if (found === undefined) {
        throw new RepoError(
          'ACCOUNT_PARENT_NOT_FOUND',
          `Template ${template.id} places ${account.code} under ${account.parentCode}, ` +
            'which it has not defined yet. A parent must come before its children.',
          { code: account.code, parentCode: account.parentCode },
        )
      }
      parentId = found
    }

    const created = await createAccount(trx, {
      code: account.code,
      name: account.name,
      type: account.type,
      parentId,
      isGroup: account.isGroup,
      description: account.description ?? null,
    })
    idByCode.set(account.code, created.id)

    if (account.role !== undefined) {
      await setAccountRole(trx, account.role, created.id)
      rolesMapped += 1
    }
  }

  return { templateId: template.id, accountsCreated: accounts.length, rolesMapped }
}
