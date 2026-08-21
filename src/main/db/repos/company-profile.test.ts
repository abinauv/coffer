/*
 * The company profile, against a real encrypted database.
 *
 * What is worth putting to the database rather than to a mock: every rule this table has
 * is a CHECK in migration 0011, and the point of a CHECK is that it holds when the
 * repository does not run. So each one is written to straight, with SQL, as well as
 * through the repository — a mock would agree with whatever this file believed.
 *
 * The other subject is the upsert. `saveCompanyProfile` is one statement that inserts the
 * first time and replaces afterwards, and the two things easy to get wrong about it are
 * that `created_at` must survive a replace and that a field left out must be cleared.
 * Both are asserted against a row whose timestamps were forced to known values, rather
 * than against the wall clock — two saves can land in the same millisecond.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DATABASE_KEY_BYTES, closeDatabase, openDatabase, type SqliteDatabase } from '../connection'
import { createQueryBuilder, type CofferDb } from '../kysely'
import { runMigrations, rollbackMigrations } from '../migrate'
import { MIGRATIONS } from '../migrations'

import { getCompanyProfile, homeJurisdictionCode, saveCompanyProfile } from './company-profile'
import { isRepoError, type RepoError, type RepoErrorCode } from './errors'
import type { SaveCompanyProfileInput } from '@shared/dto'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x5a)

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase
let db: CofferDb

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-company-'))
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

async function codeOf(action: () => Promise<unknown>): Promise<RepoErrorCode | string> {
  try {
    await action()
    return 'NO_ERROR'
  } catch (error) {
    return isRepoError(error) ? (error as RepoError).code : String(error)
  }
}

/** The least a profile can be: a name and a country. */
const MINIMAL: SaveCompanyProfileInput = {
  legalName: 'Selvaraj Traders Private Limited',
  countryCode: 'in',
}

/** A registered business with every field filled in. */
const FULL: SaveCompanyProfileInput = {
  legalName: 'Selvaraj Traders Private Limited',
  tradeName: 'Selvaraj Traders',
  registrationNumber: '33AABCS1234D1ZI',
  jurisdictionCode: '33',
  countryCode: 'in',
  addressLine1: '14 Anna Salai',
  addressLine2: 'Second Floor',
  city: 'Chennai',
  postalCode: '600002',
  email: 'accounts@selvaraj.example',
  phone: '+91 44 4000 0000',
}

/** Straight to the table, so that a CHECK is what refuses rather than the repository. */
function writeProfile(id: string, columns: Record<string, string | null>): void {
  const values: Record<string, string | null> = {
    id,
    legal_name: 'Written Directly',
    trade_name: null,
    registration_number: null,
    jurisdiction_code: null,
    country_code: 'in',
    address_line1: null,
    address_line2: null,
    city: null,
    postal_code: null,
    email: null,
    phone: null,
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-01T00:00:00.000Z',
    ...columns,
  }
  const names = Object.keys(values)
  connection
    .prepare(
      `INSERT INTO company_profile (${names.join(', ')})
       VALUES (${names.map(() => '?').join(', ')})`,
    )
    .run(...names.map((name) => values[name] ?? null))
}

/** Force the stamps to known values, so a replace can be measured rather than raced. */
function stampProfile(createdAt: string, updatedAt: string): void {
  connection
    .prepare<[string, string]>(`UPDATE company_profile SET created_at = ?, updated_at = ?`)
    .run(createdAt, updatedAt)
}

describe('reading a profile that is not there', () => {
  /*
   * An empty table is a legal state, and this is the assertion that says so. 0011 seeds
   * no row because a migration cannot know a company's legal name, and a placeholder
   * would be indistinguishable afterwards from a profile somebody filled in.
   */
  it('answers null on books nobody has filled in', async () => {
    expect(await getCompanyProfile(db)).toBeNull()
  })

  it('answers null for the home jurisdiction too', async () => {
    expect(await homeJurisdictionCode(db)).toBeNull()
  })
})

