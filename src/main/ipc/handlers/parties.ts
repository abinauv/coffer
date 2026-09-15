/*
 * The `parties` group.
 *
 * Same contract as ./ledger.ts: these own the boundary, not the behaviour. They validate
 * the shape of what the renderer sent, call a `PartiesService`, and wrap the answer in a
 * `Result`.
 *
 * VALIDATION IS SHAPE ONLY, and the registration number is the case that shows why.
 * Whether `33AABCC1234D1ZI` is a real GSTIN is the regime's question, its answer carries
 * a sentence written for the user, and its code is `PARTY_REGISTRATION_INVALID`.
 * Collapsing that into 'INVALID_ARGUMENT' here would tell somebody who mistyped one
 * character that their input was malformed. So this file checks that it is a string, and
 * nothing more.
 *
 * WHY `create` DOES NOT DEFAULT THE ROLES. A party must be a customer, a vendor or both,
 * and the repository refuses one that is neither. Defaulting `isCustomer` to true here
 * would make a form that forgot to send the flags quietly produce customers — which is
 * exactly the sort of thing nobody notices until a vendor list is empty.
 */

import type {
  ArchivePartyInput,
  CreatePartyInput,
  ListPartiesInput,
  Party,
  PartyRole,
  PartySummary,
  UpdatePartyInput,
} from '../../../shared/dto'
import type { GroupHandlers } from '../registry'
import { ok } from '../surface'
import {
  expectBoolean,
  expectBoundedString,
  expectDecimalString,
  expectInteger,
  expectNonEmptyString,
  expectOneOf,
  expectRecord,
  optional,
} from '../validate'

/**
 * What the IPC layer needs from src/main/parties.
 *
 * One method per contract method, same names, same DTOs, no envelope.
 */
export interface PartiesService {
  list(input: ListPartiesInput): Promise<PartySummary[]>
  get(id: string): Promise<Party | null>
  create(input: CreatePartyInput): Promise<Party>
  update(input: UpdatePartyInput): Promise<Party>
  archive(input: ArchivePartyInput): Promise<Party>
  delete(id: string): Promise<void>
}

/*
 * Duplicated from `PartyRole` in shared/dto on purpose, exactly as `ACCOUNT_TYPES` is in
 * ./ledger.ts: `expectOneOf` needs the values at runtime and a type has none. Pinned to
 * the type by a test rather than by a comment.
 */
const PARTY_ROLES = ['customer', 'vendor'] as const satisfies readonly PartyRole[]

/** Long enough for a legal name with a full address in it, short enough to bound. */
const MAX_TEXT = 500

/** A payment term nobody has ever agreed, used as a ceiling rather than a rule. */
const MAX_TERMS_DAYS = 3650

const text = (value: unknown, field: string): string => expectBoundedString(value, field, MAX_TEXT)

/** An optional free-text field: absent stays absent, null clears, a string is trimmed. */
function nullableText(input: Record<string, unknown>, field: string): string | null | undefined {
  if (!(field in input)) return undefined
  if (input[field] == null) return null
  return text(input[field], field)
}

