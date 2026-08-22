/*
 * The receipt editor, rendered.
 *
 * FOUR THINGS ARE COVERED ONLY HERE.
 *
 * A posted receipt is FROZEN except for what it settles. That is rule 1 and rule 2 read
 * together, and it is the shape of the whole screen: before the receipt exists everything
 * is editable and there is one button; after it exists the money is fixed and only the
 * matching can move.
 *
 * "Settle in full" COPIES what main sent. There is no test that a running total appears
 * as the user types, because there is no running total: the renderer does not add money
 * up, so what is left on the receipt belongs to the last saved version and says so.
 *
 * `exceptReceiptId` is sent when editing. An existing receipt's own allocations have to
 * come back as available, or the invoice the screen is showing a line for is absent from
 * the list it offers and the user cannot reduce what they allocated.
 *
 * And a blank line is NOT sent as a zero. Main refuses an allocation of nothing, so a row
 * nobody filled in has to be left out rather than turned into '0.00'.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  Account,
  OpenDocument,
  PartySummary,
  Receipt as ReceiptDto,
  Result,
} from '@shared/dto'
import { renderScreen, screenContext, testRoute, type BridgeStub } from '../../test/harness'
import { Receipt } from './Receipt'

const CUSTOMERS: PartySummary[] = [
  { id: 'party-1', name: 'Sunrise Components', isCustomer: true } as PartySummary,
  { id: 'party-2', name: 'Deccan Alloys', isCustomer: true } as PartySummary,
]

const ACCOUNTS: Account[] = [
  {
    id: 'acc-bank',
    code: '1210',
    name: 'Bank Account',
    isGroup: false,
    isArchived: false,
  } as Account,
  {
    id: 'acc-cash',
    code: '1100',
    name: 'Cash in Hand',
    isGroup: false,
    isArchived: false,
  } as Account,
  {
    id: 'acc-group',
    code: '1200',
    name: 'Bank Accounts',
    isGroup: true,
    isArchived: false,
  } as Account,
  { id: 'acc-old', code: '1299', name: 'Closed Bank', isGroup: false, isArchived: true } as Account,
]

function openDocument(over: Partial<OpenDocument> = {}): OpenDocument {
  return {
    id: 'doc-1',
    kind: 'sales-invoice',
    number: 'INV/2026-27/0001',
    date: '2026-04-15',
    grandTotal: '1180.00',
    outstanding: '1180.00',
    ...over,
  }
}

function receipt(over: Partial<ReceiptDto> = {}): ReceiptDto {
  return {
    id: 'rct-1',
    kind: 'receipt',
    status: 'posted',
    number: 'RCT/2026-27/0001',
    date: '2026-04-20',
    partyId: 'party-1',
    partyName: 'Sunrise Components',
    amount: '1180.00',
    allocated: '0.00',
    unallocated: '1180.00',
    seriesId: 'series-1',
    accountId: 'acc-bank',
    accountName: 'Bank Account',
    reference: 'UTR8842',
    narration: '',
    entryId: 'entry-1',
    allocations: [],
    createdAt: '2026-04-20T09:00:00.000Z',
    updatedAt: '2026-04-20T09:00:00.000Z',
    cancelledAt: null,
    ...over,
  }
}

/** A bridge serving one receipt, a set of open invoices, and an answer for every write. */
function bridgeFor(
  stored: ReceiptDto | null,
  open: OpenDocument[] = [openDocument()],
  answer: ReceiptDto = receipt(),
): BridgeStub {
  return {
    parties: {
      list: () => Promise.resolve<Result<PartySummary[]>>({ ok: true, data: CUSTOMERS }),
    },
    ledger: {
      listAccounts: () => Promise.resolve<Result<Account[]>>({ ok: true, data: ACCOUNTS }),
    },
    receipts: {
      get: () => Promise.resolve<Result<ReceiptDto | null>>({ ok: true, data: stored }),
      open: () => Promise.resolve<Result<OpenDocument[]>>({ ok: true, data: open }),
      create: () => Promise.resolve<Result<ReceiptDto>>({ ok: true, data: answer }),
      allocate: () => Promise.resolve<Result<ReceiptDto>>({ ok: true, data: answer }),
      cancel: () => Promise.resolve<Result<ReceiptDto>>({ ok: true, data: answer }),
    },
  }
}

