/*
 * The company profile service, against a real company created by the real company service.
 *
 * What is only testable here is the reason the service exists: a registration number is
 * checked by the regime the BOOKS were created under, and a number that disagrees with
 * the jurisdiction beside it is refused rather than reconciled. Everything else is a pass
 * to db/repos/company-profile and is tested there against a real database.
 *
 * The rule itself lives in ../books/registration.ts and is shared with parties. It is
 * asserted on both sides on purpose: the two services choose different error codes, and a
 * shared implementation that answered with the party's vocabulary here would put a
 * sentence about somebody's customer in front of a user editing their own address.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CompanyService } from '../companies/service'
import { CompanyError } from '../companies/errors'
import { type Argon2Params, MIN_MEMORY_COST } from '../security'
import { CompanyProfileService } from './service'

const FAST: Argon2Params = {
  algorithm: 'argon2id',
  memoryCost: MIN_MEMORY_COST,
  timeCost: 1,
  parallelism: 1,
}

const PASSPHRASE = 'a quiet ledger keeps its own counsel'

/* Tamil Nadu is 33, Karnataka 29 — both real, and different, which is what makes the
 * jurisdiction rule testable at all. */
const TAMIL_NADU_GSTIN = '33AABCC1234D1ZI'
const KARNATAKA_GSTIN = '29AAAAA0000A1ZY'

const directories: string[] = []
const services: CompanyService[] = []

interface Fixture {
  companies: CompanyService
  profile: CompanyProfileService
}

async function fixture(): Promise<Fixture> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'coffer-profile-registry-'))
  const companyDirectory = await mkdtemp(join(tmpdir(), 'coffer-profile-books-'))
  directories.push(dataDirectory, companyDirectory)

  const companies = new CompanyService({
    dataDirectory,
    kdf: { passphrase: FAST, recovery: FAST },
  })
  services.push(companies)

  await companies.create({
    displayName: 'Acme Traders',
    directoryPath: companyDirectory,
    passphrase: PASSPHRASE,
  })

  return { companies, profile: new CompanyProfileService(companies) }
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
  return 'no error thrown'
}

const acme = { legalName: 'Acme Traders Private Limited', countryCode: 'in' }

describe('which company is open', () => {
  it('refuses both methods when none is', async () => {
    const profile = new CompanyProfileService({ currentDatabase: () => null })

    expect(await codeOf(() => profile.get())).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => profile.save(acme))).toBe('NO_COMPANY_OPEN')
  })

  /*
   * A new company has books and no profile, and that is a working state rather than a
   * half-finished one. Nothing else in the app needs it to raise a document.
   */
  it('answers null for a company that has just been created', async () => {
    const { profile } = await fixture()

    expect(await profile.get()).toBeNull()
  })

  it('writes to the company that is open, and stops when it closes', async () => {
    const { companies, profile } = await fixture()

    await profile.save(acme)
    expect((await profile.get())?.legalName).toBe('Acme Traders Private Limited')

    await companies.close()
    expect(await codeOf(() => profile.get())).toBe('NO_COMPANY_OPEN')
  })
})

describe('the company registration number', () => {
  it('takes a valid one and fills in where it says the business is', async () => {
    const { profile } = await fixture()

    const saved = await profile.save({ ...acme, registrationNumber: TAMIL_NADU_GSTIN })

    expect(saved.registrationNumber).toBe(TAMIL_NADU_GSTIN)
    expect(saved.jurisdictionCode).toBe('33')
  })

  it('refuses one the regime does not recognise', async () => {
    const { profile } = await fixture()

    expect(
      await codeOf(() => profile.save({ ...acme, registrationNumber: '33AABCC1234D1ZZ' })),
    ).toBe('COMPANY_REGISTRATION_INVALID')
    expect(await profile.get()).toBeNull()
  })

  /*
   * The rule that changes money, and it changes more of it here than on a party. A
   * customer with the wrong state code gets the wrong tax on their own invoices; the
   * COMPANY with the wrong state code gets the wrong tax on every invoice in the books,
   * in both directions, and nothing about the documents would look wrong afterwards.
   */
  it('refuses a jurisdiction the number disagrees with', async () => {
    const { profile } = await fixture()

    expect(
      await codeOf(() =>
        profile.save({ ...acme, registrationNumber: KARNATAKA_GSTIN, jurisdictionCode: '33' }),
      ),
    ).toBe('COMPANY_JURISDICTION_MISMATCH')
  })

  /* The company's own failures are named for the company. A user editing their address
   * must not be told something about a party. */
  it('fails with the company vocabulary rather than the party vocabulary', async () => {
    const { profile } = await fixture()

    const code = await codeOf(() => profile.save({ ...acme, registrationNumber: 'nonsense' }))

    expect(code).toBe('COMPANY_REGISTRATION_INVALID')
    expect(code).not.toContain('PARTY')
  })

  it('accepts a jurisdiction the number agrees with', async () => {
    const { profile } = await fixture()

    const saved = await profile.save({
      ...acme,
      registrationNumber: KARNATAKA_GSTIN,
      jurisdictionCode: '29',
    })

    expect(saved.jurisdictionCode).toBe('29')
  })

  it('stores the regime spelling of a number, not the one that was typed', async () => {
    const { profile } = await fixture()

    const saved = await profile.save({
      ...acme,
      registrationNumber: ` ${TAMIL_NADU_GSTIN.toLowerCase()} `,
    })

    expect(saved.registrationNumber).toBe(TAMIL_NADU_GSTIN)
    expect(saved.jurisdictionCode).toBe('33')
  })

  /*
   * A business below the registration threshold is exactly the kind Coffer is for. It
   * still has a state, and the state still decides the place of supply — so an
   * unregistered profile keeps the jurisdiction it was given rather than having it
   * cleared by a check that had nothing to say about it.
   */
  it('keeps the jurisdiction of a business with no registration number', async () => {
    const { profile } = await fixture()

    const saved = await profile.save({ ...acme, registrationNumber: '  ', jurisdictionCode: '33' })

    expect(saved.registrationNumber).toBeNull()
    expect(saved.jurisdictionCode).toBe('33')
  })

  it('checks it again on the save that replaces a good profile', async () => {
    const { profile } = await fixture()
    await profile.save({ ...acme, registrationNumber: TAMIL_NADU_GSTIN })

    expect(await codeOf(() => profile.save({ ...acme, registrationNumber: 'nonsense' }))).toBe(
      'COMPANY_REGISTRATION_INVALID',
    )

    /* And the good profile is still there, unchanged. */
    expect((await profile.get())?.registrationNumber).toBe(TAMIL_NADU_GSTIN)
  })
})
