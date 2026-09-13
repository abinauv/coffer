import { describe, expect, it } from 'vitest'
import type { UnitOfMeasure } from '@shared/dto'
import {
  DECIMAL_PLACES_CHOICES,
  DEFAULT_DECIMAL_PLACES,
  filterUnits,
  unitCodeHint,
  unitErrorField,
} from './unit-view'

function unit(over: Partial<UnitOfMeasure> & Pick<UnitOfMeasure, 'code'>): UnitOfMeasure {
  return {
    name: over.code,
    decimalPlaces: 3,
    regimeCode: null,
    isArchived: false,
    ...over,
  }
}

const LIST: UnitOfMeasure[] = [
  unit({ code: 'BUNDLE', name: 'Bundles of ten' }),
  unit({ code: 'KGS', name: 'Kilograms', regimeCode: 'KGS' }),
  unit({ code: 'NOS', name: 'Numbers', regimeCode: 'NOS' }),
]

const codes = (rows: readonly UnitOfMeasure[]): string[] => rows.map((row) => row.code)

describe('filterUnits', () => {
  it('returns everything for an empty query', () => {
    expect(filterUnits(LIST, '')).toHaveLength(3)
    expect(filterUnits(LIST, '   ')).toHaveLength(3)
  })

  /*
   * Every stored code is upper case, so a case-sensitive search would find nothing for
   * somebody typing `kg` — which is precisely the courtesy the boundary extends by not
   * refusing lower case at all.
   */
  it('matches a code typed in lower case', () => {
    expect(codes(filterUnits(LIST, 'kg'))).toEqual(['KGS'])
  })

  /*
   * AND THE HALF THE LOWER-CASE QUERY CANNOT TEST. Every field is lowered before it is
   * compared, so an all-lowercase query matches whether or not the NEEDLE is lowered too
   * — the two spellings only disagree when the query itself carries a capital. This is
   * that query, and it is also the ordinary one: a name is typed the way it is written.
   */
  it('matches a name typed with the capital it is written with', () => {
    expect(codes(filterUnits(LIST, 'Bundles'))).toEqual(['BUNDLE'])
  })

  it('matches a name, which is what somebody who forgot the code has', () => {
    expect(codes(filterUnits(LIST, 'bundles'))).toEqual(['BUNDLE'])
  })

  it('matches nothing rather than everything when nothing matches', () => {
    expect(filterUnits(LIST, 'zzz')).toHaveLength(0)
  })

  /* Nothing is mapped to a return code until Phase 5, so most units have none. */
  it('does not trip over a unit that reports as nothing yet', () => {
    expect(filterUnits([unit({ code: 'TIN' })], 'nos')).toHaveLength(0)
  })
})

describe('DECIMAL_PLACES_CHOICES', () => {
  /*
   * Four, matching the CHECK in migration 0006. The ceiling is the storage scale — a
   * quantity column holds three places — and the boundary refuses a fifth value as a
   * caller bug rather than phrasing it for a user, which is only fair if the control
   * cannot produce one.
   */
  it('offers exactly the four places a unit may permit', () => {
    expect(DECIMAL_PLACES_CHOICES.map((choice) => choice.value)).toEqual([0, 1, 2, 3])
  })

  /* Zero is the interesting one and the reason this is a choice at all: half a box is
   * not a quantity. It has to read as a decision rather than as a blank. */
  it('says in words what choosing none means', () => {
    expect(DECIMAL_PLACES_CHOICES[0]?.label).toBe('0 — whole numbers only')
  })

  /*
   * The permissive default is the safe one: a business that creates BOX and forgets to
   * say 0 can still enter every quantity it meant to, whereas a default of 0 would refuse
   * 1.5 against a carelessly created KGS and look like a fault in the software. It is the
   * repository's default too, so a form that showed anything else would be describing a
   * save that would not happen.
   */
  it('defaults to the most permissive of them, as the repository does', () => {
    expect(DEFAULT_DECIMAL_PLACES).toBe(3)
    expect(DECIMAL_PLACES_CHOICES.map((choice) => choice.value)).toContain(DEFAULT_DECIMAL_PLACES)
  })
})

describe('unitErrorField', () => {
  /*
   * The collision users actually hit, and the one that reads as a random failure
   * anywhere else: codes are compared without case, so `kgs` typed against an existing
   * `KGS` is refused. Under the code box, with main's sentence naming the code that
   * already exists, it reads as an answer.
   */
  it('puts a code collision under the code box', () => {
    expect(
      unitErrorField({ code: 'UNIT_CODE_TAKEN', message: 'KGS is already a unit in these books.' }),
    ).toBe('code')
  })

  it('puts a missing code under the code box as well', () => {
    expect(unitErrorField({ code: 'UNIT_CODE_REQUIRED', message: '' })).toBe('code')
  })

  /* A unit in use is a fact about an ITEM, not about a box in this form, so it belongs in
   * the notice rather than under a field. */
  it('has no field for a refusal that names none', () => {
    expect(unitErrorField({ code: 'UNIT_IN_USE', message: '' })).toBeNull()
    expect(unitErrorField({ code: 'UNIT_NOT_FOUND', message: '' })).toBeNull()
    expect(unitErrorField({ code: 'NO_COMPANY_OPEN', message: '' })).toBeNull()
  })
})

describe('unitCodeHint', () => {
  /*
   * On a new unit the useful fact is that case does not distinguish one code from
   * another, because that is what makes the refusal sensible when it arrives.
   */
  it('warns a new unit that case will not tell two codes apart', () => {
    expect(unitCodeHint(true)).toMatch(/kg and KG would be one unit/)
  })

  /*
   * On an existing one the useful fact is that the box cannot change at all, and WHY: the
   * code is printed on paperwork that has already gone out, so a rename would make old
   * documents describe a unit that no longer exists under that name. A read-only field
   * with no explanation is a field somebody files a bug about.
   */
  it('says why an existing code cannot be edited, and what to do instead', () => {
    expect(unitCodeHint(false)).toMatch(/already issued/)
    expect(unitCodeHint(false)).toMatch(/create the new unit and move the items across/i)
  })

  it('does not give the same sentence to both', () => {
    expect(unitCodeHint(true)).not.toBe(unitCodeHint(false))
  })
})
