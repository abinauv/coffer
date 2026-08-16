/*
 * The `ledger` group.
 *
 * Same contract as ../handlers/companies.ts: these own the boundary, not the behaviour.
 * They validate what the renderer sent, call a `LedgerService`, and wrap the answer in a
 * `Result`. The service throws; `RepoError` codes reach the UI through the error mapper
 * registered in ../index.ts.
 *
 * WHAT IS NOT HERE, AND WILL NOT BE. There is no `updateEntry` and no `deleteEntry`. A
 * posted entry is immutable (invariant 3) and the database refuses both outright, so a
 * handler for either would be a channel that exists only to return an error. Corrections
 * go through `reverseEntry`.
 *
 * VALIDATION IS SHAPE ONLY. Whether an account exists, whether a period is open, whether
 * an entry balances — all of those have their own codes and their own sentences, and
 * collapsing them into 'INVALID_ARGUMENT' here would throw away everything the last four
 * migrations were written to say.
 */

import type {
  Account,
  AccountingPeriod,
  CloseFiscalYearInput,
  CreateAccountInput,
  CreateJournalEntryInput,
  DateRangeInput,
  JournalEntry,
  JournalLineInput,
  ListAccountsInput,
  ListJournalEntriesInput,
  OpeningBalanceLine,
  PostOpeningBalancesInput,
  PostingResult,
  ReverseEntryInput,
  SetAccountRoleInput,
  TrialBalance,
  UpdateAccountInput,
  YearEndCloseResult,
} from '../../../shared/dto'
import type { GroupHandlers } from '../registry'
import { ok } from '../surface'
import {
  expectArray,
  expectBoolean,
  expectDateString,
  expectDecimalString,
  expectInteger,
  expectNonEmptyString,
  expectOneOf,
  expectRecord,
  expectString,
  noArgs,
  optional,
} from '../validate'

/**
 * What the IPC layer needs from src/main/ledger.
 *
 * One method per contract method, same names, same DTOs, no envelope.
 */
export interface LedgerService {
  listAccounts(input: ListAccountsInput): Promise<Account[]>
  createAccount(input: CreateAccountInput): Promise<Account>
  updateAccount(input: UpdateAccountInput): Promise<Account>
  setAccountRole(input: SetAccountRoleInput): Promise<void>

  listPeriods(): Promise<AccountingPeriod[]>
  closePeriod(id: string): Promise<AccountingPeriod>
  reopenPeriod(id: string): Promise<AccountingPeriod>
  lockPeriod(id: string): Promise<AccountingPeriod>

  postEntry(input: CreateJournalEntryInput): Promise<PostingResult>
  reverseEntry(input: ReverseEntryInput): Promise<PostingResult>
  listEntries(input: ListJournalEntriesInput): Promise<JournalEntry[]>
  getEntry(id: string): Promise<JournalEntry | null>

  trialBalance(input: DateRangeInput): Promise<TrialBalance>
  postOpeningBalances(input: PostOpeningBalancesInput): Promise<PostingResult>
  closeFiscalYear(input: CloseFiscalYearInput): Promise<YearEndCloseResult>
}

/** Comfortably more lines than any real journal, small enough to bound the work. */
const MAX_ENTRY_LINES = 500

/** A ceiling on a page of entries. A day book screen asks for tens. */
const MAX_PAGE = 1000

/** Fiscal years Coffer will accept. Wide enough for historical books, bounded. */
const MIN_YEAR = 1900
const MAX_YEAR = 2200

/*
 * Duplicated from `ACCOUNT_TYPES` in domain/ledger on purpose. Nothing under src/main/ipc
 * imports the domain — the boundary validates the transport contract in src/shared, and
 * the domain is free to hold types the transport does not expose. The two are pinned
 * together by a test.
 */
const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const

function parseListAccounts(value: unknown): ListAccountsInput {
  if (value === undefined || value === null) return {}
  const input = expectRecord(value, 'input')
  return {
    includeArchived: optional(input['includeArchived'], (v) => expectBoolean(v, 'includeArchived')),
  }
}

