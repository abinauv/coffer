/*
 * The units service, against a real company created by the real company service.
 *
 * This service adds nothing to the repository, so what is tested here is exactly what a
 * pass can still get wrong: which database it reaches, whether it stops reaching one when
 * the company closes, and whether the two ends of the CODE — the identity — line up
 * through the whole call. A code is normalised by the repository on reads as well as
 * writes, and a service that dropped it somewhere would look correct on a create and find
 * nothing on the get afterwards.
 *
 * IT ALSO PINS WHAT A NEW COMPANY ACTUALLY HAS, and until the integration gate that was
 * NOTHING. `setUpBooks` seeded a chart, two fiscal years and nine numbering series and
 * not one unit, so a fresh company had an empty units table and every document line's
 * unit was free text. This file pinned the absence on purpose so that whoever closed it
 * would be told, and it has been: `seedStarterUnits` runs in `setUpBooks` now, and the
 * test below asserts the set rather than the emptiness.
 *
 * WHICH IS WHY THE FIXTURES BELOW USE CODES THE SEED DOES NOT. `CTN`, `TIN`, `BAG`,
 * `DRM`, `DOZ` — a company file made by the real service already holds `KGS` and `BOX`,
 * so a test creating one of those would be testing `UNIT_CODE_TAKEN`. The counts follow
 * from the same fact: what these tests assert is that a PARTICULAR code is in the list or
 * out of it, never how long the list is, because the length is the seed's business and
 * `bootstrap.test.ts` is where the seed is pinned.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CompanyService } from '../companies/service'
import { CompanyError } from '../companies/errors'
import { ItemsService } from '../items/service'
import { type Argon2Params, MIN_MEMORY_COST } from '../security'
import { UnitsService } from './service'

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
  units: UnitsService
  items: ItemsService
}

async function fixture(): Promise<Fixture> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'coffer-units-registry-'))
  const companyDirectory = await mkdtemp(join(tmpdir(), 'coffer-units-books-'))
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

  return {
    companies,
    units: new UnitsService(companies),
    items: new ItemsService(companies),
  }
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

/** The codes in a list, which is what every assertion below is actually about. */
const codesIn = (units: readonly { code: string }[]): string[] => units.map((unit) => unit.code)

describe('which company is open', () => {
  it('refuses every method when none is', async () => {
    const units = new UnitsService({ currentDatabase: () => null })

    expect(await codeOf(() => units.list())).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => units.get('KGS'))).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => units.create({ code: 'KGS', name: 'Kilograms' }))).toBe(
      'NO_COMPANY_OPEN',
    )
    expect(await codeOf(() => units.update({ code: 'KGS', name: 'Kilos' }))).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => units.archive({ code: 'KGS', archived: true }))).toBe(
      'NO_COMPANY_OPEN',
    )
    expect(await codeOf(() => units.delete('KGS'))).toBe('NO_COMPANY_OPEN')
  })

  it('writes to the company that is open, and stops when it closes', async () => {
    const { companies, units } = await fixture()

    await units.create({ code: 'CTN', name: 'Cartons' })
    expect(codesIn(await units.list())).toContain('CTN')

    await companies.close()
    expect(await codeOf(() => units.list())).toBe('NO_COMPANY_OPEN')
  })
})

describe('what a new company starts with', () => {
  /*
   * A STARTER SET, WHICH IS WHAT THIS TEST USED TO SAY THE OPPOSITE OF. It read "has no
   * units at all until somebody creates one" and asserted an empty list, deliberately, so
   * that the batch which seeded them would be told by a failing test rather than by a
   * paragraph nobody read. `seedStarterUnits` now runs inside `setUpBooks`.
   *
   * Asserted against the file the REAL company service creates and through the service a
   * screen calls, which is the whole reason this assertion lives here and not beside the
   * seed: a test with its own fixture proves the seeding function works and says nothing
   * about whether anything calls it. That was the gap for the numbering series in 0012,
   * for this table, and for the warehouse beside it.
   */
  it('can already measure something, without anybody creating a unit', async () => {
    const { units } = await fixture()

    /* By value and not by length: a seed reduced to one row still has a length, and the
     * codes are what an invoice line prints. Both a counted unit and a measured one,
     * because the two carry different scales and a seed of only one kind is half a seed. */
    const codes = codesIn(await units.list())
    expect(codes).toContain('NOS')
    expect(codes).toContain('KGS')

    /* Nothing arrives archived. A picker offering none of them would be the same empty
     * list wearing a flag. */
    expect(codesIn(await units.list({ includeArchived: true }))).toEqual(codes)
  })

  /* Nothing restricts a business to a known list — a bundle is as real as a kilogram, and
   * the reference project's silent rewrite to `Nos` is the bug this codebase exists partly
   * not to repeat (CONVENTIONS §9). */
  it('takes a unit nobody has heard of', async () => {
    const { units } = await fixture()

    const unit = await units.create({ code: 'BUNDLE', name: 'Bundles of ten', decimalPlaces: 0 })

    expect(unit.code).toBe('BUNDLE')
    expect(unit.decimalPlaces).toBe(0)
    expect(unit.regimeCode).toBeNull()
  })
})

