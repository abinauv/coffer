/*
 * The `numbering` group.
 *
 * Same contract as ./parties.ts: the boundary, not the behaviour. Validate the shape of
 * what the renderer sent, call a `NumberingService`, wrap the answer in a `Result`.
 *
 * THE KIND IS CHECKED AGAINST THE KIND TABLES rather than against a list of strings
 * written here, exactly as ./reports.ts checks a trade side against `TRADE_SIDES`. Nine
 * kinds are numbered — the five trade documents and the four vouchers — and both tables
 * live in src/shared, so this cannot drift from what the repository will accept. A tenth
 * kind added to either table is offered here on the day it is added, and a copy of the
 * nine would be a copy nobody keeps in step (CONVENTIONS §1.9).
 *
 * IT IS A REFUSAL HERE AND NOT A PASS-THROUGH, and that is the one place this file is not
 * merely shape. `numberedKindDefinition` throws a plain `Error` for a kind it does not
 * know, because from the domain's point of view an unknown kind is a programmer error and
 * not something a user can act on — which means it reaches the renderer as an internal
 * error naming nothing. `INVALID_ARGUMENT` naming the field is strictly better, and
 * nothing is lost: there is no user-facing sentence about an unknown kind to collapse.
 *
 * A PREFIX AND A SEPARATOR ARE NOT TRIMMED, and that is deliberate rather than an
 * omission. A space is a legitimate separator and a prefix ending in one is somebody's
 * existing format; the repository stores both as they arrive, and trimming them here
 * would quietly change the number a business has been printing for years.
 *
 * There is no `allocate`. See the group in src/shared/ipc.ts for why there never will be.
 */

import { DOCUMENT_KINDS } from '../../../shared/documents'
import type {
  CreateNumberingSeriesInput,
  ListNumberingSeriesInput,
  NumberPreview,
  NumberingReset,
  NumberingSeriesRecord,
  UpdateNumberingSeriesInput,
} from '../../../shared/dto'
import type { ArchiveNumberingSeriesInput, PreviewNumberInput } from '../../../shared/ipc'
import { RECEIPT_KINDS } from '../../../shared/receipts'
import type { GroupHandlers } from '../registry'
import { ok } from '../surface'
import {
  expectBoolean,
  expectBoundedString,
  expectInteger,
  expectNonEmptyString,
  expectOneOf,
  expectRecord,
  noArgs,
  optional,
} from '../validate'

/**
 * What the IPC layer needs from src/main/numbering.
 *
 * One method per contract method, same names, same DTOs, no envelope.
 */
export interface NumberingService {
  list(input: ListNumberingSeriesInput): Promise<NumberingSeriesRecord[]>
  get(id: string): Promise<NumberingSeriesRecord | null>
  create(input: CreateNumberingSeriesInput): Promise<NumberingSeriesRecord>
  update(input: UpdateNumberingSeriesInput): Promise<NumberingSeriesRecord>
  archive(input: ArchiveNumberingSeriesInput): Promise<NumberingSeriesRecord>
  delete(id: string): Promise<void>
  preview(input: PreviewNumberInput): Promise<NumberPreview>
  seedDefaults(): Promise<number>
}

/**
 * Everything a series may be created for, derived from the two kind tables in src/shared.
 *
 * Documents first, then vouchers — the same order `NUMBERED_KINDS` in
 * main/domain/documents composes them in, which is what makes this list and the
 * repository's `requireKind` answer the same question. Pinned to that domain table by a
 * test rather than by this sentence.
 */
const NUMBERED_KINDS: readonly string[] = [
  ...DOCUMENT_KINDS.map((definition) => definition.kind),
  ...RECEIPT_KINDS.map((definition) => definition.kind),
]

/*
 * Duplicated from `NumberingReset` in shared/dto on purpose, exactly as `PARTY_ROLES` is
 * in ./parties.ts: `expectOneOf` needs the values at runtime and a type has none.
 */
const NUMBERING_RESETS = ['fiscal-year', 'never'] as const satisfies readonly NumberingReset[]

/** What a business calls one of its series — 'Main', 'Export', 'Branch — Coimbatore'. */
const MAX_LABEL = 100

/** A prefix, suffix or separator. Short by nature: all three print inside one number. */
const MAX_AFFIX = 32

/**
 * A fiscal year label, as the regime spells it — '2026-27' in India, '2026' where the
 * year is the calendar one. Bounded and otherwise unexamined: the shape is the regime's,
 * and this layer has no regime.
 */
const MAX_FISCAL_YEAR_LABEL = 32

/** Matches the CHECK in 0007 and `requireWidth` in the repository. Zero is padding off. */
const MIN_WIDTH = 0
const MAX_WIDTH = 12

const kind = (value: unknown, field: string): string => expectOneOf(value, field, NUMBERED_KINDS)

/** Not trimmed, and never trimmed. A space is a legitimate part of a number's shape. */
const affix = (value: unknown, field: string): string =>
  expectBoundedString(value, field, MAX_AFFIX)

const width = (value: unknown): number => expectInteger(value, 'width', MIN_WIDTH, MAX_WIDTH)

function parseList(value: unknown): ListNumberingSeriesInput {
  if (value === undefined || value === null) return {}
  const input = expectRecord(value, 'input')
  return {
    includeArchived: optional(input['includeArchived'], (v) => expectBoolean(v, 'includeArchived')),
    kind: optional(input['kind'], (v) => kind(v, 'kind')),
  }
}

