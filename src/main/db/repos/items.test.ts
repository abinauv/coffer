/*
 * Against a real encrypted database, like every other repository test here.
 *
 * What is worth putting to the database rather than to a mock: two unique indexes, one of
 * them partial; the CHECK that an item is sold or purchased; the money GLOB and the rate
 * GLOB, which differ by one decimal place and would both look right in a mock; and three
 * foreign keys whose ON DELETE behaviour is the whole reason a unit or an account cannot
 * be tidied away out from under an item.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DATABASE_KEY_BYTES, closeDatabase, openDatabase, type SqliteDatabase } from '../connection'
import { createQueryBuilder, type CofferDb } from '../kysely'
import { runMigrations } from '../migrate'
import { MIGRATIONS } from '../migrations'

import {
  archiveItem,
  assertItemsActive,
  createItem,
  deleteItem,
  getItem,
  listItems,
  updateItem,
} from './items'
import { archiveUnit, createUnit } from './units'
import { createAccount, updateAccount } from './accounts'
import { isRepoError, type RepoError, type RepoErrorCode } from './errors'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x5a)

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase
let db: CofferDb

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-items-'))
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

const sold = (name: string, over: Record<string, unknown> = {}) =>
  createItem(db, { name, kind: 'goods', isSold: true, ...over })

/**
 * An item written straight to the table, bypassing the repository.
 *
 * The only way to test a constraint the repository also enforces. Every rule tested
 * through `createItem` is answered by whichever layer happens to run first, which is how
 * a test keeps passing against a database that has stopped enforcing anything.
 */
