/*
 * The `documents` group.
 *
 * Same contract as ./parties.ts: the boundary, not the behaviour. Validate the shape of
 * what the renderer sent, call a `DocumentsService`, wrap the answer in a `Result`.
 *
 * WHAT A LINE MAY NOT CARRY IS THE POINT OF THIS FILE. There is no `taxableAmount` and
 * no `taxes` in the parse, because there is none in `DocumentLineInput` — the renderer
 * never computes money (CONVENTIONS §1.7) and the tax is the regime's answer, asked once
 * by the service with both sides of the supply in hand. A renderer that sent either would
 * have them dropped here rather than believed, which is the behaviour to keep: an amount
 * arriving from an untrusted process must never be the amount that reaches the books.
 *
 * `ratePct` IS accepted, and is not the same kind of thing. It is the slab the user chose
 * for the line — an input to the tax, not the tax.
 *
 * VALIDATION IS SHAPE ONLY. Whether a kind can be issued, whether the party exists,
 * whether the period is open — all of those are answers with their own codes and their
 * own sentences, and collapsing them into `INVALID_ARGUMENT` would tell a user with a
 * closed period that their input was malformed.
 */

import type {
  CancelDocumentInput,
  CreateDocumentInput,
  Document,
  DocumentLineInput,
  DocumentListRow,
  DocumentSettlement,
  DocumentStatusDto,
  IssueDocumentInput,
  ListDocumentsInput,
  OffsetInput,
  OpenDocument,
  SetOffsetsInput,
  UpdateDocumentInput,
} from '../../../shared/dto'
import type { GroupHandlers } from '../registry'
import { ok } from '../surface'
import {
  expectArray,
  expectBoolean,
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
 * What the IPC layer needs from src/main/documents.
 *
 * One method per contract method, same names, same DTOs, no envelope.
 */
export interface DocumentsService {
  list(input: ListDocumentsInput): Promise<DocumentListRow[]>
  get(id: string): Promise<Document | null>
  create(input: CreateDocumentInput): Promise<Document>
  update(input: UpdateDocumentInput): Promise<Document>
  delete(id: string): Promise<void>
  issue(input: IssueDocumentInput): Promise<Document>
  cancel(input: CancelDocumentInput): Promise<Document>
  settlement(documentId: string): Promise<DocumentSettlement>
  offset(input: SetOffsetsInput): Promise<DocumentSettlement>
  openForOffset(documentId: string): Promise<OpenDocument[]>
}

/*
 * Duplicated from `DocumentStatusDto` in shared/dto on purpose, exactly as `PARTY_ROLES`
 * is in ./parties.ts: `expectOneOf` needs the values at runtime and a type has none.
 * Pinned to the type by a test rather than by a comment.
 */
const DOCUMENT_STATUSES = [
  'draft',
  'issued',
  'cancelled',
] as const satisfies readonly DocumentStatusDto[]

/**
 * The same ceiling `receipts.allocate` puts on a set of allocations, for the same reason:
 * a bound that a real save cannot reach and a malicious one cannot get past.
 */
const MAX_OFFSETS = 500

/** A description with a full specification in it, and no more. */
const MAX_TEXT = 500

/** A narration is the sentence the day book carries, and can be a little longer. */
const MAX_NARRATION = 1000

/**
 * More lines than any real document, and few enough that a hostile renderer cannot make
 * main parse its way to death. A fifty-line invoice is a big one.
 */
const MAX_LINES = 500

/** A page of a register. The repository caps it again; this stops the allocation. */
const MAX_PAGE = 500

const text = (value: unknown, field: string): string => expectBoundedString(value, field, MAX_TEXT)

/** An optional free-text field: absent stays absent, null clears, a string is kept. */
function nullableText(input: Record<string, unknown>, field: string): string | null | undefined {
  if (!(field in input)) return undefined
  if (input[field] == null) return null
  return text(input[field], field)
}

function parseLine(value: unknown, index: number): DocumentLineInput {
  const input = expectRecord(value, `lines[${String(index)}]`)
  const at = (field: string) => `lines[${String(index)}].${field}`

  return {
    description: text(
      expectNonEmptyString(input['description'], at('description')),
      at('description'),
    ),
    quantity: expectDecimalString(input['quantity'], at('quantity')),
    unitPrice: expectDecimalString(input['unitPrice'], at('unitPrice')),
    discount: optional(input['discount'], (v) => expectDecimalString(v, at('discount'))),
    ratePct: optional(input['ratePct'], (v) => expectDecimalString(v, at('ratePct'))),
    itemId: optional(input['itemId'], (v) => expectNonEmptyString(v, at('itemId'))),
    unitCode: optional(input['unitCode'], (v) => expectNonEmptyString(v, at('unitCode'))),
    classificationCode: optional(input['classificationCode'], (v) =>
      expectNonEmptyString(v, at('classificationCode')),
    ),
    isCharge: optional(input['isCharge'], (v) => expectBoolean(v, at('isCharge'))),
    accountId: optional(input['accountId'], (v) => expectNonEmptyString(v, at('accountId'))),
  }
}

function parseLines(value: unknown): readonly DocumentLineInput[] | undefined {
  if (value === undefined || value === null) return undefined
  return expectArray(value, 'lines', MAX_LINES).map(parseLine)
}

function parseList(value: unknown): ListDocumentsInput {
  if (value === undefined || value === null) return {}
  const input = expectRecord(value, 'input')
  return {
    kind: optional(input['kind'], (v) => expectNonEmptyString(v, 'kind')),
    status: optional(input['status'], (v) => expectOneOf(v, 'status', DOCUMENT_STATUSES)),
    partyId: optional(input['partyId'], (v) => expectNonEmptyString(v, 'partyId')),
    fromDate: optional(input['fromDate'], (v) => expectDateString(v, 'fromDate')),
    toDate: optional(input['toDate'], (v) => expectDateString(v, 'toDate')),
    search: optional(input['search'], (v) => text(v, 'search')),
    limit: optional(input['limit'], (v) => expectInteger(v, 'limit', 1, MAX_PAGE)),
    offset: optional(input['offset'], (v) =>
      expectInteger(v, 'offset', 0, Number.MAX_SAFE_INTEGER),
    ),
  }
}

/** The fields a create and an update share, and treat identically. */
function parseShared(input: Record<string, unknown>) {
  return {
    partyReference: nullableText(input, 'partyReference'),
    /* An id, so `nullableText` rather than anything that trims it into meaning: an
     * unrecognisable one is refused by the foreign key and a wrong one by 0013's trigger,
     * both of which know things this boundary does not. What this checks is that it is a
     * string, which is the only question a parser can answer. */
    originalDocumentId: nullableText(input, 'originalDocumentId'),
    placeOfSupplyJurisdiction: nullableText(input, 'placeOfSupplyJurisdiction'),
    placeOfSupplyCountry: optional(input['placeOfSupplyCountry'], (v) =>
      expectNonEmptyString(v, 'placeOfSupplyCountry'),
    ),
    roundingPolicy: optional(input['roundingPolicy'], (v) =>
      expectOneOf(v, 'roundingPolicy', ['whole-unit', 'none'] as const),
    ),
    narration: optional(input['narration'], (v) =>
      expectBoundedString(v, 'narration', MAX_NARRATION),
    ),
    lines: parseLines(input['lines']),
  }
}

function parseCreate(value: unknown): CreateDocumentInput {
  const input = expectRecord(value, 'input')
  return {
    ...parseShared(input),
    kind: expectNonEmptyString(input['kind'], 'kind'),
    date: expectDateString(input['date'], 'date'),
    partyId: expectNonEmptyString(input['partyId'], 'partyId'),
  }
}

function parseUpdate(value: unknown): UpdateDocumentInput {
  const input = expectRecord(value, 'input')
  return {
    ...parseShared(input),
    id: expectNonEmptyString(input['id'], 'id'),
    date: optional(input['date'], (v) => expectDateString(v, 'date')),
    partyId: optional(input['partyId'], (v) => expectNonEmptyString(v, 'partyId')),
  }
}

function parseIssue(value: unknown): IssueDocumentInput {
  const input = expectRecord(value, 'input')
  return {
    id: expectNonEmptyString(input['id'], 'id'),
    seriesId: optional(input['seriesId'], (v) => expectNonEmptyString(v, 'seriesId')),
  }
}

function parseCancel(value: unknown): CancelDocumentInput {
  const input = expectRecord(value, 'input')
  return {
    id: expectNonEmptyString(input['id'], 'id'),
    date: optional(input['date'], (v) => expectDateString(v, 'date')),
    narration: optional(input['narration'], (v) =>
      expectBoundedString(v, 'narration', MAX_NARRATION),
    ),
  }
}

function parseOffset(value: unknown, index: number): OffsetInput {
  const input = expectRecord(value, `offsets[${String(index)}]`)
  const at = (field: string) => `offsets[${String(index)}].${field}`

  return {
    chargeDocumentId: expectNonEmptyString(input['chargeDocumentId'], at('chargeDocumentId')),
    amount: expectDecimalString(input['amount'], at('amount')),
  }
}

function parseSetOffsets(value: unknown): SetOffsetsInput {
  const input = expectRecord(value, 'input')
  return {
    refundDocumentId: expectNonEmptyString(input['refundDocumentId'], 'refundDocumentId'),
    /* Required, not optional, and an empty array is the way to clear the set. `undefined`
     * would be a third meaning nobody needs: the panel always holds the whole list. */
    offsets: expectArray(input['offsets'], 'offsets', MAX_OFFSETS).map(parseOffset),
  }
}

export function createDocumentsHandlers(service: DocumentsService): GroupHandlers<'documents'> {
  return {
    list: {
      parseArgs: (raw): [ListDocumentsInput] => [parseList(raw[0])],
      handle: async (input = {}) => ok(await service.list(input)),
    },

    get: {
      parseArgs: (raw): [string] => [expectNonEmptyString(raw[0], 'id')],
      handle: async (id) => ok(await service.get(id)),
    },

    create: {
      parseArgs: (raw): [CreateDocumentInput] => [parseCreate(raw[0])],
      handle: async (input) => ok(await service.create(input)),
    },

    update: {
      parseArgs: (raw): [UpdateDocumentInput] => [parseUpdate(raw[0])],
      handle: async (input) => ok(await service.update(input)),
    },

    delete: {
      parseArgs: (raw): [string] => [expectNonEmptyString(raw[0], 'id')],
      handle: async (id) => {
        await service.delete(id)
        return ok(undefined)
      },
    },

    issue: {
      parseArgs: (raw): [IssueDocumentInput] => [parseIssue(raw[0])],
      handle: async (input) => ok(await service.issue(input)),
    },

    cancel: {
      parseArgs: (raw): [CancelDocumentInput] => [parseCancel(raw[0])],
      handle: async (input) => ok(await service.cancel(input)),
    },

    settlement: {
      parseArgs: (raw): [string] => [expectNonEmptyString(raw[0], 'documentId')],
      handle: async (documentId) => ok(await service.settlement(documentId)),
    },

    offset: {
      parseArgs: (raw): [SetOffsetsInput] => [parseSetOffsets(raw[0])],
      handle: async (input) => ok(await service.offset(input)),
    },

    openForOffset: {
      parseArgs: (raw): [string] => [expectNonEmptyString(raw[0], 'documentId')],
      handle: async (documentId) => ok(await service.openForOffset(documentId)),
    },
  }
}
