/*
 * The items service, against a real company created by the real company service.
 *
 * ONE THING IS ONLY TESTABLE HERE, and it is the whole reason this service exists: a
 * classification code is checked by the regime the BOOKS were created under, before
 * anything is written, and what is stored is the code the regime spells back rather than
 * the one that was typed. The repository's own header says this validation belongs above
 * it and names the error code; until this batch it had never been written, so every HSN
 * and SAC in the product was stored unexamined and the regime's `validateClassificationCode`
 * had no caller outside its own tests.
 *
 * Everything else is a pass to db/repos/items and is tested there against a real database.
 * What is repeated here is only what the pass could get wrong: which database it reaches,
 * and whether it stops reaching one when the company closes.
 *
 * The regime is asked through `books.regime()` and never imported — eslint forbids naming
 * a concrete regime outside `regimes/` (CONVENTIONS §1.6), and a test that imported India
 * directly would prove the wrong thing anyway. India is what a company file created here
 * gets, so the codes below are HSN and SAC.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CompanyService } from '../companies/service'
import { CompanyError } from '../companies/errors'
import { type Argon2Params, MIN_MEMORY_COST } from '../security'
import { ItemsService } from './service'

const FAST: Argon2Params = {
  algorithm: 'argon2id',
  memoryCost: MIN_MEMORY_COST,
  timeCost: 1,
  parallelism: 1,
}

const PASSPHRASE = 'a quiet ledger keeps its own counsel'

/* Real codes, and chosen to disagree with each other in the ways the regime cares about:
 * four digits, eight digits, and a service code — which is always six and always 99. */
const HSN_HEADING = '8471'
const HSN_TARIFF_ITEM = '84713010'
const SAC = '996511'

const directories: string[] = []
const services: CompanyService[] = []

interface Fixture {
  companies: CompanyService
  items: ItemsService
}

async function fixture(): Promise<Fixture> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'coffer-items-registry-'))
  const companyDirectory = await mkdtemp(join(tmpdir(), 'coffer-items-books-'))
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

  return { companies, items: new ItemsService(companies) }
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

const bearing = { name: 'Ball bearing 6203', kind: 'goods', isSold: true } as const

describe('which company is open', () => {
  it('refuses every method when none is', async () => {
    const items = new ItemsService({ currentDatabase: () => null })

    expect(await codeOf(() => items.list())).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => items.get('i1'))).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => items.create(bearing))).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => items.update({ id: 'i1', name: 'x' }))).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => items.archive({ id: 'i1', archived: true }))).toBe('NO_COMPANY_OPEN')
    expect(await codeOf(() => items.delete('i1'))).toBe('NO_COMPANY_OPEN')
  })

  it('writes to the company that is open, and stops when it closes', async () => {
    const { companies, items } = await fixture()

    await items.create(bearing)
    expect(await items.list()).toHaveLength(1)

    await companies.close()
    expect(await codeOf(() => items.list())).toBe('NO_COMPANY_OPEN')
  })
})

