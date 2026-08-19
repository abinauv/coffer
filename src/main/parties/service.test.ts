/*
 * The parties service, against a real company created by the real company service.
 *
 * Two things are only testable here. The first is the seam every service shares — which
 * database is written to, and what happens across a close and reopen — and it is tested
 * once, here, because `OpenBooks` is now one object rather than a copy per service.
 *
 * The second is the whole reason this service exists: a registration number is checked
 * by the regime the BOOKS were created under, not by the build's default. Everything
 * else is a pass to db/repos/parties and is tested there against a real database.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CompanyService } from '../companies/service'
import { CompanyError } from '../companies/errors'
import { type Argon2Params, MIN_MEMORY_COST } from '../security'
import { PartiesService } from './service'

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
  parties: PartiesService
}

async function fixture(): Promise<Fixture> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'coffer-parties-registry-'))
  const companyDirectory = await mkdtemp(join(tmpdir(), 'coffer-parties-books-'))
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

  return { companies, parties: new PartiesService(companies) }
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

const customer = { name: 'Bharat Steel', countryCode: 'in', isCustomer: true }

describe('which company is open', () => {
  it('refuses every method when none is', async () => {
    const parties = new PartiesService({ currentDatabase: () => null })

    expect(await codeOf(() => parties.list())).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => parties.get('p1'))).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => parties.create(customer))).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => parties.delete('p1'))).toBe('NO_COMPANY_OPEN')
  })

  it('writes to the company that is open, and stops when it closes', async () => {
    const { companies, parties } = await fixture()

    await parties.create(customer)
    expect(await parties.list()).toHaveLength(1)

    await companies.close()
    expect(await codeOf(() => parties.list())).toBe('NO_COMPANY_OPEN')
  })
})

describe('the registration number', () => {
  it('takes a valid one and fills in where it says the party is', async () => {
    const { parties } = await fixture()

    const party = await parties.create({ ...customer, registrationNumber: TAMIL_NADU_GSTIN })

    expect(party.registrationNumber).toBe(TAMIL_NADU_GSTIN)
    expect(party.jurisdictionCode).toBe('33')
  })

  /*
   * One transposed character. The GSTIN check digit is what catches it, and catching it
   * at the desk is the entire point — an invalid number fails at the portal weeks later,
   * by which time every invoice of the month carries it.
   */
  it('refuses one the regime does not recognise', async () => {
    const { parties } = await fixture()

    expect(
      await codeOf(() => parties.create({ ...customer, registrationNumber: '33AABCC1234D1ZZ' })),
    ).toBe('PARTY_REGISTRATION_INVALID')
  })

  /*
   * The rule that changes money. A party's jurisdiction decides the place of supply,
   * which decides CGST+SGST against IGST. A number saying Karnataka against a state
   * saying Tamil Nadu is not a detail to resolve quietly — either answer is wrong on
   * half the invoices raised for them.
   */
  it('refuses a jurisdiction the number disagrees with', async () => {
    const { parties } = await fixture()

    expect(
      await codeOf(() =>
        parties.create({
          ...customer,
          registrationNumber: KARNATAKA_GSTIN,
          jurisdictionCode: '33',
        }),
      ),
    ).toBe('PARTY_JURISDICTION_MISMATCH')
  })

  it('accepts a jurisdiction the number agrees with', async () => {
    const { parties } = await fixture()

    const party = await parties.create({
      ...customer,
      registrationNumber: KARNATAKA_GSTIN,
      jurisdictionCode: '29',
    })

    expect(party.jurisdictionCode).toBe('29')
  })

  /*
   * A form with an empty GSTIN box sends `''`, not `undefined`. Putting that to the
   * regime would answer "not a valid registration number" to somebody who has correctly
   * said they have none.
   */
  it('treats a blank number as no number rather than a bad one', async () => {
    const { parties } = await fixture()

    const party = await parties.create({ ...customer, registrationNumber: '   ' })
    expect(party.registrationNumber).toBeNull()

    const updated = await parties.update({ id: party.id, registrationNumber: '' })
    expect(updated.registrationNumber).toBeNull()
  })

  /*
   * A GSTIN is nearly always pasted, and GSTIN validation upper-cases and strips
   * whitespace before it looks at anything — so ` 33aabcc1234d1zi ` is a VALID number
   * and would be stored exactly as it arrived if the caller's spelling were kept. It
   * would then be printed like that on a tax invoice. The regime says what the canonical
   * form is, and that is what is stored.
   */
  it('stores the regime spelling of a number, not the one that was typed', async () => {
    const { parties } = await fixture()

    const party = await parties.create({
      ...customer,
      registrationNumber: ` ${TAMIL_NADU_GSTIN.toLowerCase()} `,
    })

    expect(party.registrationNumber).toBe(TAMIL_NADU_GSTIN)
    expect(party.jurisdictionCode).toBe('33')
  })

  /* Unregistered parties are ordinary. Nothing is validated and nothing is derived —
   * a composition dealer or a walk-in customer has no number to check. */
  it('leaves a party with no number alone', async () => {
    const { parties } = await fixture()

    const party = await parties.create({ ...customer, jurisdictionCode: '33' })

    expect(party.registrationNumber).toBeNull()
    expect(party.jurisdictionCode).toBe('33')
  })

  it('checks it on an update too', async () => {
    const { parties } = await fixture()
    const party = await parties.create(customer)

    expect(
      await codeOf(() => parties.update({ id: party.id, registrationNumber: 'nonsense' })),
    ).toBe('PARTY_REGISTRATION_INVALID')

    const updated = await parties.update({ id: party.id, registrationNumber: TAMIL_NADU_GSTIN })
    expect(updated.jurisdictionCode).toBe('33')
  })

  /*
   * Clearing is not validating. An update that sets the number to null has nothing to
   * check, and one that never mentions it must not re-derive the jurisdiction — which is
   * what a naive `input.registrationNumber ?? existing` would do.
   */
  it('clears a number without checking it, and leaves an absent one alone', async () => {
    const { parties } = await fixture()
    const party = await parties.create({ ...customer, registrationNumber: TAMIL_NADU_GSTIN })

    const renamed = await parties.update({ id: party.id, name: 'Bharat Steel Works' })
    expect(renamed.registrationNumber).toBe(TAMIL_NADU_GSTIN)
    expect(renamed.jurisdictionCode).toBe('33')

    const cleared = await parties.update({ id: party.id, registrationNumber: null })
    expect(cleared.registrationNumber).toBeNull()
  })
})

describe('the rest of the group', () => {
  it('lists, reads back, archives and deletes', async () => {
    const { parties } = await fixture()
    const party = await parties.create(customer)

    expect((await parties.get(party.id))?.name).toBe('Bharat Steel')

    const archived = await parties.archive({ id: party.id, archived: true })
    expect(archived.isArchived).toBe(true)
    expect(await parties.list()).toHaveLength(0)
    expect(await parties.list({ includeArchived: true })).toHaveLength(1)

    await parties.archive({ id: party.id, archived: false })
    await parties.delete(party.id)
    expect(await parties.list({ includeArchived: true })).toHaveLength(0)
  })

  it('filters a list by role', async () => {
    const { parties } = await fixture()
    await parties.create(customer)
    await parties.create({ name: 'Southern Transport', countryCode: 'in', isVendor: true })

    expect((await parties.list({ role: 'customer' })).map((p) => p.name)).toEqual(['Bharat Steel'])
    expect((await parties.list({ role: 'vendor' })).map((p) => p.name)).toEqual([
      'Southern Transport',
    ])
  })
})