const editing = (id = 'rct-1') => screenContext({ route: testRoute('receipt', { id }) })
const creating = (params: Record<string, string> = {}) =>
  screenContext({ route: testRoute('receipt', params) })

const sentTo = (
  bridge: { lastCallTo(channel: string): { args: readonly unknown[] } | undefined },
  channel: string,
): Record<string, unknown> | undefined =>
  bridge.lastCallTo(channel)?.args[0] as Record<string, unknown> | undefined

/** Fill in a new receipt's header, which is what every create test needs first. */
async function fillHeader(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.selectOptions(screen.getByLabelText('Customer'), 'party-1')
  await user.type(screen.getByLabelText('Date'), '2026-04-20')
  await user.type(screen.getByLabelText('Amount'), '1180.00')
  await user.selectOptions(screen.getByLabelText('Account the money landed in'), 'acc-bank')
}

describe('recording one', () => {
  /*
   * ONE FIELD AT A TIME, and that is the point. Filling all four and asserting the button
   * turns on passes against a screen that only checks one of them — a mutation removing
   * the amount and the account from the condition survived exactly that test. Each step
   * below has to leave the button off.
   */
  it('will not record until it knows the customer, the date, the amount and the account', async () => {
    const user = userEvent.setup()
    renderScreen(<Receipt {...creating()} />, { bridge: bridgeFor(null) })

    const button = await screen.findByRole('button', { name: 'Record receipt' })
    expect(button).toBeDisabled()

    await user.selectOptions(screen.getByLabelText('Customer'), 'party-1')
    expect(button).toBeDisabled()

    await user.type(screen.getByLabelText('Date'), '2026-04-20')
    expect(button).toBeDisabled()

    await user.type(screen.getByLabelText('Amount'), '1180.00')
    expect(button).toBeDisabled()

    await user.selectOptions(screen.getByLabelText('Account the money landed in'), 'acc-bank')
    expect(button).toBeEnabled()
  })

  /*
   * THE THING THE SCREEN IS FOR. Recording money against an invoice in one action — the
   * receipt and what it settles, together, in the transaction that posts it. Nothing else
   * in this file sends an allocation on a CREATE, and a mutation dropping them survived
   * until this was written.
   */
  it('sends what it settles along with the money', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Receipt {...creating()} />, { bridge: bridgeFor(null) })

    await screen.findByRole('button', { name: 'Record receipt' })
    await fillHeader(user)
    await user.click(await screen.findByRole('button', { name: 'Settle in full' }))
    await user.click(screen.getByRole('button', { name: 'Record receipt' }))

    await waitFor(() => expect(bridge.callsTo('receipts:create')).toHaveLength(1))
    expect(sentTo(bridge, 'receipts:create')?.['allocations']).toEqual([
      { documentId: 'doc-1', amount: '1180.00' },
    ])
  })

  it('sends what was typed, as a receipt', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Receipt {...creating()} />, { bridge: bridgeFor(null) })

    await screen.findByRole('button', { name: 'Record receipt' })
    await fillHeader(user)
    await user.type(screen.getByLabelText('Reference'), 'UTR8842')
    await user.click(screen.getByRole('button', { name: 'Record receipt' }))

    await waitFor(() => expect(bridge.callsTo('receipts:create')).toHaveLength(1))
    expect(sentTo(bridge, 'receipts:create')).toMatchObject({
      kind: 'receipt',
      partyId: 'party-1',
      amount: '1180.00',
      accountId: 'acc-bank',
      reference: 'UTR8842',
    })
  })

  /* Recording IS posting. There is no draft, so there is no second button and no state
   * between the two — the toast says the money is in the books. */
  it('offers no way to save a draft, because there is no draft', async () => {
    renderScreen(<Receipt {...creating()} />, { bridge: bridgeFor(null) })

    await screen.findByRole('button', { name: 'Record receipt' })
    expect(screen.queryByRole('button', { name: /draft/i })).not.toBeInTheDocument()
    expect(screen.getByText(/Recording it posts it/)).toBeInTheDocument()
  })

  it('moves to the receipt it made', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    renderScreen(<Receipt {...screenContext({ route: testRoute('receipt'), navigate })} />, {
      bridge: bridgeFor(null),
    })

    await screen.findByRole('button', { name: 'Record receipt' })
    await fillHeader(user)
    await user.click(screen.getByRole('button', { name: 'Record receipt' }))

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({ screenId: 'receipt', params: { id: 'rct-1' } }),
      ),
    )
  })

  it('shows what main refused, in main own words', async () => {
    const user = userEvent.setup()
    renderScreen(<Receipt {...creating()} />, {
      bridge: {
        ...bridgeFor(null),
        receipts: {
          ...bridgeFor(null).receipts,
          create: () =>
            Promise.resolve<Result<ReceiptDto>>({
              ok: false,
              error: {
                code: 'ALLOCATION_EXCEEDS_DOCUMENT',
                message: 'INV/2026-27/0001 has 180.00 outstanding, and 900.00 was allocated to it.',
              },
            }),
        },
      },
    })

    await screen.findByRole('button', { name: 'Record receipt' })
    await fillHeader(user)
    await user.click(screen.getByRole('button', { name: 'Record receipt' }))

    expect(
      await screen.findByText(/has 180\.00 outstanding, and 900\.00 was allocated/),
    ).toBeInTheDocument()
  })
})

