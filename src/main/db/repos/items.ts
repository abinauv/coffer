/*
 * The items repository — what goes on a document line.
 *
 * Read migration 0006 first. The decision that shapes everything here is that every
 * column on an item is a DEFAULT for a line and never a lookup the line performs later.
 * A document line stores its own description, price, unit and rate (domain/documents,
 * rule 4), so repricing an item, renaming it or archiving it cannot rewrite an invoice
 * that has already been issued — and nothing in this file needs to defend against that,
 * because the document does not read back through here.
 *
 * WHAT THIS FILE DOES NOT DO. It does not validate an HSN or a SAC. What a classification
 * code looks like — how many digits, which chapter, whether a service takes one at all —
 * is the regime's business, `db/` may not import a concrete regime (CONVENTIONS §1.6),
 * and threading a validator through every call would put the seam in the wrong place. The
 * items service validates before calling, exactly as the parties service does for a GSTIN
 * (`ITEM_CLASSIFICATION_INVALID`). What is enforced here is uniqueness, which only the
 * database can answer, and the shape of a stored decimal, which only `domain/money` can.
 *
 * MONEY IN, MONEY OUT. Prices are parsed and normalised on the way in, so '5000' becomes
 * '5000.00' and a value with three places is refused rather than rounded. `null` and
 * '0.00' are different answers and both are meaningful: no standard price agreed, versus
 * a price of nothing — a sample, or a warranty replacement. The tax rate is a RATE and
 * carries three places, not two; see 0006 and `SCALE.rate`.
 */

import { randomUUID } from 'node:crypto'
import { sql, type Selectable, type Updateable } from 'kysely'

import { parseMoney, parseRate, toMoneyString, toRateString } from '@main/domain/money'
import type {
  CreateItemInput,
  DecimalString,
  Item,
  ItemSummary,
  ListItemsInput,
  UpdateItemInput,
} from '@shared/dto'

import type { CofferDb } from '../kysely'
import type { ItemsTable } from '../schema'
import { RepoError } from './errors'
import { setItemStockTracking } from './stock'
import { inTransaction } from './transaction'
import { requireActiveUnit } from './units'

/**
 * A row of `items` as a SELECT hands it back.
 *
 * `Selectable<ItemsTable>` AND NOT `{ [K in keyof ItemsTable]: ItemsTable[K] }`, which is
 * what this was. That identity map is right only while no column of the table is a Kysely
 * `ColumnType`: the moment one is, the map hands back the wrapper rather than the value a
 * SELECT produces. `is_stock_tracked` was spelled `SqlBool | undefined` in the schema for
 * exactly that reason — a compatibility shim for this line, wearing the shape of a claim
 * about the column. It is `Generated<SqlBool>` now, which says what the column actually
 * is, and this type is what makes that spelling possible.
 */
type ItemRow = Selectable<ItemsTable>

// ---- Reading ---------------------------------------------------------------

/**
 * Items, ordered by name.
 *
 * Archived items are excluded by default. A picker offering one is a picker that lets
 * somebody put a discontinued product on an invoice, which the customer then expects to
 * receive.
 */
export async function listItems(db: CofferDb, input: ListItemsInput = {}): Promise<ItemSummary[]> {
  let query = db.selectFrom('items').selectAll()

  if (input.includeArchived !== true) {
    query = query.where('is_archived', '=', 0)
  }
  if (input.side === 'sold') {
    query = query.where('is_sold', '=', 1)
  }
  if (input.side === 'purchased') {
    query = query.where('is_purchased', '=', 1)
  }
  if (input.kind !== undefined) {
    query = query.where('kind', '=', input.kind)
  }
  /* The blank check is not a rule: the term is built from `.trim()`, so a search of
   * spaces becomes '%%' and matches everything with or without this guard. It is here to
   * skip three LIKEs over the table, and a mutation removing it survives. */
  if (input.search !== undefined && input.search.trim() !== '') {
    const term = `%${input.search.trim()}%`
    query = query.where((eb) =>
      eb.or([
        eb(sql<string>`name COLLATE NOCASE`, 'like', term),
        eb(sql<string>`COALESCE(code, '') COLLATE NOCASE`, 'like', term),
        eb(sql<string>`COALESCE(classification_code, '') COLLATE NOCASE`, 'like', term),
      ]),
    )
  }

  const rows = await query.orderBy(sql`name COLLATE NOCASE`).execute()
  return rows.map(toSummary)
}

