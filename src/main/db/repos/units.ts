/*
 * The units repository — what a quantity is counted in.
 *
 * Read migration 0006 first. The decision that shapes this whole file is that a unit has
 * no surrogate id: its code IS its identity, so every operation here takes a code, and
 * the code a caller supplies is normalised — trimmed and upper-cased — before it touches
 * the database. That is not tidying. SQLite's TEXT primary key is case-sensitive and the
 * foreign key from `items.unit_code` is too, so `kg` typed into a picker does not find
 * `KG` and cannot be attached to an item; normalising at this boundary is what makes the
 * two agree. The CHECK in 0006 is the floor under it.
 *
 * CUSTOM UNITS ARE THE POINT. Nothing here restricts a business to a known list. A unit
 * called `BUNDLE` or `TIN` is as real as `KGS`, and `regime_code` — untouched by
 * everything in Phase 2 — is where the filing layer will later record that `BAGS` is
 * reported as `BAG`. Coercing a unit onto a fixed list is the reference project's bug
 * this codebase exists partly to not repeat (CONVENTIONS §9).
 *
 * WHAT THIS FILE DOES NOT DO. It does not check that `decimal_places` is 0 to 3 and it
 * does not check that a name has characters in it. Both are CHECKs in 0006 and neither is
 * restated here: `decimal_places` is a four-way choice in the UI, so a value outside it
 * is a caller bug rather than something to phrase for a user, and `RepoErrorCode` has no
 * member for a blank unit name. A second copy of a rule is a second thing to keep in
 * step, and this codebase has twice deleted the redundant copy rather than test it.
 */

import type { CreateUnitInput, ListUnitsInput, UnitOfMeasure, UpdateUnitInput } from '@shared/dto'

import type { CofferDb } from '../kysely'
import type { UnitsOfMeasureTable } from '../schema'
import { RepoError } from './errors'

type UnitRow = {
  [K in keyof UnitsOfMeasureTable]: UnitsOfMeasureTable[K]
}

/**
 * What a unit permits when nobody says otherwise.
 *
 * Three, the storage scale, so a new unit imposes nothing beyond what the column already
 * does. The permissive default is the safe one: a business that creates `BOX` and forgets
 * to say 0 can still enter every quantity it meant to, whereas a default of 0 would
 * refuse `1.5` against a carelessly created `KGS` and look like a bug in the software.
 */
const DEFAULT_DECIMAL_PLACES = 3

// ---- Seeding ---------------------------------------------------------------

/*
 * THE STARTER SET, AND WHY A FILE THAT ARGUES AGAINST FIXED LISTS HAS ONE.
 *
 * Nothing below restricts anybody. `BUNDLE` and `TIN` are as real as `KGS` and the header
 * of this file spends a paragraph saying so — the reference project's silent rewrite to
 * `Nos` is a bug this codebase exists partly not to repeat. A SEED IS NOT A LIST: these
 * eight rows are ordinary units a business may rename, archive or delete, and the only
 * thing that makes them special is that they are there on the first day.
 *
 * WHAT THE ABSENCE COST. `setUpBooks` seeded a chart, two fiscal years and nine numbering
 * series and NOT ONE UNIT, so a fresh company had an empty `units_of_measure` table;
 * `units/service.test.ts` pinned that fact on purpose so whoever fixed it would be told.
 * It is the shape of 0012's `SERIES_NOT_CONFIGURED` one table over — a file that looks
 * finished, where the first invoice line has nothing to be measured in.
 *
 * THE CODES ARE THE UQC's OWN, WHICH IS THE WHOLE JUDGEMENT HERE. `regime_code` is
 * India's Unit Quantity Code, the closed set a GSTR-1 is filed against, and the column
 * exists because a business measuring in `BAGS` must keep saying `BAGS` on its paperwork
 * while filing `BAG`. A seed does not have to create that gap: picking codes that ARE
 * UQCs means the invoice and the return say the same word, and a business that wants its
 * own word creates it and maps it.
 *
 * WHERE `regimeCode` IS NULL IT IS AN ADMISSION AND NOT AN OVERSIGHT. Nothing in this
 * build has ever written that column, and a wrong UQC is worse than an absent one — it
 * fails at the portal weeks later under a code somebody will believe was checked. `LTR`
 * is seeded as a unit because businesses sell in litres and left unmapped because the
 * volume codes I can vouch for are `KLR` and `MLT`; the filing layer maps it when it can
 * say so from the pack rather than from memory.
 *
 * DECIMAL PLACES ARE THE UNIT'S OWN ARGUMENT, not the column's. Nought on the counted
 * ones — half a box is not a quantity and an invoice line for one cannot be picked — and
 * three, the storage scale, on the measured ones, where 2.5 metres is the ordinary case.
 */
interface StarterUnit {
  readonly code: string
  readonly name: string
  readonly decimalPlaces: number
  /** India's UQC, where this file can vouch for it. Null is "not yet mapped". */
  readonly regimeCode: string | null
}

