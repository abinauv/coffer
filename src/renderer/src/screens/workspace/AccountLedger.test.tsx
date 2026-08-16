/*
 * One account's ledger, rendered.
 *
 * The claim worth testing above all others here: the opening balance is on screen. A
 * ledger that started at zero would close on the range's movement wearing the closing
 * balance's name — right-looking, right-labelled, and wrong by everything that happened
 * before the range.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Account, AccountLedger as Ledger, AccountLedgerRow } from '@shared/dto'
import { renderScreen, type BridgeStub } from '../../test/harness'
import { AccountLedger } from './AccountLedger'

const ACCOUNTS: Account[] = [
  {
    id: 'g1',
    code: '1000',
    name: 'Current Assets',
    type: 'asset',
    normalBalance: 'debit',
    parentId: null,
    isGroup: true,
    isArchived: false,
    description: null,
    depth: 0,
    roles: [],
  },
  {
    id: 'bank',
    code: '1210',
    name: 'Bank Account',
    type: 'asset',
    normalBalance: 'debit',
    parentId: 'g1',
    isGroup: false,
    isArchived: false,
    description: null,
    depth: 1,
    roles: [],
  },
]

function row(over: Partial<AccountLedgerRow> = {}): AccountLedgerRow {
  return {
    entryId: 'e1',
    entryNumber: 'JV-2026-27-0001',
    date: '2026-05-10',
    narration: '',
    contra: 'Sales',
    debit: '25000.00',
    credit: '0.00',
    balance: '125000.00',
    ...over,
  }
}

function ledger(over: Partial<Ledger> = {}): Ledger {
  return {
    accountId: 'bank',
    code: '1210',
    name: 'Bank Account',
    type: 'asset',
    normalBalance: 'debit',
    fromDate: '2026-05-01',
    toDate: '2026-05-31',
    openingBalance: '100000.00',
    rows: [row()],
    totalDebit: '25000.00',
    totalCredit: '0.00',
    closingBalance: '125000.00',
    ...over,
  }
}

function bridge(value: Ledger = ledger()): BridgeStub {
  return {
    ledger: { listAccounts: () => Promise.resolve({ ok: true, data: ACCOUNTS }) },
    reports: { accountLedger: () => Promise.resolve({ ok: true, data: value }) },
  }
}

async function choose(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const select = await screen.findByLabelText('Account')
  await user.selectOptions(select, 'bank')
}

describe('AccountLedger', () => {
  it('asks nothing until an account is chosen', async () => {
    const { bridge: fake } = renderScreen(<AccountLedger />, { bridge: bridge() })

    await screen.findByLabelText('Account')
    expect(fake.callsTo('reports:accountLedger')).toHaveLength(0)
    expect(screen.getByText('Choose an account to see its ledger.')).toBeInTheDocument()
  })

  /* A group takes no postings, so its ledger is empty by construction and offering it
   * would be offering a blank screen. */
  it('offers only accounts that can be posted to', async () => {
    renderScreen(<AccountLedger />, { bridge: bridge() })

    const select = await screen.findByLabelText('Account')
    expect(within(select).getByRole('option', { name: /1210/ })).toBeInTheDocument()
    expect(within(select).queryByRole('option', { name: /1000/ })).toBeNull()
  })

  it('loads the chosen account', async () => {
    const user = userEvent.setup()
    const { bridge: fake } = renderScreen(<AccountLedger />, { bridge: bridge() })
    await choose(user)

    await waitFor(() => expect(fake.callsTo('reports:accountLedger')).toHaveLength(1))
    expect(fake.lastCallTo('reports:accountLedger')?.args[0]).toEqual({ accountId: 'bank' })
  })

  /* The row this screen would be dangerous without. */
  it('shows the opening balance as its own row', async () => {
    const user = userEvent.setup()
    renderScreen(<AccountLedger />, { bridge: bridge() })
    await choose(user)

    const opening = (await screen.findByText('Opening balance')).closest('tr')
    expect(within(opening as HTMLElement).getByText('1,00,000.00')).toBeInTheDocument()
  })

  it('shows the running balance against each movement', async () => {
    const user = userEvent.setup()
    renderScreen(<AccountLedger />, {
      bridge: bridge(
        ledger({
          rows: [
            row({ entryNumber: 'JV-1', debit: '25000.00', balance: '125000.00' }),
            row({ entryNumber: 'JV-2', debit: '0.00', credit: '30000.00', balance: '95000.00' }),
          ],
          totalDebit: '25000.00',
          totalCredit: '30000.00',
          closingBalance: '95000.00',
        }),
      ),
    })
    await choose(user)

    const first = (await screen.findByText('JV-1')).closest('tr')
    expect(within(first as HTMLElement).getByText('1,25,000.00')).toBeInTheDocument()

    const second = screen.getByText('JV-2').closest('tr')
    expect(within(second as HTMLElement).getByText('95,000.00')).toBeInTheDocument()
    /* A credit line leaves the debit column blank rather than printing 0.00. */
    expect(within(second as HTMLElement).getByText('30,000.00')).toBeInTheDocument()
  })

  it('closes on the closing balance, with both column totals', async () => {
    const user = userEvent.setup()
    renderScreen(<AccountLedger />, { bridge: bridge() })
    await choose(user)

    const closing = (await screen.findByText('Closing balance')).closest('tr')
    expect(within(closing as HTMLElement).getByText('1,25,000.00')).toBeInTheDocument()
    expect(within(closing as HTMLElement).getByText('25,000.00')).toBeInTheDocument()
  })

  it('names the account on the other side', async () => {
    const user = userEvent.setup()
    renderScreen(<AccountLedger />, { bridge: bridge() })
    await choose(user)

    expect(await screen.findByText('Sales')).toBeInTheDocument()
  })

  it('sends the range with the account', async () => {
    const user = userEvent.setup()
    const { bridge: fake } = renderScreen(<AccountLedger />, { bridge: bridge() })
    await choose(user)
    await waitFor(() => expect(fake.callsTo('reports:accountLedger')).toHaveLength(1))

    await user.type(screen.getByLabelText('From'), '2026-05-01')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(fake.callsTo('reports:accountLedger')).toHaveLength(2))
    expect(fake.lastCallTo('reports:accountLedger')?.args[0]).toEqual({
      accountId: 'bank',
      fromDate: '2026-05-01',
    })
  })

  it('says so when nothing moved, and still shows the balance', async () => {
    const user = userEvent.setup()
    renderScreen(<AccountLedger />, {
      bridge: bridge(ledger({ rows: [], totalDebit: '0.00', totalCredit: '0.00' })),
    })
    await choose(user)

    expect(await screen.findByText('Nothing moved through this account')).toBeInTheDocument()
    /* Not a blank screen: an account with a balance and no movement in the range is a
     * different thing from an account with nothing in it. */
    expect(screen.getByText('Opening balance')).toBeInTheDocument()
  })

  it('shows a refusal from main rather than a stale ledger', async () => {
    const user = userEvent.setup()
    renderScreen(<AccountLedger />, {
      bridge: {
        ledger: { listAccounts: () => Promise.resolve({ ok: true, data: ACCOUNTS }) },
        reports: {
          accountLedger: () =>
            Promise.resolve({
              ok: false,
              error: {
                code: 'ACCOUNT_IS_GROUP',
                message: 'A group holds no figures of its own.',
              },
            }),
        },
      },
    })
    await choose(user)

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('Opening balance')).toBeNull()
  })

  /*
   * The test above starts from a failure, so nothing was ever on screen to go stale. A
   * ledger that loaded and then failed to reload is the case that matters: figures for
   * one account sitting under an error about another are figures somebody will read.
   */
  it('clears a loaded ledger when a later request is refused', async () => {
    const user = userEvent.setup()
    let attempt = 0
    renderScreen(<AccountLedger />, {
      bridge: {
        ledger: { listAccounts: () => Promise.resolve({ ok: true, data: ACCOUNTS }) },
        reports: {
          accountLedger: () => {
            attempt += 1
            return Promise.resolve(
              attempt === 1
                ? { ok: true, data: ledger() }
                : { ok: false, error: { code: 'NO_COMPANY_OPEN', message: 'Open a company.' } },
            )
          },
        },
      },
    })

    await choose(user)
    expect(await screen.findByText('Opening balance')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Refresh' }))

    await screen.findByRole('alert')
    await waitFor(() => expect(screen.queryByText('Opening balance')).toBeNull())
  })

  /*
   * Choosing the blank option again is a real path — the user backs out of a report.
   * Without the guard it asks main for the ledger of an account with no id.
   */
  it('asks nothing and shows nothing when the choice is cleared', async () => {
    const user = userEvent.setup()
    const { bridge: fake } = renderScreen(<AccountLedger />, { bridge: bridge() })

    await choose(user)
    await waitFor(() => expect(fake.callsTo('reports:accountLedger')).toHaveLength(1))

    await user.selectOptions(screen.getByLabelText('Account'), '')

    expect(await screen.findByText('Choose an account to see its ledger.')).toBeInTheDocument()
    expect(fake.callsTo('reports:accountLedger')).toHaveLength(1)
  })
})
