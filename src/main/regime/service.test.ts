/*
 * The regime service, and the mapping under it.
 *
 * Two things are worth testing here and they are not the same thing.
 *
 * `describeRegime` is a pure function, so it is tested against the real India regime and
 * against a stub — the stub is what proves the mapping reads the interface rather than
 * knowing India, and it is the only place a second regime exists anywhere in the suite.
 *
 * THE ASSERTION THIS FILE EXISTS FOR IS A NEGATIVE ONE. Nothing executable may cross.
 * `TaxRegime` has `computeTax` on it; `RegimeDescription` must not, and a test that only
 * checked the fields that ARE there would pass just as happily against a mapping that
 * spread the whole regime object. So there is a test that spreads the regime deliberately
 * and asserts the description is not that.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CompanyService } from '../companies/service'
import { CompanyError } from '../companies/errors'
import { DEFAULT_REGIME_ID, getRegime, type TaxRegime } from '../regimes'
import { type Argon2Params, MIN_MEMORY_COST } from '../security'
import { RegimeService, describeRegime } from './service'

const FAST: Argon2Params = {
  algorithm: 'argon2id',
  memoryCost: MIN_MEMORY_COST,
  timeCost: 1,
  parallelism: 1,
}

const PASSPHRASE = 'a quiet ledger keeps its own counsel'

const directories: string[] = []
const services: CompanyService[] = []

async function fixture(): Promise<{ companies: CompanyService; regime: RegimeService }> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'coffer-regime-registry-'))
  const companyDirectory = await mkdtemp(join(tmpdir(), 'coffer-regime-books-'))
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

  return { companies, regime: new RegimeService(companies) }
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.close().catch(() => undefined)
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
  }
})

describe('which company is open', () => {
  it('refuses to describe anything when none is', async () => {
    const regime = new RegimeService({ currentDatabase: () => null })

    await expect(regime.describe()).rejects.toBeInstanceOf(CompanyError)
    await expect(regime.describe()).rejects.toMatchObject({ code: 'NO_COMPANY_OPEN' })
  })

  /*
   * The regime is a property of the BOOKS, read off the file rather than taken from the
   * build. A company created today under a regime a future build drops must fail loudly
   * here, because the alternative is describing Portuguese books as Indian ones and
   * offering the user a picker full of Indian states.
   */
  it('describes the regime the open company was created under', async () => {
    const { regime } = await fixture()

    expect((await regime.describe()).id).toBe('in')
  })
})