const STARTER_UNITS: readonly StarterUnit[] = [
  { code: 'NOS', name: 'Numbers', decimalPlaces: 0, regimeCode: 'NOS' },
  { code: 'PCS', name: 'Pieces', decimalPlaces: 0, regimeCode: 'PCS' },
  { code: 'SET', name: 'Sets', decimalPlaces: 0, regimeCode: 'SET' },
  { code: 'PRS', name: 'Pairs', decimalPlaces: 0, regimeCode: 'PRS' },
  { code: 'BOX', name: 'Boxes', decimalPlaces: 0, regimeCode: 'BOX' },
  { code: 'KGS', name: 'Kilograms', decimalPlaces: 3, regimeCode: 'KGS' },
  { code: 'MTR', name: 'Metres', decimalPlaces: 3, regimeCode: 'MTR' },
  { code: 'LTR', name: 'Litres', decimalPlaces: 3, regimeCode: null },
]

/**
 * Give a new company something to measure in. Called from `setUpBooks`, in its
 * transaction.
 *
 * `seedDefaultSeries`'s shape exactly, including the return — the number created, which
 * is zero on a file that already has every one of them. Idempotent, and a code somebody
 * has already taken is skipped rather than overwritten: a business that renamed `NOS` to
 * something of their own keeps their decision.
 *
 * `createUnit` rather than direct inserts, so the normalisation, the default and the
 * clash check are the ones the rest of the application is held to. A seeding path with
 * its own inserts is a second way to make a unit, and it is the one that would still be
 * writing a lower-case code after somebody changed the rule.
 */
export async function seedStarterUnits(db: CofferDb): Promise<number> {
  let created = 0
  for (const unit of STARTER_UNITS) {
    const existing = await db
      .selectFrom('units_of_measure')
      .select('code')
      .where('code', '=', unit.code)
      .executeTakeFirst()
    if (existing !== undefined) continue

    await createUnit(db, {
      code: unit.code,
      name: unit.name,
      decimalPlaces: unit.decimalPlaces,
      regimeCode: unit.regimeCode,
    })
    created += 1
  }
  return created
}

// ---- Reading ---------------------------------------------------------------

/**
 * Units, ordered by code.
 *
 * By code and not by name, because the code is what the user typed, what prints, and what
 * they are looking for in the list. Archived units are excluded by default: a picker
 * offering one lets somebody attach an invoice line to a unit the business has retired.
 */
export async function listUnits(
  db: CofferDb,
  input: ListUnitsInput = {},
): Promise<UnitOfMeasure[]> {
  let query = db.selectFrom('units_of_measure').selectAll()

  if (input.includeArchived !== true) {
    query = query.where('is_archived', '=', 0)
  }

  const rows = await query.orderBy('code').execute()
  return rows.map(toUnit)
}

/**
 * One unit, or null.
 *
 * The code is normalised first, so a caller holding `kg` — from a spreadsheet import, or
 * from a user who did not hold shift — finds `KG` rather than nothing.
 */
export async function getUnit(db: CofferDb, code: string): Promise<UnitOfMeasure | null> {
  const row = await db
    .selectFrom('units_of_measure')
    .selectAll()
    .where('code', '=', normalisedCode(code))
    .executeTakeFirst()
  return row === undefined ? null : toUnit(row)
}

// ---- Writing ---------------------------------------------------------------

export async function createUnit(db: CofferDb, input: CreateUnitInput): Promise<UnitOfMeasure> {
  const code = requireCode(input.code)
  await assertCodeFree(db, code)

  const now = new Date().toISOString()

  await db
    .insertInto('units_of_measure')
    .values({
      code,
      name: input.name.trim(),
      decimal_places: input.decimalPlaces ?? DEFAULT_DECIMAL_PLACES,
      regime_code: trimmedOrNull(input.regimeCode),
      is_archived: 0,
      created_at: now,
      updated_at: now,
    })
    .execute()

  return await readBack(db, code)
}

/**
 * Change a unit.
 *
 * The code is not among the fields that may change — it is the identity, it is what every
 * item referring to this unit stores, and it is printed on every document already issued.
 * A business that has decided `KGS` should have been `KG` creates the second one and moves
 * its items across, which is a decision somebody makes rather than a rename that silently
 * rewrites what old paperwork claims to have said.
 *
 * `null` clears `regimeCode`; absent leaves every field as it was, so a screen that edits
 * one thing cannot blank a field it never showed.
 */
export async function updateUnit(db: CofferDb, input: UpdateUnitInput): Promise<UnitOfMeasure> {
  const existing = await requireUnit(db, input.code)

  const update: Partial<UnitRow> = { updated_at: new Date().toISOString() }

  if (input.name !== undefined) update.name = input.name.trim()
  if (input.decimalPlaces !== undefined) update.decimal_places = input.decimalPlaces
  if (input.regimeCode !== undefined) update.regime_code = trimmedOrNull(input.regimeCode)
  if (input.isArchived !== undefined) update.is_archived = input.isArchived ? 1 : 0

  await db.updateTable('units_of_measure').set(update).where('code', '=', existing.code).execute()

  return await readBack(db, existing.code)
}

