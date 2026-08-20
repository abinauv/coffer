/*
 * Against a real encrypted database, like every other repository test here.
 *
 * What is worth putting to the database rather than to a mock: the code is the primary
 * key and SQLite compares a TEXT key case-sensitively, so `KG` and `kg` are two rows
 * unless a CHECK says otherwise; the foreign key from `items.unit_code` is case-sensitive
 * too. A mock would agree with whatever this file believed about either.
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
  archiveUnit,
  createUnit,
  deleteUnit,
  getUnit,
  listUnits,
  requireActiveUnit,
  updateUnit,
} from './units'
import { createItem } from './items'
import { isRepoError, type RepoError, type RepoErrorCode } from './errors'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x5a)

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase
let db: CofferDb

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-units-'))
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

const AT = '2026-08-19T00:00:00.000Z'

/**
 * A unit written straight to the table, bypassing the repository.
 *
 * The only way to test a constraint the repository also enforces. Every rule tested
 * through `createUnit` is answered by whichever layer happens to run first, which is how
 * a test keeps passing against a database that has stopped enforcing anything.
 */
function writeUnit(code: string, over: Record<string, string | number | null> = {}): void {
  const row: Record<string, string | number | null> = {
    code,
    name: 'A unit',
    decimal_places: 3,
    created_at: AT,
    updated_at: AT,
    ...over,
  }
  const columns = Object.keys(row)
  connection
    .prepare(
      `INSERT INTO units_of_measure (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(...Object.values(row))
}

describe('migration 0006', () => {
  const tableNames = () =>
    connection
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
      )
      .all()
      .map((row) => row.name)

  it('creates both tables and rolls back cleanly', () => {
    expect(tableNames()).toContain('units_of_measure')
    expect(tableNames()).toContain('items')

    /* To '0005' and not to '0006': rolling back TO a migration leaves it applied.
     * 0007 is registered after this one and is reverted first — a rollback runs in
     * descending order — so this also proves 0006's `down` survives running while a
     * later migration's tables are already gone. */
    rollbackMigrations(connection, MIGRATIONS, { to: '0005' })

    expect(tableNames()).not.toContain('units_of_measure')
    expect(tableNames()).not.toContain('items')
    expect(tableNames()).toContain('parties')
  })

  it('leaves a database that migrates forward again', () => {
    /* A `down` that drops a parent table before its child leaves a foreign key pointing
     * at nothing, and the next `runMigrations` fails against a file nobody can repair. */
    rollbackMigrations(connection, MIGRATIONS, { to: '0005' })
    runMigrations(connection, MIGRATIONS)

    expect(tableNames()).toContain('units_of_measure')
    expect(tableNames()).toContain('items')
  })

  it('rolls back a database that has units and items in it', () => {
    /* Measured, not assumed, and it is the reason `down` drops `items` first: with
     * foreign keys on, DROP TABLE performs an implicit delete of every row, so dropping
     * `units_of_measure` while an item still names one is a foreign key violation and the
     * rollback stops half way. On empty tables the wrong order passes and tells nobody. */
    writeUnit('KG')
    connection
      .prepare(
        `INSERT INTO items (id, name, kind, unit_code, is_sold, created_at, updated_at)
         VALUES ('i-1', 'Rice', 'goods', 'KG', 1, ?, ?)`,
      )
      .run(AT, AT)

    rollbackMigrations(connection, MIGRATIONS, { to: '0005' })
    expect(tableNames()).not.toContain('units_of_measure')
  })

  /*
   * The rules below are enforced twice — here and in the repository — and a test that
   * goes through the repository passes whichever layer answers first. Each of these goes
   * at the table directly. CONVENTIONS §6, "defence in depth makes tests blind".
   */

  it('refuses a code that is not upper case', () => {
    /* The whole reason the CHECK exists: without it `kg` is simply a second primary key,
     * and the business ends up with two units that print differently and total apart. */
    expect(() => writeUnit('kg')).toThrow(/CHECK/i)
    expect(() => writeUnit('Kg')).toThrow(/CHECK/i)
    expect(() => writeUnit('KG')).not.toThrow()
  })

  it('refuses a code with space around it', () => {
    expect(() => writeUnit(' KG')).toThrow(/CHECK/i)
    expect(() => writeUnit('KG ')).toThrow(/CHECK/i)
  })

  it('refuses a blank code', () => {
    expect(() => writeUnit('')).toThrow(/CHECK/i)
    expect(() => writeUnit('   ')).toThrow(/CHECK/i)
  })

  it('refuses a blank name', () => {
    expect(() => writeUnit('KG', { name: '   ' })).toThrow(/CHECK/i)
  })

  it('refuses a flag that is neither 0 nor 1', () => {
    expect(() => writeUnit('KG', { is_archived: 2 })).toThrow(/CHECK/i)
  })

  it('refuses decimal places outside 0 to 3', () => {
    expect(() => writeUnit('U0', { decimal_places: 0 })).not.toThrow()
    expect(() => writeUnit('U3', { decimal_places: 3 })).not.toThrow()
    expect(() => writeUnit('U4', { decimal_places: 4 })).toThrow(/CHECK/i)
    expect(() => writeUnit('UN', { decimal_places: -1 })).toThrow(/CHECK/i)
  })

  it('refuses to delete a unit an item is measured in', () => {
    /* ON DELETE RESTRICT. The repository says the same thing in a sentence, and this is
     * what holds when something reaches the table another way. */
    writeUnit('KG')
    connection
      .prepare(
        `INSERT INTO items (id, name, kind, unit_code, is_sold, created_at, updated_at)
         VALUES ('i-1', 'Rice', 'goods', 'KG', 1, ?, ?)`,
      )
      .run(AT, AT)

    expect(() =>
      connection.prepare(`DELETE FROM units_of_measure WHERE code = 'KG'`).run(),
    ).toThrow(/FOREIGN KEY/i)
  })

  it('matches an item to its unit case-sensitively', () => {
    /* Measured, not read: a foreign key onto a TEXT primary key compares exactly, so an
     * item written with `kg` against a unit stored as `KG` is refused outright. This is
     * why the items repository writes the code the unit gave it rather than the caller's. */
    writeUnit('KG')
    expect(() =>
      connection
        .prepare(
          `INSERT INTO items (id, name, kind, unit_code, is_sold, created_at, updated_at)
           VALUES ('i-1', 'Rice', 'goods', 'kg', 1, ?, ?)`,
        )
        .run(AT, AT),
    ).toThrow(/FOREIGN KEY/i)
  })
})

describe('creating a unit', () => {
  it('keeps what it was given', async () => {
    const unit = await createUnit(db, {
      code: 'KGS',
      name: 'Kilograms',
      decimalPlaces: 3,
      regimeCode: 'KGS',
    })

    expect(unit.code).toBe('KGS')
    expect(unit.name).toBe('Kilograms')
    expect(unit.decimalPlaces).toBe(3)
    expect(unit.regimeCode).toBe('KGS')
    expect(unit.isArchived).toBe(false)
  })

  it('upper-cases and trims the code, because the code is the identity', async () => {
    const unit = await createUnit(db, { code: '  kg  ', name: 'Kilograms' })
    expect(unit.code).toBe('KG')
  })

  it('takes a unit the business made up, which is the point', async () => {
    /* Not `Nos/Sets/Kg/Mtr`, and not silently rewritten to one of them — that is the
     * reference project's bug this codebase exists partly to not repeat. */
    const unit = await createUnit(db, { code: 'BUNDLE', name: 'Bundles', decimalPlaces: 0 })
    expect(unit.code).toBe('BUNDLE')
    expect(unit.decimalPlaces).toBe(0)
  })

  it('defaults to three decimal places, which is what the column already permits', async () => {
    expect((await createUnit(db, { code: 'LTR', name: 'Litres' })).decimalPlaces).toBe(3)
  })

  it('keeps zero decimal places, because half a box is not a quantity', async () => {
    expect(
      (await createUnit(db, { code: 'BOX', name: 'Boxes', decimalPlaces: 0 })).decimalPlaces,
    ).toBe(0)
  })

  it('refuses a blank code', async () => {
    expect(await codeOf(() => createUnit(db, { code: '   ', name: 'Nothing' }))).toBe(
      'UNIT_CODE_REQUIRED',
    )
  })

  it('refuses a code another unit already holds', async () => {
    await createUnit(db, { code: 'KG', name: 'Kilograms' })
    expect(await codeOf(() => createUnit(db, { code: 'KG', name: 'Kilogrammes' }))).toBe(
      'UNIT_CODE_TAKEN',
    )
  })

  it('refuses one that differs only in case', async () => {
    await createUnit(db, { code: 'KG', name: 'Kilograms' })
    expect(await codeOf(() => createUnit(db, { code: 'kg', name: 'Kilogrammes' }))).toBe(
      'UNIT_CODE_TAKEN',
    )
  })

  it('stores a blank regime code as null rather than as an empty string', async () => {
    /* Otherwise the filing layer has to test for both, and one of the two gets forgotten. */
    const unit = await createUnit(db, { code: 'BAGS', name: 'Bags', regimeCode: '   ' })
    expect(unit.regimeCode).toBeNull()
  })

  it('keeps the filing code separate from the code that prints', async () => {
    /* The whole reason `regime_code` is a second column: India's UQC is a closed set and
     * a company's own units are not. `BAGS` on the invoice, `BAG` in the return. */
    const unit = await createUnit(db, { code: 'BAGS', name: 'Bags', regimeCode: 'BAG' })
    expect(unit.code).toBe('BAGS')
    expect(unit.regimeCode).toBe('BAG')
  })

  it("does not validate the filing code, which is the regime's business", async () => {
    expect(
      (await createUnit(db, { code: 'X', name: 'X', regimeCode: 'NOT-A-UQC' })).regimeCode,
    ).toBe('NOT-A-UQC')
  })

  it('leaves decimal places to the CHECK rather than restating the range', async () => {
    /* Deliberate: a four-way choice in the UI, so anything else is a caller bug and not
     * a sentence for a user. The rule lives in 0006 and in exactly one place. */
    await expect(createUnit(db, { code: 'BAD', name: 'Bad', decimalPlaces: 4 })).rejects.toThrow(
      /CHECK/i,
    )
  })
})

describe('reading units', () => {
  beforeEach(async () => {
    await createUnit(db, { code: 'NOS', name: 'Numbers', decimalPlaces: 0 })
    await createUnit(db, { code: 'BAGS', name: 'Bags', decimalPlaces: 0 })
    await createUnit(db, { code: 'KG', name: 'Kilograms' })
  })

  it('finds a unit whoever typed it did not shift for', async () => {
    expect((await getUnit(db, 'kg'))?.code).toBe('KG')
    expect((await getUnit(db, '  Kg '))?.code).toBe('KG')
  })

  it('returns null for a unit that is not there', async () => {
    expect(await getUnit(db, 'MTR')).toBeNull()
  })

  it('orders by code, which is what the user is looking for', async () => {
    expect((await listUnits(db)).map((unit) => unit.code)).toEqual(['BAGS', 'KG', 'NOS'])
  })

  it('hides archived units by default and shows them when asked', async () => {
    await archiveUnit(db, 'BAGS', true)

    expect((await listUnits(db)).map((unit) => unit.code)).toEqual(['KG', 'NOS'])
    expect((await listUnits(db, { includeArchived: true })).map((unit) => unit.code)).toEqual([
      'BAGS',
      'KG',
      'NOS',
    ])
  })
})

describe('updating a unit', () => {
  beforeEach(async () => {
    await createUnit(db, { code: 'KG', name: 'Kilograms', regimeCode: 'KGS' })
  })

  it('writes only the fields that were sent', async () => {
    const updated = await updateUnit(db, { code: 'KG', name: 'Kilogrammes' })

    expect(updated.name).toBe('Kilogrammes')
    /* The screen that corrected the spelling never showed the filing code. */
    expect(updated.regimeCode).toBe('KGS')
    expect(updated.decimalPlaces).toBe(3)
  })

  it('clears the filing code when it is sent as null', async () => {
    expect((await updateUnit(db, { code: 'KG', regimeCode: null })).regimeCode).toBeNull()
  })

  /*
   * Absent is not null, tested from the other side. The test above proves a field that
   * WAS sent lands; this proves a field that was NOT sent is not written — which is a
   * different statement, and the one a screen editing a single field depends on. Without
   * it, writing every field unconditionally passed every test in this file.
   */
  it('does not write a field the update never mentions', async () => {
    const updated = await updateUnit(db, { code: 'KG', decimalPlaces: 0 })

    expect(updated.name).toBe('Kilograms')
    expect(updated.regimeCode).toBe('KGS')
    expect(updated.decimalPlaces).toBe(0)
  })

  it('narrows the decimal places a unit permits', async () => {
    expect((await updateUnit(db, { code: 'KG', decimalPlaces: 0 })).decimalPlaces).toBe(0)
  })

  it('takes the code in whatever case it was given', async () => {
    expect((await updateUnit(db, { code: 'kg', name: 'Kilogrammes' })).name).toBe('Kilogrammes')
  })

  it('refuses a unit that does not exist', async () => {
    expect(await codeOf(() => updateUnit(db, { code: 'MTR', name: 'Metres' }))).toBe(
      'UNIT_NOT_FOUND',
    )
  })
})

describe('archiving and deleting', () => {
  it('archives and unarchives, because a product line comes back', async () => {
    await createUnit(db, { code: 'KG', name: 'Kilograms' })

    expect((await archiveUnit(db, 'KG', true)).isArchived).toBe(true)
    expect((await archiveUnit(db, 'KG', false)).isArchived).toBe(false)
  })

  it('deletes a unit nothing is measured in', async () => {
    await createUnit(db, { code: 'MTR', name: 'Metres' })
    await deleteUnit(db, 'MTR')
    expect(await getUnit(db, 'MTR')).toBeNull()
  })

  it('refuses to delete a unit an item uses, and says which item', async () => {
    await createUnit(db, { code: 'KG', name: 'Kilograms' })
    await createItem(db, { name: 'Basmati rice', kind: 'goods', unitCode: 'KG', isSold: true })

    const failure = await failureOf(() => deleteUnit(db, 'KG'))
    expect(failure.code).toBe('UNIT_IN_USE')
    expect(failure.details).toMatchObject({ itemName: 'Basmati rice' })
  })

  it('refuses to delete one that does not exist', async () => {
    expect(await codeOf(() => deleteUnit(db, 'MTR'))).toBe('UNIT_NOT_FOUND')
  })
})

describe('requireActiveUnit', () => {
  it('returns the stored code for whatever case it was given', async () => {
    await createUnit(db, { code: 'KG', name: 'Kilograms' })
    expect((await requireActiveUnit(db, 'kg')).code).toBe('KG')
  })

  it('refuses an archived unit by code', async () => {
    await createUnit(db, { code: 'KG', name: 'Kilograms' })
    await archiveUnit(db, 'KG', true)

    const failure = await failureOf(() => requireActiveUnit(db, 'KG'))
    expect(failure.code).toBe('UNIT_ARCHIVED')
    expect(failure.details).toMatchObject({ code: 'KG' })
  })

  it('refuses one that does not exist', async () => {
    expect(await codeOf(() => requireActiveUnit(db, 'MTR'))).toBe('UNIT_NOT_FOUND')
  })
})
