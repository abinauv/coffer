/*
 * The stock repository, against a real encrypted database.
 *
 * THE STRONGEST TEST IN THIS FILE IS THE GOLDEN STOCK CARD, and it is the inventory
 * analogue of the accounting-equation suite. `domain/inventory/__fixtures__/stock-card.json`
 * is thirteen movements worked out by hand — a receipt that re-averages, an issue that
 * must not, freight with no quantity, a free sample, both returns, both adjustments, an
 * item run down to exactly nothing and a receipt afterwards that must start a fresh
 * average. The domain already proves it folds to those figures. This file proves the same
 * thirteen movements produce the same figures AFTER A ROUND TRIP THROUGH SQLITE: written
 * as rows, read back, parsed, and folded again.
 *
 * It is asserted twice, on purpose, because the two say different things:
 *
 *   THROUGH THE TABLE, in the fixture's own deliberately scrambled order (5, 12, 1, 9, 3,
 *   13, 7, 2, 11, 4, 10, 6, 8), with the fixture's own sequence numbers. That is the READ
 *   path: it proves `stockCardFor` orders by date and then by sequence rather than by
 *   whatever the query returned. The repository could not write them in that order — the
 *   first is an issue of 60 against an empty item — which is itself the point: the read
 *   path has to be right for rows it did not write.
 *
 *   THROUGH `recordMovement`, in an order that is valid at every step and still puts one
 *   movement in BEFORE one that is dated after it. That is the WRITE path, and it proves
 *   the same figures come out when the sequence numbers are allocated rather than given.
 *
 * AND THE RULES ARE NOT TESTED HERE. 0017's CHECKs, 0019's CHECKs and 0019's triggers each
 * have a test beside their migration that writes straight at the table, because this file
 * goes through a repository that refuses the same things first — and a test that only went
 * through it would pass against a database that had stopped checking. What IS asserted
 * here is `details`, which only the repository populates: it is the one thing that can
 * tell the two layers apart when they answer with the same code.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { D } from '@main/domain/money'
import { aprilToMarch, fixedClock } from '@main/domain/time'
import type { StockMovementKind } from '@main/domain/inventory'

import { DATABASE_KEY_BYTES, closeDatabase, openDatabase, type SqliteDatabase } from '../connection'
import { createQueryBuilder, type CofferDb } from '../kysely'
import { runMigrations } from '../migrate'
import { MIGRATIONS } from '../migrations'
import { setUpBooks } from './bootstrap'
import { isRepoError, type RepoError } from './errors'
import { createItem } from './items'
import { postManualEntry } from './journal'
import {
  DEFAULT_WAREHOUSE_CODE,
  createWarehouse,
  defaultWarehouseId,
  deleteWarehouse,
  itemStockSettings,
  listWarehouses,
  recordMovement,
  seedDefaultWarehouse,
  setItemStockTracking,
  stockCardFor,
  stockOnHand,
  stockOnHandByItem,
  updateWarehouse,
} from './stock'

import fixture from '@main/domain/inventory/__fixtures__/stock-card.json'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x4a)
/* Inside the fiscal year the golden fixture's movements fall in, so `setUpBooks`
 * generates periods that cover them. Frozen, so "which year is it" is not a fact about
 * the wall clock. */
const CLOCK = fixedClock('2026-04-01T09:00:00.000Z')
const NOW = '2026-04-01T00:00:00.000Z'

interface GoldenRow {
  sequence: number
  kind: StockMovementKind
  moved: string
  cost: string
  quantity: string
  unitCost: string
  value: string
}

const golden = fixture as unknown as {
  itemId: string
  movements: {
    sequence: number
    date: string
    kind: StockMovementKind
    quantity: string
    cost: string | null
  }[]
  expected: {
    rows: GoldenRow[]
    closing: { quantity: string; value: string; unitCost: string }
    quantityIn: string
    quantityOut: string
    costIn: string
    costOut: string
  }
}

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase
let db: CofferDb
let widget: string
let tape: string
let advice: string
let main: string
let yard: string
let stubEntry: string

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-stock-'))
  directories.push(dir)
  connection = openDatabase({ filePath: join(dir, 'company.coffer'), key: KEY })
  handles.push(connection)
  runMigrations(connection, MIGRATIONS)
  db = createQueryBuilder(connection)

  await setUpBooks(db, { rule: aprilToMarch, clock: CLOCK })

  /* Created through the SHIPPED path, then marked as stock through this file's own.
   * `createItem` cannot set the flag — see the note on `setItemStockTracking`. */
  widget = (await createItem(db, { name: 'Ball bearing 6203', kind: 'goods', isSold: true })).id
  tape = (await createItem(db, { name: 'Packing tape', kind: 'goods', isPurchased: true })).id
  advice = (await createItem(db, { name: 'Advice', kind: 'service', isSold: true })).id
  await setItemStockTracking(db, { itemId: widget, isStockTracked: true })

  /*
   * `MAIN` IS `setUpBooks`'s OWN NOW, and this fixture takes it rather than making a
   * second one beside it — the seeding moved into `setUpBooks` at the integration gate,
   * because `stock_ledger.warehouse_id` is NOT NULL and no file the application had ever
   * made could record a movement. Read through `defaultWarehouseId`, which refuses to
   * answer when there are two, so this line also asserts the seed made exactly one.
   */
  main = await defaultWarehouseId(db)

  /* Created AFTER `MAIN` and with a code that sorts BEFORE it, so a list handed back in
   * insertion order rather than by code is visible. It was `WH-2` while this fixture made
   * both warehouses itself and could create them in the disagreeing order; it cannot any
   * more, so the disagreement moves into the code. */
  yard = (await createWarehouse(db, { code: 'BLR', name: 'Bengaluru yard' })).id

  stubEntry = await stubEntryId()
})