export async function getItem(db: CofferDb, id: string): Promise<Item | null> {
  const row = await db.selectFrom('items').selectAll().where('id', '=', id).executeTakeFirst()
  return row === undefined ? null : toItem(row)
}

// ---- Writing ---------------------------------------------------------------

export async function createItem(db: CofferDb, input: CreateItemInput): Promise<Item> {
  const name = requireName(input.name)
  const code = trimmedOrNull(input.code)

  assertHasASide(input.isSold === true, input.isPurchased === true)

  const now = new Date().toISOString()
  const id = randomUUID()

  /* ONE TRANSACTION, because the stock settings are a second statement against the row
   * this one just wrote. An item created and then refused a stock register — a service
   * asked to keep a balance — must leave nothing behind, or the caller is told it failed
   * and finds the item in their list. */
  return inTransaction(db, async (trx) => {
    await assertNameFree(trx, name, null)
    await assertCodeFree(trx, code, null)

    await trx
      .insertInto('items')
      .values({
        id,
        code,
        name,
        description: trimmedOrNull(input.description),
        kind: input.kind,
        unit_code: await unitCodeOf(trx, input.unitCode),
        classification_code: trimmedOrNull(input.classificationCode),
        tax_rate_pct: taxRateOf(input.taxRatePct),
        sale_price: priceOf(input.salePrice, 'sale price'),
        purchase_price: priceOf(input.purchasePrice, 'purchase price'),
        is_charge: input.isCharge === true ? 1 : 0,
        is_sold: input.isSold === true ? 1 : 0,
        is_purchased: input.isPurchased === true ? 1 : 0,
        sales_account_id: await postingAccountOf(trx, input.salesAccountId, 'sales'),
        purchase_account_id: await postingAccountOf(trx, input.purchaseAccountId, 'purchase'),
        is_archived: 0,
        created_at: now,
        updated_at: now,
      })
      .execute()

    /* `is_stock_tracked` defaults to 0 and `reorder_level` to null, so a caller that says
     * nothing gets an item that keeps no balance — which is what every item created
     * before 0017 is, and what a consumable should be. */
    await applyStockSettings(trx, id, false, null, input)

    const created = await getItem(trx, id)
    if (created === null) {
      throw new RepoError('ITEM_NOT_FOUND', 'The item was written but could not be read back.', {
        id,
      })
    }
    return created
  })
}

/**
 * Write the two stock columns, through the one function that owns the rules.
 *
 * DELEGATED AND NOT REIMPLEMENTED, which is the whole reason these fields could be added
 * here at all. `setItemStockTracking` refuses a service a balance, refuses switching a
 * register off once movements exist, and clears a reorder level along with the register —
 * three rules with sentences and `details` already written. A second implementation on
 * this path would be a second set of answers to the same questions, and the one that goes
 * stale is whichever nobody is looking at.
 *
 * Skipped entirely when the caller says nothing about either field, so an edit to a name
 * does not re-decide anything about stock, and so `updateItem` costs no extra statement
 * for the ordinary case.
 */
async function applyStockSettings(
  db: CofferDb,
  id: string,
  currentIsTracked: boolean,
  currentReorderLevel: DecimalString | null,
  input: { isStockTracked?: boolean; reorderLevel?: DecimalString | null },
): Promise<void> {
  if (input.isStockTracked === undefined && input.reorderLevel === undefined) return

  await setItemStockTracking(db, {
    itemId: id,
    isStockTracked: input.isStockTracked ?? currentIsTracked,
    reorderLevel: input.reorderLevel === undefined ? currentReorderLevel : input.reorderLevel,
  })
}