describe('the classification code', () => {
  it('takes one the regime recognises', async () => {
    const { items } = await fixture()

    const item = await items.create({ ...bearing, classificationCode: HSN_TARIFF_ITEM })
    expect(item.classificationCode).toBe(HSN_TARIFF_ITEM)
  })

  /*
   * FIVE DIGITS IS THE CASE THAT MATTERS, and it is the one this service refused for the
   * first time. A five-digit code is not a coarser eight-digit one, it is a truncated one,
   * and GSTR-1 rejects it — weeks later, at the portal, by which time every invoice of the
   * month carries it. Stored unexamined until this batch.
   */
  it('refuses one the regime does not', async () => {
    const { items } = await fixture()

    expect(await codeOf(() => items.create({ ...bearing, classificationCode: '84713' }))).toBe(
      'ITEM_CLASSIFICATION_INVALID',
    )
    expect(await items.list()).toHaveLength(0)
  })

  /*
   * The rule the regime gets right and nobody would think to write: a code starting 99 is
   * a SERVICE code, which is always six digits, so `9965` is a typo rather than a coarser
   * service code. A length check alone would admit it — four is a valid HSN length.
   */
  it('refuses a chapter-99 code that is not six digits', async () => {
    const { items } = await fixture()

    expect(await codeOf(() => items.create({ ...bearing, classificationCode: '9965' }))).toBe(
      'ITEM_CLASSIFICATION_INVALID',
    )
    expect(await codeOf(() => items.create({ ...bearing, classificationCode: '99651100' }))).toBe(
      'ITEM_CLASSIFICATION_INVALID',
    )

    /* Six digits starting 99 is the real thing, and is accepted. Asserted beside the two
     * refusals so this is a rule rather than a blanket ban on chapter 99. */
    const item = await items.create({
      ...bearing,
      name: 'Software licence',
      kind: 'service',
      classificationCode: SAC,
    })
    expect(item.classificationCode).toBe(SAC)
  })

  it('refuses one that is not digits at all', async () => {
    const { items } = await fixture()

    expect(await codeOf(() => items.create({ ...bearing, classificationCode: 'ABCD' }))).toBe(
      'ITEM_CLASSIFICATION_INVALID',
    )
  })

  /*
   * THE STORED VALUE IS THE REGIME'S SPELLING, NOT THE TYPED ONE. The tariff prints
   * `8471.30` and people paste it that way, and the regime accepts it — so a service that
   * stored what arrived would put a dot in a code that has to match a schedule with no
   * dots in it. The same reasoning `normalisedValue` carries for a GSTIN.
   */
  it('stores the regime spelling of a code, not the one that was typed', async () => {
    const { items } = await fixture()

    const dotted = await items.create({ ...bearing, classificationCode: '8471.30' })
    expect(dotted.classificationCode).toBe('847130')

    const spaced = await items.create({
      ...bearing,
      name: 'Ball bearing 6204',
      classificationCode: ` ${HSN_HEADING} `,
    })
    expect(spaced.classificationCode).toBe(HSN_HEADING)
  })

  /*
   * A form with an empty HSN box sends `''`, not `undefined`. Putting that to the regime
   * would answer 'Enter an HSN or SAC code.' to somebody who has correctly said the item
   * has none — the trap `checkRegistration` sidesteps for an unregistered party.
   */
  it('treats a blank code as no code rather than a bad one', async () => {
    const { items } = await fixture()

    const item = await items.create({ ...bearing, classificationCode: '   ' })
    expect(item.classificationCode).toBeNull()

    const updated = await items.update({ id: item.id, classificationCode: '' })
    expect(updated.classificationCode).toBeNull()
  })

  it('leaves an item with no code alone', async () => {
    const { items } = await fixture()

    const item = await items.create(bearing)
    expect(item.classificationCode).toBeNull()
  })

  it('checks it on an update too', async () => {
    const { items } = await fixture()
    const item = await items.create(bearing)

    expect(await codeOf(() => items.update({ id: item.id, classificationCode: '8471301' }))).toBe(
      'ITEM_CLASSIFICATION_INVALID',
    )

    const updated = await items.update({ id: item.id, classificationCode: '8471.30' })
    expect(updated.classificationCode).toBe('847130')
  })

  /*
   * Clearing is not validating, and an update that never mentions the code must not
   * re-derive or re-check it. Both directions, because the naive spread —
   * `{ ...input, ...check(input) }` with a check that answered for an absent field —
   * would blank the code on every rename.
   */
  it('clears a code without checking it, and leaves an absent one alone', async () => {
    const { items } = await fixture()
    const item = await items.create({ ...bearing, classificationCode: HSN_TARIFF_ITEM })

    const renamed = await items.update({ id: item.id, name: 'Ball bearing 6203 ZZ' })
    expect(renamed.classificationCode).toBe(HSN_TARIFF_ITEM)

    const cleared = await items.update({ id: item.id, classificationCode: null })
    expect(cleared.classificationCode).toBeNull()
  })
})

describe('the rest of the group', () => {
  it('lists, reads back, archives and deletes', async () => {
    const { items } = await fixture()
    const item = await items.create(bearing)

    expect((await items.get(item.id))?.name).toBe('Ball bearing 6203')

    const archived = await items.archive({ id: item.id, archived: true })
    expect(archived.isArchived).toBe(true)
    expect(await items.list()).toHaveLength(0)
    expect(await items.list({ includeArchived: true })).toHaveLength(1)

    await items.archive({ id: item.id, archived: false })
    await items.delete(item.id)
    expect(await items.list({ includeArchived: true })).toHaveLength(0)
  })

  /*
   * TWO FILTERS THAT COULD MASK EACH OTHER, given a fixture where every sold item is also
   * goods and every purchased one a service — so the row that separates them is the
   * ordinary one nobody writes down: a SERVICE THAT IS SOLD. Deleting either condition
   * changes the answer below; with a tidier fixture neither would (CONVENTIONS §6).
   */
  it('narrows by side and by kind independently', async () => {
    const { items } = await fixture()

    await items.create({ name: 'Ball bearing 6203', kind: 'goods', isSold: true })
    await items.create({ name: 'Machining charges', kind: 'service', isSold: true })
    await items.create({ name: 'Bar stock 40mm', kind: 'goods', isPurchased: true })
    await items.create({ name: 'Freight inward', kind: 'service', isPurchased: true })

    const sold = await items.list({ side: 'sold' })
    expect(sold.map((item) => item.name).sort()).toEqual(['Ball bearing 6203', 'Machining charges'])

    const services = await items.list({ kind: 'service' })
    expect(services.map((item) => item.name).sort()).toEqual([
      'Freight inward',
      'Machining charges',
    ])

    /* Both at once. Exactly one row satisfies them together, and it is a row each filter
     * alone would have let three others through with. */
    const soldServices = await items.list({ side: 'sold', kind: 'service' })
    expect(soldServices.map((item) => item.name)).toEqual(['Machining charges'])
  })

  /* Ordered by name, and the fixture is inserted in an order that disagrees with the
   * answer — an alphabetical fixture cannot tell a sorted list from an unsorted one. */
  it('lists by name whatever order they were entered in', async () => {
    const { items } = await fixture()

    await items.create({ name: 'Zinc plating', kind: 'service', isSold: true })
    await items.create({ name: 'Ball bearing 6203', kind: 'goods', isSold: true })
    await items.create({ name: 'Machining charges', kind: 'service', isSold: true })

    expect((await items.list()).map((item) => item.name)).toEqual([
      'Ball bearing 6203',
      'Machining charges',
      'Zinc plating',
    ])
  })
})