/**
 * One real journal entry, for the rows this file writes PAST the repository.
 *
 * WHY THE RAW WRITES NEED ONE AT ALL. Migration 0022 refuses a movement that cost money
 * and names no entry — ARCHITECTURE §6.4 as a trigger, because a movement with no entry
 * is a balance sheet that does not tie and neither page says so. `recordMovement` posts
 * one for every movement it writes; a test writing straight at the table has to satisfy
 * the constraint the same way it satisfies the kind CHECK and the cost biconditional.
 *
 * ONE ENTRY FOR EVERY RAW ROW, AND THAT IS LEGAL ON PURPOSE. `entry_id` is deliberately
 * NOT unique — 0022's header says why: a document moving five items should eventually
 * post one entry carrying five cost lines. So this is not a loophole being exploited, it
 * is the shape the column was left open for.
 *
 * ITS FIGURES ARE MEANINGLESS AND MUST STAY THAT WAY. A rupee between two accounts no
 * test in this file reads. The rows it is attached to are deliberate corruption — an
 * over-issue, a duplicate sequence, a value against nothing — and the point of them is
 * that the READ path reports the corruption. Making the ledger agree with them would take
 * that away.
 */
async function stubEntryId(): Promise<string> {
  const [debit, credit] = await Promise.all([accountByCode('1100'), accountByCode('3100')])
  const posted = await postManualEntry(db, {
    date: '2026-04-01',
    narration: 'A rupee, so rows written past the repository have an entry to name',
    lines: [
      { accountId: debit, debit: '1.00', credit: '0.00' },
      { accountId: credit, debit: '0.00', credit: '1.00' },
    ],
  })
  return posted.entryId
}

async function accountByCode(code: string): Promise<string> {
  const row = await db
    .selectFrom('accounts')
    .select('id')
    .where('code', '=', code)
    .executeTakeFirst()
  if (row === undefined) throw new Error(`The seeded chart has no account ${code}.`)
  return row.id
}

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

// ---- Helpers ---------------------------------------------------------------

async function failureOf(action: () => Promise<unknown>): Promise<RepoError> {
  try {
    await action()
  } catch (error) {
    if (isRepoError(error)) return error
    throw error
  }
  throw new Error('Expected the action to fail, and it did not.')
}

async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action()
  } catch (error) {
    const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined
    return typeof code === 'string' ? code : `not a coded error: ${String(error)}`
  }
  return 'no error thrown'
}

interface MovementSpec {
  kind: StockMovementKind
  date: string
  quantity: string
  cost?: string | null
  itemId?: string
  warehouseId?: string
}

async function record(spec: MovementSpec): Promise<ReturnType<typeof recordMovement>> {
  return recordMovement(db, {
    itemId: spec.itemId ?? widget,
    warehouseId: spec.warehouseId ?? main,
    kind: spec.kind,
    date: spec.date,
    quantity: spec.quantity,
    cost: spec.cost ?? null,
    sourceType: 'stock-adjustment',
  })
}

/** One golden movement, written past the repository with its own sequence number. */
function writeGolden(entry: {
  sequence: number
  date: string
  kind: StockMovementKind
  quantity: string
  cost: string | null
}): void {
  connection
    .prepare(
      `INSERT INTO stock_ledger (id, item_id, warehouse_id, kind, movement_date, sequence,
         quantity, cost, source_type, source_id, source_number, narration, created_at, entry_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stock-adjustment', NULL, NULL, NULL, ?, ?)`,
    )
    .run(
      `m-${String(entry.sequence)}`,
      widget,
      main,
      entry.kind,
      entry.date,
      entry.sequence,
      entry.quantity,
      entry.cost,
      NOW,
      stubEntry,
    )
}

// ---- Warehouses ------------------------------------------------------------

