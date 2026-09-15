/*
 * The `receipts` group.
 *
 * The boundary, not the behaviour — same contract as ./documents.ts. Validate the shape
 * of what the renderer sent, call a `ReceiptsService`, wrap the answer in a `Result`.
 *
 * THE AMOUNTS ARE ACCEPTED HERE AND THAT IS NOT THE SAME MISTAKE `documents` REFUSES.
 * A document line's `taxableAmount` is dropped at this boundary because it is the tax —
 * an ANSWER the regime gives, which an untrusted process must never supply. A receipt's
 * amount is what the user typed off a bank statement: it is an input, and there is
 * nothing to derive it from. So it crosses, and every rule about it — positive, at money
 * scale, no more allocated than arrived — is enforced below, where the figures it has to
 * agree with actually are.
 *
 * VALIDATION IS SHAPE ONLY. Whether the party exists, whether the period is open,
 * whether an invoice has that much left on it — all of those have their own codes and
 * their own sentences, and collapsing them into `INVALID_ARGUMENT` would tell a user
 * with a closed month that their input was malformed.
 */

import type {
  AllocateReceiptInput,
  AllocationInput,
  CancelReceiptInput,
  CountReceiptsInput,
  CreateReceiptInput,
  ListReceiptsInput,
  OpenDocument,
  OpenDocumentsInput,
  Receipt,
  ReceiptStatusDto,
  ReceiptSummary,
} from '../../../shared/dto'
import type { GroupHandlers } from '../registry'
import { ok } from '../surface'
import {
  expectArray,
  expectBoundedString,
  expectDateString,
  expectDecimalString,
  expectInteger,
  expectNonEmptyString,
  expectOneOf,
  expectRecord,
  optional,
} from '../validate'

/**
 * What the IPC layer needs from src/main/receipts.
 *
 * One method per contract method, same names, same DTOs, no envelope.
 */
export interface ReceiptsService {
  list(input: ListReceiptsInput): Promise<ReceiptSummary[]>
  count(input: CountReceiptsInput): Promise<number>
  get(id: string): Promise<Receipt | null>
  create(input: CreateReceiptInput): Promise<Receipt>
  allocate(input: AllocateReceiptInput): Promise<Receipt>
  cancel(input: CancelReceiptInput): Promise<Receipt>
  open(input: OpenDocumentsInput): Promise<OpenDocument[]>
}

/*
 * Duplicated from `ReceiptStatusDto` on purpose, exactly as `DOCUMENT_STATUSES` is in
 * ./documents.ts: `expectOneOf` needs the values at runtime and a type has none. Pinned
 * to the type by `satisfies` and by a test rather than by a comment.
 */
const RECEIPT_STATUSES = ['posted', 'cancelled'] as const satisfies readonly ReceiptStatusDto[]

/** A cheque number or a UTR. Somebody else's format, so only a length is checked. */
const MAX_REFERENCE = 200

/** A narration is the sentence the day book carries. Same bound as a document's. */
const MAX_NARRATION = 1000

/** A search term, bounded so a hostile renderer cannot make main build a huge LIKE. */
const MAX_SEARCH = 500

/** A page of a register. The repository caps it again; this stops the allocation. */
const MAX_PAGE = 500

/**
 * More lines than any real receipt.
 *
 * A payment covering fifty of a supplier's bills at once is a big one and is ordinary;
 * five hundred is somebody's script, and parsing it is work main does before it can
 * refuse it.
 */
const MAX_ALLOCATIONS = 500

function parseAllocation(value: unknown, index: number): AllocationInput {
  const input = expectRecord(value, `allocations[${String(index)}]`)
  const at = (field: string) => `allocations[${String(index)}].${field}`

  return {
    documentId: expectNonEmptyString(input['documentId'], at('documentId')),
    amount: expectDecimalString(input['amount'], at('amount')),
  }
}

function parseAllocations(value: unknown): readonly AllocationInput[] | undefined {
  if (value === undefined || value === null) return undefined
  return expectArray(value, 'allocations', MAX_ALLOCATIONS).map(parseAllocation)
}

/** What a register filters by. The list and the count read the same fields the same way. */
function parseFilter(value: unknown): CountReceiptsInput {
  if (value === undefined || value === null) return {}
  const input = expectRecord(value, 'input')
  return {
    kind: optional(input['kind'], (v) => expectNonEmptyString(v, 'kind')),
    status: optional(input['status'], (v) => expectOneOf(v, 'status', RECEIPT_STATUSES)),
    partyId: optional(input['partyId'], (v) => expectNonEmptyString(v, 'partyId')),
    fromDate: optional(input['fromDate'], (v) => expectDateString(v, 'fromDate')),
    toDate: optional(input['toDate'], (v) => expectDateString(v, 'toDate')),
    search: optional(input['search'], (v) => expectBoundedString(v, 'search', MAX_SEARCH)),
  }
}