describe('a receipt that exists', () => {
  /*
   * RULE 1 ON SCREEN. The money is a statement about something that already happened, so
   * it freezes the moment it is recorded — the same rule an issued invoice follows.
   */
  it('freezes the money and says why', async () => {
    renderScreen(<Receipt {...editing()} />, { bridge: bridgeFor(receipt()) })

    await waitFor(() => expect(screen.getByLabelText('Amount')).toHaveValue('1180.00'))
    expect(screen.getByLabelText('Amount')).toBeDisabled()
    expect(screen.getByLabelText('Customer')).toBeDisabled()
    expect(screen.getByLabelText('Date')).toBeDisabled()
    expect(screen.getByLabelText('Account the money landed in')).toBeDisabled()
    expect(screen.getByText(/cannot be edited/)).toBeInTheDocument()
  })

  /* And rule 2: allocating moves no money and writes no entry, so it is the one thing
   * about a posted receipt that may still change. */
  it('still lets what it settles be changed', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Receipt {...editing()} />, { bridge: bridgeFor(receipt()) })

    const box = await screen.findByLabelText('Settle against INV/2026-27/0001')
    expect(box).toBeEnabled()

    await user.type(box, '500.00')
    await user.click(screen.getByRole('button', { name: 'Save what it settles' }))

    await waitFor(() => expect(bridge.callsTo('receipts:allocate')).toHaveLength(1))
    expect(sentTo(bridge, 'receipts:allocate')).toEqual({
      id: 'rct-1',
      allocations: [{ documentId: 'doc-1', amount: '500.00' }],
    })
  })

  it('offers nothing at all once it is cancelled', async () => {
    renderScreen(<Receipt {...editing()} />, {
      bridge: bridgeFor(receipt({ status: 'cancelled', cancelledAt: '2026-04-21T09:00:00.000Z' })),
    })

    await screen.findByText('Cancelled')
    expect(screen.queryByRole('button', { name: 'Save what it settles' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel this receipt' })).not.toBeInTheDocument()
  })

  it('cancels, and says the invoices are owed again', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Receipt {...editing()} />, {
      bridge: bridgeFor(receipt(), [openDocument()], receipt({ status: 'cancelled' })),
    })

    await user.click(await screen.findByRole('button', { name: 'Cancel this receipt' }))

    await waitFor(() => expect(bridge.callsTo('receipts:cancel')).toHaveLength(1))
    expect(
      await within(screen.getByRole('region', { name: 'Notifications' })).findByText(/owed again/),
    ).toBeInTheDocument()
  })

  /* There is no delete anywhere, and this is the assertion that says so: a number handed
   * out is never released, so cancelling is the only way out. */
  it('offers no way to delete one', async () => {
    renderScreen(<Receipt {...editing()} />, { bridge: bridgeFor(receipt()) })

    await screen.findByText('Posted')
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
  })
})