function parseList(value: unknown): ListPartiesInput {
  if (value === undefined || value === null) return {}
  const input = expectRecord(value, 'input')
  return {
    includeArchived: optional(input['includeArchived'], (v) => expectBoolean(v, 'includeArchived')),
    role: optional(input['role'], (v) => expectOneOf(v, 'role', PARTY_ROLES)),
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
): Omit<CreatePartyInput, 'name' | 'countryCode'> {
  return {
    isCustomer: optional(input['isCustomer'], (v) => expectBoolean(v, 'isCustomer')),
    isVendor: optional(input['isVendor'], (v) => expectBoolean(v, 'isVendor')),
    legalName: nullableText(input, 'legalName'),
    registrationNumber: nullableText(input, 'registrationNumber'),
    jurisdictionCode: nullableText(input, 'jurisdictionCode'),
    addressLine1: nullableText(input, 'addressLine1'),
    addressLine2: nullableText(input, 'addressLine2'),
    city: nullableText(input, 'city'),
    postalCode: nullableText(input, 'postalCode'),
    email: nullableText(input, 'email'),
    phone: nullableText(input, 'phone'),
    notes: nullableText(input, 'notes'),
    paymentTermsDays:
      'paymentTermsDays' in input
        ? input['paymentTermsDays'] == null
          ? null
          : expectInteger(input['paymentTermsDays'], 'paymentTermsDays', 0, MAX_TERMS_DAYS)
        : undefined,
    /* A credit limit is money, so it crosses as a decimal string like every other amount
     * and never as a number (CONVENTIONS §1.7). Null is no limit at all, which is a
     * different answer from '0.00'.
     *
     * B21: A BLANK BOX IS NO LIMIT, AND THIS REFUSED IT. The party dialog sends every field
     * as typed, so a customer added with the credit limit left empty arrived as '', and
     * `expectDecimalString` refused it — no party could be added without a limit, while the
     * repository's `creditLimitOf` had always read blank as null. Blank is read as null here
     * too; anything else still has to be a decimal string. */
    creditLimit:
      'creditLimit' in input
        ? input['creditLimit'] == null ||
          (typeof input['creditLimit'] === 'string' && input['creditLimit'].trim() === '')
          ? null
          : expectDecimalString(input['creditLimit'], 'creditLimit')
        : undefined,
  }
}

function parseCreate(value: unknown): CreatePartyInput {
  const input = expectRecord(value, 'input')
  return {
    ...parseOptionalFields(input),
    name: text(expectNonEmptyString(input['name'], 'name'), 'name'),
    countryCode: expectNonEmptyString(input['countryCode'], 'countryCode'),
  }
}

/**
 * A change to a party.
 *
 * `name` and `countryCode` are the two fields that may not be cleared — a party with no
 * name is not a party — so they are optional here but never nullable.
 */
function parseUpdate(value: unknown): UpdatePartyInput {
  const input = expectRecord(value, 'input')
  return {
    ...parseOptionalFields(input),
    id: expectNonEmptyString(input['id'], 'id'),
    /*
     * `'name' in input` rather than `optional`, which folds null into absent. Here the
     * two differ: absent means leave the name alone, and null is a caller asking to
     * clear it — which is not a thing a party can do without ceasing to be one. Saying
     * so beats quietly ignoring it.
     */
    name: 'name' in input ? text(expectNonEmptyString(input['name'], 'name'), 'name') : undefined,
    countryCode:
      'countryCode' in input
        ? expectNonEmptyString(input['countryCode'], 'countryCode')
        : undefined,
  }
}

function parseArchive(value: unknown): ArchivePartyInput {
  const input = expectRecord(value, 'input')
  return {
    id: expectNonEmptyString(input['id'], 'id'),
    archived: expectBoolean(input['archived'], 'archived'),
  }
}

export function createPartiesHandlers(service: PartiesService): GroupHandlers<'parties'> {
  return {
    list: {
      parseArgs: (raw): [ListPartiesInput] => [parseList(raw[0])],
      handle: async (input = {}) => ok(await service.list(input)),
    },

    get: {
      parseArgs: (raw): [string] => [expectNonEmptyString(raw[0], 'id')],
      handle: async (id) => ok(await service.get(id)),
    },

    create: {
      parseArgs: (raw): [CreatePartyInput] => [parseCreate(raw[0])],
      handle: async (input) => ok(await service.create(input)),
    },

    update: {
      parseArgs: (raw): [UpdatePartyInput] => [parseUpdate(raw[0])],
      handle: async (input) => ok(await service.update(input)),
    },

    archive: {
      parseArgs: (raw): [ArchivePartyInput] => [parseArchive(raw[0])],
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
