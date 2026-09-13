/*
 * The stock repository — warehouses, which items keep a balance, and the register itself.
 *
 * Read migration 0019 first, then src/main/domain/inventory/types.ts. The two decisions
 * that shape every function below are made there and restated here only as consequences:
 *
 *   NOTHING IN THIS FILE DOES VALUATION ARITHMETIC. Not a multiplication, not a division,
 *   not a rounding. `MOVING_AVERAGE.applyMovement` decides what a movement costs and
 *   `runStockCard` decides what the register holds, and this file's whole job is to hand
 *   them rows and turn what comes back into a DTO. A second implementation of the average
 *   — even a "simple" one for a summary figure — is a second answer to a question the
 *   balance sheet already has an answer to.
 *
 *   NO RUNNING BALANCE IS READ FROM A COLUMN, because there is no column. Every figure a
 *   card or an on-hand report shows is folded from the movements when it is asked for.
 *   That is invariant 7 and CONVENTIONS §1.3, and 0019's header is the argument.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS CHECKED HERE AS WELL AS THERE, AND WHY IT IS IN THIS ORDER
 *
 * The repository speaks FIRST and the trigger is the floor underneath (CONVENTIONS §6).
 * That is not a preference: a repository check that runs after the write which trips the
 * trigger can never answer, and no assertion on a code can tell, because both layers
 * report the same one. So `recordMovement` establishes the item, the warehouse and the
 * period before it touches `stock_ledger`, and the sentence a user reads has the figures
 * in it — how much is on hand, and how much this movement wanted to take out.
 *
 * Where the two layers share a code, the repository puts `details` on the error and the
 * trigger cannot. That is what a test asserts on to tell them apart.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS CHECKED ONLY HERE
 *
 * AN ARCHIVED WAREHOUSE OR AN ARCHIVED ITEM takes nothing new. 0004's decision about
 * archived accounts, 0005's about parties and 0006's about units, for the fourth time:
 * archiving is a stated intention rather than a correctness rule, and a trigger would
 * make a historical movement uncorrectable the moment something it names is archived.
 *
 * A WAREHOUSE THAT HOLDS STOCK MAY NOT BE ARCHIVED OR DELETED. This one is about a
 * report — its value would drop off every stock page while the balance sheet kept it —
 * and it is still not a trigger, because "holds stock" is a running total whose value
 * side is not in the table at all. The question is asked of the domain, in
 * `warehouseHoldsStock`.
 *
 * THE PERIOD BEING OPEN. A movement dated into a closed year changes the closing stock of
 * a year that has been filed. The floor under it is 0004's `journal_entries_period_open`,
 * one table over, because ARCHITECTURE §6.4 says every movement posts.
 *
 * ---------------------------------------------------------------------------
 * ERRORS
 *
 * `RepoError`, like every other repository. Phase 4.1 carried a parallel error class and
 * a parallel code union here, for a stated reason that was about PATHS rather than
 * design: `repos/errors.ts` belonged to nobody that batch, and adding members to a
 * contract other work was building on would have been editing across a boundary
 * (CONVENTIONS §8). The two were deliberately the same shape — a stable code, a sentence,
 * structured `details` — so the merge at the integration gate was a union member per line
 * and no call site changed.
 *
 * The valuation codes are the domain's own `InventoryErrorCode`, unchanged and not
 * re-spelled, so "you have 4 on hand" is one code whether the domain or a screen noticed
 * it — `RepoErrorCode` includes that union rather than copying it.
 *
 * AND THE MERGE CLOSED SOMETHING THE PARALLEL CLASS QUIETLY OPENED. `repoErrorFrom` reads
 * a trigger's abort message back into a code from ONE list, and `errors.test.ts` builds
 * that list by reading the migrations. A second class with a second `TRIGGER_CODES`
 * beside it was a second thing for a later migration to fall out of step with, and the
 * test that catches that only ever looked at the first.
 */

import { randomUUID } from 'node:crypto'

import { sql } from 'kysely'

import {
  ZERO,
  parseMoney,
  parseQuantity,
  sum,
  toMoneyString,
  toQuantityString,
  type Decimal,
} from '@main/domain/money'
import { isDateString } from '@main/domain/time'
import {
  MOVING_AVERAGE,
  STOCK_MOVEMENT_KINDS,
  UNIT_COST_SCALE,
  costChangesBetween,
  definitionOf,
  movementEntry,
  revaluationsFor,
  roundUnitCost,
  runStockCard,
  unitCostOf,
  type CostChange,
  type InventoryProblem,
  type MovementPosting,
  type StockMovement,
  type StockMovementKind,
  type StockMovementKindDefinition,
  type ValuationState,
} from '@main/domain/inventory'
import { isPostingError, type AccountResolver, type SourceDocument } from '@main/domain/ledger'
import type {
  AppError,
  CreateWarehouseInput,
  StockRevaluation,
  DateString,
  DecimalString,
  ItemStockSettings,
  ListWarehousesInput,
  RecordStockMovementInput,
  RecordedStockMovement,
  SetItemStockTrackingInput,
  StockBalance,
  StockCard,
  StockCardInput,
  StockCardRow,
  StockOnHandInput,
  StockOnHandRow,
  UpdateWarehouseInput,
  Warehouse,
} from '@shared/dto'

import type { CofferDb } from '../kysely'
import type { StockLedgerTable, WarehousesTable } from '../schema'
import { buildResolver } from './accounts'
import { RepoError, repoErrorFrom, type RepoErrorCode } from './errors'
import { postEntry } from './journal'
import { requirePostablePeriod } from './periods'
import { inTransaction } from './transaction'

type WarehouseRow = { [K in keyof WarehousesTable]: WarehousesTable[K] }
type LedgerRow = { [K in keyof StockLedgerTable]: StockLedgerTable[K] }

// ---- Errors ----------------------------------------------------------------

/** A domain refusal, in this layer's currency. `details` comes across as the domain built it. */
function fromProblem(problem: InventoryProblem): RepoError {
  return new RepoError(problem.code, problem.message, { ...problem.details })
}

