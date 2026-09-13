/*
 * THE INVARIANT PHASE 4 EXISTS FOR: inventory on the balance sheet equals the stock
 * register, to the paisa, as at every date.
 *
 * ARCHITECTURE §6.4: "Every stock movement writes to the stock ledger AND posts to the
 * general ledger, so inventory value on the balance sheet always reconciles with the
 * stock register." Everything else in Phase 4 is machinery for this sentence. This file
 * is the sentence.
 *
 * ===========================================================================
 * WHY IT ASSERTS FIGURES AND NOT ONLY THAT THE TWO SIDES AGREE
 * ===========================================================================
 *
 * Because an invariant that holds BY CONSTRUCTION cannot see a dropped row, and this
 * project has shipped exactly that test before — the aged report's `ties`, which every
 * test asserted true and which a mutation replacing the whole expression with `true`
 * survived (CONVENTIONS §6). If a movement failed to post at all, both sides would be
 * short by the same amount and `stockValue === balanceSheetStock` would still be TRUE.
 *
 * So every figure below is written out, worked by hand from the movements above it, and
 * the reconciliation is asserted on TOP of them rather than instead of them. Three
 * separate things are pinned and each catches something the others cannot:
 *
 *   THE REGISTER'S OWN CLOSING FIGURES, per item and per warehouse. A movement that never
 *   reached the register makes these wrong.
 *   THE LEDGER ACCOUNTS, one by one — stock, cost of goods sold, stock adjustment,
 *   purchases. A movement posted to the WRONG counter account leaves the stock account
 *   right and one of these wrong, and no total anywhere would notice.
 *   THE TWO AGAINST EACH OTHER, which is the sentence itself.
 *
 * ===========================================================================
 * THE FIXTURE IS ORDERED TO DISAGREE WITH ITS OWN ANSWER
 * ===========================================================================
 *
 * The back-dated receipt is recorded LAST and dated SECOND. That is the case the whole
 * design turns on: it takes the highest sequence and an early date, it re-averages the
 * pool, and it changes what three movements after it cost — three movements whose journal
 * entries are already posted and cannot be edited (ledger invariant 3).
 *
 * TWO ITEMS IN TWO WAREHOUSES, so the balance-sheet figure is a genuine sum of two
 * registers rather than a copy of one. A single register would let "the balance sheet
 * equals the stock register" pass while the code compared one register against itself.
 *
 * ===========================================================================
 * THE AS-AT ASSERTIONS ARE THE ONES THAT PIN THE HARD DECISION
 * ===========================================================================
 *
 * A back-dated receipt on the 8th changes what an issue on the 12th cost. The correcting
 * entry is dated at the MOVEMENT IT RESTATES — the 12th — and not at the movement that
 * caused it. Both choices give the same answer at the end of the month, so a test that
 * only looked at the closing figures could not tell them apart.
 *
 * `reconciles as at every date` is what tells them apart. On the 11th the issue has not
 * happened in either book, so both must read 6,500.00; dating the corrections at the 8th
 * would make the ledger read 6,265.28 and the register 6,500.00 on that day, and both
 * pages would still total.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { D, sum, toMoneyString } from '@main/domain/money'
import { aprilToMarch, fixedClock } from '@main/domain/time'
import type { StockMovementKind } from '@main/domain/inventory'
import type { DateString, RecordedStockMovement } from '@shared/dto'

import { DATABASE_KEY_BYTES, closeDatabase, openDatabase, type SqliteDatabase } from '../connection'
import { createQueryBuilder, type CofferDb } from '../kysely'
import { runMigrations } from '../migrate'
import { MIGRATIONS } from '../migrations'
import { clearAccountRole } from './accounts'
import { accountBalance } from './balances'
import { setUpBooks } from './bootstrap'
import { isRepoError } from './errors'
import { createItem } from './items'
import { getEntry, getEntryForSource } from './journal'
import { closePeriod, listPeriods } from './periods'
import { balanceSheet } from './reports'
import {
  createWarehouse,
  defaultWarehouseId,
  recordMovement,
  setItemStockTracking,
  stockOnHand,
} from './stock'

const KEY = new Uint8Array(DATABASE_KEY_BYTES).fill(0x42)
const CLOCK = fixedClock('2026-04-01T09:00:00.000Z')

/** Codes from the shipped chart. The roles are what the posting rule asks for. */
const STOCK = '1400'
const COST_OF_GOODS_SOLD = '5300'
const PURCHASES = '5100'
const STOCK_ADJUSTMENT = '5500'

