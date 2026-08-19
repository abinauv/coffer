/*
 * Against a real encrypted database, like every other repository test here.
 *
 * What is worth putting to the database rather than to a mock: the two unique indexes
 * are `COLLATE NOCASE`, one of them is partial, and the CHECK that a party is a customer
 * or a vendor is in the migration. A mock would agree with whatever this file believed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DATABASE_KEY_BYTES, closeDatabase, openDatabase, type SqliteDatabase } from '../connection'
import { createQueryBuilder, type CofferDb } from '../kysely'
import { runMigrations, rollbackMigrations } from '../migrate'
import { MIGRATIONS } from '../migrations'

import {
  archiveParty,
  assertPartiesActive,
  createParty,
  deleteParty,
  getParty,
  listParties,
  updateParty,
} from './parties'
import { isRepoError, type RepoError, type RepoErrorCode } from './errors'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x5a)

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase
let db: CofferDb

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-parties-'))
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
  } catch (error) {
    return isRepoError(error) ? error.code : `not a RepoError: ${String(error)}`
  }
  return 'no error thrown'
}

async function failureOf(action: () => Promise<unknown>): Promise<RepoError> {
  try {
    await action()
  } catch (error) {
    if (isRepoError(error)) {
      return error
    }
    throw error
  }
  throw new Error('Expected the action to fail, and it did not.')
}

const customer = (name: string, over: Record<string, unknown> = {}) =>
  createParty(db, { name, countryCode: 'in', isCustomer: true, ...over })

/**
 * A party written straight to the table, bypassing the repository.
 *
 * The only way to test a constraint that the repository also checks. Every rule tested
 * through `createParty` is answered by whichever layer happens to run first, which is how
 * a test keeps passing against a database that has stopped enforcing anything.
 */
function writeParty(id: string, name: string, registrationNumber: string | null = null): void {
  connection
    .prepare(
      `INSERT INTO parties (id, name, country_code, is_customer, registration_number, created_at, updated_at)
       VALUES (?, ?, 'in', 1, ?, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z')`,
    )
    .run(id, name, registrationNumber)
}