describe('warehouses', () => {
  it('lists them by code, whatever order they were created in', async () => {
    const codes = (await listWarehouses(db)).map((warehouse) => warehouse.code)

    expect(codes).toEqual(['BLR', 'MAIN'])
  })

  /*
   * THE NOCASE BUG, ASSERTED FROM THE REPOSITORY SIDE. A comparison written `where('code',
   * '=', code)` finds nothing against the NOCASE index, so this refusal would never fire
   * and the user would read `UNIQUE constraint failed` instead. The migration's test pins
   * the index; this pins the comparison in front of it.
   */
  it('refuses a code that is taken, ignoring case', async () => {
    const failure = await failureOf(() => createWarehouse(db, { code: 'main', name: 'Second' }))

    expect(failure.code).toBe('WAREHOUSE_CODE_TAKEN')
    expect(failure.details).toMatchObject({ code: 'main' })
    expect(failure.message).toContain('MAIN')
  })

  it('refuses a name that is taken, ignoring case', async () => {
    const failure = await failureOf(() => createWarehouse(db, { code: 'WH-3', name: 'MAIN STORE' }))

    expect(failure.code).toBe('WAREHOUSE_NAME_TAKEN')
  })

  it('refuses a blank code and a blank name', async () => {
    expect(await codeOf(() => createWarehouse(db, { code: '  ', name: 'X' }))).toBe(
      'WAREHOUSE_CODE_REQUIRED',
    )
    expect(await codeOf(() => createWarehouse(db, { code: 'WH-9', name: ' ' }))).toBe(
      'WAREHOUSE_NAME_REQUIRED',
    )
  })

  /* A warehouse's code is a label and not its identity, so unlike a unit's it may change.
   * Every movement refers to the id, so nothing that has been recorded moves. */
  it('lets a code change, which a unit code may not', async () => {
    const renamed = await updateWarehouse(db, { id: yard, code: 'KOCHI' })

    expect(renamed.code).toBe('KOCHI')
    expect(await codeOf(() => updateWarehouse(db, { id: yard, code: 'main' }))).toBe(
      'WAREHOUSE_CODE_TAKEN',
    )
  })

  it('seeds one, once', async () => {
    expect(await seedDefaultWarehouse(db)).toBe(0)

    for (const warehouse of await listWarehouses(db)) {
      await deleteWarehouse(db, warehouse.id)
    }

    expect(await seedDefaultWarehouse(db)).toBe(1)
    expect(await seedDefaultWarehouse(db)).toBe(0)
    expect((await listWarehouses(db)).map((warehouse) => warehouse.code)).toEqual([
      DEFAULT_WAREHOUSE_CODE,
    ])
  })

  describe('which warehouse a caller meant when it named none', () => {
    it('refuses to guess when there are two', async () => {
      expect(await codeOf(() => defaultWarehouseId(db))).toBe('WAREHOUSE_REQUIRED')
    })

    it('answers with the only one there is', async () => {
      await deleteWarehouse(db, yard)

      expect(await defaultWarehouseId(db)).toBe(main)
    })

    it('says so when there is none, rather than letting a foreign key be the message', async () => {
      await deleteWarehouse(db, yard)
      await deleteWarehouse(db, main)

      expect(await codeOf(() => defaultWarehouseId(db))).toBe('WAREHOUSE_NOT_CONFIGURED')
    })
  })

  describe('archiving', () => {
    it('takes an empty one', async () => {
      const archived = await updateWarehouse(db, { id: yard, isArchived: true })

      expect(archived.isArchived).toBe(true)
      expect((await listWarehouses(db)).map((warehouse) => warehouse.code)).toEqual(['MAIN'])
    })

    /*
     * REFUSED WHILE IT HOLDS ANYTHING, and the database cannot ask this question: "holds
     * stock" is a running total whose value side is never stored. The value would drop off
     * every stock page and stay on the balance sheet.
     */
    it('refuses one that still holds stock', async () => {
      await record({ kind: 'receipt', date: '2026-04-01', quantity: '10.000', cost: '1000.00' })

      const failure = await failureOf(() => updateWarehouse(db, { id: main, isArchived: true }))
      expect(failure.code).toBe('WAREHOUSE_IN_USE')
      expect(failure.details).toMatchObject({ items: 1 })
    })

    /* Emptied, not merely written to: the rule is about what is on hand, not about
     * whether anything ever happened there. */
    it('takes one that has been emptied', async () => {
      await record({ kind: 'receipt', date: '2026-04-01', quantity: '10.000', cost: '1000.00' })
      await record({ kind: 'issue', date: '2026-04-02', quantity: '10.000' })

      expect(await codeOf(() => updateWarehouse(db, { id: main, isArchived: true }))).toBe(
        'no error thrown',
      )
    })

    it('refuses deleting one with movements against it, emptied or not', async () => {
      await record({ kind: 'receipt', date: '2026-04-01', quantity: '10.000', cost: '1000.00' })
      await record({ kind: 'issue', date: '2026-04-02', quantity: '10.000' })

      expect(await codeOf(() => deleteWarehouse(db, main))).toBe('WAREHOUSE_IN_USE')
    })

    it('takes nothing new once archived', async () => {
      await updateWarehouse(db, { id: main, isArchived: true })

      expect(
        await codeOf(() =>
          record({ kind: 'receipt', date: '2026-04-01', quantity: '1.000', cost: '1.00' }),
        ),
      ).toBe('WAREHOUSE_ARCHIVED')
    })
  })
})

// ---- Which items keep a balance --------------------------------------------

describe('turning an item register on and off', () => {
  it('leaves an item created the normal way keeping no balance, and refuses a movement for it', async () => {
    expect(await itemStockSettings(db, tape)).toEqual({
      itemId: tape,
      isStockTracked: false,
      reorderLevel: null,
    })

    /*
     * BOTH LAYERS SAY `ITEM_NOT_STOCK_TRACKED` — the repository here and 0019's trigger
     * underneath — so the code cannot tell them apart. `details` can, and only the
     * repository populates it. The trigger's version is asserted beside the migration, by
     * writing straight at the table.
     */
    const failure = await failureOf(() =>
      record({
        itemId: tape,
        kind: 'receipt',
        date: '2026-04-01',
        quantity: '1.000',
        cost: '1.00',
      }),
    )
    expect(failure.code).toBe('ITEM_NOT_STOCK_TRACKED')
    expect(failure.details).toMatchObject({ itemId: tape, name: 'Packing tape' })
  })

  it('makes an item created the normal way stockable, and then it takes a movement', async () => {
    await setItemStockTracking(db, { itemId: tape, isStockTracked: true, reorderLevel: '25.000' })

    expect(await itemStockSettings(db, tape)).toEqual({
      itemId: tape,
      isStockTracked: true,
      reorderLevel: '25.000',
    })
    const recorded = await record({
      itemId: tape,
      kind: 'receipt',
      date: '2026-04-01',
      quantity: '1.000',
      cost: '1.00',
    })
    expect(recorded.after.quantity).toBe('1.000')
  })

  it('refuses to make a service stockable, with the item in the sentence', async () => {
    const failure = await failureOf(() =>
      setItemStockTracking(db, { itemId: advice, isStockTracked: true }),
    )

    expect(failure.code).toBe('ITEM_NOT_STOCKABLE')
    expect(failure.details).toMatchObject({ itemId: advice, kind: 'service' })
    expect(failure.message).toContain('Advice')
  })

  /*
   * THE REPOSITORY COUNTS THE MOVEMENTS AND THE TRIGGER CANNOT. Both answer `ITEM_IN_USE`,
   * so `details.movements` is the only thing an assertion can use to tell which layer
   * spoke — and it is what makes the repository's check reachable rather than merely
   * redundant.
   */
  it('refuses to switch a register off once it has movements', async () => {
    await record({ kind: 'receipt', date: '2026-04-01', quantity: '10.000', cost: '1000.00' })

    const failure = await failureOf(() =>
      setItemStockTracking(db, { itemId: widget, isStockTracked: false }),
    )
    expect(failure.code).toBe('ITEM_IN_USE')
    expect(failure.details).toMatchObject({ movements: 1 })
  })

  it('clears a reorder level when the register is switched off', async () => {
    await setItemStockTracking(db, { itemId: tape, isStockTracked: true, reorderLevel: '25.000' })
    await setItemStockTracking(db, { itemId: tape, isStockTracked: false })

    expect(await itemStockSettings(db, tape)).toEqual({
      itemId: tape,
      isStockTracked: false,
      reorderLevel: null,
    })
  })

  it('refuses a reorder level that is not a quantity', async () => {
    expect(
      await codeOf(() =>
        setItemStockTracking(db, { itemId: tape, isStockTracked: true, reorderLevel: '25.0004' }),
      ),
    ).toBe('INVALID_AMOUNT')
  })

  it('refuses an item that is not there', async () => {
    expect(
      await codeOf(() => setItemStockTracking(db, { itemId: 'gone', isStockTracked: true })),
    ).toBe('ITEM_NOT_FOUND')
  })
})