const directories: string[] = []
const handles: SqliteDatabase[] = []

let connection: SqliteDatabase
let db: CofferDb
let widget: string
let gasket: string
let main: string
let yard: string

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-recon-'))
  directories.push(dir)
  connection = openDatabase({ filePath: join(dir, 'company.coffer'), key: KEY })
  handles.push(connection)
  runMigrations(connection, MIGRATIONS)
  db = createQueryBuilder(connection)

  await setUpBooks(db, { rule: aprilToMarch, clock: CLOCK })

  widget = (await createItem(db, { name: 'Ball bearing 6203', kind: 'goods', isSold: true })).id
  gasket = (await createItem(db, { name: 'Gasket set', kind: 'goods', isSold: true })).id
  await setItemStockTracking(db, { itemId: widget, isStockTracked: true })
  await setItemStockTracking(db, { itemId: gasket, isStockTracked: true })

  main = await defaultWarehouseId(db)
  yard = (await createWarehouse(db, { code: 'BLR', name: 'Bengaluru yard' })).id
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

// ---- The month -------------------------------------------------------------

interface Spec {
  itemId: string
  warehouseId: string
  kind: StockMovementKind
  date: DateString
  quantity: string
  cost?: string
}

async function record(spec: Spec): Promise<RecordedStockMovement> {
  return recordMovement(db, {
    itemId: spec.itemId,
    warehouseId: spec.warehouseId,
    kind: spec.kind,
    date: spec.date,
    quantity: spec.quantity,
    cost: spec.cost ?? null,
    sourceType: 'stock-adjustment',
  })
}

/**
 * A month of movements, RECORDED IN AN ORDER THAT DISAGREES WITH ITS OWN DATES.
 *
 * The widget's registers, worked by hand and in CARD order (date, then sequence). The
 * back-dated receipt is written last and dated the 8th, so every figure after it moves.
 *
 *   05 Apr  receipt          10.000 @ 1,000.00 stated     10.000    1,000.00   unit 100
 *   08 Apr  receipt          10.000 @ 2,000.00 stated     20.000    3,000.00   unit 150   ← last in
 *   10 Apr  receipt          20.000 @ 3,000.00 stated     40.000    6,000.00   unit 150
 *   12 Apr  issue             5.000 valued at    750.00   35.000    5,250.00   unit 150
 *   15 Apr  sales return      5.000 @   600.00 stated     40.000    5,850.00   unit 146.25
 *   18 Apr  adjustment out    4.000 valued at    585.00   36.000    5,265.00   unit 146.25
 *   20 Apr  purchase return   6.000 valued at    877.50   30.000    4,387.50   unit 146.25
 *
 * The gasket, in the OTHER warehouse, so the balance sheet has two registers to add up:
 *
 *   06 Apr  receipt         100.000 @   500.00 stated    100.000      500.00   unit 5
 *   14 Apr  issue            40.000 valued at    200.00   60.000      300.00   unit 5
 *
 * Every division above is exact at money scale, deliberately. A fixture whose expected
 * figures came out of the code would prove only that the code agrees with itself.
 */
async function writeTheMonth(): Promise<RecordedStockMovement> {
  await record({ itemId: widget, warehouseId: main, kind: 'receipt', date: '2026-04-05', quantity: '10.000', cost: '1000.00' }) // prettier-ignore
  await record({ itemId: gasket, warehouseId: yard, kind: 'receipt', date: '2026-04-06', quantity: '100.000', cost: '500.00' }) // prettier-ignore
  await record({ itemId: widget, warehouseId: main, kind: 'receipt', date: '2026-04-10', quantity: '20.000', cost: '3000.00' }) // prettier-ignore
  await record({ itemId: widget, warehouseId: main, kind: 'issue', date: '2026-04-12', quantity: '5.000' }) // prettier-ignore
  await record({ itemId: gasket, warehouseId: yard, kind: 'issue', date: '2026-04-14', quantity: '40.000' }) // prettier-ignore
  await record({ itemId: widget, warehouseId: main, kind: 'sales-return', date: '2026-04-15', quantity: '5.000', cost: '600.00' }) // prettier-ignore
  await record({ itemId: widget, warehouseId: main, kind: 'adjustment-out', date: '2026-04-18', quantity: '4.000' }) // prettier-ignore
  await record({ itemId: widget, warehouseId: main, kind: 'purchase-return', date: '2026-04-20', quantity: '6.000' }) // prettier-ignore

  /* LAST IN, SECOND BY DATE. Everything above it in card order is already posted. */
  return record({ itemId: widget, warehouseId: main, kind: 'receipt', date: '2026-04-08', quantity: '10.000', cost: '2000.00' }) // prettier-ignore
}

