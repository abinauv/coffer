/*
 * Reading a list of units of measure, and the choices a unit editor offers.
 *
 * THE KEY IS A CODE. Every other master record in these books has a surrogate id; a unit
 * has none, and its code is what an item stores and what prints on every document already
 * issued. That is why `UpdateUnitInput` carries no new code, why this file has a hint
 * saying so, and why nothing here offers to rename one.
 *
 * NOTHING HERE RESTRICTS A BUSINESS TO A KNOWN LIST. `BUNDLE` and `TIN` are as real as
 * `KGS`. The reference project rewrote anything outside four units to `Nos` and
 * CONVENTIONS §9 calls that a bug to fix rather than port, so there is no table of
 * permitted codes in this module and there will not be one.
 *
 * AND NOTHING HERE UPPER-CASES A CODE. The repository normalises — trimmed and
 * upper-cased — on the way in and on the way to a lookup, and a second copy of that rule
 * in the renderer is a second thing to keep in step. What the screen does instead is
 * re-read what main returns, so `kgs` is shown back as `KGS` because that is what the
 * books now hold.
 */

import type { AppError, UnitOfMeasure } from '@shared/dto'

/**
 * The rows a search should show. An empty query returns everything.
 *
 * Code and name, because those are the two things on a unit. The code is searched
 * case-insensitively even though every stored code is upper case: somebody looking for
 * kilograms types `kg`, and a picker that does not hold shift must not look broken —
 * which is the same courtesy the boundary extends by not refusing lower case at all.
 */
export function filterUnits(
  units: readonly UnitOfMeasure[],
  query: string,
): readonly UnitOfMeasure[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return units

  return units.filter((unit) =>
    [unit.code, unit.name, unit.regimeCode].some(
      (field) => field !== null && field.toLowerCase().includes(needle),
    ),
  )
}

/** One entry in the decimal-places picker. */
export interface DecimalPlacesChoice {
  value: number
  label: string
}

/**
 * How many places a quantity in this unit may carry.
 *
 * Four choices, matching the CHECK in migration 0006, and the ceiling is the storage
 * scale — a quantity column holds three places, so a unit cannot permit a fourth. Zero is
 * the interesting one and the reason this is a choice at all: half a box is not a
 * quantity, and an invoice line for one should not be enterable.
 *
 * A LIST RATHER THAN A FREE BOX, because the set is closed and small. The boundary
 * refuses a fifth value as a caller bug rather than phrasing it for a user
 * (src/main/ipc/handlers/units.ts), which is only fair if the control cannot produce one.
 */
export const DECIMAL_PLACES_CHOICES: readonly DecimalPlacesChoice[] = [
  { value: 0, label: '0 — whole numbers only' },
  { value: 1, label: '1 — 4.5' },
  { value: 2, label: '2 — 4.25' },
  { value: 3, label: '3 — 4.125' },
]

/**
 * What a new unit permits when nobody says otherwise.
 *
 * Three, the same permissive default the repository applies, and stated here so that the
 * form shows what will happen rather than leaving the field on whatever the browser
 * picked. A business that creates `BOX` and forgets to say 0 can still enter every
 * quantity it meant to; a default of 0 would refuse `1.5` against a carelessly created
 * `KGS` and look like a fault in the software.
 */
export const DEFAULT_DECIMAL_PLACES = 3

/** The fields a unit editor can put a refusal underneath. */
export type UnitField = 'code' | 'name'

/*
 * Which field a refusal belongs under. A lookup, as `itemErrorField` — see the note
 * there. Codes come from src/main/db/repos/units.ts.
 *
 * `UNIT_CODE_TAKEN` is the one that matters. Stored codes are upper case and a code is
 * upper-cased before it is compared, so `kgs` and `KGS` are the same unit and the second
 * one is refused — with a sentence naming the code that already exists. Under the code
 * box that reads as an answer; in a banner it reads as a random failure.
 */
const UNIT_ERROR_FIELDS: Record<string, UnitField> = {
  UNIT_CODE_TAKEN: 'code',
  UNIT_CODE_REQUIRED: 'code',
}

export function unitErrorField(error: AppError): UnitField | null {
  return UNIT_ERROR_FIELDS[error.code] ?? null
}

/**
 * What to say under the code box.
 *
 * Two different sentences for two different facts, and the second is the one nobody
 * expects. On a new unit the useful thing to know is that case does not distinguish one
 * code from another, because that is what makes the refusal sensible when it comes. On an
 * existing one the useful thing is that the box cannot be changed at all, and WHY — a
 * code is printed on paperwork that has already gone out, so a rename would make old
 * documents describe a unit that no longer exists under that name.
 */
export function unitCodeHint(isNew: boolean): string {
  return isNew
    ? 'Short, and it prints on every document. Codes are stored in capitals and compared without case, so kg and KG would be one unit, not two.'
    : 'A code is the identity: every item stores it and every document already issued has printed it. To move to a different code, create the new unit and move the items across.'
}