/**
 * Stop offering a unit without losing what it measured.
 *
 * One line, because archiving is `updateUnit` with one field set and a second
 * implementation of it would be a second place for the timestamp or the flag to be
 * written differently. Reversible: a unit comes back when the product line does.
 */
export async function archiveUnit(
  db: CofferDb,
  code: string,
  archived: boolean,
): Promise<UnitOfMeasure> {
  return await updateUnit(db, { code, isArchived: archived })
}

/**
 * Remove a unit entirely.
 *
 * Only one no item refers to. `ON DELETE RESTRICT` on `items.unit_code` would refuse it
 * anyway; the check here exists so the caller gets a sentence naming the item in the way
 * rather than `FOREIGN KEY constraint failed`. A unit in use is archived, never deleted —
 * documents already issued print the code it held.
 */
export async function deleteUnit(db: CofferDb, code: string): Promise<void> {
  const unit = await requireUnit(db, code)

  const used = await db
    .selectFrom('items')
    .select(['id', 'name'])
    .where('unit_code', '=', unit.code)
    .executeTakeFirst()
  if (used !== undefined) {
    throw new RepoError(
      'UNIT_IN_USE',
      `${used.name} is measured in ${unit.code}. Archive the unit instead.`,
      { code: unit.code, itemId: used.id, itemName: used.name },
    )
  }

  await db.deleteFrom('units_of_measure').where('code', '=', unit.code).execute()
}

// ---- Guards ----------------------------------------------------------------

/**
 * Load a unit and refuse a missing one.
 *
 * Returns the DTO rather than the row, so that callers needing the stored code — which is
 * the normalised form of whatever they passed in — read it through one code path.
 */
async function requireUnit(db: CofferDb, code: string): Promise<UnitOfMeasure> {
  const unit = await getUnit(db, code)
  if (unit === null) {
    throw new RepoError('UNIT_NOT_FOUND', `There is no unit called ${normalisedCode(code)}.`, {
      code,
    })
  }
  return unit
}

/**
 * The unit an item may be measured in, or a refusal.
 *
 * Exported because items.ts is where a unit code arrives from a user, and because both
 * halves of the answer belong together: the code has to exist, and an archived unit takes
 * nothing new. A repository check and NOT a trigger, which is the archived-account
 * decision in 0004 reaching the same answer for the same reason — see the closing block
 * of 0006. The caller writes the returned `code`, not its own, so the case-sensitive
 * foreign key resolves.
 */
export async function requireActiveUnit(db: CofferDb, code: string): Promise<UnitOfMeasure> {
  const unit = await requireUnit(db, code)
  if (unit.isArchived) {
    throw new RepoError('UNIT_ARCHIVED', `${unit.code} is archived and takes nothing new.`, {
      code: unit.code,
    })
  }
  return unit
}

/**
 * Refuse a code another unit already holds.
 *
 * A plain equality and not `COLLATE NOCASE`, and that is not the trap it looks like:
 * every stored code is upper case because 0006 CHECKs it, and `code` here has already
 * been through `requireCode`. The two strings are therefore comparable exactly. The
 * pre-check exists at all so the caller gets a code and a sentence — catching the primary
 * key's own failure instead would report every other constraint on the table as a
 * duplicate code, which is how a bad `decimal_places` would come back as "that code is
 * taken".
 */
async function assertCodeFree(db: CofferDb, code: string): Promise<void> {
  const clash = await db
    .selectFrom('units_of_measure')
    .select('code')
    .where('code', '=', code)
    .executeTakeFirst()
  if (clash !== undefined) {
    throw new RepoError('UNIT_CODE_TAKEN', `${code} is already a unit in these books.`, { code })
  }
}

// ---- Conversion ------------------------------------------------------------

function toUnit(row: UnitRow): UnitOfMeasure {
  return {
    code: row.code,
    name: row.name,
    decimalPlaces: row.decimal_places,
    regimeCode: row.regime_code,
    isArchived: row.is_archived === 1,
  }
}

/**
 * The stored form of a code: trimmed and upper case.
 *
 * Upper-cased in JavaScript rather than by the database, which matters for a code outside
 * ASCII: SQLite's `upper()` leaves `кг` alone and the CHECK in 0006 would admit it, while
 * this does not. Measured, not read.
 */
function normalisedCode(value: string): string {
  return value.trim().toUpperCase()
}

function requireCode(value: string): string {
  const code = normalisedCode(value)
  if (code === '') {
    throw new RepoError('UNIT_CODE_REQUIRED', 'A unit needs a code — it is what prints.', {})
  }
  return code
}

function trimmedOrNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null
  }
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Read a unit back after writing it.
 *
 * A missing row here is not a user error and is not actionable — the write succeeded a
 * statement ago — so it carries the same code as any other missing unit and the message
 * says what actually happened.
 */
async function readBack(db: CofferDb, code: string): Promise<UnitOfMeasure> {
  const unit = await getUnit(db, code)
  if (unit === null) {
    throw new RepoError('UNIT_NOT_FOUND', 'The unit was written but could not be read back.', {
      code,
    })
  }
  return unit
}