// ---- Reading the two registers --------------------------------------------

/** What the stock register says everything is worth, as at a date. */
async function registerValue(asAt: DateString): Promise<string> {
  const rows = await stockOnHand(db, { asAt, includeEmpty: true })
  for (const row of rows) {
    /* A row that could not be folded is stock as at the last movement it could value, not
     * as at the date asked for — so a total over it would be a plausible wrong figure. */
    expect(row.problem, `${row.itemName} at ${row.warehouseName ?? '?'}`).toBeNull()
  }
  return toMoneyString(sum(rows.map((row) => D(row.value))))
}

/**
 * What the balance sheet carries as inventory, as at a date.
 *
 * AN ABSENT LINE IS NOT A MISSING FIGURE. A statement lists the accounts with movement in
 * it, so before the first receipt there is no stock line at all and the right answer is
 * nothing. The account is looked up in the CHART first and separately, so that "nobody has
 * posted to stock yet" cannot be mistaken for "these books have no stock account" — which
 * would make every reconciliation below pass against a file with no seam in it at all.
 */
async function balanceSheetStock(asAt: DateString): Promise<string> {
  const stock = await accountIdOf(STOCK)
  const sheet = await balanceSheet(db, asAt)
  return sheet.assets.lines.find((each) => each.accountId === stock)?.amount ?? '0.00'
}

async function accountIdOf(code: string): Promise<string> {
  const account = await db
    .selectFrom('accounts')
    .select('id')
    .where('code', '=', code)
    .executeTakeFirst()
  expect(account, `the shipped chart has no account ${code}`).toBeDefined()
  return account!.id
}

async function balanceOf(code: string): Promise<string> {
  return (await accountBalance(db, await accountIdOf(code))).balance
}

// ---- The tests -------------------------------------------------------------

