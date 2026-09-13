/*
 * The `units` group.
 *
 * Same contract as ./parties.ts: the boundary, not the behaviour. Validate the shape of
 * what the renderer sent, call a `UnitsService`, wrap the answer in a `Result`.
 *
 * THIS FILE VALIDATES TWO THINGS THE REPOSITORY DELIBERATELY DOES NOT, and both are
 * named in that repository's header as belonging here. `decimalPlaces` is a four-way
 * choice in the UI, so a fifth value is a caller bug rather than something to phrase for
 * a user — and `RepoErrorCode` has no member for a blank unit NAME. Both are CHECKs in
 * migration 0006, which is the floor: without a refusal at this layer they reach a user
 * as a constraint failure wearing an internal error, naming no field. So the boundary
 * answers first and says which field, and 0006 stays underneath for anything written
 * another way.
 *
 * WHAT IS NOT CHECKED IS THE CASE OF A CODE. `kg` is a perfectly good thing for a screen
 * to send: the repository upper-cases before it reads or writes, on purpose, because
 * SQLite's TEXT primary key is case-sensitive and so is the foreign key from an item.
 * Refusing lower case here would make a picker that does not hold shift look broken.
 *
 * THERE IS NO `code` ON AN UPDATE, and that absence is the contract rather than an
 * oversight — a code is an identity and is printed on every document already issued. See
 * the `units` group in src/shared/ipc.ts.
 */

import type {
  CreateUnitInput,
  ListUnitsInput,
  UnitOfMeasure,
  UpdateUnitInput,
} from '../../../shared/dto'
import type { ArchiveUnitInput } from '../../../shared/ipc'
import type { GroupHandlers } from '../registry'
import { ok } from '../surface'
import {
  expectBoolean,
  expectBoundedString,
  expectInteger,
  expectNonEmptyString,
  expectRecord,
  optional,
} from '../validate'

/**
 * What the IPC layer needs from src/main/units.
 *
 * One method per contract method, same names, same DTOs, no envelope.
 */
export interface UnitsService {
  list(input: ListUnitsInput): Promise<UnitOfMeasure[]>
  get(code: string): Promise<UnitOfMeasure | null>
  create(input: CreateUnitInput): Promise<UnitOfMeasure>
  update(input: UpdateUnitInput): Promise<UnitOfMeasure>
  archive(input: ArchiveUnitInput): Promise<UnitOfMeasure>
  delete(code: string): Promise<void>
}

/**
 * A code that prints on a document line, so short by nature. A ceiling rather than a
 * rule: nothing in the product wants a sixteen-character unit, and the database has no
 * opinion at all.
 */
const MAX_CODE = 16

/** A unit's full name — 'Kilograms', 'Bundles of ten'. */
const MAX_NAME = 100

/**
 * Quantity decimals a unit may permit, matching the CHECK in 0006.
 *
 * The ceiling is the storage scale: three places is what a quantity column holds, so a
 * unit cannot permit a fourth. Zero is a real answer and the interesting one — half a box
 * is not a quantity.
 */
const MIN_DECIMAL_PLACES = 0
const MAX_DECIMAL_PLACES = 3

const code = (value: unknown, field: string): string =>
  expectBoundedString(expectNonEmptyString(value, field), field, MAX_CODE)

const name = (value: unknown, field: string): string =>
  expectBoundedString(expectNonEmptyString(value, field), field, MAX_NAME)

const decimalPlaces = (value: unknown): number =>
  expectInteger(value, 'decimalPlaces', MIN_DECIMAL_PLACES, MAX_DECIMAL_PLACES)

/**
 * What a unit reports as in a return. Absent stays absent, null clears, a string is kept.
 *
 * Nullable on create as well as on update, and that is not symmetry for its own sake: a
 * business creating `BAGS` has no idea yet which UQC it maps to, and Phase 5 fills it in.
 */
function nullableRegimeCode(input: Record<string, unknown>): string | null | undefined {
  if (!('regimeCode' in input)) return undefined
  if (input['regimeCode'] == null) return null
  return expectBoundedString(input['regimeCode'], 'regimeCode', MAX_CODE)
}

function parseList(value: unknown): ListUnitsInput {
  if (value === undefined || value === null) return {}
  const input = expectRecord(value, 'input')
  return {
    includeArchived: optional(input['includeArchived'], (v) => expectBoolean(v, 'includeArchived')),
  }
}

function parseCreate(value: unknown): CreateUnitInput {
  const input = expectRecord(value, 'input')
  return {
    code: code(input['code'], 'code'),
    name: name(input['name'], 'name'),
    decimalPlaces: optional(input['decimalPlaces'], decimalPlaces),
    regimeCode: nullableRegimeCode(input),
  }
}

/**
 * A change to a unit.
 *
 * `name` is optional and never nullable, for the reason `parties.update` refuses to clear
 * a party's name: a unit with no name is not one, and 0006 CHECKs it. `code` is not a
 * field at all — see the header.
 */
function parseUpdate(value: unknown): UpdateUnitInput {
  const input = expectRecord(value, 'input')
  return {
    code: code(input['code'], 'code'),
    name: 'name' in input ? name(input['name'], 'name') : undefined,
    decimalPlaces: optional(input['decimalPlaces'], decimalPlaces),
    regimeCode: nullableRegimeCode(input),
    isArchived: optional(input['isArchived'], (v) => expectBoolean(v, 'isArchived')),
  }
}

function parseArchive(value: unknown): ArchiveUnitInput {
  const input = expectRecord(value, 'input')
  return {
    code: code(input['code'], 'code'),
    archived: expectBoolean(input['archived'], 'archived'),
  }
}

export function createUnitsHandlers(service: UnitsService): GroupHandlers<'units'> {
  return {
    list: {
      parseArgs: (raw): [ListUnitsInput] => [parseList(raw[0])],
      handle: async (input = {}) => ok(await service.list(input)),
    },

    get: {
      parseArgs: (raw): [string] => [code(raw[0], 'code')],
      handle: async (unitCode) => ok(await service.get(unitCode)),
    },

    create: {
      parseArgs: (raw): [CreateUnitInput] => [parseCreate(raw[0])],
      handle: async (input) => ok(await service.create(input)),
    },

    update: {
      parseArgs: (raw): [UpdateUnitInput] => [parseUpdate(raw[0])],
      handle: async (input) => ok(await service.update(input)),
    },

    archive: {
      parseArgs: (raw): [ArchiveUnitInput] => [parseArchive(raw[0])],
      handle: async (input) => ok(await service.archive(input)),
    },

    delete: {
      parseArgs: (raw): [string] => [code(raw[0], 'code')],
      handle: async (unitCode) => {
        await service.delete(unitCode)
        return ok(undefined)
      },
    },
  }
}