/** A domain refusal on its way to a screen. */
export function toAppError(problem: InventoryProblem): AppError {
  return { code: problem.code, message: problem.message, details: { ...problem.details } }
}

// ---- Scalars ---------------------------------------------------------------

/**
 * Render a unit cost for a column: exactly six places.
 *
 * NOT `toStorageString`, and the absence is deliberate. `ROUNDING_POINTS` in
 * domain/money/scale.ts has no unit-cost entry, and the note at the top of
 * domain/inventory/cost.ts says it should gain one "when the stock ledger table lands".
 * It has landed and it stores no unit cost — 0019 holds a quantity and a value and
 * derives the rest — so there is no column for a rounding point to name, and adding one
 * would be a named point that nothing rounds at. `roundUnitCost` is the rounding, taken
 * from the domain with its mode; this only formats.
 */
function toUnitCostString(value: Decimal): DecimalString {
  return roundUnitCost(value).toFixed(UNIT_COST_SCALE)
}

function balanceOf(quantity: Decimal, value: Decimal): StockBalance {
  return {
    quantity: toQuantityString(quantity),
    value: toMoneyString(value),
    unitCost: toUnitCostString(unitCostOf(quantity, value)),
  }
}

function balanceOfState(state: ValuationState): StockBalance {
  return balanceOf(state.quantity, state.value)
}

/**
 * Parse an amount, saying which field it was on.
 *
 * Scale is REJECTED rather than rounded away, which `parseAt` does for us: a quantity
 * arriving with four places did not come off a document line, it came from arithmetic
 * somebody did on the way here, and rounding it would mean the card recomputed from the
 * stored rows no longer equals the card computed when they were written.
 */
function amountOf(parse: (text: string) => Decimal, text: string, field: string): Decimal {
  try {
    return parse(text)
  } catch (error) {
    throw new RepoError(
      'INVALID_AMOUNT',
      `${JSON.stringify(text)} is not a ${field}.`,
      { field, value: text },
      { cause: error },
    )
  }
}

/**
 * A movement kind, looked up in the domain's table rather than compared against a list
 * written out here.
 *
 * A total record over the union is the only shape that cannot silently accept a kind this
 * build does not know (CONVENTIONS §1.9): an unknown one in a company file means the file
 * was written by a newer build, and valuing it as whatever the last branch said is how a
 * stock card gets a direction nothing decided.
 */
function requireKind(value: string): StockMovementKind {
  const table: Readonly<Record<string, StockMovementKindDefinition | undefined>> =
    STOCK_MOVEMENT_KINDS
  const definition = table[value]
  if (definition === undefined) {
    throw new RepoError(
      'MOVEMENT_KIND_UNKNOWN',
      `${JSON.stringify(value)} is not a kind of stock movement this build knows.`,
      { kind: value },
    )
  }
  return definition.kind
}

function requireDate(value: string, field: string): DateString {
  if (isDateString(value)) {
    return value
  }
  throw new RepoError(
    'INVALID_DATE',
    `${JSON.stringify(value)} is not a date. A stock movement is valued as at a day.`,
    { field, value },
  )
}

function trimmedOrNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null
  }
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

// ---- Warehouses ------------------------------------------------------------

/**
 * The warehouse a single-location business gets, and the only one this layer invents.
 *
 * A code and a name rather than nothing at all, because `warehouse_id` on a movement is
 * NOT NULL and a company file with no warehouse can record no stock. See 0018's header
 * for why a migration is the wrong place to create it.
 */
export const DEFAULT_WAREHOUSE_CODE = 'MAIN'
export const DEFAULT_WAREHOUSE_NAME = 'Main store'

/**
 * Give a new company file somewhere to keep stock, unless it already has somewhere.
 *
 * `seedDefaultSeries`'s shape exactly, including the return: the number created, which is
 * zero on a file that already has a warehouse. Idempotent, so it may be called on an
 * existing file without a second `Main store` appearing beside the first.
 *
 * IT BELONGS IN `setUpBooks`, beside the chart, the periods and the numbering series, and
 * the line that calls it is not this batch's to write. Until it exists, a company file
 * created by the app has no warehouse and `defaultWarehouseId` says so in a sentence
 * rather than letting a foreign key be the message. That is the bug 0012 found in
 * `bootstrap.ts`, named in advance.
 */
export async function seedDefaultWarehouse(db: CofferDb): Promise<number> {
  return inTransaction(db, async (trx) => {
    const existing = await trx.selectFrom('warehouses').select('id').executeTakeFirst()
    if (existing !== undefined) {
      return 0
    }
    await createWarehouse(trx, { code: DEFAULT_WAREHOUSE_CODE, name: DEFAULT_WAREHOUSE_NAME })
    return 1
  })
}

/** Warehouses, by code. Archived ones are left out unless asked for. */
export async function listWarehouses(
  db: CofferDb,
  input: ListWarehousesInput = {},
): Promise<Warehouse[]> {
  let query = db.selectFrom('warehouses').selectAll()
  if (input.includeArchived !== true) {
    query = query.where('is_archived', '=', 0)
  }
  const rows = await query.orderBy('code').execute()
  return rows.map(toWarehouse)
}

export async function getWarehouse(db: CofferDb, id: string): Promise<Warehouse | null> {
  const row = await db.selectFrom('warehouses').selectAll().where('id', '=', id).executeTakeFirst()
  return row === undefined ? null : toWarehouse(row)
}

export async function createWarehouse(
  db: CofferDb,
  input: CreateWarehouseInput,
): Promise<Warehouse> {
  const code = requireText(input.code, 'WAREHOUSE_CODE_REQUIRED', 'A warehouse needs a code.')
  const name = requireText(input.name, 'WAREHOUSE_NAME_REQUIRED', 'A warehouse needs a name.')

  return inTransaction(db, async (trx) => {
    await assertCodeFree(trx, code, null)
    await assertNameFree(trx, name, null)

    const id = randomUUID()
    const now = new Date().toISOString()
    await trx
      .insertInto('warehouses')
      .values({
        id,
        code,
        name,
        description: trimmedOrNull(input.description),
        is_archived: 0,
        created_at: now,
        updated_at: now,
      })
      .execute()

    return await readBackWarehouse(trx, id)
  })
}