describe('the code is the identity, all the way through', () => {
  /*
   * The pass this service could break without anything else noticing. SQLite's TEXT
   * primary key is case-sensitive, so the repository upper-cases on writes AND on reads;
   * a lower-case code entered from a spreadsheet import has to find the same row a
   * picker's upper-case one does.
   */
  it('finds a unit however the code was cased on the way in', async () => {
    const { units } = await fixture()

    const created = await units.create({ code: ' kg ', name: 'Kilograms' })
    expect(created.code).toBe('KG')

    expect((await units.get('kg'))?.name).toBe('Kilograms')
    expect((await units.get('KG'))?.name).toBe('Kilograms')
    expect((await units.get(' Kg '))?.name).toBe('Kilograms')
  })

  it('answers null for a unit these books do not have', async () => {
    const { units } = await fixture()

    /* `DOZ` rather than `NOS`: the starter set holds NOS, so asking for it would test
     * that a seeded unit is found and not that a missing one answers null. */
    expect(await units.get('DOZ')).toBeNull()
  })

  it('archives and un-archives by code', async () => {
    const { units } = await fixture()
    await units.create({ code: 'CTN', name: 'Cartons' })

    const archived = await units.archive({ code: 'ctn', archived: true })
    expect(archived.isArchived).toBe(true)
    expect(codesIn(await units.list())).not.toContain('CTN')
    expect(codesIn(await units.list({ includeArchived: true }))).toContain('CTN')

    const restored = await units.archive({ code: 'CTN', archived: false })
    expect(restored.isArchived).toBe(false)
    expect(codesIn(await units.list())).toContain('CTN')
  })

  /* Ordered by code, and the fixture is entered in an order that disagrees with the
   * answer — an alphabetical fixture cannot tell a sorted list from an unsorted one. */
  it('lists by code whatever order they were entered in', async () => {
    const { units } = await fixture()

    await units.create({ code: 'TIN', name: 'Tins' })
    await units.create({ code: 'BAG', name: 'Bags' })
    await units.create({ code: 'DRM', name: 'Drums' })

    /* Filtered to the three this test entered, in the order the list came back — so the
     * assertion is about the list's ORDER and not about the seed's contents. */
    const entered = codesIn(await units.list()).filter((code) =>
      ['TIN', 'BAG', 'DRM'].includes(code),
    )
    expect(entered).toEqual(['BAG', 'DRM', 'TIN'])
  })
})

describe('a unit in use', () => {
  /*
   * Archived, never deleted. The repository names the item in the way, and this is what
   * proves the refusal survives the trip through the service — a `UNIT_IN_USE` swallowed
   * here would become a foreign-key failure with no sentence in it.
   */
  it('will not be deleted while an item is measured in it', async () => {
    const { units, items } = await fixture()

    await units.create({ code: 'CTN', name: 'Cartons' })
    await items.create({ name: 'Bar stock 40mm', kind: 'goods', isSold: true, unitCode: 'ctn' })

    expect(await codeOf(() => units.delete('CTN'))).toBe('UNIT_IN_USE')
    expect(codesIn(await units.list())).toContain('CTN')
  })

  it('is deleted once nothing refers to it', async () => {
    const { units } = await fixture()
    await units.create({ code: 'CTN', name: 'Cartons' })

    await units.delete('ctn')
    expect(codesIn(await units.list({ includeArchived: true }))).not.toContain('CTN')
  })

  it('refuses a delete of a unit that is not there', async () => {
    const { units } = await fixture()

    /* `DOZ` and not `KGS`, which the starter set now holds — deleting a seeded unit
     * succeeds, and the test would have been asserting the wrong sentence. */
    expect(await codeOf(() => units.delete('DOZ'))).toBe('UNIT_NOT_FOUND')
  })
})

describe('changing a unit', () => {
  it('renames it and changes what it permits, leaving absent fields alone', async () => {
    const { units } = await fixture()
    await units.create({ code: 'CTN', name: 'Cartons', decimalPlaces: 0, regimeCode: 'CTN' })

    const renamed = await units.update({ code: 'ctn', name: 'Shippers' })

    expect(renamed.name).toBe('Shippers')
    expect(renamed.decimalPlaces).toBe(0)
    expect(renamed.regimeCode).toBe('CTN')
  })

  it('clears the regime code when asked, and only then', async () => {
    const { units } = await fixture()
    await units.create({ code: 'CTN', name: 'Cartons', regimeCode: 'CTN' })

    expect((await units.update({ code: 'CTN', name: 'Shippers' })).regimeCode).toBe('CTN')
    expect((await units.update({ code: 'CTN', regimeCode: null })).regimeCode).toBeNull()
  })
})
