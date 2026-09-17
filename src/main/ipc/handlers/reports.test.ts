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
import type { AgedReport, OverviewFigures, TaxReturn } from '../../../shared/dto'
import { IpcError } from '../errors'
import { createReportHandlers, type ReportService, type TaxReturnsService } from './reports'

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

const RETURN: TaxReturn = {
  form: { id: 'gstr-1', label: 'GSTR-1', description: 'Outward supplies.' },
  period: { from: '2026-08-01', to: '2026-08-31', label: 'August 2026' },
  packVersion: '2026.1',
  isProvisional: true,
  notice: 'Check it before you upload it.',
  rows: [],
  total: {
    id: 'reported',
    label: 'Total',
    what: 'Everything reported',
    documentCount: 0,
    taxableValue: '0.00',
    tax: '0.00',
  },
  issues: [],
}

let service: ReportService
let taxReturns: TaxReturnsService
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
  taxReturns = {
    taxReturn: vi.fn(async () => RETURN),
    exportTaxReturn: vi.fn(async () => ({ path: '/home/a/gstr-1-2026-08.json' })),
    markTaxReturnSeen: vi.fn(async () => undefined),
    taxReturnsDue: vi.fn(async () => []),
  }
  handlers = createReportHandlers(service, taxReturns)
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

describe('tax returns', () => {
  const input = { formId: 'gstr-1', from: '2026-08-01', to: '2026-08-31' }

  it('passes a form and a period through, and wraps the answer', async () => {
    const [parsed] = handlers.taxReturn.parseArgs([input])
    expect(parsed).toEqual(input)
    await expect(handlers.taxReturn.handle(input)).resolves.toEqual({ ok: true, data: RETURN })
    expect(taxReturns.taxReturn).toHaveBeenCalledWith(input)
  })

  /* The form is checked against the regime in main. A handler keeping its own list would
   * be a second answer to "which forms exist", and the first to fall out of step. */
  it('does not decide which forms exist', () => {
    expect(handlers.taxReturn.parseArgs([{ ...input, formId: 'anything-at-all' }])).toEqual([
      { ...input, formId: 'anything-at-all' },
    ])
  })

  /* A date compared as text: '2026-8-1' sorts before '2026-08-01' and would quietly
   * choose a different month rather than failing. */
  it('refuses a date that is not a date', () => {
    for (const bad of [
      { ...input, from: '2026-8-1' },
      { ...input, to: 'August' },
      { formId: 'gstr-1' },
      { ...input, formId: '' },
      { ...input, formId: 'x'.repeat(65) },
    ]) {
      expect(() => handlers.taxReturn.parseArgs([bad])).toThrow(IpcError)
    }
  })

  it('answers an export with the path, or null when cancelled', async () => {
    await expect(handlers.exportTaxReturn.handle(input)).resolves.toEqual({
      ok: true,
      data: { path: '/home/a/gstr-1-2026-08.json' },
    })
  })

  it('marks a return seen and answers nothing', async () => {
    await expect(handlers.markTaxReturnSeen.handle(input)).resolves.toEqual({
      ok: true,
      data: undefined,
    })
    expect(taxReturns.markTaxReturnSeen).toHaveBeenCalledWith(input)
  })

  it('asks what is due as at a date', async () => {
    expect(handlers.taxReturnsDue.parseArgs([{ asAtDate: '2026-09-17' }])).toEqual([
      { asAtDate: '2026-09-17' },
    ])
    await expect(handlers.taxReturnsDue.handle({ asAtDate: '2026-09-17' })).resolves.toEqual({
      ok: true,
      data: [],
    })
  })
})