describe('what it settles', () => {
  it('lists the customer open invoices with what is left on each', async () => {
    renderScreen(<Receipt {...editing()} />, {
      bridge: bridgeFor(receipt(), [
        openDocument(),
        openDocument({ id: 'doc-2', number: 'INV/2026-27/0002', outstanding: '400.00' }),
      ]),
    })

    const row = (await screen.findByText('INV/2026-27/0002')).closest('tr') as HTMLElement
    const cells = within(row).getAllByRole('cell')
    expect(cells[3]).toHaveTextContent('400.00')
  })

  /*
   * A COPY, NOT A SUM. The figure the button writes is the one main computed against the
   * ledger — already net of what other receipts took, which is the case anything the
   * renderer worked out would get wrong.
   */
  it('settles one in full with exactly the figure main sent', async () => {
    const user = userEvent.setup()
    renderScreen(<Receipt {...editing()} />, {
      bridge: bridgeFor(receipt(), [openDocument({ outstanding: '680.00' })]),
    })

    await user.click(await screen.findByRole('button', { name: 'Settle in full' }))
    expect(screen.getByLabelText('Settle against INV/2026-27/0001')).toHaveValue('680.00')
  })

  /*
   * `exceptReceiptId` IS SENT WHEN EDITING. Without it, an invoice this receipt already
   * settles in full is simply absent from the list, and the user cannot reduce what they
   * allocated because there is no row to reduce.
   */
  it('asks for the open invoices with this receipt own allocations put back', async () => {
    const { bridge } = renderScreen(<Receipt {...editing()} />, { bridge: bridgeFor(receipt()) })

    await waitFor(() => expect(bridge.callsTo('receipts:open').length).toBeGreaterThan(0))
    expect(sentTo(bridge, 'receipts:open')).toMatchObject({
      partyId: 'party-1',
      kind: 'receipt',
      exceptReceiptId: 'rct-1',
    })
  })

  /* And NOT when creating: there is no receipt yet whose allocations could be excluded,
   * and sending an id for one would be sending a lie. */
  it('sends no exception when there is no receipt yet', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Receipt {...creating()} />, { bridge: bridgeFor(null) })

    await screen.findByRole('button', { name: 'Record receipt' })
    await user.selectOptions(screen.getByLabelText('Customer'), 'party-1')

    await waitFor(() => expect(bridge.callsTo('receipts:open').length).toBeGreaterThan(0))
    expect(sentTo(bridge, 'receipts:open')).not.toHaveProperty('exceptReceiptId')
  })

  it('seeds a line from what the receipt already settles', async () => {
    renderScreen(<Receipt {...editing()} />, {
      bridge: bridgeFor(
        receipt({
          allocated: '400.00',
          unallocated: '780.00',
          allocations: [
            {
              id: 'alloc-1',
              documentId: 'doc-1',
              documentKind: 'sales-invoice',
              documentNumber: 'INV/2026-27/0001',
              documentDate: '2026-04-15',
              amount: '400.00',
            },
          ],
        }),
      ),
    })

    await waitFor(() =>
      expect(screen.getByLabelText('Settle against INV/2026-27/0001')).toHaveValue('400.00'),
    )
  })

  /*
   * A BLANK IS NOT A ZERO. Main refuses an allocation of nothing, so a row nobody filled
   * in is left out — a screen that sent '0.00' would have every save refused for a line
   * the user never touched.
   */
  it('leaves out a line nobody filled in', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Receipt {...editing()} />, {
      bridge: bridgeFor(receipt(), [
        openDocument(),
        openDocument({ id: 'doc-2', number: 'INV/2026-27/0002' }),
      ]),
    })

    await user.type(await screen.findByLabelText('Settle against INV/2026-27/0001'), '100.00')
    await user.click(screen.getByRole('button', { name: 'Save what it settles' }))

    await waitFor(() => expect(bridge.callsTo('receipts:allocate')).toHaveLength(1))
    expect(sentTo(bridge, 'receipts:allocate')?.['allocations']).toEqual([
      { documentId: 'doc-1', amount: '100.00' },
    ])
  })

  /* Money on account is an ordinary thing to hold, so the screen says so rather than
   * treating it as a problem to solve before recording. */
  it('says a customer with nothing outstanding can still be receipted', async () => {
    renderScreen(<Receipt {...editing()} />, { bridge: bridgeFor(receipt(), []) })

    expect(await screen.findByText('Nothing of theirs is outstanding')).toBeInTheDocument()
    expect(screen.getByText(/sits on account/)).toBeInTheDocument()
  })

  it('asks for nothing until a customer is chosen', async () => {
    const { bridge } = renderScreen(<Receipt {...creating()} />, { bridge: bridgeFor(null) })

    await screen.findByRole('button', { name: 'Record receipt' })
    expect(bridge.callsTo('receipts:open')).toHaveLength(0)
    expect(screen.getByText('Choose a customer to see what they owe')).toBeInTheDocument()
  })
})