function parseCreate(value: unknown): CreateNumberingSeriesInput {
  const input = expectRecord(value, 'input')
  return {
    kind: kind(input['kind'], 'kind'),
    label: expectBoundedString(expectNonEmptyString(input['label'], 'label'), 'label', MAX_LABEL),
    prefix: optional(input['prefix'], (v) => affix(v, 'prefix')),
    suffix: optional(input['suffix'], (v) => affix(v, 'suffix')),
    separator: optional(input['separator'], (v) => affix(v, 'separator')),
    includeFiscalYear: optional(input['includeFiscalYear'], (v) =>
      expectBoolean(v, 'includeFiscalYear'),
    ),
    width: optional(input['width'], width),
    resetOn: optional(input['resetOn'], (v) => expectOneOf(v, 'resetOn', NUMBERING_RESETS)),
    isDefault: optional(input['isDefault'], (v) => expectBoolean(v, 'isDefault')),
  }
}

/**
 * A change to a series.
 *
 * No `kind`, and there is no version of this that takes one: moving a series to another
 * kind would renumber the documents already issued under it. `UpdateNumberingSeriesInput`
 * has no such field and 0007's trigger names the column anyway.
 *
 * The shape fields are all still parsed, because a settings screen posts the whole record
 * back and re-sending the prefix a series already has is not a change to it. Whether a
 * change to one is allowed at all is the repository's answer — `SERIES_IN_USE`, a
 * sentence naming the series — and collapsing it into 'INVALID_ARGUMENT' here would tell
 * somebody their input was malformed when it was merely too late.
 */
function parseUpdate(value: unknown): UpdateNumberingSeriesInput {
  const input = expectRecord(value, 'input')
  return {
    id: expectNonEmptyString(input['id'], 'id'),
    label:
      'label' in input
        ? expectBoundedString(expectNonEmptyString(input['label'], 'label'), 'label', MAX_LABEL)
        : undefined,
    prefix: optional(input['prefix'], (v) => affix(v, 'prefix')),
    suffix: optional(input['suffix'], (v) => affix(v, 'suffix')),
    separator: optional(input['separator'], (v) => affix(v, 'separator')),
    includeFiscalYear: optional(input['includeFiscalYear'], (v) =>
      expectBoolean(v, 'includeFiscalYear'),
    ),
    width: optional(input['width'], width),
    resetOn: optional(input['resetOn'], (v) => expectOneOf(v, 'resetOn', NUMBERING_RESETS)),
    isDefault: optional(input['isDefault'], (v) => expectBoolean(v, 'isDefault')),
    isArchived: optional(input['isArchived'], (v) => expectBoolean(v, 'isArchived')),
  }
}

function parseArchive(value: unknown): ArchiveNumberingSeriesInput {
  const input = expectRecord(value, 'input')
  return {
    id: expectNonEmptyString(input['id'], 'id'),
    archived: expectBoolean(input['archived'], 'archived'),
  }
}

/**
 * What to preview, and in which year.
 *
 * `fiscalYearLabel` IS REQUIRED TO BE PRESENT AND MAY BE NULL, which is not the same as
 * optional — so the null is tested for explicitly rather than with `optional`, which
 * folds the two together. Null is a real answer, meaning this document is in no fiscal
 * year, and a series that prints the year or resets on it refuses it with
 * `FISCAL_YEAR_REQUIRED`: a sentence saying which series and why. An absent field is a
 * screen that forgot to send the year, and letting it through as the same null would
 * preview a number that collides with last year's — precisely what including the year
 * exists to prevent.
 */
function parsePreview(value: unknown): PreviewNumberInput {
  const input = expectRecord(value, 'input')
  const label = input['fiscalYearLabel']
  return {
    seriesId: expectNonEmptyString(input['seriesId'], 'seriesId'),
    fiscalYearLabel:
      label === null
        ? null
        : expectBoundedString(
            expectNonEmptyString(label, 'fiscalYearLabel'),
            'fiscalYearLabel',
            MAX_FISCAL_YEAR_LABEL,
          ),
  }
}

export function createNumberingHandlers(service: NumberingService): GroupHandlers<'numbering'> {
  return {
    list: {
      parseArgs: (raw): [ListNumberingSeriesInput] => [parseList(raw[0])],
      handle: async (input = {}) => ok(await service.list(input)),
    },

    get: {
      parseArgs: (raw): [string] => [expectNonEmptyString(raw[0], 'id')],
      handle: async (id) => ok(await service.get(id)),
    },

    create: {
      parseArgs: (raw): [CreateNumberingSeriesInput] => [parseCreate(raw[0])],
      handle: async (input) => ok(await service.create(input)),
    },

    update: {
      parseArgs: (raw): [UpdateNumberingSeriesInput] => [parseUpdate(raw[0])],
      handle: async (input) => ok(await service.update(input)),
    },

    archive: {
      parseArgs: (raw): [ArchiveNumberingSeriesInput] => [parseArchive(raw[0])],
      handle: async (input) => ok(await service.archive(input)),
    },

    delete: {
      parseArgs: (raw): [string] => [expectNonEmptyString(raw[0], 'id')],
      handle: async (id) => {
        await service.delete(id)
        return ok(undefined)
      },
    },

    preview: {
      parseArgs: (raw): [PreviewNumberInput] => [parsePreview(raw[0])],
      handle: async (input) => ok(await service.preview(input)),
    },

    /* Takes nothing, and anything the renderer sent is ignored — there is nothing for a
     * caller to get wrong, which is the point of a repair. */
    seedDefaults: {
      parseArgs: noArgs,
      handle: async () => ok(await service.seedDefaults()),
    },
  }
}
