/*
 * The ledger service, against a real company created by the real company service.
 *
 * The point of this file is the seam the repositories cannot test: which database the
 * ledger writes to, and what happens across a close and reopen. Everything the
 * repositories do with a handle they were given is tested against a real database in
 * src/main/db/repos.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CompanyService } from '../companies/service'
import { CompanyError } from '../companies/errors'
import { METADATA_KEYS, writeMetadata } from '../companies/metadata'
import { type Argon2Params, MIN_MEMORY_COST } from '../security'
import { LedgerService } from './service'

const FAST: Argon2Params = {
  algorithm: 'argon2id',
  memoryCost: MIN_MEMORY_COST,
  timeCost: 1,
  parallelism: 1,
}

const PASSPHRASE = 'a quiet ledger keeps its own counsel'

const directories: string[] = []
const services: CompanyService[] = []

interface Fixture {
  companies: CompanyService
  ledger: LedgerService
  companyId: string
}

async function fixture(): Promise<Fixture> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'coffer-ledger-registry-'))
  const companyDirectory = await mkdtemp(join(tmpdir(), 'coffer-ledger-books-'))
  directories.push(dataDirectory, companyDirectory)

  const companies = new CompanyService({
    dataDirectory,
    kdf: { passphrase: FAST, recovery: FAST },
  })
  services.push(companies)

  const created = await companies.create({
    displayName: 'Acme Traders',
    directoryPath: companyDirectory,
    passphrase: PASSPHRASE,
  })

  return { companies, ledger: new LedgerService(companies), companyId: created.company.id }
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.close().catch(() => undefined)
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
  }
})

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof CompanyError) return error.code
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : `unexpected: ${String(error)}`
  }
  return 'did not throw'
}

/** Today, which is inside the fiscal year `create` generated. */
const TODAY = new Date().toISOString().slice(0, 10)

const idOf = async (ledger: LedgerService, code: string): Promise<string> => {
  const accounts = await ledger.listAccounts({})
  const account = accounts.find((candidate) => candidate.code === code)
  if (account === undefined) throw new Error(`no account ${code} in the seeded chart`)
  return account.id
}

describe('reading the open company', () => {
  it('sees the chart the company was created with', async () => {
    const { ledger } = await fixture()
    const accounts = await ledger.listAccounts({})

    expect(accounts.length).toBeGreaterThan(30)
    expect(accounts.map((account) => account.code)).toContain('1210')
  })

  it('sees the periods the company was created with', async () => {
    const { ledger } = await fixture()
    expect(await ledger.listPeriods()).toHaveLength(24)
  })

  it('reports an empty trial balance that still ties', async () => {
    const { ledger } = await fixture()
    const tb = await ledger.trialBalance({})

    expect(tb.rows).toEqual([])
    expect(tb.balanced).toBe(true)
    expect(tb.totalDebit).toBe('0.00')
  })
})

describe('posting through the service', () => {
  it('posts, reads back, and ties', async () => {
    const { ledger } = await fixture()

    const posted = await ledger.postEntry({
      date: TODAY,
      narration: 'Owner introduces capital',
      lines: [
        { accountId: await idOf(ledger, '1210'), debit: '100000.00', credit: '0.00' },
        { accountId: await idOf(ledger, '3100'), debit: '0.00', credit: '100000.00' },
      ],
    })

    expect(posted.total).toBe('100000.00')
    expect((await ledger.getEntry(posted.entryId))?.entryNumber).toBe(posted.entryNumber)
    expect(await ledger.listEntries({})).toHaveLength(1)
    expect((await ledger.trialBalance({})).balanced).toBe(true)
  })

  it('reverses rather than edits', async () => {
    const { ledger } = await fixture()
    const posted = await ledger.postEntry({
      date: TODAY,
      narration: 'Sale',
      /* A cash sale rather than a credit one. From 0005 a line posting to receivables
       * must name a party, and the service has no way to create one until the parties
       * IPC group lands — which is itself the gap that batch closes. What this test is
       * about is the reversal, and bank is as good an account for that as any. */
      lines: [
        { accountId: await idOf(ledger, '1210'), debit: '5000.00', credit: '0.00' },
        { accountId: await idOf(ledger, '4100'), debit: '0.00', credit: '5000.00' },
      ],
    })

    await ledger.reverseEntry({ entryId: posted.entryId, date: TODAY, narration: 'Cancelled' })

    expect(await ledger.listEntries({})).toHaveLength(2)
    expect((await ledger.getEntry(posted.entryId))?.reversedByEntryId).not.toBeNull()
  })

  it('refuses a posting into a closed period', async () => {
    const { ledger } = await fixture()
    const period = (await ledger.listPeriods()).find(
      (candidate) => TODAY >= candidate.startDate && TODAY <= candidate.endDate,
    )!

    /* Periods close in order, so everything before this one goes first. */
    for (const earlier of await ledger.listPeriods()) {
      if (earlier.startDate <= period.startDate) await ledger.closePeriod(earlier.id)
    }

    expect(
      await codeOf(() =>
        ledger.postEntry({
          date: TODAY,
          narration: 'Too late',
          lines: [
            { accountId: '1', debit: '1.00', credit: '0.00' },
            { accountId: '2', debit: '0.00', credit: '1.00' },
          ],
        }),
      ),
    ).toBe('PERIOD_CLOSED')
  })
})