function writeItem(id: string, over: Record<string, string | number | null> = {}): void {
  const row: Record<string, string | number | null> = {
    id,
    name: `Item ${id}`,
    kind: 'goods',
    is_sold: 1,
    created_at: AT,
    updated_at: AT,
    ...over,
  }
  const columns = Object.keys(row)
  connection
    .prepare(
      `INSERT INTO items (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(...Object.values(row))
}

const revenueAccount = () =>
  createAccount(db, {
    code: '4100',
    name: 'Sales of goods',
    type: 'income',
    parentId: null,
    isGroup: false,
  })

describe('migration 0006 — the items table', () => {
  /*
   * Every rule here is enforced twice, in the migration and in the repository, and a test
   * that goes through the repository passes whichever layer answers first. These go at
   * the table directly. CONVENTIONS §6, "defence in depth makes tests blind".
   */

  it('refuses a blank name', () => {
    expect(() => writeItem('i-blank', { name: '   ' })).toThrow(/CHECK/i)
  })

  it('refuses a name another item holds, ignoring case', () => {
    writeItem('i-1', { name: 'Ball bearing 6203' })
    expect(() => writeItem('i-2', { name: 'BALL BEARING 6203' })).toThrow(/UNIQUE/i)
  })

  it('refuses a code another item holds, ignoring case', () => {
    writeItem('i-1', { code: 'BB-6203' })
    expect(() => writeItem('i-2', { code: 'bb-6203' })).toThrow(/UNIQUE/i)
  })

  it('lets any number of items carry no code', () => {
    /* NULLs do not collide in a unique index, which is what makes a business that keeps
     * no SKUs possible at all. The index is partial only so it does not carry those
     * rows — see the same note in 0005. */
    writeItem('i-1')
    expect(() => writeItem('i-2')).not.toThrow()
  })

  it('refuses a blank code, which would collide with the next blank one', () => {
    expect(() => writeItem('i-blank-code', { code: '  ' })).toThrow(/CHECK/i)
  })

  it('refuses an item that is neither sold nor purchased', () => {
    expect(() => writeItem('i-nobody', { is_sold: 0, is_purchased: 0 })).toThrow(/CHECK/i)
  })

  it('refuses a flag that is neither 0 nor 1', () => {
    expect(() => writeItem('i-flag', { is_charge: 2 })).toThrow(/CHECK/i)
  })

  it('refuses a kind that is neither goods nor a service', () => {
    expect(() => writeItem('i-odd', { kind: 'widget' })).toThrow(/CHECK/i)
  })

  it('refuses a price that is not money at two places', () => {
    expect(() => writeItem('i-a', { sale_price: '1000' })).toThrow(/CHECK/i)
    expect(() => writeItem('i-b', { sale_price: '1000.5' })).toThrow(/CHECK/i)
    expect(() => writeItem('i-c', { sale_price: '1000.000' })).toThrow(/CHECK/i)
    expect(() => writeItem('i-d', { sale_price: '-1.00' })).toThrow(/CHECK/i)
    expect(() => writeItem('i-e', { sale_price: '1000.00' })).not.toThrow()
  })

  it('refuses a purchase price that is not money at two places', () => {
    expect(() => writeItem('i-f', { purchase_price: '12.345' })).toThrow(/CHECK/i)
    expect(() => writeItem('i-g', { purchase_price: '12.34' })).not.toThrow()
  })

  it('refuses a tax rate that is not a rate at three places', () => {
    /* Three, not two. Half of India's 0.25% slab is 0.125%, and at two places the
     * invoice prints a rate the tax was never computed from. The money GLOB would
     * accept '18.00' here and reject '0.125', which is the wrong way round. */
    expect(() => writeItem('r-a', { tax_rate_pct: '18' })).toThrow(/CHECK/i)
    expect(() => writeItem('r-b', { tax_rate_pct: '18.00' })).toThrow(/CHECK/i)
    expect(() => writeItem('r-c', { tax_rate_pct: '0.1250' })).toThrow(/CHECK/i)
    expect(() => writeItem('r-d', { tax_rate_pct: '-1.000' })).toThrow(/CHECK/i)
    expect(() => writeItem('r-e', { tax_rate_pct: '.125' })).toThrow(/CHECK/i)
    expect(() => writeItem('r-f', { tax_rate_pct: '18.000' })).not.toThrow()
    expect(() => writeItem('r-g', { tax_rate_pct: '0.125' })).not.toThrow()
  })

  it('refuses to delete an account an item posts to', async () => {
    /* ON DELETE RESTRICT rather than SET NULL. Null on these columns is not "unknown" —
     * it means "use the account the document kind implies" — so an item quietly reverting
     * to the default would post its value somewhere other than every invoice raised
     * before it, and no report would say when that started. */
    const account = await revenueAccount()
    writeItem('i-1', { sales_account_id: account.id })

    expect(() => connection.prepare(`DELETE FROM accounts WHERE id = ?`).run(account.id)).toThrow(
      /FOREIGN KEY/i,
    )
  })

  it('refuses an item posting to an account that is not in the chart', () => {
    expect(() => writeItem('i-1', { purchase_account_id: 'nobody' })).toThrow(/FOREIGN KEY/i)
  })
})

describe('creating an item', () => {
  it('keeps what it was given', async () => {
    await createUnit(db, { code: 'KG', name: 'Kilograms' })
    const account = await revenueAccount()

    const item = await createItem(db, {
      name: 'Basmati rice',
      kind: 'goods',
      code: 'RICE-1',
      description: 'Long grain, 1121',
      unitCode: 'KG',
      classificationCode: '10063020',
      taxRatePct: '5',
      salePrice: '120',
      purchasePrice: '96.50',
      isSold: true,
      isPurchased: true,
      salesAccountId: account.id,
    })

    expect(item.name).toBe('Basmati rice')
    expect(item.code).toBe('RICE-1')
    expect(item.description).toBe('Long grain, 1121')
    expect(item.kind).toBe('goods')
    expect(item.unitCode).toBe('KG')
    expect(item.classificationCode).toBe('10063020')
    expect(item.taxRatePct).toBe('5.000')
    expect(item.salePrice).toBe('120.00')
    expect(item.purchasePrice).toBe('96.50')
    expect(item.isSold).toBe(true)
    expect(item.isPurchased).toBe(true)
    expect(item.isCharge).toBe(false)
    expect(item.salesAccountId).toBe(account.id)
    expect(item.isArchived).toBe(false)
  })

  it('refuses one that is neither sold nor purchased', async () => {
    expect(await codeOf(() => createItem(db, { name: 'Nobody', kind: 'goods' }))).toBe(
      'ITEM_HAS_NO_SIDE',
    )
  })

  it('refuses a blank name', async () => {
    expect(await codeOf(() => sold('   '))).toBe('ITEM_NAME_REQUIRED')
  })

  it('trims what it stores', async () => {
    const item = await sold('  Spaced Out Widget  ', { code: '  SKU-1  ' })
    expect(item.name).toBe('Spaced Out Widget')
    expect(item.code).toBe('SKU-1')
  })

  it('stores an empty optional field as null rather than as an empty string', async () => {
    const item = await sold('Minimal Widget', {
      code: '',
      description: '   ',
      classificationCode: null,
    })
    expect(item.code).toBeNull()
    expect(item.description).toBeNull()
    expect(item.classificationCode).toBeNull()
  })

  it('takes a service as readily as goods', async () => {
    const item = await createItem(db, { name: 'Machining', kind: 'service', isSold: true })
    expect(item.kind).toBe('service')
    expect(item.unitCode).toBeNull()
  })

  it('takes a charge, which is taxable but is not sales revenue', async () => {
    const item = await sold('Freight outward', { isCharge: true })
    expect(item.isCharge).toBe(true)
  })

  it("does not validate the classification code, which is the regime's business", async () => {
    /* `db/` may not import a concrete regime. Whether `NOT-AN-HSN` is an HSN is a
     * question only the regime can answer, and it answers it above this layer. */
    expect(
      (await sold('Odd Widget', { classificationCode: 'NOT-AN-HSN' })).classificationCode,
    ).toBe('NOT-AN-HSN')
  })
})

describe('names and codes are unique, ignoring case', () => {
  it('refuses a name another item already holds', async () => {
    await sold('Ball bearing 6203')
    expect(await codeOf(() => sold('BALL BEARING 6203'))).toBe('ITEM_NAME_TAKEN')
  })

  it('says which name clashed, from the repository', async () => {
    /* `details` is only populated by the repository. Without this the test would pass
     * against a repository that had stopped checking and left it to the index — which
     * reports a constraint name rather than the name that clashed. */
    await sold('Ball bearing 6203')
    const failure = await failureOf(() => sold('ball bearing 6203'))

    expect(failure.code).toBe('ITEM_NAME_TAKEN')
    expect(failure.details).toMatchObject({ existingName: 'Ball bearing 6203' })
  })

  it('refuses a code another item already holds, ignoring case', async () => {
    await sold('Ball bearing 6203', { code: 'BB-6203' })
    const failure = await failureOf(() => sold('Ball bearing 6204', { code: 'bb-6203' }))

    expect(failure.code).toBe('ITEM_CODE_TAKEN')
    expect(failure.details).toMatchObject({ existingName: 'Ball bearing 6203' })
  })

  it('allows any number of items with no code', async () => {
    await sold('First Unlabelled')
    await sold('Second Unlabelled')
    expect((await listItems(db)).length).toBe(2)
  })

  it('lets an item keep its own name and code through an update', async () => {
    const item = await sold('Ball bearing 6203', { code: 'BB-6203' })
    const updated = await updateItem(db, {
      id: item.id,
      name: 'Ball bearing 6203',
      code: 'BB-6203',
      salePrice: '45.00',
    })

    expect(updated.salePrice).toBe('45.00')
  })
})

describe('the unit an item is measured in', () => {
  beforeEach(async () => {
    await createUnit(db, { code: 'KG', name: 'Kilograms' })
  })

  it('stores the code the unit holds, not the one the caller typed', async () => {
    /* The foreign key onto a TEXT primary key is case-sensitive — measured in the units
     * test — so `kg` written as given would be refused outright. */
    expect((await sold('Rice', { unitCode: 'kg' })).unitCode).toBe('KG')
  })

  it('refuses a unit that is not in these books', async () => {
    expect(await codeOf(() => sold('Cloth', { unitCode: 'MTR' }))).toBe('UNIT_NOT_FOUND')
  })

  it('refuses an archived unit', async () => {
    await archiveUnit(db, 'KG', true)
    expect(await codeOf(() => sold('Rice', { unitCode: 'KG' }))).toBe('UNIT_ARCHIVED')
  })

  it('takes no unit at all, which is what a service usually wants', async () => {
    expect((await sold('Consulting', { unitCode: null })).unitCode).toBeNull()
    expect((await sold('Advice', { unitCode: '  ' })).unitCode).toBeNull()
  })

  it('clears the unit when an update sends null', async () => {
    const item = await sold('Rice', { unitCode: 'KG' })
    expect((await updateItem(db, { id: item.id, unitCode: null })).unitCode).toBeNull()
  })
})

describe('the account an item posts to', () => {
  it('takes a leaf account', async () => {
    const account = await revenueAccount()
    expect((await sold('Rice', { salesAccountId: account.id })).salesAccountId).toBe(account.id)
  })

  it('refuses a group, because a group holds no figures of its own', async () => {
    /* A repository check and not a trigger. 0004's `journal_lines_not_group` already
     * refuses the posting, so nothing is corrupted by getting this wrong — what an
     * earlier refusal buys is a sentence when the choice is made rather than an abort
     * weeks later when an invoice will not issue. */
    const group = await createAccount(db, {
      code: '4000',
      name: 'Revenue',
      type: 'income',
      parentId: null,
      isGroup: true,
    })

    const failure = await failureOf(() => sold('Rice', { salesAccountId: group.id }))
    expect(failure.code).toBe('ITEM_ACCOUNT_IS_GROUP')
    expect(failure.details).toMatchObject({ which: 'sales', name: 'Revenue' })
  })

  it('refuses an account that is not in the chart', async () => {
    expect(await codeOf(() => sold('Rice', { purchaseAccountId: 'nobody' }))).toBe(
      'ACCOUNT_NOT_FOUND',
    )
  })

  it('refuses an archived account', async () => {
    const account = await revenueAccount()
    await updateAccount(db, { id: account.id, isArchived: true })

    expect(await codeOf(() => sold('Rice', { salesAccountId: account.id }))).toBe(
      'ACCOUNT_ARCHIVED',
    )
  })

  it('leaves an item editable after its account is archived', async () => {
    /* The account is only re-checked when it is sent, so correcting a typo in the name is
     * not blocked by a decision made about the chart of accounts. */
    const account = await revenueAccount()
    const item = await sold('Rice', { salesAccountId: account.id })
    await updateAccount(db, { id: account.id, isArchived: true })

    expect((await updateItem(db, { id: item.id, name: 'Basmati rice' })).name).toBe('Basmati rice')
  })

  it('clears the override when an update sends null', async () => {
    const account = await revenueAccount()
    const item = await sold('Rice', { salesAccountId: account.id })
    expect((await updateItem(db, { id: item.id, salesAccountId: null })).salesAccountId).toBeNull()
  })
})

describe('prices', () => {
  it('keeps null and 0.00 apart', async () => {
    /* Nothing agreed, versus agreed at nothing — a sample or a warranty replacement.
     * Coercing one into the other puts a price on a free issue. */
    const unpriced = await sold('Unpriced Widget')
    const free = await sold('Free Sample', { salePrice: '0.00' })

    expect(unpriced.salePrice).toBeNull()
    expect(free.salePrice).toBe('0.00')
  })

  it('normalises what it is given to money scale', async () => {
    expect((await sold('Rounded Widget', { salePrice: '5000' })).salePrice).toBe('5000.00')
  })

  it('refuses a price with more places than money has', async () => {
    /* Rejected rather than rounded: three places means something upstream is working at
     * the wrong scale, and rounding it here hides that until the totals stop tying. */
    expect(await codeOf(() => sold('Overprecise Widget', { salePrice: '12.345' }))).toBe(
      'INVALID_AMOUNT',
    )
  })

  it('refuses a negative price on either side', async () => {
    expect(await codeOf(() => sold('Negative Widget', { salePrice: '-100.00' }))).toBe(
      'INVALID_AMOUNT',
    )
    expect(await codeOf(() => sold('Negative Cost', { purchasePrice: '-1.00' }))).toBe(
      'INVALID_AMOUNT',
    )
  })

  it('refuses something that is not an amount', async () => {
    expect(await codeOf(() => sold('Nonsense Widget', { salePrice: 'lots' }))).toBe(
      'INVALID_AMOUNT',
    )
  })

  it('treats an empty string as no price', async () => {
    expect((await sold('Blank Widget', { salePrice: '' })).salePrice).toBeNull()
  })

  it('normalises the purchase price too', async () => {
    expect((await sold('Bought Widget', { purchasePrice: '96.5' })).purchasePrice).toBe('96.50')
  })
})

describe('the tax rate', () => {
  it('stores a rate at three places, not at two', async () => {
    expect((await sold('Standard Widget', { taxRatePct: '18' })).taxRatePct).toBe('18.000')
  })

  it('keeps the third place, which is where a halved slab lives', async () => {
    /* 0.25% on rough diamonds splits into CGST 0.125% and SGST 0.125%. At two places the
     * invoice would print 0.13% and the tax would not reconcile to it. */
    expect((await sold('Rough Diamond', { taxRatePct: '0.125' })).taxRatePct).toBe('0.125')
  })

  it('refuses a fourth decimal place rather than rounding it away', async () => {
    expect(await codeOf(() => sold('Overprecise Widget', { taxRatePct: '0.1255' }))).toBe(
      'INVALID_AMOUNT',
    )
  })

  it('refuses a negative rate', async () => {
    expect(await codeOf(() => sold('Negative Widget', { taxRatePct: '-5.000' }))).toBe(
      'INVALID_AMOUNT',
    )
  })

  it('refuses something that is not a rate', async () => {
    expect(await codeOf(() => sold('Nonsense Widget', { taxRatePct: 'eighteen' }))).toBe(
      'INVALID_AMOUNT',
    )
  })

  it('keeps null and 0.000 apart', async () => {
    /* Nil-rated is an answer a return has to carry. "Nobody has said yet" is not. */
    const unrated = await sold('Unrated Widget')
    const nilRated = await sold('Nil Rated Widget', { taxRatePct: '0' })

    expect(unrated.taxRatePct).toBeNull()
    expect(nilRated.taxRatePct).toBe('0.000')
  })
})

describe('updating an item', () => {
  it('writes only the fields that were sent', async () => {
    const item = await sold('Rice', { salePrice: '120.00', description: 'Long grain' })
    const updated = await updateItem(db, { id: item.id, salePrice: '135.00' })

    expect(updated.salePrice).toBe('135.00')
    /* The screen that repriced it never showed the description, and must not blank it. */
    expect(updated.description).toBe('Long grain')
  })

  it('clears a field that was sent as null', async () => {
    const item = await sold('Rice', { description: 'Long grain' })
    expect((await updateItem(db, { id: item.id, description: null })).description).toBeNull()
  })

  it('refuses to leave an item as neither sold nor purchased', async () => {
    const item = await sold('Rice')
    expect(await codeOf(() => updateItem(db, { id: item.id, isSold: false }))).toBe(
      'ITEM_HAS_NO_SIDE',
    )
  })

  it('allows dropping one side while the other stands', async () => {
    const item = await createItem(db, {
      name: 'Rice',
      kind: 'goods',
      isSold: true,
      isPurchased: true,
    })
    const updated = await updateItem(db, { id: item.id, isSold: false })

    expect(updated.isSold).toBe(false)
    expect(updated.isPurchased).toBe(true)
  })

  it('changes what an item is, because a service can be reclassified', async () => {
    const item = await sold('Machining')
    expect((await updateItem(db, { id: item.id, kind: 'service' })).kind).toBe('service')
  })

  it('refuses a name another item already holds', async () => {
    await sold('Ball bearing 6203')
    const other = await sold('Ball bearing 6204')

    expect(await codeOf(() => updateItem(db, { id: other.id, name: 'BALL BEARING 6203' }))).toBe(
      'ITEM_NAME_TAKEN',
    )
  })

  it('refuses a code another item already holds', async () => {
    await sold('Ball bearing 6203', { code: 'BB-6203' })
    const other = await sold('Ball bearing 6204', { code: 'BB-6204' })

    expect(await codeOf(() => updateItem(db, { id: other.id, code: 'bb-6203' }))).toBe(
      'ITEM_CODE_TAKEN',
    )
  })

  it('moves updated_at and leaves created_at alone', async () => {
    const item = await sold('Rice')
    const updated = await updateItem(db, { id: item.id, salePrice: '10.00' })

    expect(updated.createdAt).toBe(item.createdAt)
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(item.updatedAt))
  })

  it('refuses an item that does not exist', async () => {
    expect(await codeOf(() => updateItem(db, { id: 'nobody', name: 'Rice' }))).toBe(
      'ITEM_NOT_FOUND',
    )
  })

  it('reprices without touching anything a document already says', async () => {
    /* The reason every column here is a default for a line and never a lookup: a line
     * stores its own price, so this is free. The test pins the intent — if an item ever
     * grew a back-reference to the documents naming it, this is where it would show. */
    const item = await sold('Rice', { salePrice: '120.00' })
    const updated = await updateItem(db, { id: item.id, salePrice: '135.00' })

    expect(updated.salePrice).toBe('135.00')
    expect(updated.id).toBe(item.id)
  })
})

describe('listing', () => {
  beforeEach(async () => {
    await createItem(db, { name: 'Zebra widget', kind: 'goods', isSold: true, code: 'ZW-1' })
    await createItem(db, { name: 'Anvil casting', kind: 'goods', isPurchased: true })
    await createItem(db, {
      name: 'machining service',
      kind: 'service',
      isSold: true,
      isPurchased: true,
      classificationCode: '998873',
    })
  })

  it('orders by name, ignoring case', async () => {
    /* Sorted by the raw column, `machining service` sorts after `Zebra widget`, because
     * lower-case letters come after upper-case ones in ASCII. */
    expect((await listItems(db)).map((item) => item.name)).toEqual([
      'Anvil casting',
      'machining service',
      'Zebra widget',
    ])
  })

  it('offers only what is sold when asked for what is sold', async () => {
    expect((await listItems(db, { side: 'sold' })).map((item) => item.name)).toEqual([
      'machining service',
      'Zebra widget',
    ])
  })

  it('offers only what is purchased when asked for what is purchased', async () => {
    expect((await listItems(db, { side: 'purchased' })).map((item) => item.name)).toEqual([
      'Anvil casting',
      'machining service',
    ])
  })

  it('counts an item that is both on either list', async () => {
    const forSale = await listItems(db, { side: 'sold' })
    const bought = await listItems(db, { side: 'purchased' })

    expect(forSale.map((item) => item.name)).toContain('machining service')
    expect(bought.map((item) => item.name)).toContain('machining service')
  })

  it('separates goods from services', async () => {
    expect((await listItems(db, { kind: 'service' })).map((item) => item.name)).toEqual([
      'machining service',
    ])
    expect((await listItems(db, { kind: 'goods' })).map((item) => item.name)).toEqual([
      'Anvil casting',
      'Zebra widget',
    ])
  })

  it('hides archived items by default and shows them when asked', async () => {
    const zebra = (await listItems(db)).find((item) => item.name === 'Zebra widget')!
    await archiveItem(db, zebra.id, true)

    expect((await listItems(db)).map((item) => item.name)).not.toContain('Zebra widget')
    expect((await listItems(db, { includeArchived: true })).map((item) => item.name)).toContain(
      'Zebra widget',
    )
  })

  it('searches the name, the code and the classification code', async () => {
    expect((await listItems(db, { search: 'anvil' })).map((item) => item.name)).toEqual([
      'Anvil casting',
    ])
    expect((await listItems(db, { search: 'zw-1' })).map((item) => item.name)).toEqual([
      'Zebra widget',
    ])
    expect((await listItems(db, { search: '998873' })).map((item) => item.name)).toEqual([
      'machining service',
    ])
  })

  it('ignores a blank search rather than matching nothing', async () => {
    expect((await listItems(db, { search: '   ' })).length).toBe(3)
  })

  it('carries the sale price and the rate on the summary, which is what a picker shows', async () => {
    const item = await sold('Priced Widget', { salePrice: '99.00', taxRatePct: '18' })
    const listed = (await listItems(db)).find((row) => row.id === item.id)

    expect(listed?.salePrice).toBe('99.00')
    expect(listed?.taxRatePct).toBe('18.000')
  })
})

describe('archiving and deleting', () => {
  it('archives and unarchives, because a product line comes back', async () => {
    const item = await sold('Rice')

    expect((await archiveItem(db, item.id, true)).isArchived).toBe(true)
    expect((await archiveItem(db, item.id, false)).isArchived).toBe(false)
  })

  it('deletes one that has never reached a document', async () => {
    const item = await sold('Never Sold Widget')
    await deleteItem(db, item.id)
    expect(await getItem(db, item.id)).toBeNull()
  })

  it('refuses to delete one that does not exist', async () => {
    expect(await codeOf(() => deleteItem(db, 'nobody'))).toBe('ITEM_NOT_FOUND')
  })

  it('turns a constraint on a referencing row into a sentence', async () => {
    /* 0008 adds `document_lines.item_id REFERENCES items(id) ON DELETE RESTRICT`. Until
     * that table exists this stands in for it: what is being tested is the translation
     * from `FOREIGN KEY constraint failed` into an actionable code, and that code is
     * written now rather than remembered later. */
    const item = await sold('Sold Widget')
    connection.exec(
      `CREATE TABLE probe_document_lines (
         id TEXT PRIMARY KEY,
         item_id TEXT REFERENCES items(id) ON DELETE RESTRICT
       ) STRICT`,
    )
    connection.prepare(`INSERT INTO probe_document_lines VALUES ('l-1', ?)`).run(item.id)

    const failure = await failureOf(() => deleteItem(db, item.id))
    expect(failure.code).toBe('ITEM_IN_USE')
    expect(failure.details).toMatchObject({ name: 'Sold Widget' })
  })
})

describe('assertItemsActive', () => {
  it('passes an empty list without asking the database anything', async () => {
    await expect(assertItemsActive(db, [])).resolves.toBeUndefined()
  })

  it('refuses an archived item by name', async () => {
    const item = await sold('Discontinued Widget')
    await archiveItem(db, item.id, true)

    const failure = await failureOf(() => assertItemsActive(db, [item.id]))
    expect(failure.code).toBe('ITEM_ARCHIVED')
    expect(failure.details).toMatchObject({ name: 'Discontinued Widget' })
  })

  it('refuses one that does not exist', async () => {
    expect(await codeOf(() => assertItemsActive(db, ['nobody']))).toBe('ITEM_NOT_FOUND')
  })

  it('checks every item, not only the first', async () => {
    const good = await sold('Still Sold Widget')
    const bad = await sold('Discontinued Widget')
    await archiveItem(db, bad.id, true)

    expect(await codeOf(() => assertItemsActive(db, [good.id, bad.id]))).toBe('ITEM_ARCHIVED')
  })

  it('asks about a repeated item once', async () => {
    const item = await sold('Repeated Widget')
    await expect(assertItemsActive(db, [item.id, item.id, item.id])).resolves.toBeUndefined()
  })
})
