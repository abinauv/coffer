/*
 * The profit and loss, rendered.
 *
 * What is covered only here: that a loss is called a loss, and that the range the user
 * applied is the range that was asked for.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { ProfitAndLoss as Statement, ReportLine, ReportSection } from '@shared/dto'
import { renderScreen, type BridgeStub } from '../../test/harness'
import { ProfitAndLoss } from './ProfitAndLoss'

function line(code: string, name: string, amount: string, depth = 0): ReportLine {
  return { accountId: code, code, name, depth, isGroup: false, amount }
}

function section(type: ReportSection['type'], lines: ReportLine[], total: string): ReportSection {
  return { type, lines, total }
}

function statement(over: Partial<Statement> = {}): Statement {
  return {
    fromDate: null,
    toDate: null,
    income: section('income', [line('4100', 'Sales', '100000.00')], '100000.00'),
    expenses: section('expense', [line('6200', 'Rent', '55000.50')], '55000.50'),
    totalIncome: '100000.00',
    totalExpenses: '55000.50',
    netProfit: '44999.50',
    ...over,
  }
}

function bridgeReturning(value: Statement): BridgeStub {
  return { reports: { profitAndLoss: () => Promise.resolve({ ok: true, data: value }) } }
}

describe('ProfitAndLoss', () => {
  it('asks for the whole ledger on mount, with no range', async () => {
    const { bridge } = renderScreen(<ProfitAndLoss />, { bridge: bridgeReturning(statement()) })

    await screen.findByText(/4100 · Sales/)
    expect(bridge.lastCallTo('reports:profitAndLoss')?.args[0]).toEqual({})
  })

  it('shows both sections against their totals', async () => {
    renderScreen(<ProfitAndLoss />, { bridge: bridgeReturning(statement()) })

    const income = (await screen.findByText('Total income')).closest('tr')
    expect(within(income as HTMLElement).getByText('1,00,000.00')).toBeInTheDocument()

    const expenses = screen.getByText('Total expenses').closest('tr')
    expect(within(expenses as HTMLElement).getByText('55,000.50')).toBeInTheDocument()
  })

  /*
   * "Net profit: -15,000.00" asks the reader to notice a minus sign in a column of
   * figures. They will not. The word is what carries it.
   */
  it('calls a loss a loss, and still shows the signed figure', async () => {
    renderScreen(<ProfitAndLoss />, {
      bridge: bridgeReturning(
        statement({ totalIncome: '10000.00', totalExpenses: '25000.00', netProfit: '-15000.00' }),
      ),
    })

    const row = (await screen.findByText('Net loss')).closest('tr')
    expect(row).not.toBeNull()
    expect(within(row as HTMLElement).getByText('-15,000.00')).toBeInTheDocument()
    expect(screen.queryByText('Net profit')).toBeNull()
  })

  it('calls a profit a profit', async () => {
    renderScreen(<ProfitAndLoss />, { bridge: bridgeReturning(statement()) })

    const row = (await screen.findByText('Net profit')).closest('tr')
    expect(within(row as HTMLElement).getByText('44,999.50')).toBeInTheDocument()
  })

  it('calls exactly zero neither', async () => {
    renderScreen(<ProfitAndLoss />, {
      bridge: bridgeReturning(
        statement({ totalIncome: '0.00', totalExpenses: '0.00', netProfit: '0.00' }),
      ),
    })

    expect(await screen.findByText('Neither profit nor loss')).toBeInTheDocument()
  })

  it('sends the range the user applied, and only on Apply', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<ProfitAndLoss />, { bridge: bridgeReturning(statement()) })
    await screen.findByText(/4100 · Sales/)

    await user.type(screen.getByLabelText('From'), '2026-04-01')
    await user.type(screen.getByLabelText('To'), '2027-03-31')
    /* Typing a date must not re-run the query on every keystroke. */
    expect(bridge.callsTo('reports:profitAndLoss')).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(bridge.callsTo('reports:profitAndLoss')).toHaveLength(2))
    expect(bridge.lastCallTo('reports:profitAndLoss')?.args[0]).toEqual({
      fromDate: '2026-04-01',
      toDate: '2027-03-31',
    })
  })

  it('clears back to the whole ledger', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<ProfitAndLoss />, { bridge: bridgeReturning(statement()) })
    await screen.findByText(/4100 · Sales/)

    await user.type(screen.getByLabelText('From'), '2026-04-01')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(bridge.callsTo('reports:profitAndLoss')).toHaveLength(2))

    await user.click(screen.getByRole('button', { name: 'Clear' }))

    await waitFor(() => expect(bridge.callsTo('reports:profitAndLoss')).toHaveLength(3))
    expect(bridge.lastCallTo('reports:profitAndLoss')?.args[0]).toEqual({})
    expect(screen.getByLabelText('From')).toHaveValue('')
  })

  it('says which range the figures cover', async () => {
    renderScreen(<ProfitAndLoss />, {
      bridge: bridgeReturning(statement({ fromDate: '2026-04-01', toDate: '2027-03-31' })),
    })

    expect(await screen.findByText('1 Apr 2026 to 31 Mar 2027')).toBeInTheDocument()
  })

  it('shows a failure from main instead of a blank statement', async () => {
    renderScreen(<ProfitAndLoss />, {
      bridge: {
        reports: {
          profitAndLoss: () =>
            Promise.resolve({
              ok: false,
              error: { code: 'NO_COMPANY_OPEN', message: 'Open a company first.' },
            }),
        },
      },
    })

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('Net profit')).toBeNull()
  })
})