describe('saving a profile', () => {
  it('stores every field and reads it back', async () => {
    const saved = await saveCompanyProfile(db, FULL)

    expect(saved).toMatchObject({
      legalName: 'Selvaraj Traders Private Limited',
      tradeName: 'Selvaraj Traders',
      registrationNumber: '33AABCS1234D1ZI',
      jurisdictionCode: '33',
      countryCode: 'in',
      addressLine1: '14 Anna Salai',
      addressLine2: 'Second Floor',
      city: 'Chennai',
      postalCode: '600002',
      email: 'accounts@selvaraj.example',
      phone: '+91 44 4000 0000',
    })
    expect(await getCompanyProfile(db)).toEqual(saved)
  })

  it('leaves everything optional null when only the two required fields are given', async () => {
    const saved = await saveCompanyProfile(db, MINIMAL)

    expect(saved.tradeName).toBeNull()
    expect(saved.registrationNumber).toBeNull()
    expect(saved.jurisdictionCode).toBeNull()
    expect(saved.city).toBeNull()
  })

  /*
   * A pasted value arrives with the whitespace around it, and a form with an empty box
   * sends `''`. Both mean "nothing here", and there is one way to store that — otherwise
   * `registration_number IS NULL` and `registration_number = ''` are two answers to
   * "is this business registered".
   */
  it('trims what it is given and stores a blank as nothing', async () => {
    const saved = await saveCompanyProfile(db, {
      legalName: '  Selvaraj Traders Private Limited  ',
      countryCode: ' IN ',
      registrationNumber: '   ',
      city: '',
      phone: '  +91 44 4000 0000 ',
    })

    expect(saved.legalName).toBe('Selvaraj Traders Private Limited')
    expect(saved.registrationNumber).toBeNull()
    expect(saved.city).toBeNull()
    expect(saved.phone).toBe('+91 44 4000 0000')
  })

  /** ISO 3166-1 alpha-2, lower case, on both sides of a supply — as `parties` stores it. */
  it('lower-cases the country code, so it matches how a party stores one', async () => {
    const saved = await saveCompanyProfile(db, { ...MINIMAL, countryCode: 'IN' })

    expect(saved.countryCode).toBe('in')
  })

  it('refuses a profile with no legal name', async () => {
    expect(await codeOf(() => saveCompanyProfile(db, { ...MINIMAL, legalName: '   ' }))).toBe(
      'COMPANY_LEGAL_NAME_REQUIRED',
    )
    expect(await getCompanyProfile(db)).toBeNull()
  })

  it('refuses a profile with no country', async () => {
    expect(await codeOf(() => saveCompanyProfile(db, { ...MINIMAL, countryCode: '' }))).toBe(
      'COMPANY_COUNTRY_REQUIRED',
    )
  })
})

describe('saving over a profile that is already there', () => {
  /*
   * The distinction this file exists to hold: a save is a REPLACE. `updateParty` writes
   * only the fields it was given; this writes all of them, because there is one profile
   * and one screen that owns every field of it.
   */
  it('clears a field the caller left out', async () => {
    await saveCompanyProfile(db, FULL)

    const replaced = await saveCompanyProfile(db, MINIMAL)

    expect(replaced.registrationNumber).toBeNull()
    expect(replaced.jurisdictionCode).toBeNull()
    expect(replaced.city).toBeNull()
    expect(replaced.legalName).toBe('Selvaraj Traders Private Limited')
  })

  it('replaces rather than adding a second profile', async () => {
    await saveCompanyProfile(db, FULL)
    await saveCompanyProfile(db, { ...MINIMAL, legalName: 'Selvaraj Enterprises LLP' })

    const rows = connection
      .prepare<[], { n: number }>(`SELECT count(*) AS n FROM company_profile`)
      .get()
    expect(rows?.n).toBe(1)
    expect((await getCompanyProfile(db))?.legalName).toBe('Selvaraj Enterprises LLP')
  })

  /*
   * `created_at` says when somebody first entered a profile, which is not when the
   * company file was made and is worth being able to tell apart. The stamps are forced
   * to known values first: two saves really can land in the same millisecond, and a test
   * that raced the clock would fail on a fast machine and nowhere else.
   */
  it('keeps the moment the profile was first entered', async () => {
    await saveCompanyProfile(db, FULL)
    stampProfile('2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z')

    const replaced = await saveCompanyProfile(db, MINIMAL)

    expect(replaced.createdAt).toBe('2026-04-01T00:00:00.000Z')
    expect(replaced.updatedAt).not.toBe('2026-04-01T00:00:00.000Z')
  })
})