describe('inventory on the balance sheet, against the stock register', () => {
  beforeEach(async () => {
    await writeTheMonth()
  })

  it('holds the figures the register was worked out to hold', async () => {
    const rows = await stockOnHand(db, { includeEmpty: true })
    const held = rows.map((row) => [row.itemName, row.quantity, row.value, row.unitCost])

    /* Ordered by item then warehouse by the repository, not by the order they were
     * written — which was neither. */
    expect(held).toEqual([
      ['Ball bearing 6203', '30.000', '4387.50', '146.250000'],
      ['Gasket set', '60.000', '300.00', '5.000000'],
    ])
  })

  it('carries exactly that value on the balance sheet', async () => {
    /* 4,387.50 + 300.00, and written out rather than summed here: a test that added the
     * two rows up would agree with the register by construction. */
    expect(await balanceSheetStock('2026-04-30')).toBe('4687.50')
    expect(await registerValue('2026-04-30')).toBe('4687.50')
  })

  it('puts every movement in the account its kind faces, and no other', async () => {
    /*
     * THE ASSERTION THAT CATCHES A MOVEMENT POSTED TO THE WRONG COUNTER. The stock
     * account would still tie and the balance sheet would still balance; only these four
     * figures move.
     *
     *   COGS         750.00 out on the issue, 600.00 back on the sales return   = 150.00
     *   Adjustment   585.00 write-off + 877.50 purchase return                  = 1,462.50
     *                plus the gasket's 200.00 issue in COGS                     = 350.00
     *   Purchases    1,000 + 3,000 + 2,000 + 500 received, all credited         = 6,500.00 Cr
     */
    expect(await balanceOf(STOCK)).toBe('4687.50')
    expect(await balanceOf(COST_OF_GOODS_SOLD)).toBe('350.00')
    expect(await balanceOf(STOCK_ADJUSTMENT)).toBe('1462.50')
    expect(await balanceOf(PURCHASES)).toBe('-6500.00')
  })

  it('leaves a balance sheet that balances', async () => {
    const sheet = await balanceSheet(db, '2026-04-30')

    expect(sheet.balanced).toBe(true)
    /* And the figure it balances AT, so that `balanced` is not the only claim. Nothing
     * but stock has been posted, so the whole of it is the stock and the whole of the
     * other side is the profit those counter accounts net to. */
    expect(sheet.totalAssets).toBe('4687.50')
    expect(sheet.profitForPeriod).toBe('4687.50')
  })

  /*
   * THE ONE THAT PINS THE DATING OF A CORRECTION. Both dating rules agree on the 30th and
   * disagree on every day between the back-dated receipt and the movements it re-valued.
   */
  it('reconciles as at every date, not only at the end of the month', async () => {
    const dates: DateString[] = [
      '2026-04-04', // before anything
      '2026-04-05', // one receipt
      '2026-04-07', // the gasket has arrived, the back-dated receipt has not
      '2026-04-08', // the back-dated receipt, on its own date
      '2026-04-11', // ← the window: re-averaged, and nothing it re-valued has happened yet
      '2026-04-13', // the issue, at its NEW cost
      '2026-04-16',
      '2026-04-19',
      '2026-04-30',
    ]

    for (const date of dates) {
      expect([date, await balanceSheetStock(date)]).toEqual([date, await registerValue(date)])
    }
  })

  it('reads the same figure on both sides on the day in the middle of the window', async () => {
    /*
     * Written out by value as well as compared, because the loop above compares two
     * things this code produces and would pass if BOTH were wrong. On the 11th the
     * widget's pool is 40.000 at 6,000.00 and the gasket's is 100.000 at 500.00.
     */
    expect(await registerValue('2026-04-11')).toBe('6500.00')
    expect(await balanceSheetStock('2026-04-11')).toBe('6500.00')

    /* And on the 13th, after the issue, at the cost the re-average gave it: 750.00 out of
     * 6,500.00, not the 666.67 the issue originally posted. */
    expect(await registerValue('2026-04-13')).toBe('5750.00')
    expect(await balanceSheetStock('2026-04-13')).toBe('5750.00')
  })
})

describe('what a back-dated movement reports about itself', () => {
  it('says which movements it re-valued, on which dates, and by how much', async () => {
    const recorded = await writeTheMonth()

    /*
     * The three outward movements after it in card order. THE SALES RETURN ON THE 15TH IS
     * NOT AMONG THEM and its absence is the assertion: an inward movement STATES its cost
     * (invariant 4) and no re-averaging can move a figure the row itself carries.
     *
     * `stockAmount` is signed to ADD to the stock account, so it is negative here: a
     * receipt back-dated at a HIGHER unit cost makes everything after it cost more, and
     * more value leaving means less stock on hand than the ledger had recorded.
     */
    expect(recorded.revaluations).toEqual([
      { entryId: expect.any(String), date: '2026-04-12', stockAmount: '-83.33', movements: 1 },
      { entryId: expect.any(String), date: '2026-04-18', stockAmount: '-60.56', movements: 1 },
      { entryId: expect.any(String), date: '2026-04-20', stockAmount: '-90.83', movements: 1 },
    ])

    /* The three together are exactly the gap between what the movement's own entry put
     * into stock and what the register says is there — and the corrections are what close
     * it. 234.72 = 83.33 + 60.56 + 90.83. */
    const closed = sum(recorded.revaluations.map((each) => D(each.stockAmount)))
    expect(toMoneyString(closed)).toBe('-234.72')
  })

  it('reports the movement in card order and the register as it now stands, differently', async () => {
    const recorded = await writeTheMonth()

    /* 0019's own detection: `after` is the pool immediately behind the back-dated receipt
     * and `closing` is the pool today. They differ exactly when something is back-dated,
     * which is the fact a posting rule needs. */
    expect(recorded.after).toEqual({
      quantity: '20.000',
      value: '3000.00',
      unitCost: '150.000000',
    })
    expect(recorded.closing).toEqual({
      quantity: '30.000',
      value: '4387.50',
      unitCost: '146.250000',
    })
  })

  it('posts nothing to correct when nothing was back-dated', async () => {
    const first = await record({
      itemId: widget,
      warehouseId: main,
      kind: 'receipt',
      date: '2026-04-05',
      quantity: '10.000',
      cost: '1000.00',
    })
    const second = await record({
      itemId: widget,
      warehouseId: main,
      kind: 'issue',
      date: '2026-04-06',
      quantity: '4.000',
    })

    expect(first.revaluations).toEqual([])
    expect(second.revaluations).toEqual([])
    expect(second.cost).toBe('400.00')
    expect(await balanceSheetStock('2026-04-30')).toBe('600.00')
    expect(await registerValue('2026-04-30')).toBe('600.00')
  })
})