// ---- Recording -------------------------------------------------------------

describe('recording a movement', () => {
  it('values an issue by the register rather than by the caller', async () => {
    await record({ kind: 'receipt', date: '2026-04-01', quantity: '100.000', cost: '25000.00' })
    await record({ kind: 'receipt', date: '2026-04-05', quantity: '50.000', cost: '13750.00' })

    const issue = await record({ kind: 'issue', date: '2026-04-08', quantity: '40.000' })

    /* 38750.00 x 40.000 / 150.000 = 10333.3333…, which is 10333.33 at money scale. */
    expect(issue.cost).toBe('10333.33')
    expect(issue.after).toEqual({
      quantity: '110.000',
      value: '28416.67',
      unitCost: '258.333364',
    })
  })

  /* The boundary is INCLUSIVE and clears the value to exactly nothing: `shareOfCost` of
   * the whole is the whole, so no paisa is stranded in an item that is now empty. */
  it('lets an issue take out exactly what is on hand', async () => {
    await record({ kind: 'receipt', date: '2026-04-01', quantity: '3.000', cost: '100.00' })

    const issue = await record({ kind: 'issue', date: '2026-04-02', quantity: '3.000' })

    expect(issue.cost).toBe('100.00')
    expect(issue.after).toEqual({ quantity: '0.000', value: '0.00', unitCost: '0.000000' })
  })

  it('refuses an issue larger than what is on hand, and says by how much', async () => {
    await record({ kind: 'receipt', date: '2026-04-01', quantity: '4.000', cost: '100.00' })

    const failure = await failureOf(() =>
      record({ kind: 'issue', date: '2026-04-02', quantity: '6.000' }),
    )

    expect(failure.code).toBe('INSUFFICIENT_STOCK')
    expect(failure.details).toMatchObject({ onHand: '4', requested: '6' })
    /* Both figures are in the sentence, which is the whole reason the repository answers
     * before the register is touched. The domain renders them UNPADDED — '4', not '4.000'
     * — because the message is built from `Decimal.toString()`; noted rather than worked
     * around here, since `domain/inventory` is not this batch's to change. */
    expect(failure.message).toContain('4 on hand')
    expect(failure.message).toContain('takes out 6')
  })

  /*
   * ONE ERROR CLASS FOR ALL THREE FAMILIES. Phase 4.1 threw a parallel `StockError`, for a
   * reason that was about which paths that batch owned rather than about design; the
   * merge at the integration gate matters because `ipc/errors.ts` maps `RepoError` and
   * had never heard of the other one, so a stock refusal would have reached a screen as
   * an unexpected error with its sentence stripped.
   *
   * ASSERTED ACROSS THE THREE ROUTES A REFUSAL TAKES, because they are three different
   * constructions: a warehouse rule this file raises, an item rule this file raises, and
   * a VALUATION rule the DOMAIN raised, which `fromProblem` carries across. A test that
   * only tried the first would pass against a file that still wrapped the domain's.
   */
  it('raises one error class, for its own refusals and for the domain’s', async () => {
    await record({ kind: 'receipt', date: '2026-04-01', quantity: '4.000', cost: '100.00' })

    const valuation = await failureOf(() =>
      record({ kind: 'issue', date: '2026-04-02', quantity: '6.000' }),
    )
    const warehouse = await failureOf(() => createWarehouse(db, { code: 'main', name: 'Second' }))
    const item = await failureOf(() =>
      setItemStockTracking(db, { itemId: advice, isStockTracked: true }),
    )

    for (const failure of [valuation, warehouse, item]) {
      expect(isRepoError(failure), failure.code).toBe(true)
      expect(failure.name).toBe('RepoError')
    }
    expect([valuation.code, warehouse.code, item.code]).toEqual([
      'INSUFFICIENT_STOCK',
      'WAREHOUSE_CODE_TAKEN',
      'ITEM_NOT_STOCKABLE',
    ])
  })

  it('writes nothing when it refuses', async () => {
    await record({ kind: 'receipt', date: '2026-04-01', quantity: '4.000', cost: '100.00' })
    await failureOf(() => record({ kind: 'issue', date: '2026-04-02', quantity: '6.000' }))

    const card = await stockCardFor(db, { itemId: widget, warehouseId: main })
    expect(card.rows).toHaveLength(1)
    expect(card.problem).toBeNull()
  })

  it('requires a cost on the way in and refuses one on the way out', async () => {
    expect(
      await codeOf(() => record({ kind: 'receipt', date: '2026-04-01', quantity: '1.000' })),
    ).toBe('COST_REQUIRED')

    await record({ kind: 'receipt', date: '2026-04-01', quantity: '5.000', cost: '100.00' })
    expect(
      await codeOf(() =>
        record({ kind: 'issue', date: '2026-04-02', quantity: '1.000', cost: '20.00' }),
      ),
    ).toBe('COST_NOT_PERMITTED')
  })

  it('refuses a movement kind this build does not know', async () => {
    expect(
      await codeOf(() =>
        recordMovement(db, {
          itemId: widget,
          warehouseId: main,
          kind: 'transfer',
          date: '2026-04-01',
          quantity: '1.000',
          cost: '1.00',
          sourceType: 'stock-adjustment',
        }),
      ),
    ).toBe('MOVEMENT_KIND_UNKNOWN')
  })

  it('refuses a quantity that is not a quantity', async () => {
    expect(
      await codeOf(() =>
        record({ kind: 'receipt', date: '2026-04-01', quantity: '1.0004', cost: '1.00' }),
      ),
    ).toBe('INVALID_AMOUNT')
  })

  it('refuses a date the books do not reach', async () => {
    expect(
      await codeOf(() =>
        record({ kind: 'receipt', date: '2019-04-01', quantity: '1.000', cost: '1.00' }),
      ),
    ).toBe('NO_PERIOD')
  })

  it('refuses an archived item', async () => {
    await db.updateTable('items').set({ is_archived: 1 }).where('id', '=', widget).execute()

    expect(
      await codeOf(() =>
        record({ kind: 'receipt', date: '2026-04-01', quantity: '1.000', cost: '1.00' }),
      ),
    ).toBe('ITEM_ARCHIVED')
  })

  /*
   * A BACK-DATED MOVEMENT IS THE CASE THIS WHOLE DESIGN IS ABOUT. It gets the HIGHEST
   * sequence and the EARLIEST date, so sorting by sequence and sorting by date disagree —
   * and `after` (what it left behind, in card order) is not `closing` (what the item holds
   * now). Both are reported, because a posting rule needs the first and a screen needs the
   * second.
   */
  it('puts a back-dated movement in its own place, not at the end', async () => {
    await record({ kind: 'receipt', date: '2026-04-10', quantity: '10.000', cost: '1000.00' })

    const backDated = await record({
      kind: 'receipt',
      date: '2026-04-01',
      quantity: '5.000',
      cost: '250.00',
    })

    expect(backDated.sequence).toBe(2)
    expect(backDated.after).toEqual({ quantity: '5.000', value: '250.00', unitCost: '50.000000' })
    expect(backDated.closing).toEqual({
      quantity: '15.000',
      value: '1250.00',
      unitCost: '83.333333',
    })

    const card = await stockCardFor(db, { itemId: widget, warehouseId: main })
    expect(card.rows.map((row) => row.date)).toEqual(['2026-04-01', '2026-04-10'])
    expect(card.rows.map((row) => row.sequence)).toEqual([2, 1])
  })

  /*
   * AND IT IS REFUSED WHEN IT MAKES AN EXISTING MOVEMENT IMPOSSIBLE. The whole card is
   * folded before anything is written, so a back-dated issue that empties the register
   * cannot be accepted and leave a LATER issue unvaluable — which would make the card
   * stop at that row and every figure after it vanish while the foot still tied.
   */
  it('refuses a back-dated movement that makes a later one impossible', async () => {
    await record({ kind: 'receipt', date: '2026-04-01', quantity: '10.000', cost: '1000.00' })
    await record({ kind: 'issue', date: '2026-04-10', quantity: '10.000' })

    const failure = await failureOf(() =>
      record({ kind: 'adjustment-out', date: '2026-04-05', quantity: '4.000' }),
    )

    expect(failure.code).toBe('INSUFFICIENT_STOCK')
    expect(failure.details).toMatchObject({ onHand: '6', requested: '10' })

    const card = await stockCardFor(db, { itemId: widget, warehouseId: main })
    expect(card.rows).toHaveLength(2)
  })

  it('keeps each place its own register, with its own average', async () => {
    await record({
      warehouseId: main,
      kind: 'receipt',
      date: '2026-04-01',
      quantity: '10.000',
      cost: '1000.00',
    })
    await record({
      warehouseId: yard,
      kind: 'receipt',
      date: '2026-04-01',
      quantity: '10.000',
      cost: '3000.00',
    })

    const mainIssue = await record({
      warehouseId: main,
      kind: 'issue',
      date: '2026-04-02',
      quantity: '1.000',
    })
    const yardIssue = await record({
      warehouseId: yard,
      kind: 'issue',
      date: '2026-04-02',
      quantity: '1.000',
    })

    expect(mainIssue.cost).toBe('100.00')
    expect(yardIssue.cost).toBe('300.00')
    /* Each register numbers its own movements from 1. */
    expect([mainIssue.sequence, yardIssue.sequence]).toEqual([2, 2])
  })
})

