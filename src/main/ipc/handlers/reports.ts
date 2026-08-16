/*
 * The `reports` group.
 *
 * Every method here reads and nothing writes, which is the whole reason it is not part
 * of `ledger`. The boundary's job is unchanged: validate the shape of what the renderer
 * sent, call the service, wrap the answer in a `Result`.
 *
 * DATES ARE VALIDATED AS DATES, and that is not ceremony. A range is two strings that go
 * straight into a SQL comparison against `entry_date`, which is text — so `'2026-4-1'`
 * would compare as less than `'2026-04-01'` and quietly return a different set of
 * entries rather than failing. `expectDateString` is what keeps a malformed date a
 * refusal instead of a wrong report.
 */

import type {
  AccountLedger,
  AccountLedgerInput,
  AsAtDateInput,
  BalanceSheet,
  DateRangeInput,
  DayBook,
  ProfitAndLoss,
} from '../../../shared/dto'
import type { GroupHandlers } from '../registry'
import { ok } from '../surface'
import { expectDateString, expectNonEmptyString, expectRecord, optional } from '../validate'

/**
 * What the IPC layer needs from the reporting side of src/main/ledger.
 *
 * One method per contract method, same names, same DTOs, no envelope.
 */
export interface ReportService {
  balanceSheet(input: AsAtDateInput): Promise<BalanceSheet>
  profitAndLoss(input: DateRangeInput): Promise<ProfitAndLoss>
  accountLedger(input: AccountLedgerInput): Promise<AccountLedger>
  dayBook(input: DateRangeInput): Promise<DayBook>
}

function parseDateRange(value: unknown): DateRangeInput {
  if (value === undefined || value === null) return {}
  const input = expectRecord(value, 'input')
  return {
    fromDate: optional(input['fromDate'], (v) => expectDateString(v, 'fromDate')),
    toDate: optional(input['toDate'], (v) => expectDateString(v, 'toDate')),
  }
}

/** Required, unlike a range's ends: a balance sheet with no date is not a balance sheet. */
function parseAsAt(value: unknown): AsAtDateInput {
  const input = expectRecord(value, 'input')
  return { asAtDate: expectDateString(input['asAtDate'], 'asAtDate') }
}

function parseAccountLedger(value: unknown): AccountLedgerInput {
  const input = expectRecord(value, 'input')
  return {
    accountId: expectNonEmptyString(input['accountId'], 'accountId'),
    fromDate: optional(input['fromDate'], (v) => expectDateString(v, 'fromDate')),
    toDate: optional(input['toDate'], (v) => expectDateString(v, 'toDate')),
  }
}

export function createReportHandlers(service: ReportService): GroupHandlers<'reports'> {
  return {
    balanceSheet: {
      parseArgs: (raw): [AsAtDateInput] => [parseAsAt(raw[0])],
      handle: async (input) => ok(await service.balanceSheet(input)),
    },

    profitAndLoss: {
      parseArgs: (raw): [DateRangeInput] => [parseDateRange(raw[0])],
      /* The contract declares the argument optional, so the parameter is too —
       * `parseArgs` has already turned a missing one into `{}`. */
      handle: async (input = {}) => ok(await service.profitAndLoss(input)),
    },

    accountLedger: {
      parseArgs: (raw): [AccountLedgerInput] => [parseAccountLedger(raw[0])],
      handle: async (input) => ok(await service.accountLedger(input)),
    },

    dayBook: {
      parseArgs: (raw): [DateRangeInput] => [parseDateRange(raw[0])],
      handle: async (input = {}) => ok(await service.dayBook(input)),
    },
  }
}