describe('every movement carries the entry it posted', () => {
  /*
   * THE SOURCE PAIR IS UNIQUE PER MOVEMENT, and that is a decision rather than a detail.
   * `getEntryForSource` takes the FIRST row it finds (CONVENTIONS §6 on `.find`, wearing a
   * query's clothes), so an entry sharing (type, id) with the document's own entry would
   * make a drill-through land on whichever came back first. The movement's own id is what
   * keeps the pair unique; the NUMBER is the raising document's, so a day book still reads
   * "against GRN-7" rather than a uuid.
   */
  it('names the movement rather than the document, so the pair has one answer', async () => {
    const recorded = await recordMovement(db, {
      itemId: widget,
      warehouseId: main,
      kind: 'receipt',
      date: '2026-04-05',
      quantity: '10.000',
      cost: '1000.00',
      sourceType: 'purchase-bill',
      sourceId: 'a-purchase-bill-somewhere',
      sourceNumber: 'BILL/2026-27/0009',
    })

    const found = await getEntryForSource(db, 'stock-adjustment', recorded.movementId)
    expect(found?.id).toBe(recorded.entryId)
    expect(found?.sourceNumber).toBe('BILL/2026-27/0009')
    expect(found?.narration).toBe('Receipt: Ball bearing 6203 against BILL/2026-27/0009')

    /* And NOT under the document's own type and id, which is where the invoice's own entry
     * would be if a document had raised this. */
    expect(await getEntryForSource(db, 'purchase-bill', 'a-purchase-bill-somewhere')).toBeNull()
  })

  /*
   * A CORRECTING ENTRY CARRIES NO SOURCE ID, for the same reason. Several of them can arise
   * from one movement — one per affected date — so giving them the movement's id would turn
   * the lookup above into a `.find` over rows. What they carry instead is a narration that
   * names the item, the date and the movement that caused them.
   */
  it('leaves a correction unattached, and says in words what caused it', async () => {
    const recorded = await writeTheMonth()
    const first = recorded.revaluations[0]
    expect(first).toBeDefined()

    const entry = await getEntry(db, first!.entryId)
    expect(entry?.sourceType).toBe('stock-adjustment')
    expect(entry?.sourceId).toBeNull()
    expect(entry?.narration).toContain('Ball bearing 6203')
    expect(entry?.narration).toContain('back-dated to 2026-04-08')
    expect(entry?.date).toBe('2026-04-12')
  })

  it('names one, and the ledger holds it', async () => {
    const recorded = await record({
      itemId: widget,
      warehouseId: main,
      kind: 'receipt',
      date: '2026-04-05',
      quantity: '10.000',
      cost: '1000.00',
    })

    expect(recorded.entryId).not.toBeNull()

    const row = await db
      .selectFrom('stock_ledger')
      .select('entry_id')
      .where('id', '=', recorded.movementId)
      .executeTakeFirst()
    expect(row?.entry_id).toBe(recorded.entryId)
  })

  /*
   * A MOVEMENT THAT MOVED NO MONEY POSTS NOTHING, and that is not a hole in the
   * reconciliation — it is the reason 0022's trigger is written the way it is. A free
   * sample taken in at nil changes the quantity and not the value, and an entry of two
   * zero lines is refused by ledger invariant 5.
   */
  it('names none when the movement moved nothing, and still reconciles', async () => {
    const free = await record({
      itemId: widget,
      warehouseId: main,
      kind: 'receipt',
      date: '2026-04-05',
      quantity: '10.000',
      cost: '0.00',
    })

    expect(free.entryId).toBeNull()
    expect(await registerValue('2026-04-30')).toBe('0.00')
    expect(await balanceSheetStock('2026-04-30')).toBe('0.00')

    const held = await stockOnHand(db, { itemId: widget })
    expect(held[0]?.quantity).toBe('10.000')
  })
})