// ---- The golden stock card -------------------------------------------------

describe('the worked stock card, through SQLite', () => {
  /*
   * WRITTEN IN THE FIXTURE'S OWN ORDER — 5, 12, 1, 9, 3, 13, 7, 2, 11, 4, 10, 6, 8 —
   * which is neither sorted nor reversed, and which the repository could not produce: the
   * first of them is an issue of 60 against an empty item. That is exactly why it is
   * written past the repository. A fixture already in the answer's order cannot tell a
   * sorted card from an unsorted one, and this project has shipped that test twice.
   */
  beforeEach(() => {
    for (const entry of golden.movements) {
      writeGolden(entry)
    }
  })

  it('reproduces every row of it, figure for figure', async () => {
    const card = await stockCardFor(db, { itemId: widget, warehouseId: main })

    expect(card.problem).toBeNull()
    expect(
      card.rows.map((row) => ({
        sequence: row.sequence,
        kind: row.kind,
        moved: row.quantity,
        cost: row.cost,
        quantity: row.balance.quantity,
        unitCost: row.balance.unitCost,
        value: row.balance.value,
      })),
    ).toEqual(
      golden.expected.rows.map((row) => ({
        sequence: row.sequence,
        kind: row.kind,
        moved: row.moved,
        cost: row.cost,
        quantity: row.quantity,
        unitCost: row.unitCost,
        value: row.value,
      })),
    )
  })

  it('closes where the fixture closes, and totals what it totals', async () => {
    const card = await stockCardFor(db, { itemId: widget, warehouseId: main })

    expect(card.closing).toEqual(golden.expected.closing)
    expect(card.quantityIn).toBe(golden.expected.quantityIn)
    expect(card.quantityOut).toBe(golden.expected.quantityOut)
    expect(card.costIn).toBe(golden.expected.costIn)
    expect(card.costOut).toBe(golden.expected.costOut)
  })

  it('opens at nothing, because the fixture does', async () => {
    const card = await stockCardFor(db, { itemId: widget, warehouseId: main })

    expect(card.opening).toEqual({ quantity: '0.000', value: '0.00', unitCost: '0.000000' })
    expect(card.method).toBe('moving-average')
  })

  it('reports the same closing figure through stock on hand', async () => {
    const held = await stockOnHand(db, { itemId: widget })

    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({
      quantity: golden.expected.closing.quantity,
      value: golden.expected.closing.value,
      unitCost: golden.expected.closing.unitCost,
      warehouseCode: 'MAIN',
    })
  })

  /*
   * "AS AT A DATE" IS A FILTER ON THE REGISTER, NEVER ON THE ROWS SHOWN. As at 20 April
   * the item held what rows 1 to 7 left behind, not what it holds at the end — and the
   * figure has to come from folding those seven, not from subtracting later ones.
   */
  it('answers as at a date with the figure from that day', async () => {
    const held = await stockOnHand(db, { itemId: widget, asAt: '2026-04-20' })

    const seventh = golden.expected.rows[6]
    expect(held[0]).toMatchObject({
      quantity: seventh?.quantity,
      value: seventh?.value,
      unitCost: seventh?.unitCost,
    })
  })

  /*
   * A WINDOWED CARD OPENS WITH WHAT WAS ON HAND THE DAY BEFORE, folded from every earlier
   * movement. The cheap version — start from nothing and show only May's rows — would
   * report an item that arrived out of nowhere and value the 6 May issue against a pool
   * that never existed.
   */
  it('opens a windowed card at the state before the window', async () => {
    const card = await stockCardFor(db, { itemId: widget, warehouseId: main, from: '2026-05-01' })

    const tenth = golden.expected.rows[9]
    expect(card.opening).toEqual({
      quantity: tenth?.quantity,
      value: tenth?.value,
      unitCost: tenth?.unitCost,
    })
    expect(card.rows.map((row) => row.sequence)).toEqual([11, 12, 13])
    /* And it still ends where the whole card ends. */
    expect(card.closing).toEqual(golden.expected.closing)
    expect(card.quantityIn).toBe('32.000')
  })

  it('stops a card at a date without letting later rows into the totals', async () => {
    const card = await stockCardFor(db, { itemId: widget, warehouseId: main, to: '2026-04-12' })

    expect(card.rows.map((row) => row.sequence)).toEqual([1, 2, 3, 4])
    const fourth = golden.expected.rows[3]
    expect(card.closing).toEqual({
      quantity: fourth?.quantity,
      value: fourth?.value,
      unitCost: fourth?.unitCost,
    })
  })

  /*
   * A WINDOW WHOSE OPENING IS NOT NOTHING, and the reason it exists is a mutation that
   * survived the test above it.
   *
   * `from: '2026-05-01'` opens at row 10 — and row 10 is the issue that takes the item down
   * to EXACTLY nothing. So opening from the fold and opening from an empty state are the
   * same two figures, and dropping the opening argument entirely changed no assertion. A
   * fixture that cannot tell two implementations apart reports a missing measurement as a
   * clean one (CONVENTIONS §6).
   *
   * From 18 April the opening is 50.000 at 13462.12, which no empty state can imitate — and
   * the card that follows is not merely differently-labelled, it is impossible: with nothing
   * to open from, row 10 issues 72.000 out of an item holding 25.000 and the whole card
   * stops there. Both the opening AND the completeness are asserted, because either one on
   * its own would let some other way of getting the state wrong through.
   */
  it('opens a windowed card at a state that is not nothing', async () => {
    const card = await stockCardFor(db, { itemId: widget, warehouseId: main, from: '2026-04-18' })

    const fifth = golden.expected.rows[4]
    expect(card.opening).toEqual({
      quantity: fifth?.quantity,
      value: fifth?.value,
      unitCost: fifth?.unitCost,
    })
    expect(card.opening.quantity).not.toBe('0.000')
    expect(card.rows.map((row) => row.sequence)).toEqual([6, 7, 8, 9, 10, 11, 12, 13])
    expect(card.problem).toBeNull()
    expect(card.closing).toEqual(golden.expected.closing)

    /* And every row inside the window is still costed against the pool it inherited: row 7
     * leaves at the average the opening carried, not at one built from the window alone. */
    expect(card.rows.map((row) => row.cost)).toEqual(
      golden.expected.rows.slice(5).map((row) => row.cost),
    )
  })
})