describe('migration 0005', () => {
  it('creates parties and rolls back cleanly', () => {
    const tableNames = () =>
      connection
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
        )
        .all()
        .map((row) => row.name)

    expect(tableNames()).toContain('parties')

    rollbackMigrations(connection, MIGRATIONS, { to: '0004' })
    expect(tableNames()).not.toContain('parties')
  })

  it('leaves journal_lines usable after the rollback drops party_id', () => {
    /* A `down` that removes a column has to remove the index naming it first, or the
     * rollback fails half way and leaves a database nothing can migrate forward. */
    rollbackMigrations(connection, MIGRATIONS, { to: '0004' })

    const columns = connection
      .prepare<[], { name: string }>(`PRAGMA table_info(journal_lines)`)
      .all()
      .map((row) => row.name)

    expect(columns).toContain('debit')
    expect(columns).not.toContain('party_id')
  })

  it('refuses a party that is neither a customer nor a vendor', () => {
    /* The CHECK, put to the database directly — the repository check is tested below and
     * the two must not be the same test. */
    expect(() =>
      connection
        .prepare(
          `INSERT INTO parties (id, name, country_code, is_customer, is_vendor, created_at, updated_at)
           VALUES ('p', 'Nobody', 'in', 0, 0, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK/i)
  })

  /*
   * The four rules below are enforced twice — here and in the repository — and every one
   * of them survived its first mutation because the repository check ran first. This is
   * the batch 1.1A finding for the third time: defence in depth makes a test blind to
   * losing a layer unless something goes at the database directly.
   */

  it('refuses a blank name', () => {
    expect(() => writeParty('p-blank', '   ')).toThrow(/CHECK/i)
  })

  it('refuses a name another party holds, ignoring case', () => {
    writeParty('p-1', 'Acme Traders')
    expect(() => writeParty('p-2', 'ACME TRADERS')).toThrow(/UNIQUE/i)
  })

  it('refuses a registration number another party holds, ignoring case', () => {
    writeParty('p-1', 'Acme Traders', '33AABCC1234D1ZI')
    expect(() => writeParty('p-2', 'Another Firm', '33aabcc1234d1zi')).toThrow(/UNIQUE/i)
  })

  it('lets any number of parties carry no registration number', () => {
    /* NULLs do not collide in a unique index, which is what makes unregistered parties
     * possible at all. The index is partial only so it does not carry those rows. */
    writeParty('p-1', 'First Unregistered')
    expect(() => writeParty('p-2', 'Second Unregistered')).not.toThrow()
  })

  it('refuses a credit limit that is not money at two places', () => {
    const write = (limit: string) =>
      connection
        .prepare(
          `INSERT INTO parties (id, name, country_code, is_customer, credit_limit, created_at, updated_at)
           VALUES (?, ?, 'in', 1, ?, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z')`,
        )
        .run(`p-${limit}`, `Party ${limit}`, limit)

    expect(() => write('1000')).toThrow(/CHECK/i)
    expect(() => write('1000.5')).toThrow(/CHECK/i)
    expect(() => write('-1.00')).toThrow(/CHECK/i)
    expect(() => write('1000.00')).not.toThrow()
  })
})

describe('creating a party', () => {
  it('keeps what it was given', async () => {
    const party = await customer('Acme Traders', {
      legalName: 'Acme Traders Private Limited',
      registrationNumber: '33AABCC1234D1ZI',
      jurisdictionCode: '33',
      city: 'Coimbatore',
      paymentTermsDays: 30,
      creditLimit: '250000.00',
    })

    expect(party.name).toBe('Acme Traders')
    expect(party.legalName).toBe('Acme Traders Private Limited')
    expect(party.registrationNumber).toBe('33AABCC1234D1ZI')
    expect(party.jurisdictionCode).toBe('33')
    expect(party.isCustomer).toBe(true)
    expect(party.isVendor).toBe(false)
    expect(party.paymentTermsDays).toBe(30)
    expect(party.creditLimit).toBe('250000.00')
    expect(party.isArchived).toBe(false)
  })

  it('is one record that can be both', async () => {
    /* The reason there is one table and not two: the firm you sell to is often the firm
     * you buy transport from, and two records would mean two balances to set off. */
    const both = await createParty(db, {
      name: 'Both Ways Logistics',
      countryCode: 'in',
      isCustomer: true,
      isVendor: true,
    })

    expect(both.isCustomer).toBe(true)
    expect(both.isVendor).toBe(true)
  })

  it('refuses one that is neither', async () => {
    expect(await codeOf(() => createParty(db, { name: 'Nobody', countryCode: 'in' }))).toBe(
      'PARTY_HAS_NO_ROLE',
    )
  })

  it('refuses a blank name', async () => {
    expect(await codeOf(() => customer('   '))).toBe('PARTY_NAME_REQUIRED')
  })

  it('trims what it stores', async () => {
    const party = await customer('  Spaced Out Traders  ', { city: '  Chennai  ' })
    expect(party.name).toBe('Spaced Out Traders')
    expect(party.city).toBe('Chennai')
  })

  it('stores an empty optional field as null rather than as an empty string', async () => {
    /* Otherwise a screen has to test for both, and one of the two tests gets forgotten. */
    const party = await customer('Minimal Traders', { city: '', email: '   ', notes: null })
    expect(party.city).toBeNull()
    expect(party.email).toBeNull()
    expect(party.notes).toBeNull()
  })

  it('lower-cases the country code, because it is an ISO code and not a label', async () => {
    expect((await customer('Upper Case Ltd', { countryCode: 'IN' })).countryCode).toBe('in')
  })
})

describe('names are unique, ignoring case', () => {
  it('refuses a name another party already holds', async () => {
    await customer('Acme Traders')
    expect(await codeOf(() => customer('Acme Traders'))).toBe('PARTY_NAME_TAKEN')
  })

  it('refuses one that differs only in case', async () => {
    /* Two rows reading `Acme Traders` and `ACME TRADERS` in a picker is an invoice
     * raised against the wrong one, and no report would ever show it. */
    await customer('Acme Traders')
    expect(await codeOf(() => customer('ACME TRADERS'))).toBe('PARTY_NAME_TAKEN')
  })

  it('says which name clashed, from the repository', async () => {
    /* `details` is only populated by the repository. Without this the test would pass
     * against a repository that had stopped checking and left it to the index — which
     * reports a constraint name rather than the name that clashed. */
    await customer('Acme Traders')
    const failure = await failureOf(() => customer('acme traders'))

    expect(failure.code).toBe('PARTY_NAME_TAKEN')
    expect(failure.details).toMatchObject({ existingName: 'Acme Traders' })
  })

  it('lets a party keep its own name through an update', async () => {
    const party = await customer('Acme Traders')
    const updated = await updateParty(db, { id: party.id, name: 'Acme Traders', city: 'Salem' })
    expect(updated.city).toBe('Salem')
  })
})

describe('registration numbers', () => {
  it('refuses two parties carrying the same one', async () => {
    await customer('Acme Traders', { registrationNumber: '33AABCC1234D1ZI' })
    expect(
      await codeOf(() =>
        customer('Acme Traders Chennai', { registrationNumber: '33AABCC1234D1ZI' }),
      ),
    ).toBe('PARTY_REGISTRATION_TAKEN')
  })

  it('ignores case, because a GSTIN is not case-sensitive', async () => {
    await customer('Acme Traders', { registrationNumber: '33AABCC1234D1ZI' })
    expect(
      await codeOf(() => customer('Another Firm', { registrationNumber: '33aabcc1234d1zi' })),
    ).toBe('PARTY_REGISTRATION_TAKEN')
  })

  it('allows any number of unregistered parties', async () => {
    /* NULLs are distinct in a SQLite unique index, which is exactly right — two
     * unregistered parties are not duplicates of each other. */
    await customer('First Unregistered')
    await customer('Second Unregistered')
    expect((await listParties(db)).length).toBe(2)
  })

  it("does not validate the number, which is the regime's business", async () => {
    /* `db/` may not import a concrete regime. Uniqueness is the only part of this that
     * needs a database, and it is the only part enforced here. */
    const party = await customer('Nonsense GSTIN Ltd', { registrationNumber: 'NOT-A-GSTIN' })
    expect(party.registrationNumber).toBe('NOT-A-GSTIN')
  })
})

describe('updating a party', () => {
  it('writes only the fields that were sent', async () => {
    const party = await customer('Acme Traders', { city: 'Coimbatore', email: 'a@example.com' })
    const updated = await updateParty(db, { id: party.id, city: 'Salem' })

    expect(updated.city).toBe('Salem')
    /* The screen that edited the city never showed the email, and must not blank it. */
    expect(updated.email).toBe('a@example.com')
  })

  it('clears a field that was sent as null', async () => {
    const party = await customer('Acme Traders', { email: 'a@example.com' })
    const updated = await updateParty(db, { id: party.id, email: null })
    expect(updated.email).toBeNull()
  })

  it('refuses to leave a party as neither customer nor vendor', async () => {
    const party = await customer('Acme Traders')
    expect(await codeOf(() => updateParty(db, { id: party.id, isCustomer: false }))).toBe(
      'PARTY_HAS_NO_ROLE',
    )
  })

  it('allows dropping one role while the other stands', async () => {
    const party = await createParty(db, {
      name: 'Both Ways Logistics',
      countryCode: 'in',
      isCustomer: true,
      isVendor: true,
    })
    const updated = await updateParty(db, { id: party.id, isCustomer: false })

    expect(updated.isCustomer).toBe(false)
    expect(updated.isVendor).toBe(true)
  })

  it('moves updated_at and leaves created_at alone', async () => {
    const party = await customer('Acme Traders')
    const updated = await updateParty(db, { id: party.id, city: 'Salem' })

    expect(updated.createdAt).toBe(party.createdAt)
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(party.updatedAt))
  })

  it('refuses a party that does not exist', async () => {
    expect(await codeOf(() => updateParty(db, { id: 'nobody', city: 'Salem' }))).toBe(
      'PARTY_NOT_FOUND',
    )
  })
})