/*
 * ===========================================================================
 * ONE TRANSACTION, OR NEITHER HALF
 * ===========================================================================
 *
 * ARCHITECTURE §6.4 says every movement writes to both registers. What makes that a
 * PROPERTY rather than an intention is that the two happen together: a movement that
 * cannot post leaves no row behind, and a row that was written has an entry. There is no
 * "recorded but not yet posted" state to represent, exactly as there is none for an issued
 * document (rule 3, domain/documents/types.ts).
 *
 * The order inside the transaction is forced twice over — `stock_ledger.entry_id`
 * REFERENCES `journal_entries(id)`, so the parent has to exist; and nothing may be written
 * before the posting is known to work, which is only true because the entry goes first.
 */
describe('a movement and its entry are one transaction', () => {
  async function codeOf(run: () => Promise<unknown>): Promise<string> {
    try {
      await run()
    } catch (error) {
      return isRepoError(error) ? error.code : `not a RepoError: ${String(error)}`
    }
    return 'no error thrown'
  }

  async function registerRows(): Promise<number> {
    const rows = await db.selectFrom('stock_ledger').select('id').execute()
    return rows.length
  }

  async function entries(): Promise<number> {
    const rows = await db.selectFrom('journal_entries').select('id').execute()
    return rows.length
  }

  const receipt: Spec = {
    itemId: 'set below',
    warehouseId: 'set below',
    kind: 'receipt',
    date: '2026-04-05',
    quantity: '10.000',
    cost: '1000.00',
  }

  it('writes no row at all when the posting cannot be made', async () => {
    /* The chart has no account for stock, which is the one thing a stock movement cannot
     * post without. A real file reaches this by somebody removing the mapping. */
    await clearAccountRole(db, 'stock')

    expect(await codeOf(() => record({ ...receipt, itemId: widget, warehouseId: main }))).toBe(
      'ROLE_UNMAPPED',
    )

    expect(await registerRows()).toBe(0)
    expect(await entries()).toBe(0)
  })

  it('writes no entry at all when the movement is refused', async () => {
    /* An issue against an empty register: refused by the domain, before anything is
     * written. The assertion is that the LEDGER is untouched as well as the register — a
     * posting made and then rolled back would leave an entry number spent. */
    expect(
      await codeOf(() =>
        record({
          itemId: widget,
          warehouseId: main,
          kind: 'issue',
          date: '2026-04-05',
          quantity: '1.000',
        }),
      ),
    ).toBe('INSUFFICIENT_STOCK')

    expect(await registerRows()).toBe(0)
    expect(await entries()).toBe(0)
  })

  /*
   * A CLOSED PERIOD REFUSES BOTH HALVES. `requirePostablePeriod` is asked by the
   * repository as well as by `postEntry`, and the second copy is not redundant: a movement
   * that moved no money posts nothing, so without the repository's own check a free sample
   * could be recorded into a filed year with no entry to refuse it.
   */
  it('refuses a movement into a closed year, even one that moves no money', async () => {
    const periods = await listPeriods(db, {})
    const april = periods.find((period) => period.startDate === '2026-04-01')
    expect(april, 'the fixture generates April 2026').toBeDefined()
    await closePeriod(db, april!.id)

    expect(await codeOf(() => record({ ...receipt, itemId: widget, warehouseId: main }))).toBe(
      'PERIOD_CLOSED',
    )
    expect(
      await codeOf(() => record({ ...receipt, itemId: widget, warehouseId: main, cost: '0.00' })),
    ).toBe('PERIOD_CLOSED')

    expect(await registerRows()).toBe(0)
    expect(await entries()).toBe(0)
  })

  /*
   * AND THE BACK-DATED CASE, WHICH WRITES FOUR THINGS OR NONE. The movement's own entry,
   * three correcting entries and the register row all land together — so a correction that
   * could not post would take the movement with it rather than leaving the ledger half
   * restated.
   */
  it('writes the movement, its entry and every correction together', async () => {
    await writeTheMonth()

    const movements = await db.selectFrom('stock_ledger').selectAll().execute()
    expect(movements).toHaveLength(9)
    /* Every row that moved money names an entry; the ones at nil are the exception the
     * trigger stands aside for, and this fixture has none. */
    expect(movements.every((row) => row.entry_id !== null)).toBe(true)

    /* Nine movements, nine entries, plus the three corrections the back-dating made. */
    expect(await entries()).toBe(12)
  })
})