/*
 * The seam this file exists for. A handle cached across a close would write into a
 * company the user believes they have shut — and on a different company entirely if
 * they then opened another.
 */
describe('which company the ledger writes to', () => {
  it('refuses everything when no company is open', async () => {
    const { companies, ledger } = await fixture()
    await companies.close()

    expect(await codeOf(() => ledger.listAccounts({}))).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => ledger.listPeriods())).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => ledger.trialBalance({}))).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => ledger.closeFiscalYear({ startYear: 2026 }))).toBe('NO_COMPANY_OPEN')
  })

  it('follows the company across a close and reopen', async () => {
    const { companies, ledger, companyId } = await fixture()
    const posted = await ledger.postEntry({
      date: TODAY,
      narration: 'Before the close',
      lines: [
        { accountId: await idOf(ledger, '1210'), debit: '250.00', credit: '0.00' },
        { accountId: await idOf(ledger, '4100'), debit: '0.00', credit: '250.00' },
      ],
    })

    await companies.close()
    await companies.open({ id: companyId, passphrase: PASSPHRASE })

    expect((await ledger.getEntry(posted.entryId))?.total).toBe('250.00')
    expect((await ledger.trialBalance({})).totalDebit).toBe('250.00')
  })

  it('writes into the company that is open now, not the one that was', async () => {
    const { companies, ledger } = await fixture()
    await ledger.postEntry({
      date: TODAY,
      narration: 'In the first company',
      lines: [
        { accountId: await idOf(ledger, '1210'), debit: '111.00', credit: '0.00' },
        { accountId: await idOf(ledger, '4100'), debit: '0.00', credit: '111.00' },
      ],
    })

    const secondDirectory = await mkdtemp(join(tmpdir(), 'coffer-ledger-second-'))
    directories.push(secondDirectory)
    await companies.create({
      displayName: 'Beta Supplies',
      directoryPath: secondDirectory,
      passphrase: PASSPHRASE,
    })

    /* A fresh set of books, and the first company's entry must not be in them. */
    expect(await ledger.listEntries({})).toEqual([])
    expect((await ledger.trialBalance({})).totalDebit).toBe('0.00')

    await ledger.postEntry({
      date: TODAY,
      narration: 'In the second company',
      lines: [
        { accountId: await idOf(ledger, '1210'), debit: '222.00', credit: '0.00' },
        { accountId: await idOf(ledger, '4100'), debit: '0.00', credit: '222.00' },
      ],
    })

    expect((await ledger.trialBalance({})).totalDebit).toBe('222.00')
  })
})

describe('roles', () => {
  it('points a slot at an account, and clears it with an empty id', async () => {
    const { ledger } = await fixture()
    const pettyCash = await ledger.createAccount({
      code: '1150',
      name: 'Petty Cash',
      type: 'asset',
      parentId: await idOf(ledger, '1000'),
      isGroup: false,
    })

    await ledger.setAccountRole({ role: 'cash', accountId: pettyCash.id })
    const roleOn = async (code: string) =>
      (await ledger.listAccounts({})).find((a) => a.code === code)?.roles ?? []

    expect(await roleOn('1150')).toContain('cash')
    expect(await roleOn('1100')).not.toContain('cash')

    /* An empty id clears the slot rather than pointing it at nothing — which is what
     * lets a user unmap a role without inventing an account to park it on. */
    await ledger.setAccountRole({ role: 'cash', accountId: '' })
    expect(await roleOn('1150')).not.toContain('cash')
  })
})

describe('the year-end close', () => {
  /*
   * Only one regime is installed, so reading the default and reading the file give the
   * same answer for every real company — which meant the lookup was untested. Writing a
   * regime the build does not have is the one way to tell the two apart today, and it is
   * also the case that actually happens: a company made by a newer build.
   */
  it('reads the regime from the file rather than assuming the default', async () => {
    const { companies, ledger } = await fixture()

    writeMetadata(companies.requireDatabase(), METADATA_KEYS.regimeId, 'atlantis')

    expect(await codeOf(() => ledger.closeFiscalYear({ startYear: 2026 }))).toBe(
      'COMPANY_REGIME_UNKNOWN',
    )
  })

  it('uses the fiscal-year rule of the regime the company was set up under', async () => {
    const { ledger } = await fixture()
    const periods = await ledger.listPeriods()

    /* India runs April to March, and the company was created under the default regime,
     * so the first period starts on 1 April rather than 1 January. */
    expect(periods[0]?.startDate.slice(5)).toBe('04-01')

    const startYear = Number(periods[0]!.fiscalYearLabel.slice(0, 4))
    const closed = await ledger.closeFiscalYear({ startYear })

    expect(closed.fiscalYearLabel).toBe(periods[0]?.fiscalYearLabel)
    expect(closed.posting).toBeNull()
    expect(closed.netResult).toBe('0.00')
  })
})