describe('the home jurisdiction, for a posting rule', () => {
  it('is the jurisdiction on the profile once there is one', async () => {
    await saveCompanyProfile(db, FULL)

    expect(await homeJurisdictionCode(db)).toBe('33')
  })

  /*
   * Three situations answer null and a posting rule treats them identically: no profile,
   * a profile with no jurisdiction, and a country that has no sub-national jurisdictions
   * at all. This is the middle one.
   */
  it('is null for a profile that has not said where it is', async () => {
    await saveCompanyProfile(db, MINIMAL)

    expect(await homeJurisdictionCode(db)).toBeNull()
  })
})

describe('what the table refuses when the repository is not there', () => {
  /*
   * One row, by CHECK rather than by convention. A company is one file (ARCHITECTURE
   * §6.3), so a second profile would be a second answer to a question the file has
   * already answered — and nothing above this layer would know which of the two to read.
   */
  it('refuses a second profile under any other id', () => {
    writeProfile('company', {})

    expect(() => {
      writeProfile('company-2', {})
    }).toThrow(/CHECK/i)
  })

  it('refuses a second profile under the same id', () => {
    writeProfile('company', {})

    expect(() => {
      writeProfile('company', {})
    }).toThrow(/UNIQUE|PRIMARY KEY/i)
  })

  it('refuses a legal name of whitespace', () => {
    expect(() => {
      writeProfile('company', { legal_name: '   ' })
    }).toThrow(/CHECK/i)
  })

  /*
   * NOT NULL and the blank CHECK are two different rules, and only one of them is
   * obvious. `length(trim(NULL))` is NULL, a CHECK whose expression is NULL PASSES, and
   * so the blank check says nothing whatever about a missing value — measured on a
   * scratch table, not read. It is the same shape as the un-IFNULLed trigger 2.2c found,
   * and the reason both rules are written on every required column.
   */
  it('refuses a legal name that is missing rather than blank', () => {
    expect(() => {
      writeProfile('company', { legal_name: null })
    }).toThrow(/NOT NULL/i)
  })

  it('refuses a country of whitespace', () => {
    expect(() => {
      writeProfile('company', { country_code: '' })
    }).toThrow(/CHECK/i)
  })

  it('refuses a country that is missing rather than blank', () => {
    expect(() => {
      writeProfile('company', { country_code: null })
    }).toThrow(/NOT NULL/i)
  })

  /*
   * A blank is not a registration number. Without these, `''` and NULL are two rows that
   * mean the same thing to a person and different things to a query — and the query that
   * matters is the one asking whether this business is registered at all.
   */
  it('refuses a blank registration number, which is not the same as having none', () => {
    expect(() => {
      writeProfile('company', { registration_number: '' })
    }).toThrow(/CHECK/i)

    expect(() => {
      writeProfile('company', { registration_number: null })
    }).not.toThrow()
  })

  it('refuses a blank jurisdiction code and a blank trade name', () => {
    expect(() => {
      writeProfile('company', { jurisdiction_code: ' ' })
    }).toThrow(/CHECK/i)

    expect(() => {
      writeProfile('company', { trade_name: '' })
    }).toThrow(/CHECK/i)
  })
})

describe('rolling 0011 off', () => {
  it('takes the table with it', async () => {
    await saveCompanyProfile(db, FULL)

    rollbackMigrations(connection, MIGRATIONS, { to: '0010' })

    expect(() => connection.prepare(`SELECT 1 FROM company_profile`).get()).toThrow(
      /no such table/i,
    )
  })
})