describe('describeRegime', () => {
  /*
   * THROUGH THE REGISTRY, NOT AT THE CONCRETE REGIME. eslint refuses the direct import —
   * the rule that keeps tax logic inside `regimes/` (CONVENTIONS §1.6) applies to a test
   * as much as to a screen, and it caught this file being written the other way. Asking
   * by id is also what production does: `OpenBooks.regime()` looks up a string that came
   * off the company file.
   */
  const india = getRegime(DEFAULT_REGIME_ID)
  const description = describeRegime(india)

  it('names the regime the way CompanySummary.regimeId does', () => {
    expect(description.id).toBe(india.id)
    expect(description.label).toBe('India — GST')
  })

  it('carries the grouping rule the renderer has been hard-coding', () => {
    expect(description.numberFormat).toEqual({
      groupSizes: [3, 2],
      decimalSeparator: '.',
      groupSeparator: ',',
      currencyCode: 'INR',
      currencySymbol: '₹',
    })
  })

  it('carries every jurisdiction, for a place-of-supply picker', () => {
    expect(description.jurisdictions).toHaveLength(36)
    expect(description.jurisdictions).toContainEqual({ code: '33', name: 'Tamil Nadu' })
  })

  it('carries the rate slabs with the words that make them readable', () => {
    expect(description.taxRates).toContainEqual({
      ratePct: '18',
      label: '18%',
      note: 'The main slab — most goods and most services.',
    })
  })

  it('carries the components, so a screen can label a tax column', () => {
    expect(description.taxComponents.map((component) => component.code)).toEqual([
      'CGST',
      'SGST',
      'UTGST',
      'IGST',
    ])
    expect(description.taxComponents[0]?.levy).toBe('both')
  })

  it('carries the classification scheme but not the codes', () => {
    expect(description.classification).toEqual({
      code: 'HSN',
      label: 'HSN / SAC',
      validLengths: [4, 6, 8],
    })
    /* A few thousand entries with a type-ahead over them is a search, not a payload. */
    expect(description).not.toHaveProperty('classificationCodes')
  })

  /*
   * THE NEGATIVE ASSERTION. Every method on `TaxRegime` is dropped, and the test names
   * them rather than checking the count — a method added to the adapter and forgotten
   * here should be invisible to the renderer, which is the safe direction to fail in.
   */
  it('drops everything executable, so the renderer cannot compute a tax', () => {
    for (const member of [
      'computeTax',
      'placeOfSupply',
      'validateRegistrationNumber',
      'validateDocumentNumber',
      'jurisdictionName',
      'amountInWords',
    ]) {
      expect(description, member).not.toHaveProperty(member)
    }

    for (const value of Object.values(description)) {
      expect(typeof value).not.toBe('function')
    }
  })

  /* And it is a mapping rather than a spread, which is what the above rests on. */
  it('is not the regime object with a few fields renamed', () => {
    expect(description).not.toMatchObject({ computeTax: expect.anything() })
    expect(Object.keys(description).sort()).toEqual([
      'classification',
      'id',
      'jurisdictions',
      'label',
      'numberFormat',
      'registrationLabel',
      'taxComponents',
      'taxRates',
    ])
  })

  /*
   * Copied, not shared. The description is handed straight to the IPC layer, and in a
   * test — or in any main-side caller — it is the live array unless something copies it.
   * A screen sorting its own jurisdiction list must not reorder the regime's.
   */
  it('copies every list out of the regime', () => {
    const again = describeRegime(india)

    expect(again.jurisdictions).not.toBe(description.jurisdictions)
    /* The ROWS too, not just the array around them. A screen that renamed a jurisdiction
     * in place would otherwise rename it in the regime, for the life of the process. */
    expect(again.jurisdictions[0]).not.toBe(india.jurisdictions()[0])
    expect(again.taxRates[0]).not.toBe(india.taxRates()[0])
    expect(again.taxComponents[0]).not.toBe(india.taxComponents()[0])
    expect(again.numberFormat.groupSizes).not.toBe(india.numberFormat.groupSizes)
    expect(again.classification.validLengths).not.toBe(india.classification.validLengths)

    description.jurisdictions.push({ code: '99', name: 'Nowhere' })
    expect(describeRegime(india).jurisdictions).toHaveLength(36)
  })

  /*
   * Read off the interface, not off India. The stub is the whole second regime this
   * codebase has, and it exists to catch a mapping that reached for the bundled regime,
   * or for an India-shaped constant, instead of for its argument.
   */
  it('describes a regime that is not India', () => {
    const described = describeRegime(portugal())

    expect(described.id).toBe('pt')
    expect(described.label).toBe('Portugal — IVA')
    /* The WHOLE rule, not a field or two of it. Every one of these is Indian in the
     * bundled regime, so an assertion that skipped one would not notice it being
     * hardcoded — which is how three of them were being missed. */
    expect(described.numberFormat).toEqual({
      groupSizes: [3],
      decimalSeparator: ',',
      groupSeparator: '.',
      currencyCode: 'EUR',
      currencySymbol: '€',
    })
    expect(described.taxRates).toEqual([
      { ratePct: '23', label: '23%', note: 'The standard rate.' },
    ])
    expect(described.jurisdictions).toHaveLength(1)
    /* A regime that classifies nothing says so with a null code, and the field hides. */
    expect(described.classification.code).toBeNull()
    /* The word above a registration number is the regime's own. India says GSTIN / UIN,
     * and a mapping that had reached for a constant would say it here too. */
    expect(described.registrationLabel).toBe('NIF')
    /* Every India component is levied on both sides, so this is the only assertion in
     * the suite that can tell `component.levy` from the constant 'both'. */
    expect(described.taxComponents[0]?.levy).toBe('output')
    expect(described.classification.validLengths).toEqual([])
  })

  /*
   * ROWS ARE COPIED, NOT JUST THE ARRAYS AROUND THEM — and this needs the stub to say so.
   *
   * India's `jurisdictions()` and `taxRates()` happen to build fresh objects on every
   * call, so against the bundled regime a mapping that handed the regime's own rows
   * straight through is indistinguishable from one that copies them. It is only
   * indistinguishable by luck: `taxComponents()` returns a module-level array, and a
   * regime written the same way for its states would hand a screen a live reference to
   * the adapter's own data. So the stub returns stable arrays, which is the case the
   * contract has to survive.
   */
  it('copies the rows out of a regime that reuses its own arrays', () => {
    const regime = portugal()
    const described = describeRegime(regime)

    expect(described.jurisdictions[0]).not.toBe(regime.jurisdictions()[0])
    expect(described.taxRates[0]).not.toBe(regime.taxRates()[0])
    expect(described.taxComponents[0]).not.toBe(regime.taxComponents()[0])

    described.jurisdictions[0]!.name = 'Renamed by a screen'
    expect(regime.jurisdictions()[0]?.name).toBe('Área Metropolitana de Lisboa')
  })
})

/*
 * The whole second regime this codebase has. It exists to catch a mapping that reached
 * for the bundled regime, or for an India-shaped constant, instead of for its argument —
 * and every list it returns is STABLE, so that copying can be told from sharing.
 */
function portugal(): TaxRegime {
  const jurisdictions = [{ code: 'PT-11', name: 'Área Metropolitana de Lisboa' }]
  const taxRates = [{ ratePct: '23', label: '23%', note: 'The standard rate.' }]
  const taxComponents = [{ code: 'IVA', label: 'IVA', levy: 'output' as const }]

  return {
    id: 'pt',
    label: 'Portugal — IVA',
    registrationLabel: 'NIF',
    jurisdictions: () => jurisdictions,
    taxRates: () => taxRates,
    taxComponents: () => taxComponents,
    classification: { code: null, label: 'CPA', validLengths: [], validate: () => null },
    numberFormat: {
      groupSizes: [3],
      decimalSeparator: ',',
      groupSeparator: '.',
      currencyCode: 'EUR',
      currencySymbol: '€',
    },
  } as unknown as TaxRegime
}
