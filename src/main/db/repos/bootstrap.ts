/*
 * Setting up a new company's books.
 *
 * The chart of accounts, the first fiscal periods and a numbering series per kind, in ONE
 * transaction. All of it or none of it, and this is the whole reason the file exists.
 *
 * A company with accounts and no periods looks finished and is not: every posting fails
 * with `NO_PERIOD`, and the user is left with a chart of accounts they cannot use and no
 * indication of what is missing. A company with periods and no accounts is the same
 * failure wearing different clothes. Seeding them separately means a crash between the
 * two leaves exactly that, and nothing afterwards would detect it — which is why batch
 * 1.1A deliberately left the wiring alone until both halves existed.
 *
 * WHY TWO FISCAL YEARS. A company created in March would otherwise be unable to date
 * anything into the year starting the following month, which is the single most likely
 * thing a user does in their first session in March. Twenty-four rows costs nothing.
 * Beyond that, `ensureFiscalYear` extends the books on demand.
 *
 * THE NUMBERING SERIES JOINED IN 0012, AND IT WAS A BUG THAT THEY HAD NOT. Nothing
 * created one anywhere, so `defaultSeriesFor` answered null for every kind and issuing
 * any document from the app failed with `SERIES_NOT_CONFIGURED` — a company with a chart
 * and periods that looks finished and is not, which is the exact failure the paragraph
 * above describes, sitting in this file the whole time. Found by building a company file
 * the way the app builds one and asking it what series it had; every test passed
 * throughout, because a test that issues something creates its own series first.
 *
 * The fiscal-year rule arrives from the tax regime, as everywhere else. Nothing here
 * knows that India runs April to March.
 */

import {
  fiscalYearStartYearOf,
  systemClock,
  today,
  type Clock,
  type FiscalYearRule,
  type PeriodGranularity,
} from '@main/domain/time'

import type { CofferDb } from '../kysely'
import { seedDefaultSeries } from './numbering'
import { generateFiscalYearWithin } from './periods'
import { seedChartWithin } from './seed-chart'
import type { ChartTemplate, TemplateAccount } from './chart-template'

export interface SetUpBooksOptions {
  /** From the company's tax regime. */
  rule: FiscalYearRule
  /** Defaults to the general small-business chart. */
  template?: ChartTemplate
  /**
   * Accounts beyond the template — in practice the tax component accounts, one per
   * component the regime levies, built by `taxAccountsFor`. The caller supplies them
   * because the template knows nothing of any regime and this module knows nothing of
   * any tax.
   */
  extraAccounts?: readonly TemplateAccount[]
  /** Months or quarters. Months unless the caller says otherwise. */
  granularity?: PeriodGranularity
  /**
   * How many fiscal years to generate, starting with the one containing today. Two, so
   * that a company created in the last month of a year can still date into the next.
   */
  years?: number
  /** Injected in tests, so "which fiscal year is it" is not a fact about the wall clock. */
  clock?: Clock
}

export interface SetUpBooksResult {
  accountsCreated: number
  rolesMapped: number
  /** The fiscal years generated, by the calendar year each starts in. */
  fiscalYears: number[]
  periodsCreated: number
  /** One per numbered kind, unless the books already had one. */
  seriesCreated: number
}

/**
 * Write a new company's opening state.
 *
 * Runs against an empty database and refuses one that already has a chart — seeding
 * twice would produce a second set of groups with clashing codes, and the roles would
 * silently repoint at the newer ones.
 */
export async function setUpBooks(
  db: CofferDb,
  options: SetUpBooksOptions,
): Promise<SetUpBooksResult> {
  const years = options.years ?? 2
  const firstYear = fiscalYearStartYearOf(options.rule, today(options.clock ?? systemClock))

  return db.transaction().execute(async (trx) => {
    const chart = await seedChartWithin(trx, {
      template: options.template,
      extraAccounts: options.extraAccounts,
    })

    const fiscalYears: number[] = []
    let periodsCreated = 0
    for (let offset = 0; offset < years; offset += 1) {
      const startYear = firstYear + offset
      const periods = await generateFiscalYearWithin(trx, {
        rule: options.rule,
        startYear,
        granularity: options.granularity,
      })
      fiscalYears.push(startYear)
      periodsCreated += periods.length
    }

    const seriesCreated = await seedDefaultSeries(trx)

    return {
      accountsCreated: chart.accountsCreated,
      rolesMapped: chart.rolesMapped,
      fiscalYears,
      periodsCreated,
      seriesCreated,
    }
  })
}

/** True when this company has been set up. Cheap enough to call on every open. */
export async function booksAreSetUp(db: CofferDb): Promise<boolean> {
  const account = await db.selectFrom('accounts').select('id').executeTakeFirst()
  return account !== undefined
}
