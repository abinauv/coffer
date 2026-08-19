/*
 * The open company's books — the one seam every service above the repositories needs.
 *
 * Repositories take a `CofferDb`. Exactly one company is open at a time and it is the
 * companies module that knows which, so a service has to ask on every call rather than
 * hold a handle: a cached one would outlive a `close()` and write into a company the
 * user believes they have shut.
 *
 * WHY THIS IS ITS OWN FILE. It began as two private methods on `LedgerService`, and the
 * note beside them argued — correctly — against a second service copying them, because
 * two answers to "which company is open" ends with one of them stale. Phase 2 makes that
 * argument load-bearing rather than theoretical: parties, items, numbering and documents
 * are four more services that need the same fifteen lines. So the seam is extracted once
 * and composed, and there is still exactly one place that resolves the handle.
 *
 * It is a class rather than a function returning a closure only because the Kysely
 * wrapper is memoised on the handle, and that cache is state. The wrapper is a type
 * layer over the connection rather than a second connection (see db/kysely.ts), so
 * rebuilding it per call would be waste; keying the cache on the handle is what makes it
 * correct across a close and reopen.
 */

import type { SqliteDatabase } from '../db/connection'
import { createQueryBuilder, type CofferDb } from '../db/kysely'
import { METADATA_KEYS, readMetadata } from '../companies/metadata'
import { CompanyError } from '../companies/errors'
import { DEFAULT_REGIME_ID, findRegime, type TaxRegime } from '../regimes'

/**
 * What a service needs from the companies module.
 *
 * Deliberately one method rather than the whole `CompanyService`: nothing above the
 * repositories has any business opening, closing or backing up anything.
 */
export interface OpenCompanyHandle {
  /** The open company's database handle, or null when none is open. */
  currentDatabase(): SqliteDatabase | null
}

export class OpenBooks {
  private readonly companies: OpenCompanyHandle

  /** Keyed on the handle, so a close and reopen gets a fresh builder. */
  private cached: { connection: SqliteDatabase; db: CofferDb } | null = null

  constructor(companies: OpenCompanyHandle) {
    this.companies = companies
  }

  /**
   * The open company's books.
   *
   * @throws CompanyError `NO_COMPANY_OPEN`
   */
  db(): CofferDb {
    const connection = this.connection()
    if (this.cached?.connection !== connection) {
      this.cached = { connection, db: createQueryBuilder(connection) }
    }
    return this.cached.db
  }

  /**
   * The regime the open company's books were set up under.
   *
   * Read from the file, not from the default. The fiscal periods on disk were generated
   * from this rule; closing a year under a different one would use the wrong dates and
   * produce a plausible, wrong figure. The same argument applies to a registration
   * number: what counts as a valid one is a property of the books, not of the build.
   *
   * @throws CompanyError `NO_COMPANY_OPEN`, `COMPANY_REGIME_UNKNOWN`
   */
  regime(): TaxRegime {
    const connection = this.connection()

    /* Companies created before the regime was recorded fall back to the default, which
     * is what they were necessarily created under — it was the only one. */
    const id = readMetadata(connection, METADATA_KEYS.regimeId) ?? DEFAULT_REGIME_ID
    const regime = findRegime(id)
    if (regime === undefined) {
      throw new CompanyError(
        'COMPANY_REGIME_UNKNOWN',
        `These books were set up under a tax regime called ${JSON.stringify(id)}, which this ` +
          'build does not have. A newer version of Coffer will open them.',
      )
    }
    return regime
  }

  private connection(): SqliteDatabase {
    const connection = this.companies.currentDatabase()
    if (connection === null) {
      throw new CompanyError('NO_COMPANY_OPEN', 'Open a company first.')
    }
    return connection
  }
}