describe('arriving from an invoice', () => {
  it('fills in the customer it was sent', async () => {
    const { bridge } = renderScreen(
      <Receipt {...creating({ partyId: 'party-2', documentId: 'doc-1' })} />,
      { bridge: bridgeFor(null) },
    )

    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('party-2'))
    await waitFor(() => expect(bridge.callsTo('receipts:open').length).toBeGreaterThan(0))
    expect(sentTo(bridge, 'receipts:open')?.['partyId']).toBe('party-2')
  })

  /*
   * AND FILLS IN NO AMOUNT. What arrived is a fact about a bank statement; pre-filling
   * what the invoice says would have somebody confirming a figure they had not read, and
   * a part payment is the ordinary case rather than the exception.
   */
  it('fills in no amount, because what arrived is not what was invoiced', async () => {
    renderScreen(<Receipt {...creating({ partyId: 'party-1', documentId: 'doc-1' })} />, {
      bridge: bridgeFor(null),
    })

    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('party-1'))
    expect(screen.getByLabelText('Amount')).toHaveValue('')
    expect(await screen.findByLabelText('Settle against INV/2026-27/0001')).toHaveValue('')
  })
})

describe('the figures', () => {
  it('shows what main said was received, settled and on account', async () => {
    renderScreen(<Receipt {...editing()} />, {
      bridge: bridgeFor(receipt({ allocated: '400.00', unallocated: '780.00' })),
    })

    const row = (await screen.findByText('On account')).closest('tr') as HTMLElement
    expect(within(row).getByText('780.00')).toBeInTheDocument()
  })

  /*
   * SAID, NOT HIDDEN. The renderer cannot add up the allocations on screen and will not
   * pretend to, so while there are unsaved edits it says which version the figures belong
   * to — the same answer the invoice editor gives.
   */
  it('marks the figures as stale rather than redrawing them', async () => {
    const user = userEvent.setup()
    renderScreen(<Receipt {...editing()} />, { bridge: bridgeFor(receipt()) })

    await user.type(await screen.findByLabelText('Settle against INV/2026-27/0001'), '500.00')

    expect(screen.getByText('These figures are from the last saved version')).toBeInTheDocument()
    /* And the on-account figure is still main's, not one the screen worked out. */
    const row = (screen.getByText('On account').closest('tr') as HTMLElement) ?? null
    expect(within(row).getByText('1,180.00')).toBeInTheDocument()
  })

  it('will not save what it settles until something has changed', async () => {
    renderScreen(<Receipt {...editing()} />, { bridge: bridgeFor(receipt()) })

    expect(await screen.findByRole('button', { name: 'Save what it settles' })).toBeDisabled()
  })
})

describe('the account the money landed in', () => {
  /*
   * EVERY POSTABLE ACCOUNT, not a filtered list of "money accounts". The role map holds
   * one bank and one cash, and a business with four banks posts to three that fill no
   * role — so a renderer that filtered would invent a rule main does not have.
   */
  it('offers the postable accounts and leaves out the groups and the archived', async () => {
    renderScreen(<Receipt {...creating()} />, { bridge: bridgeFor(null) })

    const picker = await screen.findByLabelText('Account the money landed in')
    const options = within(picker)
      .getAllByRole('option')
      .map((option) => option.textContent)

    expect(options).toContain('1210 — Bank Account')
    expect(options).toContain('1100 — Cash in Hand')
    expect(options).not.toContain('1200 — Bank Accounts')
    expect(options).not.toContain('1299 — Closed Bank')
  })
})