/**
 * Change an item.
 *
 * Every field is optional and only the ones present are written, so a screen that edits
 * the price does not have to send the whole record back and cannot blank a field it never
 * showed. `null` is a value here and means "clear it"; absent means "leave it".
 *
 * An account is only re-checked when it is sent. An item pointing at an account that was
 * archived after the item was saved therefore stays editable — otherwise correcting a
 * typo in the name would be blocked by a decision made about the chart of accounts.
 */
export async function updateItem(db: CofferDb, input: UpdateItemInput): Promise<Item> {
  return inTransaction(db, (trx) => updateItemWithin(trx, input))
}

async function updateItemWithin(db: CofferDb, input: UpdateItemInput): Promise<Item> {
  const existing = await requireItem(db, input.id)

  const update: Updateable<ItemsTable> = { updated_at: new Date().toISOString() }

  if (input.name !== undefined) {
    const name = requireName(input.name)
    await assertNameFree(db, name, existing.id)
    update.name = name
  }
  if (input.code !== undefined) {
    const code = trimmedOrNull(input.code)
    await assertCodeFree(db, code, existing.id)
    update.code = code
  }

  const nextIsSold = input.isSold ?? existing.isSold
  const nextIsPurchased = input.isPurchased ?? existing.isPurchased
  assertHasASide(nextIsSold, nextIsPurchased)
  if (input.isSold !== undefined) {
    update.is_sold = input.isSold ? 1 : 0
  }
  if (input.isPurchased !== undefined) {
    update.is_purchased = input.isPurchased ? 1 : 0
  }

  if (input.description !== undefined) update.description = trimmedOrNull(input.description)
  if (input.kind !== undefined) update.kind = input.kind
  if (input.unitCode !== undefined) update.unit_code = await unitCodeOf(db, input.unitCode)
  if (input.classificationCode !== undefined) {
    update.classification_code = trimmedOrNull(input.classificationCode)
  }
  if (input.taxRatePct !== undefined) update.tax_rate_pct = taxRateOf(input.taxRatePct)
  if (input.salePrice !== undefined) update.sale_price = priceOf(input.salePrice, 'sale price')
  if (input.purchasePrice !== undefined) {
    update.purchase_price = priceOf(input.purchasePrice, 'purchase price')
  }
  if (input.isCharge !== undefined) update.is_charge = input.isCharge ? 1 : 0
  if (input.salesAccountId !== undefined) {
    update.sales_account_id = await postingAccountOf(db, input.salesAccountId, 'sales')
  }
  if (input.purchaseAccountId !== undefined) {
    update.purchase_account_id = await postingAccountOf(db, input.purchaseAccountId, 'purchase')
  }

  /*
   * THE OTHER DIRECTION OF 0017'S CHECK, ANSWERED BEFORE THE WRITE THAT WOULD TRIP IT.
   *
   * A service may not keep a balance, and there are two ways to break that: switch the
   * register on, which `setItemStockTracking` refuses with a sentence, or turn a tracked
   * item INTO a service, which is the one 0017's header says nobody writes. The CHECK
   * catches both — it is re-evaluated on every write to the row — but it catches this one
   * with `CHECK constraint failed`, from a statement that names no item.
   *
   * So the repository speaks first and the CHECK is the floor (CONVENTIONS §6). Both
   * layers answer with the same code, so only `details` tells them apart, and the
   * migration's own test writes straight at the table to reach the floor.
   */
  const nextIsStockTracked = input.isStockTracked ?? existing.isStockTracked
  if (input.kind !== undefined && input.kind !== 'goods' && nextIsStockTracked) {
    throw new RepoError(
      'ITEM_NOT_STOCKABLE',
      `${existing.name} keeps a stock balance, and a service holds none. Switch its stock ` +
        'register off first.',
      { id: existing.id, name: existing.name, kind: input.kind },
    )
  }

  /*
   * THE ORDER OF THE TWO STATEMENTS IS A RULE, and it comes from the CHECK being about
   * two columns of ONE row: there is an intermediate state, and one of the two orders puts
   * the row through a state the CHECK forbids.
   *
   * Switching a register OFF has to happen BEFORE the kind moves to 'service' — otherwise
   * the row is briefly a tracked service and the CHECK aborts with a message naming no
   * item. Switching one ON has to happen AFTER, so that a service being reclassified as
   * goods in the same edit is goods by the time the question is asked.
   *
   * The alternative is to write the two columns into the UPDATE above, which is the
   * second implementation of the stock rules this delegation exists to avoid. Both
   * statements are in one transaction, so no caller ever sees the state in between.
   */
  const settingsFirst = !nextIsStockTracked

  if (settingsFirst) {
    await applyStockSettings(db, existing.id, existing.isStockTracked, existing.reorderLevel, input)
  }

  await db.updateTable('items').set(update).where('id', '=', existing.id).execute()

  if (!settingsFirst) {
    await applyStockSettings(db, existing.id, existing.isStockTracked, existing.reorderLevel, input)
  }

  const updated = await getItem(db, existing.id)
  if (updated === null) {
    throw new RepoError('ITEM_NOT_FOUND', 'That item is no longer in these books.', {
      id: existing.id,
    })
  }
  return updated
}

