/*
 * The balance sheet, rendered.
 *
 * What is covered only here: that the profit line reaches the face of the sheet, that a
 * sheet which does not balance says so in words, and that the as-at date the user picked
 * is the one that was asked for.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { BalanceSheet as Sheet, ReportLine, ReportSection } from '@shared/dto'
import { renderScreen, type BridgeStub } from '../../test/harness'
import { BalanceSheet } from './BalanceSheet'

function line(code: string, name: string, amount: string, depth = 0, isGroup = false): ReportLine {
  return { accountId: code, code, name, depth, isGroup, amount }
}

function section(type: ReportSection['type'], lines: ReportLine[], total: string): ReportSection {
  return { type, lines, total }
}

function sheet(over: Partial<Sheet> = {}): Sheet {
  return {
    asAtDate: '2026-04-30',
    assets: section(
      'asset',
      [
        line('1000', 'Current Assets', '135000.00', 0, true),
        line('1210', 'Bank Account', '135000.00', 1),
      ],
      '135000.00',
    ),
    liabilities: section('liability', [], '0.00'),
    equity: section('equity', [line('3100', 'Owner’s Capital', '100000.00')], '100000.00'),
    profitForPeriod: '35000.00',
    totalAssets: '135000.00',
    totalLiabilitiesAndEquity: '135000.00',
    balanced: true,
    ...over,
  }
}

function bridgeReturning(value: Sheet): BridgeStub {
  return { reports: { balanceSheet: () => Promise.resolve({ ok: true, data: value }) } }
}

describe('BalanceSheet', () => {
  it("asks for today's sheet on mount", async () => {
    const { bridge } = renderScreen(<BalanceSheet />, { bridge: bridgeReturning(sheet()) })

    await screen.findByText(/Bank Account/)

    /* Today specifically, not merely something date-shaped — a hardcoded date would
     * satisfy a pattern match and quietly show every user the same wrong day. Built
     * here from the local calendar rather than imported, so this fails if the screen
     * and the helper ever disagree about which day it is. */
    const now = new Date()
    const pad = (value: number) => String(value).padStart(2, '0')
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

    expect(bridge.lastCallTo('reports:balanceSheet')?.args[0]).toEqual({ asAtDate: today })
  })

  it('sends the date the user picked', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<BalanceSheet />, { bridge: bridgeReturning(sheet()) })
    await screen.findByText(/Bank Account/)

    await user.clear(screen.getByLabelText('As at'))
    await user.type(screen.getByLabelText('As at'), '2026-06-30')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(bridge.callsTo('reports:balanceSheet')).toHaveLength(2))
    expect(bridge.lastCallTo('reports:balanceSheet')?.args[0]).toEqual({ asAtDate: '2026-06-30' })
  })

  /*
   * The line the sheet does not balance without. A reader who knows the equation will
   * look for it, and a sheet that folded it silently into equity would be arithmetically
   * right and unreadable.
   */
  it('shows the unclosed profit on the face of the sheet', async () => {
    renderScreen(<BalanceSheet />, { bridge: bridgeReturning(sheet()) })

    const row = (await screen.findByText('Profit for the period, not yet closed')).closest('tr')
    expect(row).not.toBeNull()
    expect(within(row as HTMLElement).getByText('35,000.00')).toBeInTheDocument()
  })

  it('shows a loss on that line as a negative rather than hiding it', async () => {
    renderScreen(<BalanceSheet />, {
      bridge: bridgeReturning(
        sheet({
          profitForPeriod: '-30000.00',
          totalAssets: '70000.00',
          totalLiabilitiesAndEquity: '70000.00',
        }),
      ),
    })

    const row = (await screen.findByText('Profit for the period, not yet closed')).closest('tr')
    expect(within(row as HTMLElement).getByText('-30,000.00')).toBeInTheDocument()
  })

  it('puts each account against its own figure, indented under its group', async () => {
    renderScreen(<BalanceSheet />, { bridge: bridgeReturning(sheet()) })

    const bank = (await screen.findByText(/1210 · Bank Account/)).closest('tr')
    expect(within(bank as HTMLElement).getByText('1,35,000.00')).toBeInTheDocument()

    const group = screen.getByText(/1000 · Current Assets/)
    expect(group.style.paddingInlineStart).toBe('0rem')
    expect(screen.getByText(/1210 · Bank Account/).style.paddingInlineStart).toBe('1.25rem')
  })

  it('marks a negative asset as contra rather than leaving a bare minus', async () => {
    renderScreen(<BalanceSheet />, {
      bridge: bridgeReturning(
        sheet({
          assets: section('asset', [line('1210', 'Bank Account', '-15000.00')], '-15000.00'),
        }),
      ),
    })

    const bank = (await screen.findByText(/1210 · Bank Account/)).closest('tr')
    expect(within(bank as HTMLElement).getByText('(contra)')).toBeInTheDocument()
  })

  it('marks nothing contra when every figure is the right way round', async () => {
    /* Without this, marking *every* row passes the test above just as happily, and the
     * word stops meaning anything the moment it is on all of them. */
    renderScreen(<BalanceSheet />, { bridge: bridgeReturning(sheet()) })

    await screen.findByText(/1210 · Bank Account/)
    expect(screen.queryByText('(contra)')).toBeNull()
  })

  it('says a section is empty rather than drawing nothing at all', async () => {
    renderScreen(<BalanceSheet />, { bridge: bridgeReturning(sheet()) })
    expect(await screen.findByText('Nothing has been posted here.')).toBeInTheDocument()
  })

  /* The reason the flag crosses IPC at all. */
  it('says loudly when the sheet does not balance', async () => {
    renderScreen(<BalanceSheet />, {
      bridge: bridgeReturning(
        sheet({
          totalAssets: '135000.00',
          totalLiabilitiesAndEquity: '134000.00',
          balanced: false,
        }),
      ),
    })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('This balance sheet does not balance')
    expect(alert).toHaveTextContent('Assets come to 1,35,000.00 and the other side to 1,34,000.00')
  })

  it('says nothing of the sort when it does balance', async () => {
    renderScreen(<BalanceSheet />, { bridge: bridgeReturning(sheet()) })
    await screen.findByText(/Bank Account/)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a failure from main instead of a blank sheet', async () => {
    renderScreen(<BalanceSheet />, {
      bridge: {
        reports: {
          balanceSheet: () =>
            Promise.resolve({
              ok: false,
              error: { code: 'NO_COMPANY_OPEN', message: 'Open a company first.' },
            }),
        },
      },
    })

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText(/Bank Account/)).toBeNull()
  })
})