describe('the worked stock card, written through recordMovement', () => {
  /*
   * A VALID ORDER THAT IS STILL NOT THE ANSWER'S ORDER. Every prefix has to fold — the
   * fixture's own listing starts with an issue against an empty item, which the repository
   * refuses, and rightly. What this order does keep is the case that matters: movement 10
   * (28 April, the issue that empties the item) goes in AFTER movement 11 (2 May), so it
   * is genuinely back-dated and the sequences the repository allocates disagree with the
   * card's order.
   *
   * The sequence numbers are therefore the repository's, not the fixture's, and the
   * assertion is on the ROWS IN ORDER rather than on sequence: the dates are distinct, so
   * date order alone decides the card and the allocated numbers are tiebreaks that never
   * tie.
   */
  const insertionOrder = [1, 2, 4, 3, 8, 5, 6, 7, 9, 11, 10, 12, 13]

  beforeEach(async () => {
    const bySequence = new Map(golden.movements.map((entry) => [entry.sequence, entry]))
    for (const sequence of insertionOrder) {
      const entry = bySequence.get(sequence)
      if (entry === undefined) {
        throw new Error(`The fixture has no movement ${String(sequence)}.`)
      }
      await record({
        kind: entry.kind,
        date: entry.date,
        quantity: entry.quantity,
        cost: entry.cost,
      })
    }
  })

  it('produces the same figures as the fixture, in the same order', async () => {
    const card = await stockCardFor(db, { itemId: widget, warehouseId: main })

    expect(card.problem).toBeNull()
    expect(
      card.rows.map((row) => ({
        kind: row.kind,
        date: row.date,
        moved: row.quantity,
        cost: row.cost,
        quantity: row.balance.quantity,
        unitCost: row.balance.unitCost,
        value: row.balance.value,
      })),
    ).toEqual(
      golden.expected.rows.map((row, index) => ({
        kind: row.kind,
        date: golden.movements.find((entry) => entry.sequence === index + 1)?.date,
        moved: row.moved,
        cost: row.cost,
        quantity: row.quantity,
        unitCost: row.unitCost,
        value: row.value,
      })),
    )
    expect(card.closing).toEqual(golden.expected.closing)
  })

  /* The rows the repository allocated are NOT in card order, which is what makes the
   * assertion above a statement about the sort rather than about the query. */
  it('allocated sequences that disagree with the card order', async () => {
    const card = await stockCardFor(db, { itemId: widget, warehouseId: main })
    const sequences = card.rows.map((row) => row.sequence)

    expect(sequences).not.toEqual([...sequences].sort((a, b) => a - b))
  })
})

