/*
 * The receipts register, rendered.
 *
 * `statusTone` and `formatAmount` are covered as pure functions next door. What is
 * covered only here is what the screen asks main for and what it does with the answer.
 *
 * THE COLUMN THIS SCREEN EXISTS FOR IS "ON ACCOUNT". A receipt nobody has matched is not
 * an error and not an unfinished task — it is money the customer has paid and the
 * business has not decided about, and it has to be visible or an aged report and the
 * balance sheet stop agreeing for a reason nobody can find. There is a test that it is
 * shown, and one that it is blank rather than 0.00 when there is none.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ReceiptSummary, Result } from '@shared/dto'
import { renderScreen, screenContext, type BridgeStub } from '../../test/harness'
import { Receipts } from './Receipts'

function receipt(over: Partial<ReceiptSummary> = {}): ReceiptSummary {
  return {
    id: 'rct-1',
    kind: 'receipt',
    status: 'posted',
    number: 'RCT/2026-27/0001',
    date: '2026-04-20',
    partyId: 'party-1',
    partyName: 'Sunrise Components',
    amount: '125000.00',
    allocated: '125000.00',
    unallocated: '0.00',
    ...over,
  }
}

const ROWS: ReceiptSummary[] = [
  receipt(),
  receipt({
    id: 'rct-2',
    number: 'RCT/2026-27/0002',
    partyName: 'Kaveri Metals',
    amount: '4720.50',
    allocated: '0.00',
    unallocated: '4720.50',
  }),
  receipt({
    id: 'rct-3',
    status: 'cancelled',
    number: 'RCT/2026-27/0003',
    partyName: 'Nilgiri Traders',
    amount: '900.00',
    allocated: '0.00',
    unallocated: '900.00',
  }),
]

const listing = (rows: ReceiptSummary[]): BridgeStub => ({
  receipts: { list: () => Promise.resolve<Result<ReceiptSummary[]>>({ ok: true, data: rows }) },
})

const lastQuery = (bridge: {
  lastCallTo(channel: string): { args: readonly unknown[] } | undefined
}) => bridge.lastCallTo('receipts:list')?.args[0] as Record<string, unknown> | undefined

const rowFor = async (number: string): Promise<HTMLElement> =>
  (await screen.findByText(number)).closest('tr') as HTMLElement

describe('what it asks main for', () => {
  /* One direction. A register mixing money out into a list of money in would invite
   * reading a total that means nothing. */
  it('asks for receipts and not payments', async () => {
    const { bridge } = renderScreen(<Receipts {...screenContext()} />, { bridge: listing(ROWS) })

    await waitFor(() => expect(bridge.callsTo('receipts:list')).toHaveLength(1))
    expect(lastQuery(bridge)?.['kind']).toBe('receipt')
  })

  /* THE PAGING MECHANISM. One more row than the screen draws — the extra is how Next
   * knows there is somewhere to go, with no count query to disagree with the list. */
  it('asks for one row more than it will draw', async () => {
    const { bridge } = renderScreen(<Receipts {...screenContext()} />, { bridge: listing(ROWS) })

    await waitFor(() => expect(bridge.callsTo('receipts:list')).toHaveLength(1))
    expect(lastQuery(bridge)?.['limit']).toBe(51)
    expect(lastQuery(bridge)?.['offset']).toBe(0)
  })

  it('sends the status filter to main rather than filtering the page it got', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Receipts {...screenContext()} />, { bridge: listing(ROWS) })

    await waitFor(() => expect(bridge.callsTo('receipts:list')).toHaveLength(1))
    await user.click(screen.getByRole('button', { name: 'Cancelled' }))

    await waitFor(() => expect(lastQuery(bridge)?.['status']).toBe('cancelled'))
  })

  it('sends the search only when it is submitted, not on every keystroke', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Receipts {...screenContext()} />, { bridge: listing(ROWS) })

    await waitFor(() => expect(bridge.callsTo('receipts:list')).toHaveLength(1))
    await user.type(screen.getByLabelText('Search'), 'UTR88')
    expect(bridge.callsTo('receipts:list')).toHaveLength(1)

    await user.keyboard('{Enter}')
    await waitFor(() => expect(lastQuery(bridge)?.['search']).toBe('UTR88'))
  })

  /* Staying on page 4 of a filter that now matches six rows shows an empty register,
   * which reads as "there are none" — the worst answer to give somebody about money. */
  it('goes back to the first page whenever the filter changes', async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: 51 }, (_, index) =>
      receipt({ id: `r-${String(index)}`, number: `RCT/${String(index)}` }),
    )
    const { bridge } = renderScreen(<Receipts {...screenContext()} />, { bridge: listing(many) })

    await waitFor(() => expect(bridge.callsTo('receipts:list')).toHaveLength(1))
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(lastQuery(bridge)?.['offset']).toBe(50))

    await user.click(screen.getByRole('button', { name: 'Posted' }))
    await waitFor(() => expect(lastQuery(bridge)?.['offset']).toBe(0))
  })
})