/**
 * Stop offering an item without losing what has been sold.
 *
 * Archiving rather than deleting is the answer for anything that has ever appeared on a
 * document. Reversible, because a product line comes back.
 */
export async function archiveItem(db: CofferDb, id: string, archived: boolean): Promise<Item> {
  await requireItem(db, id)
  await db
    .updateTable('items')
    .set({ is_archived: archived ? 1 : 0, updated_at: new Date().toISOString() })
    .where('id', '=', id)
    .execute()

  const item = await getItem(db, id)
  if (item === null) {
    throw new RepoError('ITEM_NOT_FOUND', 'That item is no longer in these books.', { id })
  }
  return item
}

/**
 * Remove an item entirely.
 *
 * Only one that has never reached a document. There is no query here that looks for one,
 * because `document_lines` does not exist until 0008 — writing one now against a table
 * this build does not have would not compile, and writing it later against a table this
 * function had forgotten about is how an item disappears out from under an invoice. The
 * foreign key 0008 adds is what refuses the delete, and the whole point of catching it
 * here is that the caller gets a sentence instead of `FOREIGN KEY constraint failed`.
 *
 * A constraint is the only thing a DELETE of one row by primary key can fail on, and the
 * row was read a statement ago, so there is nothing else this catch can be hiding.
 */
export async function deleteItem(db: CofferDb, id: string): Promise<void> {
  const item = await requireItem(db, id)

  try {
    await db.deleteFrom('items').where('id', '=', item.id).execute()
  } catch (error) {
    throw new RepoError(
      'ITEM_IN_USE',
      `${item.name} appears on a document. Archive it instead.`,
      { id: item.id, name: item.name },
      { cause: error },
    )
  }
}

// ---- Guards ----------------------------------------------------------------

/**
 * Load an item and refuse a missing one.
 *
 * Returns the DTO rather than the row, so a caller that needs the current state — as
 * `updateItem` does for the two side flags — reads it through one code path.
 */
async function requireItem(db: CofferDb, id: string): Promise<Item> {
  const item = await getItem(db, id)
  if (item === null) {
    throw new RepoError('ITEM_NOT_FOUND', 'That item is not in these books.', { id })
  }
  return item
}

/**
 * An item is sold, purchased, or both. Never neither.
 *
 * Also a CHECK in 0006, and checked here so the message says what to do. An item that is
 * neither appears in no picker in the application and can reach no document line, which
 * makes it a row that exists only to be found later and puzzled over.
 */
function assertHasASide(isSold: boolean, isPurchased: boolean): void {
  if (!isSold && !isPurchased) {
    throw new RepoError(
      'ITEM_HAS_NO_SIDE',
      'An item must be sold, purchased, or both. Tick at least one.',
      { isSold, isPurchased },
    )
  }
}

