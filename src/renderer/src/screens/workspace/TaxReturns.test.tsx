/*
 * Reports → Tax returns, rendered.
 *
 * What only exists on screen: that the regime's own words are what get drawn, that a
 * provisional return says so twice, that opening one is remembered only once it has been
 * drawn, and that a regime which prepares nothing gets a sentence rather than an empty
 * picker.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AccountingPeriod, TaxReturn, TaxReturnInput } from '@shared/dto'
import { todayISO } from '@renderer/lib/today'
import { DEFAULT_COMPANY, DEFAULT_REGIME, renderScreen, type BridgeStub } from '../../test/harness'
import { TaxReturns } from './TaxReturns'

/* Two finished months before today and the one in progress, whatever today is. */
function monthsEndingToday(): AccountingPeriod[] {
  const today = new Date(`${todayISO()}T00:00:00Z`)
  return [2, 1, 0].map((back, index) => {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - back, 1))
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))
    const iso = (date: Date): string => date.toISOString().slice(0, 10)
    return {
      id: `p${index}`,
      fiscalYearLabel: 'FY',
      index,
      label: `Month ${iso(start).slice(0, 7)}`,
      startDate: iso(start),
      endDate: iso(end),
      status: 'open' as const,
      closedAt: null,
    }
  })
}

const PERIODS = monthsEndingToday()
const LAST_FINISHED = PERIODS[1]!

function prepared(input: TaxReturnInput, over: Partial<TaxReturn> = {}): TaxReturn {
  const form = DEFAULT_REGIME.returnForms.find((candidate) => candidate.id === input.formId)!
  return {
    form,
    period: { from: input.from, to: input.to, label: 'The month' },
    packVersion: '2026.1',
    isProvisional: true,
    notice: 'The shape has not been checked against the portal — check it before you upload it.',
    rows: [
      {
        id: 'b2b',
        label: 'B2B',
        what: 'Invoices to registered customers',
        documentCount: 3,
        taxableValue: '30000.00',
        tax: '5400.00',
      },
      {
        id: 'net',
        label: '4(C)',
        what: 'Net credit',
        documentCount: null,
        taxableValue: null,
        tax: '900.00',
      },
    ],
    total: {
      id: 'reported',
      label: 'Total',
      what: 'Everything reported',
      documentCount: 3,
      taxableValue: '30000.00',
      tax: '5400.00',
    },
    issues: [
      {
        code: 'UQC_NOT_MAPPED',
        severity: 'error',
        message: 'The unit BAGS has no code the portal accepts.',
        documentNumber: 'INV/2026-27/0004',
      },
      {
        code: 'REVERSE_CHARGE_NOT_RECORDED',
        severity: 'warning',
        message: 'Reverse charge was taken as not applying.',
        documentNumber: null,
      },
    ],
    ...over,
  }
}

function bridge(over: Record<string, unknown> = {}): BridgeStub {
  return {
    ledger: { listPeriods: () => Promise.resolve({ ok: true, data: PERIODS }) },
    reports: {
      taxReturn: (input: TaxReturnInput) => Promise.resolve({ ok: true, data: prepared(input) }),
      markTaxReturnSeen: () => Promise.resolve({ ok: true, data: undefined }),
      exportTaxReturn: () =>
        Promise.resolve({ ok: true, data: { path: '/home/a/gstr-1-2026-08.json' } }),
      ...over,
    },
  } as BridgeStub
}

describe('what it draws', () => {
  it('opens on the first form and the latest finished month', async () => {
    const rendered = renderScreen(<TaxReturns />, { bridge: bridge(), company: DEFAULT_COMPANY })

    await screen.findByRole('heading', { name: /GSTR-1 · The month/ })
    expect(rendered.bridge.lastCallTo('reports:taxReturn')?.args[0]).toEqual({
      formId: 'gstr-1',
      from: LAST_FINISHED.startDate,
      to: LAST_FINISHED.endDate,
    })
  })

  it('draws every row in the regime words, with main figures', async () => {
    renderScreen(<TaxReturns />, { bridge: bridge(), company: DEFAULT_COMPANY })

    const table = await screen.findByRole('table')
    const row = within(table).getByRole('row', { name: /B2B/ })
    expect(within(row).getByText('Invoices to registered customers')).toBeInTheDocument()
    expect(within(row).getByText('3')).toBeInTheDocument()
    expect(within(row).getByText('30,000.00')).toBeInTheDocument()
    expect(within(row).getByText('5,400.00')).toBeInTheDocument()
  })

  /* A table that counts no documents and carries no value shows a dash, not a zero: a zero
   * would be a figure main never sent. */
  it('draws a dash where a table has no count or no value', async () => {
    renderScreen(<TaxReturns />, { bridge: bridge(), company: DEFAULT_COMPANY })

    const row = await screen.findByRole('row', { name: /4\(C\)/ })
    expect(within(row).getAllByText('—')).toHaveLength(2)
  })

  it('says it is provisional as a badge, and says why in the notice', async () => {
    renderScreen(<TaxReturns />, { bridge: bridge(), company: DEFAULT_COMPANY })

    expect(await screen.findByText('Provisional')).toBeInTheDocument()
    expect(screen.getByText(/has not been checked against the portal/)).toBeInTheDocument()
  })

  it('lists what stops it being filed before what was assumed', async () => {
    renderScreen(<TaxReturns />, { bridge: bridge(), company: DEFAULT_COMPANY })

    const section = await screen.findByRole('region', { name: 'Before you file' })
    const items = within(section).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Must fix')
    expect(items[0]).toHaveTextContent('INV/2026-27/0004')
    expect(items[1]).toHaveTextContent('Assumed')
    expect(
      within(section).getByText(/One thing stops this being filed as it stands/),
    ).toBeInTheDocument()
  })
})