/**
 * Change a warehouse.
 *
 * THE CODE IS AMONG THE FIELDS THAT MAY CHANGE, where a unit's may not, and the asymmetry
 * is the point rather than an inconsistency. A unit's code IS its identity — it is the
 * primary key, and it prints on every line that ever used it — so renaming one would
 * rewrite what old paperwork claims to have said. A warehouse has a surrogate id, its
 * code prints on nothing a customer sees, and every movement refers to the id. Renaming
 * `WH-1` to `KOCHI` changes a label and no figure.
 *
 * `null` clears the description; absent leaves every field as it was, so a screen that
 * edits one thing cannot blank a field it never showed.
 */
export async function updateWarehouse(
  db: CofferDb,
  input: UpdateWarehouseInput,
): Promise<Warehouse> {
  return inTransaction(db, async (trx) => {
    const existing = await requireWarehouse(trx, input.id)

    const update: Partial<WarehouseRow> = { updated_at: new Date().toISOString() }

    if (input.code !== undefined) {
      const code = requireText(input.code, 'WAREHOUSE_CODE_REQUIRED', 'A warehouse needs a code.')
      await assertCodeFree(trx, code, existing.id)
      update.code = code
    }
    if (input.name !== undefined) {
      const name = requireText(input.name, 'WAREHOUSE_NAME_REQUIRED', 'A warehouse needs a name.')
      await assertNameFree(trx, name, existing.id)
      update.name = name
    }
    if (input.description !== undefined) {
      update.description = trimmedOrNull(input.description)
    }
    if (input.isArchived !== undefined) {
      /*
       * A warehouse that still holds goods may not be archived, and this is the rule
       * 0019's header hands to the repository. The value would drop off every stock page
       * and stay on the balance sheet, which is a corrupted report — but the database
       * cannot ask the question, because "holds stock" is a running total and its value
       * side is derived rather than stored.
       */
      if (input.isArchived && !existing.is_archived) {
        await assertWarehouseEmpty(trx, existing)
      }
      update.is_archived = input.isArchived ? 1 : 0
    }

    await trx.updateTable('warehouses').set(update).where('id', '=', existing.id).execute()
    return await readBackWarehouse(trx, existing.id)
  })
}

/**
 * Remove a warehouse that has never been used.
 *
 * Anything with a movement against it is refused rather than deleted, and archived
 * instead: `ON DELETE RESTRICT` on `stock_ledger.warehouse_id` would refuse it anyway,
 * and this is the sentence in front of that.
 */
export async function deleteWarehouse(db: CofferDb, id: string): Promise<void> {
  await inTransaction(db, async (trx) => {
    const existing = await requireWarehouse(trx, id)
    const used = await trx
      .selectFrom('stock_ledger')
      .select('id')
      .where('warehouse_id', '=', existing.id)
      .executeTakeFirst()
    if (used !== undefined) {
      throw new RepoError(
        'WAREHOUSE_IN_USE',
        `${existing.code} has stock movements against it. Archive it instead of deleting it.`,
        { warehouseId: existing.id, code: existing.code },
      )
    }
    await trx.deleteFrom('warehouses').where('id', '=', existing.id).execute()
  })
}

/**
 * Which warehouse a caller meant when it named none.
 *
 * "The only one there is", and it REFUSES to guess for a business with two. A default
 * flag was considered and declined in 0018: a stock movement always knows where it
 * happened, so a default is a convenience for a single-location business rather than a
 * resolution rule, and silently picking one for everybody else would put a receipt in the
 * wrong place with nothing to show it.
 */
export async function defaultWarehouseId(db: CofferDb): Promise<string> {
  const rows = await db
    .selectFrom('warehouses')
    .select(['id', 'code'])
    .where('is_archived', '=', 0)
    .orderBy('code')
    .execute()

  const only = rows[0]
  if (only === undefined) {
    throw new RepoError(
      'WAREHOUSE_NOT_CONFIGURED',
      'These books have no warehouse, so there is nowhere to keep stock. Create one first.',
      {},
    )
  }
  if (rows.length > 1) {
    throw new RepoError(
      'WAREHOUSE_REQUIRED',
      `These books keep stock in ${String(rows.length)} places. Say which one this happened at.`,
      { warehouses: rows.map((row) => row.code) },
    )
  }
  return only.id
}

async function requireWarehouse(db: CofferDb, id: string): Promise<WarehouseRow> {
  const row = await db.selectFrom('warehouses').selectAll().where('id', '=', id).executeTakeFirst()
  if (row === undefined) {
    throw new RepoError('WAREHOUSE_NOT_FOUND', 'That warehouse is not in these books.', {
      warehouseId: id,
    })
  }
  return row
}

/** The warehouse a movement may be written to: it exists, and it is not archived. */
async function requireActiveWarehouse(db: CofferDb, id: string | undefined): Promise<WarehouseRow> {
  const warehouseId = id ?? (await defaultWarehouseId(db))
  const row = await requireWarehouse(db, warehouseId)
  if (row.is_archived === 1) {
    throw new RepoError('WAREHOUSE_ARCHIVED', `${row.code} is archived and takes nothing new.`, {
      warehouseId: row.id,
      code: row.code,
    })
  }
  return row
}

/**
 * `code` is free, ignoring case.
 *
 * `COLLATE NOCASE` ON THE COMPARISON, not merely on the index, and the two are not the
 * same thing. `where('code', '=', 'main')` uses SQLite's default BINARY collation and
 * finds nothing while `MAIN` is sitting there; the INSERT that follows is then refused by
 * `warehouses_code_unique` with a raw `UNIQUE constraint failed`, so this check is not
 * redundant, it is UNREACHABLE, and the user reads a constraint name instead of a
 * sentence. Measured on a scratch database, and it is a bug this project has shipped
 * before.
 */