describe('the credit limit', () => {
  it('keeps null and 0.00 apart', async () => {
    /* No limit, versus a limit of nothing — which is how a business says "pays up
     * front". Coercing one into the other extends credit to somebody who was cut off. */
    const noLimit = await customer('No Limit Ltd')
    const cutOff = await customer('Cut Off Ltd', { creditLimit: '0.00' })

    expect(noLimit.creditLimit).toBeNull()
    expect(cutOff.creditLimit).toBe('0.00')
  })

  it('normalises what it is given to money scale', async () => {
    expect((await customer('Rounded Ltd', { creditLimit: '5000' })).creditLimit).toBe('5000.00')
  })

  it('refuses a negative limit', async () => {
    expect(await codeOf(() => customer('Negative Ltd', { creditLimit: '-100.00' }))).toBe(
      'INVALID_AMOUNT',
    )
  })

  it('refuses something that is not an amount', async () => {
    expect(await codeOf(() => customer('Nonsense Ltd', { creditLimit: 'lots' }))).toBe(
      'INVALID_AMOUNT',
    )
  })

  it('treats an empty string as no limit', async () => {
    expect((await customer('Blank Ltd', { creditLimit: '' })).creditLimit).toBeNull()
  })
})

describe('listing', () => {
  beforeEach(async () => {
    await customer('Zebra Traders', { city: 'Madurai' })
    await createParty(db, { name: 'Anvil Supplies', countryCode: 'in', isVendor: true })
    await createParty(db, {
      name: 'middle ground',
      countryCode: 'in',
      isCustomer: true,
      isVendor: true,
    })
  })

  it('orders by name, ignoring case', async () => {
    /* Sorted by the raw column, `middle ground` sorts after `Zebra Traders`, because
     * lower-case letters come after upper-case ones in ASCII. */
    expect((await listParties(db)).map((party) => party.name)).toEqual([
      'Anvil Supplies',
      'middle ground',
      'Zebra Traders',
    ])
  })

  it('offers only customers when asked for customers', async () => {
    expect((await listParties(db, { role: 'customer' })).map((party) => party.name)).toEqual([
      'middle ground',
      'Zebra Traders',
    ])
  })

  it('offers only vendors when asked for vendors', async () => {
    expect((await listParties(db, { role: 'vendor' })).map((party) => party.name)).toEqual([
      'Anvil Supplies',
      'middle ground',
    ])
  })

  it('counts a party that is both on either list', async () => {
    const customers = await listParties(db, { role: 'customer' })
    const vendors = await listParties(db, { role: 'vendor' })

    expect(customers.map((party) => party.name)).toContain('middle ground')
    expect(vendors.map((party) => party.name)).toContain('middle ground')
  })

  it('hides archived parties by default and shows them when asked', async () => {
    const zebra = (await listParties(db)).find((party) => party.name === 'Zebra Traders')!
    await archiveParty(db, zebra.id, true)

    expect((await listParties(db)).map((party) => party.name)).not.toContain('Zebra Traders')
    expect((await listParties(db, { includeArchived: true })).map((party) => party.name)).toContain(
      'Zebra Traders',
    )
  })

  it('searches the name, the registration number and the city', async () => {
    await customer('Findable Ltd', { registrationNumber: '29AAAAA0000A1ZY', city: 'Bengaluru' })

    expect((await listParties(db, { search: 'findable' })).map((p) => p.name)).toEqual([
      'Findable Ltd',
    ])
    expect((await listParties(db, { search: '29AAAAA' })).map((p) => p.name)).toEqual([
      'Findable Ltd',
    ])
    expect((await listParties(db, { search: 'bengal' })).map((p) => p.name)).toEqual([
      'Findable Ltd',
    ])
  })

  it('ignores a blank search rather than matching nothing', async () => {
    expect((await listParties(db, { search: '   ' })).length).toBe(3)
  })

  it('carries the city on the summary, because it is what tells two firms apart', async () => {
    const zebra = (await listParties(db)).find((party) => party.name === 'Zebra Traders')
    expect(zebra?.city).toBe('Madurai')
  })
})

