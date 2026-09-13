/*
 * The `items` group.
 *
 * Same contract as ./parties.ts: these own the boundary, not the behaviour. They validate
 * the shape of what the renderer sent, call an `ItemsService`, and wrap the answer in a
 * `Result`.
 *
 * VALIDATION IS SHAPE ONLY, and the classification code is the case that shows why.
 * Whether `847130` is a real HSN is the regime's question, its answer carries a sentence
 * written for the user, and its code is `ITEM_CLASSIFICATION_INVALID`. Collapsing that
 * into 'INVALID_ARGUMENT' here would tell somebody who typed five digits instead of six
 * that their input was malformed, when the regime is ready to tell them exactly which
 * lengths a code may have. So this file checks that it is a string, and nothing more.
 *
 * WHY `create` DOES NOT DEFAULT THE SIDES. An item is sold, purchased, or both, and the
 * repository refuses one that is neither. Defaulting `isSold` to true here would make a
 * form that forgot the flags quietly produce sellable items — which is the sort of thing
 * nobody notices until a purchase picker is empty. Exactly the parties reasoning, one
 * table over.
 *
 * MONEY CROSSES AS TEXT OR NOT AT ALL (CONVENTIONS §1.1), and there are three such fields
 * here: a sale price, a purchase price and a tax RATE. The rate is not money and is
 * checked the same way for a different reason — India's 0.25% slab halves to 0.125%, so a
 * rate arriving as a JS number is a rate that can already be wrong in its third place.
 */

import type {
  ArchiveItemInput,
  CreateItemInput,
  Item,
  ItemKind,
  ItemSide,
  ItemSummary,
  ListItemsInput,
  UpdateItemInput,
} from '../../../shared/dto'
import type { GroupHandlers } from '../registry'
import { ok } from '../surface'
import {
  expectBoolean,
  expectBoundedString,
  expectDecimalString,
  expectNonEmptyString,
  expectOneOf,
  expectRecord,
  optional,
} from '../validate'

/**
 * What the IPC layer needs from src/main/items.
 *
 * One method per contract method, same names, same DTOs, no envelope.
 */
export interface ItemsService {
  list(input: ListItemsInput): Promise<ItemSummary[]>
  get(id: string): Promise<Item | null>
  create(input: CreateItemInput): Promise<Item>
  update(input: UpdateItemInput): Promise<Item>
  archive(input: ArchiveItemInput): Promise<Item>
  delete(id: string): Promise<void>
}

/*
 * Duplicated from `ItemKind` and `ItemSide` in shared/dto on purpose, exactly as
 * `PARTY_ROLES` is in ./parties.ts: `expectOneOf` needs the values at runtime and a type
 * has none. Pinned to the types by a test rather than by a comment.
 */
const ITEM_KINDS = ['goods', 'service'] as const satisfies readonly ItemKind[]
const ITEM_SIDES = ['sold', 'purchased'] as const satisfies readonly ItemSide[]

/** Long enough for a product name with a full specification in it, short enough to bound. */
const MAX_TEXT = 500

const text = (value: unknown, field: string): string => expectBoundedString(value, field, MAX_TEXT)

/** An optional free-text field: absent stays absent, null clears, a string is kept. */
function nullableText(input: Record<string, unknown>, field: string): string | null | undefined {
  if (!(field in input)) return undefined
  if (input[field] == null) return null
  return text(input[field], field)
}

/**
 * An optional decimal field: absent stays absent, null clears, a string is checked.
 *
 * Null and '0.00' are different answers and both are meaningful — nothing standard has
 * been agreed, versus agreed at nothing, which is a sample or a warranty replacement. The
 * repository keeps them apart and this must not fold them together on the way past.
 */
function nullableDecimal(input: Record<string, unknown>, field: string): string | null | undefined {
  if (!(field in input)) return undefined
  if (input[field] == null) return null
  return expectDecimalString(input[field], field)
}

function parseList(value: unknown): ListItemsInput {
  if (value === undefined || value === null) return {}
  const input = expectRecord(value, 'input')
  return {
    includeArchived: optional(input['includeArchived'], (v) => expectBoolean(v, 'includeArchived')),
    side: optional(input['side'], (v) => expectOneOf(v, 'side', ITEM_SIDES)),
    kind: optional(input['kind'], (v) => expectOneOf(v, 'kind', ITEM_KINDS)),
    search: optional(input['search'], (v) => text(v, 'search')),
  }
}