/**
 * Refuse a name another item already holds, ignoring case.
 *
 * `COLLATE NOCASE` to match the unique index exactly. A case-sensitive check here would
 * leave the index as the only thing catching `Ball bearing 6203` against `BALL BEARING
 * 6203`, and the index reports a constraint name rather than the name that clashed.
 */
async function assertNameFree(db: CofferDb, name: string, exceptId: string | null): Promise<void> {
  let query = db
    .selectFrom('items')
    .select(['id', 'name'])
    .where((eb) => eb(sql<string>`name COLLATE NOCASE`, '=', name))
  if (exceptId !== null) {
    query = query.where('id', '!=', exceptId)
  }
  const clash = await query.executeTakeFirst()
  if (clash !== undefined) {
    throw new RepoError('ITEM_NAME_TAKEN', `${clash.name} is already in these books.`, {
      name,
      existingName: clash.name,
    })
  }
}

/**
 * Two items carrying one SKU are one item entered twice.
 *
 * The null guard is an early return and not a rule: `code = NULL` matches no row in SQL,
 * so removing it would still admit every item without a SKU. Measured — the mutation
 * survives on purpose, and the guard stays because a query nobody needs is a query nobody
 * should run.
 */
async function assertCodeFree(
  db: CofferDb,
  code: string | null,
  exceptId: string | null,
): Promise<void> {
  if (code === null) {
    return
  }
  let query = db
    .selectFrom('items')
    .select(['id', 'name'])
    .where((eb) => eb(sql<string>`code COLLATE NOCASE`, '=', code))
  if (exceptId !== null) {
    query = query.where('id', '!=', exceptId)
  }
  const clash = await query.executeTakeFirst()
  if (clash !== undefined) {
    throw new RepoError('ITEM_CODE_TAKEN', `${clash.name} already carries that code.`, {
      code,
      existingName: clash.name,
    })
  }
}

/**
 * Refuse a document line naming an archived item.
 *
 * A repository check and NOT a trigger, for the reason in the closing block of 0006 and
 * in 0004 before it: archiving states an intention, it does not make the figures wrong,
 * and a database rule would make a document unamendable the moment one of its items was
 * retired. Exported because a document's lines are where an item id is known.
 */
export async function assertItemsActive(db: CofferDb, itemIds: readonly string[]): Promise<void> {
  const wanted = [...new Set(itemIds)]
  if (wanted.length === 0) {
    return
  }

  const rows = await db
    .selectFrom('items')
    .select(['id', 'name', 'is_archived'])
    .where('id', 'in', wanted)
    .execute()

  const found = new Map(rows.map((row) => [row.id, row]))
  for (const id of wanted) {
    const row = found.get(id)
    if (row === undefined) {
      throw new RepoError('ITEM_NOT_FOUND', 'A line names an item that does not exist.', {
        itemId: id,
      })
    }
    if (row.is_archived === 1) {
      throw new RepoError('ITEM_ARCHIVED', `${row.name} is archived and takes nothing new.`, {
        itemId: id,
        name: row.name,
      })
    }
  }
}

/**
 * The unit an item is measured in, in the form the foreign key will match.
 *
 * The stored code is taken from the unit rather than from the caller, because the
 * reference is case-sensitive: an item written with `kg` against a unit stored as `KG` is
 * refused outright by SQLite. Measured, not read — see 0006.
 */
async function unitCodeOf(db: CofferDb, code: string | null | undefined): Promise<string | null> {
  if (code === undefined || code === null || code.trim() === '') {
    return null
  }
  return (await requireActiveUnit(db, code)).code
}

/**
 * The account an item's value posts to, overriding the one its document kind implies.
 *
 * Null is not "unknown" — it means "whatever the kind says", which is the usual case and
 * the reason this is checked rather than defaulted. A group account is refused here and
 * not by a trigger: 0004's `journal_lines_not_group` already refuses the posting, so
 * nothing is corrupted by getting this wrong, and what an earlier refusal buys is a
 * sentence at the moment the choice is made rather than an abort weeks later when an
 * invoice will not issue.
 */