// ---- What is on hand -------------------------------------------------------

describe('what is on hand', () => {
  beforeEach(async () => {
    await setItemStockTracking(db, { itemId: tape, isStockTracked: true, reorderLevel: '15.000' })

    await record({
      warehouseId: main,
      kind: 'receipt',
      date: '2026-04-01',
      quantity: '10.000',
      cost: '1000.00',
    })
    await record({
      warehouseId: yard,
      kind: 'receipt',
      date: '2026-04-01',
      quantity: '10.000',
      cost: '3000.00',
    })
    await record({
      itemId: tape,
      warehouseId: main,
      kind: 'receipt',
      date: '2026-04-01',
      quantity: '20.000',
      cost: '400.00',
    })
  })

  it('reports one row per place, ordered by item and then by place', async () => {
    const held = await stockOnHand(db)

    expect(
      held.map((row) => [row.itemName, row.warehouseCode, row.quantity, row.value, row.unitCost]),
    ).toEqual([
      ['Ball bearing 6203', 'BLR', '10.000', '3000.00', '300.000000'],
      ['Ball bearing 6203', 'MAIN', '10.000', '1000.00', '100.000000'],
      ['Packing tape', 'MAIN', '20.000', '400.00', '20.000000'],
    ])
  })

  /*
   * ROLLED UP BY SUMMING THE REGISTERS, not by pooling their movements. The two places
   * hold the same item at 100.00 and at 300.00 a unit; a single pool would value an issue
   * from either at 200.00, which is a figure no movement ever produced.
   */
  it('rolls up across places, and the average is the weighted one', async () => {
    const held = await stockOnHandByItem(db, { itemId: widget })

    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({
      warehouseId: null,
      warehouseCode: null,
      quantity: '20.000',
      value: '4000.00',
      unitCost: '200.000000',
    })
  })

  it('leaves out a place that holds nothing, unless asked', async () => {
    await record({ warehouseId: yard, kind: 'issue', date: '2026-04-02', quantity: '10.000' })

    const held = await stockOnHand(db, { itemId: widget })
    expect(held.map((row) => row.warehouseCode)).toEqual(['MAIN'])

    const all = await stockOnHand(db, { itemId: widget, includeEmpty: true })
    expect(all.map((row) => row.warehouseCode)).toEqual(['BLR', 'MAIN'])
  })

  /*
   * AT the level, not merely below it: an item with a reorder level of 25 and exactly 25
   * left needs re-ordering — the level is the point at which you buy. And `null` is not a
   * level of zero, which is the case that separates "no level set" from "a level of none".
   */
  it('flags what has fallen to its reorder level', async () => {
    const held = await stockOnHand(db, { itemId: tape })
    expect(held[0]?.isBelowReorderLevel).toBe(false)

    await record({
      itemId: tape,
      warehouseId: main,
      kind: 'issue',
      date: '2026-04-02',
      quantity: '10.000',
    })
    const after = await stockOnHand(db, { itemId: tape })

    expect(after[0]).toMatchObject({
      quantity: '10.000',
      reorderLevel: '15.000',
      isBelowReorderLevel: true,
    })
  })

  /* AT the level, not merely below it. The level is the point at which you buy, so an item
   * sitting exactly on it needs re-ordering — and `<` rather than `<=` would report it as
   * fine on the one day it matters. */
  it('flags what is sitting exactly on its reorder level', async () => {
    await record({
      itemId: tape,
      warehouseId: main,
      kind: 'issue',
      date: '2026-04-02',
      quantity: '5.000',
    })

    const held = await stockOnHand(db, { itemId: tape })
    expect(held[0]).toMatchObject({ quantity: '15.000', isBelowReorderLevel: true })
  })

  it('never flags an item with no level set', async () => {
    const held = await stockOnHand(db, { itemId: widget })

    expect(held.every((row) => row.isBelowReorderLevel)).toBe(false)
    expect(held.every((row) => row.reorderLevel === null)).toBe(true)
  })

  it('narrows to one place', async () => {
    const held = await stockOnHand(db, { warehouseId: yard })

    expect(held.map((row) => row.itemName)).toEqual(['Ball bearing 6203'])
  })
})