describe('choosing', () => {
  it('prepares the other form when it is chosen', async () => {
    const user = userEvent.setup()
    const rendered = renderScreen(<TaxReturns />, { bridge: bridge(), company: DEFAULT_COMPANY })
    await screen.findByRole('heading', { name: /GSTR-1/ })

    await user.selectOptions(screen.getByLabelText('Return'), 'gstr-3b')

    await screen.findByRole('heading', { name: /GSTR-3B/ })
    expect(rendered.bridge.lastCallTo('reports:taxReturn')?.args[0]).toMatchObject({
      formId: 'gstr-3b',
    })
  })

  it('opens what a link from the Overview asked for', async () => {
    const earliest = PERIODS[0]!
    const rendered = renderScreen(
      <TaxReturns
        requested={{ form: 'gstr-3b', from: earliest.startDate, to: earliest.endDate }}
      />,
      { bridge: bridge(), company: DEFAULT_COMPANY },
    )

    await screen.findByRole('heading', { name: /GSTR-3B/ })
    expect(rendered.bridge.lastCallTo('reports:taxReturn')?.args[0]).toEqual({
      formId: 'gstr-3b',
      from: earliest.startDate,
      to: earliest.endDate,
    })
  })
})

describe('remembering it was looked at', () => {
  it('remembers once the return is on screen', async () => {
    const rendered = renderScreen(<TaxReturns />, { bridge: bridge(), company: DEFAULT_COMPANY })

    await screen.findByRole('table')
    await waitFor(() =>
      expect(rendered.bridge.lastCallTo('reports:markTaxReturnSeen')?.args[0]).toEqual({
        formId: 'gstr-1',
        from: LAST_FINISHED.startDate,
        to: LAST_FINISHED.endDate,
      }),
    )
  })

  /* A return that failed to prepare has not been looked at. */
  it('does not remember a return that failed to prepare', async () => {
    const seen = vi.fn(() => Promise.resolve({ ok: true, data: undefined }))
    renderScreen(<TaxReturns />, {
      bridge: bridge({
        taxReturn: () =>
          Promise.resolve({
            ok: false,
            error: { code: 'COMPANY_PROFILE_MISSING', message: 'Fill in Business details first.' },
          }),
        markTaxReturnSeen: seen,
      }),
      company: DEFAULT_COMPANY,
    })

    expect(await screen.findByText(/Business details/)).toBeInTheDocument()
    expect(seen).not.toHaveBeenCalled()
  })
})

describe('exporting', () => {
  it('says where the file went', async () => {
    const user = userEvent.setup()
    renderScreen(<TaxReturns />, { bridge: bridge(), company: DEFAULT_COMPANY })
    await screen.findByRole('table')

    await user.click(screen.getByRole('button', { name: 'Export as a file' }))

    expect(await screen.findByText('/home/a/gstr-1-2026-08.json')).toBeInTheDocument()
  })

  it('says nothing when the save dialog is closed', async () => {
    const user = userEvent.setup()
    renderScreen(<TaxReturns />, {
      bridge: bridge({
        exportTaxReturn: () => Promise.resolve({ ok: true, data: { path: null } }),
      }),
      company: DEFAULT_COMPANY,
    })
    await screen.findByRole('table')

    await user.click(screen.getByRole('button', { name: 'Export as a file' }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Export as a file' })).toBeEnabled(),
    )
    expect(screen.queryByText('Return exported')).not.toBeInTheDocument()
  })
})

describe('a regime that prepares nothing', () => {
  /* Decided by what main describes, never by the renderer checking a country. */
  it('says so rather than offering an empty picker', async () => {
    renderScreen(<TaxReturns />, {
      bridge: bridge(),
      company: DEFAULT_COMPANY,
      regime: { ...DEFAULT_REGIME, returnForms: [] },
    })

    expect(await screen.findByText('Nothing to prepare')).toBeInTheDocument()
    expect(screen.queryByLabelText('Return')).not.toBeInTheDocument()
  })
})