async function postingAccountOf(
  db: CofferDb,
  accountId: string | null | undefined,
  which: 'sales' | 'purchase',
): Promise<string | null> {
  if (accountId === undefined || accountId === null) {
    return null
  }

  const account = await db
    .selectFrom('accounts')
    .select(['id', 'name', 'is_group', 'is_archived'])
    .where('id', '=', accountId)
    .executeTakeFirst()

  if (account === undefined) {
    throw new RepoError('ACCOUNT_NOT_FOUND', `The ${which} account is not in this chart.`, {
      accountId,
      which,
    })
  }
  if (account.is_group === 1) {
    throw new RepoError(
      'ITEM_ACCOUNT_IS_GROUP',
      `${account.name} is a group and holds no figures of its own. Name one of its accounts.`,
      { accountId, which, name: account.name },
    )
  }
  if (account.is_archived === 1) {
    throw new RepoError('ACCOUNT_ARCHIVED', `${account.name} is archived and takes nothing new.`, {
      accountId,
      which,
      name: account.name,
    })
  }
  return account.id
}

// ---- Conversion ------------------------------------------------------------

function toSummary(row: ItemRow): ItemSummary {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    unitCode: row.unit_code,
    classificationCode: row.classification_code,
    taxRatePct: row.tax_rate_pct,
    salePrice: row.sale_price,
    /* On the SUMMARY, so a picker can price a purchase line and an expense line can find
     * its account without a second call per item. See `ItemSummary`. */
    purchasePrice: row.purchase_price,
    salesAccountId: row.sales_account_id,
    purchaseAccountId: row.purchase_account_id,
    isSold: row.is_sold === 1,
    isPurchased: row.is_purchased === 1,
    isCharge: row.is_charge === 1,
    isArchived: row.is_archived === 1,
  }
}

function toItem(row: ItemRow): Item {
  return {
    ...toSummary(row),
    description: row.description,
    isStockTracked: row.is_stock_tracked === 1,
    reorderLevel: row.reorder_level,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function requireName(value: string): string {
  const name = value.trim()
  if (name === '') {
    throw new RepoError('ITEM_NAME_REQUIRED', 'An item needs a name.', {})
  }
  return name
}

function trimmedOrNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null
  }
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * A price at money scale, or null for no standard price.
 *
 * Null and '0.00' are different answers and both are meaningful: nothing has been agreed,
 * versus agreed at nothing — a sample, a warranty replacement, a line that prints to show
 * what was supplied. Coercing one into the other would put a price on a free issue or
 * strip one off a paid line.
 */
function priceOf(value: string | null | undefined, what: string): string | null {
  if (value === undefined || value === null || value.trim() === '') {
    return null
  }
  try {
    const amount = parseMoney(value.trim(), what)
    if (amount.isNegative()) {
      throw new RepoError('INVALID_AMOUNT', `A ${what} cannot be negative.`, { value })
    }
    return toMoneyString(amount)
  } catch (error) {
    if (error instanceof RepoError) {
      throw error
    }
    throw new RepoError(
      'INVALID_AMOUNT',
      `${JSON.stringify(value)} is not an amount.`,
      { value, what },
      { cause: error },
    )
  }
}

/**
 * A tax rate at rate scale, or null when the item carries no standard rate.
 *
 * Three decimal places, not two, and `parseRate` refuses a fourth rather than rounding it
 * away: half of India's 0.25% slab is 0.125%, and an item storing 0.13% would print a
 * rate the tax was never computed from. Null is not 0.000 — nil-rated is a real answer
 * and "nobody has said yet" is a different one.
 */
function taxRateOf(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === '') {
    return null
  }
  try {
    const rate = parseRate(value.trim(), 'tax rate')
    if (rate.isNegative()) {
      throw new RepoError('INVALID_AMOUNT', 'A tax rate cannot be negative.', { value })
    }
    return toRateString(rate)
  } catch (error) {
    if (error instanceof RepoError) {
      throw error
    }
    throw new RepoError(
      'INVALID_AMOUNT',
      `${JSON.stringify(value)} is not a tax rate.`,
      { value },
      { cause: error },
    )
  }
}