async function assertCodeFree(db: CofferDb, code: string, exceptId: string | null): Promise<void> {
  let query = db
    .selectFrom('warehouses')
    .select(['id', 'code'])
    .where(sql<string>`code COLLATE NOCASE`, '=', code)
  if (exceptId !== null) {
    query = query.where('id', '<>', exceptId)
  }
  const clash = await query.executeTakeFirst()
  if (clash !== undefined) {
    throw new RepoError(
      'WAREHOUSE_CODE_TAKEN',
      `${clash.code} is already a warehouse in these books.`,
      { code, warehouseId: clash.id },
    )
  }
}

/** `name` is free, ignoring case. The same trap as `assertCodeFree`, from the other side. */
async function assertNameFree(db: CofferDb, name: string, exceptId: string | null): Promise<void> {
  let query = db
    .selectFrom('warehouses')
    .select(['id', 'name'])
    .where(sql<string>`name COLLATE NOCASE`, '=', name)
  if (exceptId !== null) {
    query = query.where('id', '<>', exceptId)
  }
  const clash = await query.executeTakeFirst()
  if (clash !== undefined) {
    throw new RepoError(
      'WAREHOUSE_NAME_TAKEN',
      `${clash.name} is already a warehouse in these books.`,
      { name, warehouseId: clash.id },
    )
  }
}

/** Nothing is on hand anywhere in it. Asked of the domain, because only the domain knows. */
async function assertWarehouseEmpty(db: CofferDb, warehouse: WarehouseRow): Promise<void> {
  const held = await stockOnHand(db, { warehouseId: warehouse.id })
  if (held.length > 0) {
    throw new RepoError(
      'WAREHOUSE_IN_USE',
      `${warehouse.code} still holds stock. Move it out or write it off before archiving.`,
      {
        warehouseId: warehouse.id,
        code: warehouse.code,
        items: held.length,
      },
    )
  }
}

function toWarehouse(row: WarehouseRow): Warehouse {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    isArchived: row.is_archived === 1,
  }
}

async function readBackWarehouse(db: CofferDb, id: string): Promise<Warehouse> {
  return toWarehouse(await requireWarehouse(db, id))
}

function requireText(value: string, code: RepoErrorCode, message: string): string {
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new RepoError(code, message, {})
  }
  return trimmed
}

// ---- Which items keep a balance --------------------------------------------

interface StockItemRow {
  id: string
  code: string | null
  name: string
  kind: string
  unit_code: string | null
  /* `| undefined` because `ItemsTable` spells the column that way — see schema.ts, where
   * the reason is a mapped type in a file this batch does not own. The column is
   * `NOT NULL DEFAULT 0`, so the comparisons below read it as the 0 or 1 it always is. */
  is_stock_tracked: number | undefined
  reorder_level: string | null
  is_archived: number
}

const ITEM_COLUMNS = [
  'id',
  'code',
  'name',
  'kind',
  'unit_code',
  'is_stock_tracked',
  'reorder_level',
  'is_archived',
] as const

/**
 * Turn an item's register on or off, and set the level at which it needs re-ordering.
 *
 * A FUNCTION OF ITS OWN RATHER THAN TWO FIELDS ON `updateItem`, because `repos/items.ts`
 * is another phase's file: fields on `UpdateItemInput` that no repository wrote would look
 * as though they worked. Folding this into `updateItem` is one of the changes this batch
 * asks for at integration.
 *
 * BOTH REFUSALS BELOW HAVE A FLOOR UNDER THEM AND NEITHER IS REDUNDANT. A service is
 * refused by 0017's CHECK, which raises `CHECK constraint failed` and can say nothing
 * about which item or what it is; an item with movements is refused by 0019's
 * `items_no_untrack_with_movements`, which raises `ITEM_IN_USE` and cannot count them.
 * The repository answers first, with the figures, and the database is what holds when
 * something reaches the table another way.
 */