describe('archiving and deleting', () => {
  it('archives and unarchives, because businesses come back', async () => {
    const party = await customer('Acme Traders')

    expect((await archiveParty(db, party.id, true)).isArchived).toBe(true)
    expect((await archiveParty(db, party.id, false)).isArchived).toBe(false)
  })

  it('deletes one nothing has been posted against', async () => {
    const party = await customer('Never Traded Ltd')
    await deleteParty(db, party.id)
    expect(await getParty(db, party.id)).toBeNull()
  })

  it('refuses to delete one that does not exist', async () => {
    expect(await codeOf(() => deleteParty(db, 'nobody'))).toBe('PARTY_NOT_FOUND')
  })
})

describe('assertPartiesActive', () => {
  it('passes an empty list without asking the database anything', async () => {
    await expect(assertPartiesActive(db, [])).resolves.toBeUndefined()
  })

  it('refuses an archived party by name', async () => {
    const party = await customer('Gone Away Ltd')
    await archiveParty(db, party.id, true)

    const failure = await failureOf(() => assertPartiesActive(db, [party.id]))
    expect(failure.code).toBe('PARTY_ARCHIVED')
    expect(failure.details).toMatchObject({ name: 'Gone Away Ltd' })
  })

  it('refuses one that does not exist', async () => {
    expect(await codeOf(() => assertPartiesActive(db, ['nobody']))).toBe('PARTY_NOT_FOUND')
  })

  it('checks every party, not only the first', async () => {
    const good = await customer('Still Trading Ltd')
    const bad = await customer('Gone Away Ltd')
    await archiveParty(db, bad.id, true)

    expect(await codeOf(() => assertPartiesActive(db, [good.id, bad.id]))).toBe('PARTY_ARCHIVED')
  })

  it('asks about a repeated party once', async () => {
    const party = await customer('Repeated Ltd')
    await expect(assertPartiesActive(db, [party.id, party.id, party.id])).resolves.toBeUndefined()
  })
})