function parseCreateAccount(value: unknown): CreateAccountInput {
  const input = expectRecord(value, 'input')
  return {
    code: expectNonEmptyString(input['code'], 'code'),
    name: expectNonEmptyString(input['name'], 'name'),
    type: expectOneOf(input['type'], 'type', ACCOUNT_TYPES),
    parentId:
      input['parentId'] == null ? null : expectNonEmptyString(input['parentId'], 'parentId'),
    isGroup: expectBoolean(input['isGroup'], 'isGroup'),
    description: optional(input['description'], (v) => expectString(v, 'description')) ?? null,
  }
}

/** `type` is absent by design — an account's type may not change. See the DTO. */
function parseUpdateAccount(value: unknown): UpdateAccountInput {
  const input = expectRecord(value, 'input')
  return {
    id: expectNonEmptyString(input['id'], 'id'),
    code: optional(input['code'], (v) => expectNonEmptyString(v, 'code')),
    name: optional(input['name'], (v) => expectNonEmptyString(v, 'name')),
    parentId:
      'parentId' in input
        ? input['parentId'] == null
          ? null
          : expectNonEmptyString(input['parentId'], 'parentId')
        : undefined,
    description:
      'description' in input
        ? (optional(input['description'], (v) => expectString(v, 'description')) ?? null)
        : undefined,
    isArchived: optional(input['isArchived'], (v) => expectBoolean(v, 'isArchived')),
  }
}

function parseSetAccountRole(value: unknown): SetAccountRoleInput {
  const input = expectRecord(value, 'input')
  return {
    role: expectNonEmptyString(input['role'], 'role'),
    /* Empty clears the slot, which is why this is not `expectNonEmptyString`. */
    accountId: expectString(input['accountId'], 'accountId'),
  }
}

function parseJournalLine(value: unknown, index: number): JournalLineInput {
  const line = expectRecord(value, `lines[${index}]`)
  return {
    accountId: expectNonEmptyString(line['accountId'], `lines[${index}].accountId`),
    debit: expectDecimalString(line['debit'], `lines[${index}].debit`),
    credit: expectDecimalString(line['credit'], `lines[${index}].credit`),
    narration:
      optional(line['narration'], (v) => expectString(v, `lines[${index}].narration`)) ?? null,
  }
}

function parsePostEntry(value: unknown): CreateJournalEntryInput {
  const input = expectRecord(value, 'input')
  return {
    date: expectDateString(input['date'], 'date'),
    narration: expectString(input['narration'], 'narration'),
    lines: expectArray(input['lines'], 'lines', MAX_ENTRY_LINES).map(parseJournalLine),
  }
}

function parseReverseEntry(value: unknown): ReverseEntryInput {
  const input = expectRecord(value, 'input')
  return {
    entryId: expectNonEmptyString(input['entryId'], 'entryId'),
    date: expectDateString(input['date'], 'date'),
    narration: expectString(input['narration'], 'narration'),
  }
}

function parseDateRange(value: unknown): DateRangeInput {
  if (value === undefined || value === null) return {}
  const input = expectRecord(value, 'input')
  return {
    fromDate: optional(input['fromDate'], (v) => expectDateString(v, 'fromDate')),
    toDate: optional(input['toDate'], (v) => expectDateString(v, 'toDate')),
  }
}

function parseListEntries(value: unknown): ListJournalEntriesInput {
  if (value === undefined || value === null) return {}
  const input = expectRecord(value, 'input')
  return {
    ...parseDateRange(value),
    periodId: optional(input['periodId'], (v) => expectNonEmptyString(v, 'periodId')),
    sourceType: optional(input['sourceType'], (v) => expectNonEmptyString(v, 'sourceType')),
    accountId: optional(input['accountId'], (v) => expectNonEmptyString(v, 'accountId')),
    limit: optional(input['limit'], (v) => expectInteger(v, 'limit', 1, MAX_PAGE)),
    offset: optional(input['offset'], (v) =>
      expectInteger(v, 'offset', 0, Number.MAX_SAFE_INTEGER),
    ),
  }
}

