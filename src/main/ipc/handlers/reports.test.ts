/*
 * The `reports` group's boundary — the aged report's arguments.
 *
 * WHY THIS FILE STARTS WITH ONE METHOD. The other three have had no boundary test since
 * they were written, and adding four here would be a different batch's work; `aged` gets
 * one now because it is the first method in the group whose argument CHOOSES SOMETHING
 * rather than narrowing a range. A malformed date on a day book returns the wrong set of
 * entries; a malformed side on this one would resolve no control account at all, and the
 * failure would surface from inside the repository rather than at the edge where the
 * untrusted string arrived.
 *
 * The date check is the same one the group's header already argues for and it matters
 * more here: `asAtDate` goes straight into a comparison against `entry_date`, which is
 * text, so '2026-4-1' would compare as less than '2026-04-01' and quietly report a
 * different month rather than failing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TRADE_SIDES } from '../../../shared/documents'
import type { AgedReport, OverviewFigures } from '../../../shared/dto'
import { createReportHandlers, type ReportService } from './reports'

const AGED: AgedReport = {
  side: 'sales',
  asAtDate: '2026-06-30',
  accountId: 'account-1',
  accountCode: '1300',
  accountName: 'Accounts Receivable',
  buckets: [{ label: 'Not yet due', fromDays: null, toDays: 0 }],
  parties: [],
  totals: { buckets: ['0.00'], onAccount: '0.00', overdue: '0.00', total: '0.00' },
  controlBalance: '0.00',
  ties: true,
}

let service: ReportService
let handlers: ReturnType<typeof createReportHandlers>

beforeEach(() => {
  service = {
    balanceSheet: vi.fn(),
    profitAndLoss: vi.fn(),
    accountLedger: vi.fn(),
    dayBook: vi.fn(),
    aged: vi.fn(async () => AGED),
    overviewFigures: vi.fn(async () => FIGURES),
  } as unknown as ReportService
  handlers = createReportHandlers(service)
})

const FIGURES: OverviewFigures = {
  asAtDate: '2026-09-15',
  cashAndBank: { total: '0.00', accounts: [] },
  monthToDate: { fromDate: '2026-09-01', toDate: '2026-09-15', netProfit: '0.00' },
}

describe('overviewFigures', () => {
  it('takes a date and wraps what the service answers', async () => {
    expect(handlers.overviewFigures.parseArgs([{ asAtDate: '2026-09-15' }])).toEqual([
      { asAtDate: '2026-09-15' },
    ])
    await expect(handlers.overviewFigures.handle({ asAtDate: '2026-09-15' })).resolves.toEqual({
      ok: true,
      data: FIGURES,
    })
  })

  /* A month so far with no date is no month at all, and the first of which month would be
   * the renderer's clock deciding what main reports. */
  it('refuses a request with no date, or a date that is not one', () => {
    expect(() => handlers.overviewFigures.parseArgs([{}])).toThrow(/asAtDate/)
    expect(() => handlers.overviewFigures.parseArgs([{ asAtDate: '2026-9-15' }])).toThrow(
      /asAtDate/,
    )
  })
})

describe('aged', () => {
  it('passes a well-formed request through', () => {
    expect(handlers.aged.parseArgs([{ side: 'purchase', asAtDate: '2026-06-30' }])).toEqual([
      { side: 'purchase', asAtDate: '2026-06-30' },
    ])
  })

  it('wraps what the service answers', async () => {
    await expect(handlers.aged.handle({ side: 'sales', asAtDate: '2026-06-30' })).resolves.toEqual({
      ok: true,
      data: AGED,
    })
  })

  /* Every side the kind table knows, so a side added there arrives here without an edit —
   * and a validator narrowed to one of them fails this rather than passing quietly. */
  it.each(TRADE_SIDES)('accepts %s', (side) => {
    expect(handlers.aged.parseArgs([{ side, asAtDate: '2026-06-30' }])[0].side).toBe(side)
  })

  it('refuses a side that is not one of them', () => {
    expect(() => handlers.aged.parseArgs([{ side: 'both', asAtDate: '2026-06-30' }])).toThrow(
      /side/,
    )
  })

  /* Not optional, unlike the ends of a range. An aged report with no date is not a report
   * about anything, and defaulting it to today would answer a question nobody asked. */
  it('refuses a request with no date', () => {
    expect(() => handlers.aged.parseArgs([{ side: 'sales' }])).toThrow(/asAtDate/)
  })

  it('refuses a date that is not a date', () => {
    expect(() => handlers.aged.parseArgs([{ side: 'sales', asAtDate: '2026-4-1' }])).toThrow(
      /asAtDate/,
    )
  })

  it('refuses a request that is not an object at all', () => {
    expect(() => handlers.aged.parseArgs(['sales'])).toThrow(/input/)
  })
})
