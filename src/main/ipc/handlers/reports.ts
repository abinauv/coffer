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

import { TRADE_SIDES } from '../../../shared/documents'
import type {
  AccountLedger,
  AccountLedgerInput,
  AgedReport,
  AgedReportInput,
  AsAtDateInput,
  BalanceSheet,
  DateRangeInput,
  DayBook,
  ExportTaxReturnResult,
  OverviewFigures,
  ProfitAndLoss,
  TaxReturn,
  TaxReturnDue,
  TaxReturnInput,
} from '../../../shared/dto'
import type { GroupHandlers } from '../registry'
import { ok } from '../surface'
import {
  expectBoundedString,
  expectDateString,
  expectNonEmptyString,
  expectOneOf,
  expectRecord,
  optional,
} from '../validate'

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
  aged(input: AgedReportInput): Promise<AgedReport>
  overviewFigures(input: AsAtDateInput): Promise<OverviewFigures>
}

/**
 * What the IPC layer needs in order to prepare a tax return.
 *
 * A SECOND SERVICE BEHIND ONE GROUP, as printing is behind `documents`. The ledger's
 * reports are sums the journal answers; a return is a regime's reading of a period's
 * documents, and it needs a save dialog. See src/main/tax-returns/service.ts.
 */
export interface TaxReturnsService {
  taxReturn(input: TaxReturnInput): Promise<TaxReturn>
  exportTaxReturn(input: TaxReturnInput): Promise<ExportTaxReturnResult>
  markTaxReturnSeen(input: TaxReturnInput): Promise<void>
  taxReturnsDue(input: AsAtDateInput): Promise<TaxReturnDue[]>
}

/**
 * A form and a period. The form id is checked against the regime in main, not here: which
 * forms exist is the regime's answer, and a handler that kept its own list would be a
 * second one to fall out of step. Its length is bounded because it is an id, not a text.
 */
function parseTaxReturn(value: unknown): TaxReturnInput {
  const input = expectRecord(value, 'input')
  return {
    formId: expectBoundedString(expectNonEmptyString(input['formId'], 'formId'), 'formId', 64),
    from: expectDateString(input['from'], 'from'),
    to: expectDateString(input['to'], 'to'),
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

/**
 * Both fields required, and the side checked against the kind table rather than against
 * a pair of strings written here.
 *
 * `TRADE_SIDES` is derived from `DOCUMENT_KINDS`, so this cannot drift from what the
 * posting rules understand — which matters more here than in the other handlers, because
 * a side is what chooses the control account the whole report is about.
 */
function parseAged(value: unknown): AgedReportInput {
  const input = expectRecord(value, 'input')
  return {
    side: expectOneOf(input['side'], 'side', TRADE_SIDES),
    asAtDate: expectDateString(input['asAtDate'], 'asAtDate'),
  }
}

export function createReportHandlers(
  service: ReportService,
  taxReturns: TaxReturnsService,
): GroupHandlers<'reports'> {
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

    aged: {
      parseArgs: (raw): [AgedReportInput] => [parseAged(raw[0])],
      handle: async (input) => ok(await service.aged(input)),
    },

    overviewFigures: {
      parseArgs: (raw): [AsAtDateInput] => [parseAsAt(raw[0])],
      handle: async (input) => ok(await service.overviewFigures(input)),
    },

    taxReturn: {
      parseArgs: (raw): [TaxReturnInput] => [parseTaxReturn(raw[0])],
      handle: async (input) => ok(await taxReturns.taxReturn(input)),
    },

    /* No path is granted for reveal: the save dialog is the user naming the file, and
     * the screen says where it went rather than offering to open it. */
    exportTaxReturn: {
      parseArgs: (raw): [TaxReturnInput] => [parseTaxReturn(raw[0])],
      handle: async (input) => ok(await taxReturns.exportTaxReturn(input)),
    },

    markTaxReturnSeen: {
      parseArgs: (raw): [TaxReturnInput] => [parseTaxReturn(raw[0])],
      handle: async (input) => {
        await taxReturns.markTaxReturnSeen(input)
        return ok(undefined)
      },
    },

    taxReturnsDue: {
      parseArgs: (raw): [AsAtDateInput] => [parseAsAt(raw[0])],
      handle: async (input) => ok(await taxReturns.taxReturnsDue(input)),
    },
  }
}