function parseOpeningBalanceLine(value: unknown, index: number): OpeningBalanceLine {
  const line = expectRecord(value, `lines[${index}]`)
  return {
    accountId: expectNonEmptyString(line['accountId'], `lines[${index}].accountId`),
    amount: expectDecimalString(line['amount'], `lines[${index}].amount`),
  }
}

function parseOpeningBalances(value: unknown): PostOpeningBalancesInput {
  const input = expectRecord(value, 'input')
  return {
    date: expectDateString(input['date'], 'date'),
    lines: expectArray(input['lines'], 'lines', MAX_ENTRY_LINES).map(parseOpeningBalanceLine),
  }
}

function parseCloseFiscalYear(value: unknown): CloseFiscalYearInput {
  const input = expectRecord(value, 'input')
  return { startYear: expectInteger(input['startYear'], 'startYear', MIN_YEAR, MAX_YEAR) }
}

export function createLedgerHandlers(service: LedgerService): GroupHandlers<'ledger'> {
  return {
    listAccounts: {
      parseArgs: (raw): [ListAccountsInput] => [parseListAccounts(raw[0])],
      /* The contract declares this argument optional, so the handler's parameter is
       * optional too — `parseArgs` has already turned a missing one into `{}`. */
      handle: async (input = {}) => ok(await service.listAccounts(input)),
    },

    createAccount: {
      parseArgs: (raw): [CreateAccountInput] => [parseCreateAccount(raw[0])],
      handle: async (input) => ok(await service.createAccount(input)),
    },

    updateAccount: {
      parseArgs: (raw): [UpdateAccountInput] => [parseUpdateAccount(raw[0])],
      handle: async (input) => ok(await service.updateAccount(input)),
    },

    setAccountRole: {
      parseArgs: (raw): [SetAccountRoleInput] => [parseSetAccountRole(raw[0])],
      handle: async (input) => {
        await service.setAccountRole(input)
        return ok(undefined)
      },
    },

    listPeriods: {
      parseArgs: noArgs,
      handle: async () => ok(await service.listPeriods()),
    },

    closePeriod: {
      parseArgs: (raw): [string] => [expectNonEmptyString(raw[0], 'id')],
      handle: async (id) => ok(await service.closePeriod(id)),
    },

    reopenPeriod: {
      parseArgs: (raw): [string] => [expectNonEmptyString(raw[0], 'id')],
      handle: async (id) => ok(await service.reopenPeriod(id)),
    },

    lockPeriod: {
      parseArgs: (raw): [string] => [expectNonEmptyString(raw[0], 'id')],
      handle: async (id) => ok(await service.lockPeriod(id)),
    },

    postEntry: {
      parseArgs: (raw): [CreateJournalEntryInput] => [parsePostEntry(raw[0])],
      handle: async (input) => ok(await service.postEntry(input)),
    },

    reverseEntry: {
      parseArgs: (raw): [ReverseEntryInput] => [parseReverseEntry(raw[0])],
      handle: async (input) => ok(await service.reverseEntry(input)),
    },

    listEntries: {
      parseArgs: (raw): [ListJournalEntriesInput] => [parseListEntries(raw[0])],
      handle: async (input = {}) => ok(await service.listEntries(input)),
    },

    getEntry: {
      parseArgs: (raw): [string] => [expectNonEmptyString(raw[0], 'id')],
      handle: async (id) => ok(await service.getEntry(id)),
    },

    trialBalance: {
      parseArgs: (raw): [DateRangeInput] => [parseDateRange(raw[0])],
      handle: async (input = {}) => ok(await service.trialBalance(input)),
    },

    postOpeningBalances: {
      parseArgs: (raw): [PostOpeningBalancesInput] => [parseOpeningBalances(raw[0])],
      handle: async (input) => ok(await service.postOpeningBalances(input)),
    },

    closeFiscalYear: {
      parseArgs: (raw): [CloseFiscalYearInput] => [parseCloseFiscalYear(raw[0])],
      handle: async (input) => ok(await service.closeFiscalYear(input)),
    },
  }
}