// ---- What a corrupt register does ------------------------------------------

/*
 * A REPORTED PROBLEM THAT IS ALWAYS NULL IS NOT A CHECK. Every test above asserts
 * `problem` is null, and a mutation replacing the whole expression with `null` would
 * survive all of them — so here is the file where it is not. `recordMovement` cannot
 * produce one, which is the whole reason these write straight at the table (0014-2's
 * lesson, in its inventory form).
 */
describe('a register that does not add up', () => {
  function writeRaw(
    id: string,
    kind: string,
    sequence: number,
    date: string,
    quantity: string,
    cost: string | null,
  ): void {
    connection
      .prepare(
        `INSERT INTO stock_ledger (id, item_id, warehouse_id, kind, movement_date, sequence,
           quantity, cost, source_type, created_at, entry_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stock-adjustment', ?, ?)`,
      )
      .run(id, widget, main, kind, date, sequence, quantity, cost, NOW, stubEntry)
  }

  it('stops the card at the movement it cannot value, and says so', async () => {
    writeRaw('m-1', 'receipt', 1, '2026-04-01', '4.000', '100.00')
    writeRaw('m-2', 'issue', 2, '2026-04-02', '6.000', null)
    writeRaw('m-3', 'receipt', 3, '2026-04-03', '10.000', '500.00')

    const card = await stockCardFor(db, { itemId: widget, warehouseId: main })

    expect(card.rows.map((row) => row.sequence)).toEqual([1])
    expect(card.problem?.code).toBe('INSUFFICIENT_STOCK')
    /* And the card it DID produce ties perfectly at its own foot, which is exactly why it
     * has to report the problem rather than leave a reader to notice. */
    expect(card.closing).toEqual({ quantity: '4.000', value: '100.00', unitCost: '25.000000' })
    expect(card.costIn).toBe('100.00')
  })

  it('carries the problem onto the on-hand figure, which would otherwise look ordinary', async () => {
    writeRaw('m-1', 'receipt', 1, '2026-04-01', '4.000', '100.00')
    writeRaw('m-2', 'issue', 2, '2026-04-02', '6.000', null)

    const held = await stockOnHand(db, { itemId: widget })

    expect(held[0]?.quantity).toBe('4.000')
    expect(held[0]?.problem?.code).toBe('INSUFFICIENT_STOCK')
  })

  /* Two movements sharing a place blank the whole card rather than reordering two rows:
   * under moving average issue-then-receive and receive-then-issue are different cards, so
   * the tie is a real ambiguity. The unique index refuses it here, so it is reached with
   * two warehouses' worth of rows read as one — the shape a missing WHERE clause makes. */
  it('refuses to fold a set with two movements in one place', async () => {
    writeRaw('m-1', 'receipt', 1, '2026-04-01', '4.000', '100.00')
    expect(() => writeRaw('m-2', 'receipt', 1, '2026-04-01', '4.000', '100.00')).toThrow(
      /UNIQUE constraint failed/,
    )
  })

  /* A value against nothing on hand is invariant 6's illegal half, and no movement can
   * produce it — so the register that carries one was written by something else, and
   * `checkState` names it rather than dividing by zero. Reached by capitalising freight
   * onto an item holding nothing. */
  it('refuses a cost with no quantity to carry it', async () => {
    writeRaw('m-1', 'receipt', 1, '2026-04-01', '0.000', '1200.00')

    const card = await stockCardFor(db, { itemId: widget, warehouseId: main })

    expect(card.problem?.code).toBe('COST_WITHOUT_QUANTITY')
    expect(card.rows).toHaveLength(0)
  })
})

/* A sanity check on the fixture itself: if somebody rewrites `stock-card.json` into the
 * answer's order, the tests above stop testing the sort and nothing else would say so. */
describe('the fixture', () => {
  it('lists its movements out of card order', () => {
    const sequences = golden.movements.map((entry) => entry.sequence)

    expect(sequences).not.toEqual([...sequences].sort((a, b) => a - b))
    expect(sequences).not.toEqual([...sequences].sort((a, b) => b - a))
    expect(sequences).toHaveLength(golden.expected.rows.length)
  })

  it('is a card that a decimal comparison agrees with', () => {
    /* The closing value is the last row's, not a second sum — asserted against the fixture
     * as a Decimal so a re-formatted string could not pass as a re-computed figure. */
    const last = golden.expected.rows.at(-1)
    expect(D(golden.expected.closing.value).equals(D(last?.value ?? '0.00'))).toBe(true)
  })
})