export async function setItemStockTracking(
  db: CofferDb,
  input: SetItemStockTrackingInput,
): Promise<ItemStockSettings> {
  const reorderLevel =
    input.reorderLevel === undefined || input.reorderLevel === null
      ? null
      : toQuantityString(amountOf(parseQuantity, input.reorderLevel, 'quantity'))

  return inTransaction(db, async (trx) => {
    const item = await requireItem(trx, input.itemId)

    if (input.isStockTracked && item.kind !== 'goods') {
      throw new RepoError(
        'ITEM_NOT_STOCKABLE',
        `${item.name} is a service, and a service holds no quantity. Only goods keep a stock balance.`,
        { itemId: item.id, name: item.name, kind: item.kind },
      )
    }

    if (!input.isStockTracked) {
      const movements = await trx
        .selectFrom('stock_ledger')
        .select((eb) => eb.fn.countAll<number>().as('movements'))
        .where('item_id', '=', item.id)
        .executeTakeFirst()
      const count = movements?.movements ?? 0
      if (count > 0) {
        throw new RepoError(
          'ITEM_IN_USE',
          `${item.name} has ${String(count)} stock movements. Its register cannot be switched off; archive the item instead.`,
          { itemId: item.id, name: item.name, movements: count },
        )
      }
    }

    /* Cleared alongside, because 0017 refuses a reorder level on an item that keeps no
     * balance — and because a level left behind on an item nobody counts is a row on the
     * re-order report that is always true and never useful. */
    const level = input.isStockTracked ? reorderLevel : null

    try {
      await trx
        .updateTable('items')
        .set({
          is_stock_tracked: input.isStockTracked ? 1 : 0,
          reorder_level: level,
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', item.id)
        .execute()
    } catch (error) {
      throw repoErrorFrom(error, 'ITEM_NOT_STOCKABLE')
    }

    return { itemId: item.id, isStockTracked: input.isStockTracked, reorderLevel: level }
  })
}

/** An item's stock settings as they stand. Null when there is no such item. */
export async function itemStockSettings(
  db: CofferDb,
  itemId: string,
): Promise<ItemStockSettings | null> {
  const row = await db
    .selectFrom('items')
    .select(['id', 'is_stock_tracked', 'reorder_level'])
    .where('id', '=', itemId)
    .executeTakeFirst()
  if (row === undefined) {
    return null
  }
  return {
    itemId: row.id,
    isStockTracked: row.is_stock_tracked === 1,
    reorderLevel: row.reorder_level,
  }
}

async function requireItem(db: CofferDb, id: string): Promise<StockItemRow> {
  const row = await db
    .selectFrom('items')
    .select(ITEM_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst()
  if (row === undefined) {
    throw new RepoError('ITEM_NOT_FOUND', 'That item is not in these books.', { itemId: id })
  }
  return row
}

/** The item a movement may be written for: it exists, it is active, and it keeps a balance. */
async function requireStockItem(db: CofferDb, id: string): Promise<StockItemRow> {
  const item = await requireItem(db, id)
  if (item.is_archived === 1) {
    throw new RepoError('ITEM_ARCHIVED', `${item.name} is archived and takes nothing new.`, {
      itemId: item.id,
      name: item.name,
    })
  }
  if (item.is_stock_tracked !== 1) {
    throw new RepoError(
      'ITEM_NOT_STOCK_TRACKED',
      `${item.name} keeps no stock balance, so it has no register to record this in. Turn stock tracking on for it first.`,
      { itemId: item.id, name: item.name, kind: item.kind },
    )
  }
  return item
}

// ---- Recording a movement --------------------------------------------------

/**
 * Write one movement into the register, valued by the strategy.
 *
 * THE WHOLE CARD IS FOLDED, NOT JUST THE CLOSING STATE, and that is what makes a
 * back-dated movement safe to accept. Applying the new movement to whatever the register
 * holds today would value it against a state it never saw, and — worse — would not notice
 * that a back-dated issue makes a LATER issue impossible. `runStockCard` over the whole
 * set answers both: the movement is valued in its own place in the card, and a set that
 * cannot be folded is refused with the first problem in it, before anything is written.
 *
 * The alternative is a row that goes in cleanly and makes every figure after it
 * disappear, because the card stops at the first movement it cannot value and still ties
 * at its own foot.
 *
 * THE SEQUENCE IS ALLOCATED, NOT SUPPLIED. Max plus one within this (item, warehouse), so
 * a back-dated movement takes the HIGHEST sequence and the EARLIEST date — which is
 * exactly the case where sorting by sequence and sorting by date disagree, and the reason
 * `runStockCard` sorts by date first. Read inside the transaction, and
 * `stock_ledger_position` refuses a collision rather than letting two movements share a
 * place.
 */
export async function recordMovement(
  db: CofferDb,
  input: RecordStockMovementInput,
): Promise<RecordedStockMovement> {
  const kind = requireKind(input.kind)
  const date = requireDate(input.date, 'date')
  const quantity = amountOf(parseQuantity, input.quantity, 'quantity')
  const cost =
    input.cost === undefined || input.cost === null
      ? null
      : amountOf(parseMoney, input.cost, 'amount')
  const sourceType = requireText(
    input.sourceType,
    'INVALID_AMOUNT',
    'A movement must say what raised it.',
  )
  const sourceNumber = trimmedOrNull(input.sourceNumber)

  try {
    return await inTransaction(db, async (trx) => {
      const item = await requireStockItem(trx, input.itemId)
      const warehouse = await requireActiveWarehouse(trx, input.warehouseId)

      /*
       * Asked here as well as inside `postEntry`, and the second copy is not redundant: a
       * movement that moved no money posts nothing, so without this a free sample could be
       * recorded into a closed year with no entry to refuse it. The period is the one rule
       * that has to hold for the REGISTER whether or not the ledger is touched.
       */
      await requirePostablePeriod(trx, date)

      const existing = await movementRowsFor(trx, item.id, warehouse.id)
      const sequence = nextSequenceAfter(existing)

      const movement: StockMovement = {
        itemId: item.id,
        kind,
        date,
        sequence,
        quantity,
        cost,
        layerKey: null,
        batch: null,
      }

      const held = existing.map(toStockMovement)

      /*
       * TWO FOLDS, AND THE FIRST ONE IS WHAT MAKES A BACK-DATED MOVEMENT POSTABLE.
       *
       * `before` is the register exactly as the general ledger already has it: every
       * outward movement at the cost its own entry was posted at, because every movement
       * posts and every earlier back-dating posted its own correction. `card` is the
       * register with this movement in its place in card order. Comparing the two row by
       * row is what says which already-posted costs have changed, and by how much.
       *
       * There is no third implementation of the fold and no stored figure to compare
       * against: both come out of `runStockCard`, so the difference between them is
       * arithmetic the domain did twice rather than a reconciliation this layer invented.
       */
      const before = runStockCard(MOVING_AVERAGE, item.id, held)
      const card = runStockCard(MOVING_AVERAGE, item.id, [...held, movement])
      if (card.problem !== null) {
        throw fromProblem(card.problem)
      }
      if (before.problem !== null) {
        /*
         * The register was already unfoldable before this movement, so there is no honest
         * "what it cost before" to correct from. Unreachable through this repository —
         * nothing is written unless the whole set folds — and refused rather than papered
         * over, because the alternative is posting a correction computed against rows the
         * card silently stopped at.
         */
        throw fromProblem(before.problem)
      }

      /* `find` says "the one row with this sequence" here rather than "the first of
       * several", and that is a rule rather than a hope: `runStockCard` refuses a set
       * containing a duplicate sequence outright, so either there is exactly one or there
       * is no card at all. */
      const recorded = card.rows.find((row) => row.movement.sequence === sequence)
      if (recorded === undefined) {
        throw new Error(
          `The card valued every movement and did not include sequence ${String(sequence)}.`,
        )
      }

      const id = randomUUID()
      const accounts = await buildResolver(trx)

      /*
       * THE ENTRY IS POSTED BEFORE THE ROW IS WRITTEN, and the order is forced twice over.
       * `stock_ledger.entry_id` REFERENCES `journal_entries(id)`, so the parent has to
       * exist; and a movement that cannot post must leave no row behind, which the
       * transaction gives us only because nothing has been written yet when it fails.
       */
      const entryId = await postMovement(trx, accounts, {
        kind,
        date,
        cost: recorded.cost,
        source: sourceOf(id, sourceNumber),
        narration: movementNarration(input.narration, kind, item.name, sourceNumber),
      })

      const revaluations = await postRevaluations(trx, accounts, {
        changes: costChangesBetween(before, card),
        itemName: item.name,
        kind,
        date,
        sourceNumber,
      })

      await trx
        .insertInto('stock_ledger')
        .values({
          id,
          item_id: item.id,
          warehouse_id: warehouse.id,
          kind,
          movement_date: date,
          sequence,
          quantity: toQuantityString(quantity),
          cost: cost === null ? null : toMoneyString(cost),
          source_type: sourceType,
          source_id: trimmedOrNull(input.sourceId),
          source_number: sourceNumber,
          narration: trimmedOrNull(input.narration),
          created_at: new Date().toISOString(),
          entry_id: entryId,
        })
        .execute()

      return {
        movementId: id,
        itemId: item.id,
        warehouseId: warehouse.id,
        kind,
        date,
        sequence,
        entryId,
        cost: toMoneyString(recorded.cost),
        after: balanceOf(recorded.quantity, recorded.value),
        closing: balanceOfState(card.closing),
        revaluations,
      }
    })
  } catch (error) {
    throw repoErrorFrom(error, 'MOVEMENT_REFUSED')
  }
}

/**
 * What the ledger records a movement as.
 *
 * `stock-adjustment` FOR EVERY KIND, and the word is the ledger's rather than the
 * register's: `SourceDocumentType` names what produced an entry, and what produced this
 * one is the stock register, not the invoice further upstream. Using the raising
 * document's own type would put two entries in the books under one (type, id) pair, and
 * `getEntryForSource` takes the first row it finds — so a drill-through from an invoice
 * would land on whichever of its two entries came back first, which is CONVENTIONS §6 on
 * `.find` wearing a query's clothes.
 *
 * The id is the MOVEMENT's, so the pair is unique and the entry is reachable from the
 * register. The number is the raising document's, denormalised exactly as
 * `stock_ledger.source_number` is, so a day book reads "against INV/2026-27/0007" rather
 * than a uuid.
 */
function sourceOf(movementId: string, sourceNumber: string | null): SourceDocument {
  return { type: 'stock-adjustment', id: movementId, number: sourceNumber }
}

/** What the day book says a movement is, when the caller has not said it themselves. */
function movementNarration(
  given: string | null | undefined,
  kind: StockMovementKind,
  itemName: string,
  sourceNumber: string | null,
): string {
  const own = trimmedOrNull(given)
  if (own !== null) return own
  const against = sourceNumber === null ? '' : ` against ${sourceNumber}`
  return `${definitionOf(kind).label}: ${itemName}${against}`
}

/**
 * Post one movement's entry, or none when it moved no money.
 *
 * A ZERO-COST MOVEMENT POSTS NOTHING AND THAT IS NOT A GAP. A free sample taken in at nil
 * and an issue out of a pool worth nothing both move quantity and no value — invariant 6
 * admits them deliberately — and an entry of two zero lines is refused by ledger invariant
 * 5. Nothing moved, so the balance sheet is not missing anything, and 0022's
 * `stock_ledger_posted` is written to stand aside for exactly this case.
 */
async function postMovement(
  db: CofferDb,
  accounts: AccountResolver,
  posting: MovementPosting,
): Promise<string | null> {
  const draft = fromPosting(() => movementEntry(posting, accounts))
  if (draft === null) return null
  return (await postEntry(db, draft)).entryId
}

/** What a re-valuation needs in order to describe itself. */
interface RevaluationContext {
  changes: readonly CostChange[]
  itemName: string
  kind: StockMovementKind
  date: DateString
  sourceNumber: string | null
}

/**
 * Post the corrections a back-dated movement makes necessary — one entry per affected
 * date, and none at all in the ordinary case.
 *
 * THE ENTRIES CARRY NO `source_id`. The movement's own entry carries the movement's id,
 * so `getEntryForSource('stock-adjustment', movementId)` has exactly one answer; giving
 * these the same id would turn that lookup into a `.find` over several rows. What they
 * carry instead is a narration naming the item, the date and the movement that caused
 * them, which is what somebody reading a day book needs — and the caller is handed their
 * ids directly, at the moment they are made, in `RecordedStockMovement.revaluations`.
 */
async function postRevaluations(
  db: CofferDb,
  accounts: AccountResolver,
  context: RevaluationContext,
): Promise<StockRevaluation[]> {
  const revaluations = fromPosting(() =>
    revaluationsFor(
      context.changes,
      accounts,
      { type: 'stock-adjustment', id: null, number: context.sourceNumber },
      (date, changes) =>
        `${context.itemName}: ${String(changes.length)} movement(s) on ${date} re-valued by a ` +
        `${definitionOf(context.kind).label.toLowerCase()} back-dated to ${context.date}.`,
    ),
  )

  const posted: StockRevaluation[] = []
  for (const revaluation of revaluations) {
    const result = await postEntry(db, revaluation.draft)
    posted.push({
      entryId: result.entryId,
      date: revaluation.date,
      stockAmount: toMoneyString(revaluation.stockAmount),
      movements: revaluation.changes.length,
    })
  }
  return posted
}

/**
 * Run a posting rule and turn what it refuses into what this layer refuses.
 *
 * `buildEntry` in ./issuing.ts does the same for documents and the reasoning is identical:
 * every `LedgerErrorCode` a stock posting rule can raise is already a `RepoErrorCode`
 * meaning the same thing, and the domain's sentence already names the role — rewriting it
 * here would be a second sentence about one failure.
 */
function fromPosting<T>(build: () => T): T {
  try {
    return build()
  } catch (error) {
    if (isPostingError(error)) {
      throw new RepoError(error.code as RepoErrorCode, error.message, error.details, {
        cause: error,
      })
    }
    throw error
  }
}

/**
 * The rows of one register.
 *
 * ORDERED BY SEQUENCE, WHICH IS DELIBERATELY NOT CARD ORDER. The index
 * `stock_ledger_position` is on (item, warehouse, sequence), so this is one seek and a
 * scan — and for a register holding anything back-dated the rows come back in an order
 * the card disagrees with. That is on purpose: `runStockCard` sorts by date and then by
 * sequence, and a query that handed it the answer's order would make the sort untestable
 * in every test that goes through this file (CONVENTIONS §6 — order fixtures so they
 * disagree with the expected output).
 */
async function movementRowsFor(
  db: CofferDb,
  itemId: string,
  warehouseId: string,
): Promise<LedgerRow[]> {
  return db
    .selectFrom('stock_ledger')
    .selectAll()
    .where('item_id', '=', itemId)
    .where('warehouse_id', '=', warehouseId)
    .orderBy('sequence')
    .execute()
}

function nextSequenceAfter(rows: readonly LedgerRow[]): number {
  return rows.reduce((highest, row) => Math.max(highest, row.sequence), 0) + 1
}

/**
 * A stored row as the valuation sees it.
 *
 * Nothing is dropped and nothing is invented on the way: `stock_ledger` holds a
 * `StockMovement` and this is the identity map over it. That is 0019's central claim in
 * the one place where it would show up as work if it were false.
 */
function toStockMovement(row: LedgerRow): StockMovement {
  return {
    itemId: row.item_id,
    kind: requireKind(row.kind),
    date: row.movement_date,
    sequence: row.sequence,
    quantity: parseQuantity(row.quantity),
    cost: row.cost === null ? null : parseMoney(row.cost),
    layerKey: null,
    batch: null,
  }
}

// ---- Reading a card --------------------------------------------------------

/**
 * An item's register in one warehouse, folded.
 *
 * A WINDOW IS A FILTER ON THE REGISTER, NEVER ON THE ROWS SHOWN (CONVENTIONS §1.8). A
 * card drawn from 1 May opens with what was on hand on 30 April, which means folding
 * every movement before it and only then folding the ones inside the window on top. Two
 * folds and no third implementation: the same `runStockCard` produces the opening state
 * and the card, so a windowed card and a whole one cannot come to different figures.
 *
 * The cheap version — start from nothing and show only May's movements — reports an item
 * as having arrived out of nowhere and values every issue in the window against a pool
 * that never existed.
 */
export async function stockCardFor(db: CofferDb, input: StockCardInput): Promise<StockCard> {
  const item = await requireItem(db, input.itemId)
  const warehouse = await requireActiveWarehouse(db, input.warehouseId)
  const from = input.from === undefined ? null : requireDate(input.from, 'from')
  const to = input.to === undefined ? null : requireDate(input.to, 'to')

  const rows = await movementRowsFor(db, item.id, warehouse.id)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const bySequence = new Map(rows.map((row) => [row.sequence, row.id]))

  const before: StockMovement[] = []
  const within: StockMovement[] = []
  for (const row of rows) {
    const movement = toStockMovement(row)
    if (from !== null && movement.date < from) {
      before.push(movement)
    } else if (to !== null && movement.date > to) {
      /* Outside the window on the far side: it is neither an opening figure nor a row. */
    } else {
      within.push(movement)
    }
  }

  const openingCard = runStockCard(MOVING_AVERAGE, item.id, before)
  if (openingCard.problem !== null) {
    /* The card cannot open, so it cannot show anything: an opening figure folded from an
     * incomplete set would be a plausible number for a register that does not add up. */
    return emptyCard(item.id, warehouse.id, from, to, openingCard.closing, openingCard.problem)
  }

  const card = runStockCard(MOVING_AVERAGE, item.id, within, openingCard.closing)

  const cardRows: StockCardRow[] = []
  for (const row of card.rows) {
    const id = bySequence.get(row.movement.sequence)
    const stored = id === undefined ? undefined : byId.get(id)
    if (stored === undefined) {
      throw new Error(`No stored row for sequence ${String(row.movement.sequence)}.`)
    }
    const definition = definitionOf(row.movement.kind)
    cardRows.push({
      movementId: stored.id,
      sequence: row.movement.sequence,
      date: row.movement.date,
      kind: row.movement.kind,
      label: definition.label,
      direction: definition.direction,
      quantity: toQuantityString(row.movement.quantity),
      statedCost: stored.cost,
      cost: toMoneyString(row.cost),
      balance: balanceOf(row.quantity, row.value),
      entryId: stored.entry_id,
      sourceType: stored.source_type,
      sourceId: stored.source_id,
      sourceNumber: stored.source_number,
      narration: stored.narration,
    })
  }

  return {
    itemId: item.id,
    warehouseId: warehouse.id,
    method: card.method,
    from,
    to,
    opening: balanceOfState(card.opening),
    rows: cardRows,
    closing: balanceOfState(card.closing),
    quantityIn: toQuantityString(card.quantityIn),
    quantityOut: toQuantityString(card.quantityOut),
    costIn: toMoneyString(card.costIn),
    costOut: toMoneyString(card.costOut),
    problem: card.problem === null ? null : toAppError(card.problem),
  }
}

function emptyCard(
  itemId: string,
  warehouseId: string,
  from: DateString | null,
  to: DateString | null,
  state: ValuationState,
  problem: InventoryProblem,
): StockCard {
  const balance = balanceOfState(state)
  return {
    itemId,
    warehouseId,
    method: MOVING_AVERAGE.method,
    from,
    to,
    opening: balance,
    rows: [],
    closing: balance,
    quantityIn: toQuantityString(ZERO),
    quantityOut: toQuantityString(ZERO),
    costIn: toMoneyString(ZERO),
    costOut: toMoneyString(ZERO),
    problem: toAppError(problem),
  }
}

// ---- What is on hand -------------------------------------------------------

interface HeldRow {
  itemId: string
  warehouseId: string
  quantity: Decimal
  value: Decimal
  problem: InventoryProblem | null
}

/**
 * What every item holds in every place, one row per (item, warehouse).
 *
 * FOLDED PER REGISTER, ONE `runStockCard` EACH. Not `SUM()` over the quantity and cost
 * columns, which would be wrong twice over: SQLite's `SUM` over decimal text is floating
 * point and loses a paisa on realistic figures (a trap this project has already paid for),
 * and the value going OUT is not in the table to be summed — an outward movement stores
 * no cost, because the strategy is what values it.
 *
 * `asAt` counts movements dated on or before it, which is a filter on the REGISTER rather
 * than on the rows shown: stock as at 30 June is what the movements up to 30 June come
 * to, not today's figure under June's heading (CONVENTIONS §1.8).
 */
export async function stockOnHand(
  db: CofferDb,
  input: StockOnHandInput = {},
): Promise<StockOnHandRow[]> {
  const held = await foldRegisters(db, input)

  const items = await itemFacts(
    db,
    held.map((row) => row.itemId),
  )
  const warehouses = await warehouseFacts(
    db,
    held.map((row) => row.warehouseId),
  )

  const rows: StockOnHandRow[] = []
  for (const entry of held) {
    const item = items.get(entry.itemId)
    const warehouse = warehouses.get(entry.warehouseId)
    if (item === undefined || warehouse === undefined) {
      continue
    }
    rows.push({
      itemId: item.id,
      itemName: item.name,
      itemCode: item.code,
      unitCode: item.unit_code,
      warehouseId: warehouse.id,
      warehouseCode: warehouse.code,
      warehouseName: warehouse.name,
      ...balanceOf(entry.quantity, entry.value),
      reorderLevel: item.reorder_level,
      isBelowReorderLevel: isBelowReorderLevel(entry.quantity, item.reorder_level),
      problem: entry.problem === null ? null : toAppError(entry.problem),
    })
  }

  return rows.sort(byItemThenWarehouse)
}

/**
 * The same figures rolled up across warehouses, one row per item.
 *
 * SUMMED IN THE DOMAIN with `sum` over `Decimal`, never by SQLite. And summed from the
 * per-register folds rather than from one big fold over every warehouse's movements at
 * once: each (item, warehouse) is its own pool with its own average, so pooling them
 * before valuing would issue stock out of one place at another place's cost.
 */
export async function stockOnHandByItem(
  db: CofferDb,
  input: StockOnHandInput = {},
): Promise<StockOnHandRow[]> {
  const perRegister = await stockOnHand(db, input)

  const byItem = new Map<string, StockOnHandRow[]>()
  for (const row of perRegister) {
    const existing = byItem.get(row.itemId)
    if (existing === undefined) {
      byItem.set(row.itemId, [row])
    } else {
      existing.push(row)
    }
  }

  const rows: StockOnHandRow[] = []
  for (const group of byItem.values()) {
    const first = group[0]
    if (first === undefined) {
      continue
    }
    const quantity = sum(group.map((row) => parseQuantity(row.quantity)))
    const value = sum(group.map((row) => parseMoney(row.value)))
    rows.push({
      ...first,
      warehouseId: null,
      warehouseCode: null,
      warehouseName: null,
      ...balanceOf(quantity, value),
      isBelowReorderLevel: isBelowReorderLevel(quantity, first.reorderLevel),
      /* The first problem any of its registers hit. A total that is short by one
       * warehouse's worth is exactly the figure nobody would question. */
      problem: group.find((row) => row.problem !== null)?.problem ?? null,
    })
  }

  return rows.sort(byItemThenWarehouse)
}

/** One `runStockCard` per (item, warehouse) that has ever had a movement. */
async function foldRegisters(db: CofferDb, input: StockOnHandInput): Promise<HeldRow[]> {
  let query = db.selectFrom('stock_ledger').selectAll()
  if (input.itemId !== undefined) {
    query = query.where('item_id', '=', input.itemId)
  }
  if (input.warehouseId !== undefined) {
    query = query.where('warehouse_id', '=', input.warehouseId)
  }
  if (input.asAt !== undefined) {
    query = query.where('movement_date', '<=', requireDate(input.asAt, 'asAt'))
  }
  const rows = await query.orderBy('sequence').execute()

  const registers = new Map<string, LedgerRow[]>()
  for (const row of rows) {
    const key = `${row.item_id} ${row.warehouse_id}`
    const existing = registers.get(key)
    if (existing === undefined) {
      registers.set(key, [row])
    } else {
      existing.push(row)
    }
  }

  const held: HeldRow[] = []
  for (const group of registers.values()) {
    const first = group[0]
    if (first === undefined) {
      continue
    }
    const card = runStockCard(MOVING_AVERAGE, first.item_id, group.map(toStockMovement))
    const empty = card.closing.quantity.isZero() && card.closing.value.isZero()
    if (empty && input.includeEmpty !== true && card.problem === null) {
      continue
    }
    held.push({
      itemId: first.item_id,
      warehouseId: first.warehouse_id,
      quantity: card.closing.quantity,
      value: card.closing.value,
      problem: card.problem,
    })
  }
  return held
}

/**
 * At or below the level, not merely below it.
 *
 * An item whose reorder level is 10 and which has exactly 10 left needs re-ordering: the
 * level is the point at which you buy, not the point after which you have run out. And
 * `null` is not a level of zero — an item with none set never appears, where an item at
 * zero with a level of zero does.
 */
function isBelowReorderLevel(quantity: Decimal, reorderLevel: DecimalString | null): boolean {
  if (reorderLevel === null) {
    return false
  }
  return quantity.lessThanOrEqualTo(parseQuantity(reorderLevel))
}

function byItemThenWarehouse(a: StockOnHandRow, b: StockOnHandRow): number {
  return (
    a.itemName.localeCompare(b.itemName) ||
    (a.warehouseCode ?? '').localeCompare(b.warehouseCode ?? '')
  )
}

async function itemFacts(
  db: CofferDb,
  itemIds: readonly string[],
): Promise<Map<string, StockItemRow>> {
  const wanted = [...new Set(itemIds)]
  if (wanted.length === 0) {
    return new Map()
  }
  const rows = await db.selectFrom('items').select(ITEM_COLUMNS).where('id', 'in', wanted).execute()
  return new Map(rows.map((row) => [row.id, row]))
}

async function warehouseFacts(
  db: CofferDb,
  warehouseIds: readonly string[],
): Promise<Map<string, WarehouseRow>> {
  const wanted = [...new Set(warehouseIds)]
  if (wanted.length === 0) {
    return new Map()
  }
  const rows = await db.selectFrom('warehouses').selectAll().where('id', 'in', wanted).execute()
  return new Map(rows.map((row) => [row.id, row]))
}