function parseList(value: unknown): ListReceiptsInput {
  if (value === undefined || value === null) return {}
  const input = expectRecord(value, 'input')
  return {
    ...parseFilter(input),
    limit: optional(input['limit'], (v) => expectInteger(v, 'limit', 1, MAX_PAGE)),
    offset: optional(input['offset'], (v) =>
      expectInteger(v, 'offset', 0, Number.MAX_SAFE_INTEGER),
    ),
  }
}

function parseCreate(value: unknown): CreateReceiptInput {
  const input = expectRecord(value, 'input')
  return {
    kind: expectNonEmptyString(input['kind'], 'kind'),
    date: expectDateString(input['date'], 'date'),
    partyId: expectNonEmptyString(input['partyId'], 'partyId'),
    amount: expectDecimalString(input['amount'], 'amount'),
    accountId: expectNonEmptyString(input['accountId'], 'accountId'),
    reference: optional(input['reference'], (v) =>
      expectBoundedString(v, 'reference', MAX_REFERENCE),
    ),
    narration: optional(input['narration'], (v) =>
      expectBoundedString(v, 'narration', MAX_NARRATION),
    ),
    seriesId: optional(input['seriesId'], (v) => expectNonEmptyString(v, 'seriesId')),
    allocations: parseAllocations(input['allocations']),
  }
}

/*
 * `allocations` is REQUIRED here where it is optional on a create, and the difference is
 * the whole meaning of the call. A create with none is a receipt nobody has matched yet;
 * an allocate with none is "un-match everything", which somebody chose. Defaulting an
 * absent list to `[]` would make a malformed payload silently un-allocate a receipt.
 */
function parseAllocate(value: unknown): AllocateReceiptInput {
  const input = expectRecord(value, 'input')
  return {
    id: expectNonEmptyString(input['id'], 'id'),
    allocations: expectArray(input['allocations'], 'allocations', MAX_ALLOCATIONS).map(
      parseAllocation,
    ),
  }
}

function parseCancel(value: unknown): CancelReceiptInput {
  const input = expectRecord(value, 'input')
  return {
    id: expectNonEmptyString(input['id'], 'id'),
    date: optional(input['date'], (v) => expectDateString(v, 'date')),
    narration: optional(input['narration'], (v) =>
      expectBoundedString(v, 'narration', MAX_NARRATION),
    ),
  }
}

function parseOpen(value: unknown): OpenDocumentsInput {
  const input = expectRecord(value, 'input')
  return {
    partyId: expectNonEmptyString(input['partyId'], 'partyId'),
    kind: expectNonEmptyString(input['kind'], 'kind'),
    exceptReceiptId: optional(input['exceptReceiptId'], (v) =>
      expectNonEmptyString(v, 'exceptReceiptId'),
    ),
  }
}

export function createReceiptsHandlers(service: ReceiptsService): GroupHandlers<'receipts'> {
  return {
    list: {
      parseArgs: (raw): [ListReceiptsInput] => [parseList(raw[0])],
      handle: async (input = {}) => ok(await service.list(input)),
    },

    count: {
      parseArgs: (raw): [CountReceiptsInput] => [parseFilter(raw[0])],
      handle: async (input = {}) => ok(await service.count(input)),
    },

    get: {
      parseArgs: (raw): [string] => [expectNonEmptyString(raw[0], 'id')],
      handle: async (id) => ok(await service.get(id)),
    },

    create: {
      parseArgs: (raw): [CreateReceiptInput] => [parseCreate(raw[0])],
      handle: async (input) => ok(await service.create(input)),
    },

    allocate: {
      parseArgs: (raw): [AllocateReceiptInput] => [parseAllocate(raw[0])],
      handle: async (input) => ok(await service.allocate(input)),
    },

    cancel: {
      parseArgs: (raw): [CancelReceiptInput] => [parseCancel(raw[0])],
      handle: async (input) => ok(await service.cancel(input)),
    },

    open: {
      parseArgs: (raw): [OpenDocumentsInput] => [parseOpen(raw[0])],
      handle: async (input) => ok(await service.open(input)),
    },
  }
}