/**
 * The fields create and update share, and treat identically.
 *
 * All optional on both. On create, absent simply means the column stays null; on update,
 * absent means "leave it" and `null` means "clear it" — one parse serves both because
 * `undefined` and `null` already carry that distinction all the way down to the
 * repository.
 */
function parseOptionalFields(
  input: Record<string, unknown>,
): Omit<CreateItemInput, 'name' | 'kind'> {
  return {
    code: nullableText(input, 'code'),
    description: nullableText(input, 'description'),
    unitCode: nullableText(input, 'unitCode'),
    classificationCode: nullableText(input, 'classificationCode'),
    taxRatePct: nullableDecimal(input, 'taxRatePct'),
    salePrice: nullableDecimal(input, 'salePrice'),
    purchasePrice: nullableDecimal(input, 'purchasePrice'),
    isSold: optional(input['isSold'], (v) => expectBoolean(v, 'isSold')),
    isPurchased: optional(input['isPurchased'], (v) => expectBoolean(v, 'isPurchased')),
    isCharge: optional(input['isCharge'], (v) => expectBoolean(v, 'isCharge')),
    salesAccountId: nullableText(input, 'salesAccountId'),
    purchaseAccountId: nullableText(input, 'purchaseAccountId'),
    /* 0017's pair. Shape only, as everywhere here: whether a SERVICE may keep a balance
     * and whether a register with movements against it may be switched off are the
     * repository's questions, and both have sentences already written. */
    isStockTracked: optional(input['isStockTracked'], (v) => expectBoolean(v, 'isStockTracked')),
    reorderLevel: nullableDecimal(input, 'reorderLevel'),
  }
}

function parseCreate(value: unknown): CreateItemInput {
  const input = expectRecord(value, 'input')
  return {
    ...parseOptionalFields(input),
    name: text(expectNonEmptyString(input['name'], 'name'), 'name'),
    kind: expectOneOf(input['kind'], 'kind', ITEM_KINDS),
  }
}

/**
 * A change to an item.
 *
 * `name` and `kind` are the two fields that may not be cleared — an item with no name is
 * not an item, and a thing that is neither goods nor a service classifies as nothing — so
 * they are optional here but never nullable.
 */
function parseUpdate(value: unknown): UpdateItemInput {
  const input = expectRecord(value, 'input')
  return {
    ...parseOptionalFields(input),
    id: expectNonEmptyString(input['id'], 'id'),
    /*
     * `'name' in input` rather than `optional`, which folds null into absent. Here the
     * two differ: absent means leave the name alone, and null is a caller asking to clear
     * it — which is not a thing an item can do without ceasing to be one. Saying so beats
     * quietly ignoring it.
     */
    name: 'name' in input ? text(expectNonEmptyString(input['name'], 'name'), 'name') : undefined,
    kind: 'kind' in input ? expectOneOf(input['kind'], 'kind', ITEM_KINDS) : undefined,
  }
}

function parseArchive(value: unknown): ArchiveItemInput {
  const input = expectRecord(value, 'input')
  return {
    id: expectNonEmptyString(input['id'], 'id'),
    archived: expectBoolean(input['archived'], 'archived'),
  }
}

export function createItemsHandlers(service: ItemsService): GroupHandlers<'items'> {
  return {
    list: {
      parseArgs: (raw): [ListItemsInput] => [parseList(raw[0])],
      handle: async (input = {}) => ok(await service.list(input)),
    },

    get: {
      parseArgs: (raw): [string] => [expectNonEmptyString(raw[0], 'id')],
      handle: async (id) => ok(await service.get(id)),
    },

    create: {
      parseArgs: (raw): [CreateItemInput] => [parseCreate(raw[0])],
      handle: async (input) => ok(await service.create(input)),
    },

    update: {
      parseArgs: (raw): [UpdateItemInput] => [parseUpdate(raw[0])],
      handle: async (input) => ok(await service.update(input)),
    },

    archive: {
      parseArgs: (raw): [ArchiveItemInput] => [parseArchive(raw[0])],
      handle: async (input) => ok(await service.archive(input)),
    },

    delete: {
      parseArgs: (raw): [string] => [expectNonEmptyString(raw[0], 'id')],
      handle: async (id) => {
        await service.delete(id)
        return ok(undefined)
      },
    },
  }
}