describe('what it draws', () => {
  it('draws only the rows it meant to, not the extra one it asked for', async () => {
    const many = Array.from({ length: 51 }, (_, index) =>
      receipt({ id: `r-${String(index)}`, number: `RCT/${String(index)}` }),
    )
    renderScreen(<Receipts {...screenContext()} />, { bridge: listing(many) })

    await screen.findByText('RCT/0')
    expect(screen.queryByText('RCT/50')).not.toBeInTheDocument()
  })

  /*
   * The column this screen exists for — asserted on the CELL and not on the row. A
   * receipt nobody has matched has the same figure in both money columns, so a row-scoped
   * assertion passes against a screen that draws no on-account column at all. The 2.2e-4
   * finding, in the one place it was most likely to happen again.
   */
  it('shows what is still on account', async () => {
    renderScreen(<Receipts {...screenContext()} />, { bridge: listing(ROWS) })

    const cells = within(await rowFor('RCT/2026-27/0002')).getAllByRole('cell')
    expect(cells[5]).toHaveTextContent('4,720.50')
  })

  /* Blank rather than 0.00 against every settled receipt: a column of zeros is noise, and
   * what this column is for is the row that has something left on it. */
  it('leaves the column blank when nothing is on account', async () => {
    renderScreen(<Receipts {...screenContext()} />, { bridge: listing(ROWS) })

    const row = await rowFor('RCT/2026-27/0001')
    const cells = within(row).getAllByRole('cell')
    expect(cells[4]).toHaveTextContent('1,25,000.00')
    expect(cells[5]).toHaveTextContent('')
  })

  it('names the customer and the status', async () => {
    renderScreen(<Receipts {...screenContext()} />, { bridge: listing(ROWS) })

    const row = await rowFor('RCT/2026-27/0003')
    expect(within(row).getByText('Nilgiri Traders')).toBeInTheDocument()
    expect(within(row).getByText('Cancelled')).toBeInTheDocument()
  })

  /*
   * NO TOTAL FOR THE PAGE. It would be renderer arithmetic, and worse, it would be the
   * total of a PAGE — a number that changes when you press Next and means nothing in
   * either position.
   */
  it('shows no total across the rows', async () => {
    renderScreen(<Receipts {...screenContext()} />, { bridge: listing(ROWS) })

    await screen.findByText('RCT/2026-27/0001')
    /* 125000 + 4720.50 + 900 = 130620.50, which must appear nowhere. */
    expect(screen.queryByText('1,30,620.50')).not.toBeInTheDocument()
  })

  it('says there are none, and how to make one', async () => {
    renderScreen(<Receipts {...screenContext()} />, { bridge: listing([]) })

    expect(await screen.findByText('No receipts yet')).toBeInTheDocument()
    expect(screen.getByText(/sits on account/)).toBeInTheDocument()
  })

  /* An empty page under a filter is a different fact from an empty register, and saying
   * the wrong one tells somebody their money is missing. */
  it('says nothing matches when a filter is on', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Receipts {...screenContext()} />, { bridge: listing([]) })

    await waitFor(() => expect(bridge.callsTo('receipts:list')).toHaveLength(1))
    await user.click(screen.getByRole('button', { name: 'Cancelled' }))

    expect(await screen.findByText('Nothing matches that')).toBeInTheDocument()
  })
})

describe('where it goes', () => {
  it('opens a receipt from its number', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    renderScreen(<Receipts {...screenContext({ navigate })} />, { bridge: listing(ROWS) })

    await user.click(await screen.findByRole('button', { name: 'RCT/2026-27/0002' }))
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ screenId: 'receipt', params: { id: 'rct-2' } }),
    )
  })

  /* No id is a new receipt. The editor creates nothing until it is asked to. */
  it('starts a new one with no id at all', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    renderScreen(<Receipts {...screenContext({ navigate })} />, { bridge: listing(ROWS) })

    await user.click(await screen.findByRole('button', { name: 'Record a receipt' }))
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ screenId: 'receipt', params: {} }),
    )
  })
})
