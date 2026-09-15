/*
 * The chart of accounts, rendered.
 *
 * `filterChart` and `parentsForType` are covered as pure functions next door. What is
 * covered only here is the screen around them: that the tree indents, that the dialog
 * opens and sends what was typed, that a rejected account says why and keeps what the
 * user wrote, and that a successful one is confirmed rather than silently accepted.
 *
 * The dialog is the native `<dialog>` driven by `showModal()`, which is the reason this
 * suite needs a real DOM at all — see src/renderer/src/test/setup.ts.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Account, AccountType, CreateAccountInput, NormalBalance } from '@shared/dto'
import { renderScreen, type BridgeStub } from '../../test/harness'
import { ChartOfAccounts } from './ChartOfAccounts'

const NORMAL: Record<AccountType, NormalBalance> = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  income: 'credit',
}

function account(over: Partial<Account> & Pick<Account, 'code' | 'name' | 'type'>): Account {
  return {
    id: over.code,
    normalBalance: NORMAL[over.type],
    parentId: null,
    isGroup: false,
    isArchived: false,
    description: null,
    depth: 0,
    roles: [],
    ...over,
  }
}

const CHART: Account[] = [
  account({ code: '1000', name: 'Assets', type: 'asset', isGroup: true }),
  account({
    code: '1200',
    name: 'Bank Accounts',
    type: 'asset',
    isGroup: true,
    parentId: '1000',
    depth: 1,
  }),
  account({
    code: '1210',
    name: 'Current Account',
    type: 'asset',
    parentId: '1200',
    depth: 2,
    roles: ['default-bank'],
  }),
  account({ code: '2000', name: 'Liabilities', type: 'liability', isGroup: true }),
  account({
    code: '2100',
    name: 'Trade Payables',
    type: 'liability',
    parentId: '2000',
    depth: 1,
    roles: ['accounts-payable'],
  }),
  account({ code: '9000', name: 'Suspense', type: 'asset', isArchived: true }),
]

function listing(accounts: Account[] = CHART): BridgeStub {
  return {
    ledger: { listAccounts: () => Promise.resolve({ ok: true, data: accounts }) },
  }
}

async function rowFor(code: string): Promise<HTMLElement> {
  const cell = await screen.findByText(code)
  const row = cell.closest('tr')
  if (row === null) throw new Error(`No row around the cell for ${code}`)
  return row
}

/*
 * The name cell, by position rather than by its text.
 *
 * `accountTypeLabel` returns the plural heading — 'Assets' for `asset` — so the row
 * for the group actually named "Assets" carries that word in two different cells, and
 * `getByText('Assets')` is ambiguous inside a single row. Which cell is the name is a
 * question about the column, not about the string in it.
 */
function nameCellOf(row: HTMLElement): HTMLElement {
  const span = row.querySelectorAll('td')[1]?.querySelector('span')
  if (!(span instanceof HTMLElement)) throw new Error('No name cell in that row')
  return span
}

/** Opens the dialog and returns it, so assertions are scoped inside it. */
async function openNewAccount(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'New account' }))
  return await screen.findByRole('dialog')
}

describe('ChartOfAccounts', () => {
  it('lists the chart with its codes, names and roles', async () => {
    renderScreen(<ChartOfAccounts />, { bridge: listing() })

    const current = await rowFor('1210')
    expect(nameCellOf(current)).toHaveTextContent('Current Account')
    expect(within(current).getByText('Assets')).toBeInTheDocument()
    expect(within(current).getByText('default-bank')).toBeInTheDocument()
  })

  it('indents a child under its parent', async () => {
    renderScreen(<ChartOfAccounts />, { bridge: listing() })

    /* Depth 0, 1 and 2 — the tree is legible only if these differ, and differ in
     * proportion. A single indented row would pass a `not.toBe('0rem')`. */
    expect(nameCellOf(await rowFor('1000')).style.paddingInlineStart).toBe('0rem')
    expect(nameCellOf(await rowFor('1200')).style.paddingInlineStart).toBe('1.25rem')
    expect(nameCellOf(await rowFor('1210')).style.paddingInlineStart).toBe('2.5rem')
  })

  it('hides archived accounts until asked, and asks main rather than filtering here', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<ChartOfAccounts />, { bridge: listing() })

    await screen.findByText('Current Account')
    expect(bridge.lastCallTo('ledger:listAccounts')?.args[0]).toEqual({ includeArchived: false })

    await user.click(screen.getByLabelText('Show archived'))

    await waitFor(() =>
      expect(bridge.lastCallTo('ledger:listAccounts')?.args[0]).toEqual({ includeArchived: true }),
    )
  })

  it('marks an archived account as archived', async () => {
    renderScreen(<ChartOfAccounts />, { bridge: listing() })
    const suspense = await rowFor('9000')
    expect(within(suspense).getByText('Archived')).toBeInTheDocument()
  })

  it('keeps the ancestors of a match so the row is not orphaned', async () => {
    const user = userEvent.setup()
    renderScreen(<ChartOfAccounts />, { bridge: listing() })
    await screen.findByText('Current Account')

    await user.type(screen.getByPlaceholderText('Search by code, name or role'), 'Current')

    await waitFor(() => expect(screen.queryByText('Trade Payables')).toBeNull())
    expect(screen.getByText('Current Account')).toBeInTheDocument()
    /* Its parents are kept, dimmed, so the indentation still reads as a tree. */
    expect(nameCellOf(await rowFor('1000'))).toHaveTextContent('Assets')
    expect(nameCellOf(await rowFor('1200'))).toHaveTextContent('Bank Accounts')
    expect((await rowFor('1000')).className).toContain('ledger-table__row--context')
    expect((await rowFor('1210')).className).not.toContain('ledger-table__row--context')
  })

  it('finds an account by its role, not only by its name', async () => {
    const user = userEvent.setup()
    renderScreen(<ChartOfAccounts />, { bridge: listing() })
    await screen.findByText('Trade Payables')

    await user.type(screen.getByPlaceholderText('Search by code, name or role'), 'accounts-payable')

    await waitFor(() => expect(screen.queryByText('Current Account')).toBeNull())
    expect(screen.getByText('Trade Payables')).toBeInTheDocument()
  })

  it('says so when nothing matches, rather than showing an empty table', async () => {
    const user = userEvent.setup()
    renderScreen(<ChartOfAccounts />, { bridge: listing() })
    await screen.findByText('Current Account')

    await user.type(screen.getByPlaceholderText('Search by code, name or role'), 'zzzz')

    expect(await screen.findByText('Nothing matches that')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('shows a failure from main instead of an empty chart', async () => {
    renderScreen(<ChartOfAccounts />, {
      bridge: {
        ledger: {
          listAccounts: () =>
            Promise.resolve({
              ok: false,
              error: { code: 'NO_COMPANY_OPEN', message: 'Open a company first.' },
            }),
        },
      },
    })

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  // ---- Adding an account ---------------------------------------------------

  it('opens the dialog and sends what was typed', async () => {
    const user = userEvent.setup()
    const created = account({ code: '1250', name: 'Petty Cash', type: 'asset' })
    const createAccount = vi.fn(() => Promise.resolve({ ok: true as const, data: created }))

    const { bridge } = renderScreen(<ChartOfAccounts />, {
      bridge: { ledger: { ...listing().ledger, createAccount } },
    })

    const dialog = await openNewAccount(user)
    await user.type(within(dialog).getByLabelText('Code'), '1250')
    await user.type(within(dialog).getByLabelText('Name'), 'Petty Cash')
    await user.click(within(dialog).getByRole('button', { name: 'Add account' }))

    await waitFor(() => expect(bridge.callsTo('ledger:createAccount')).toHaveLength(1))
    expect(bridge.lastCallTo('ledger:createAccount')?.args[0]).toEqual({
      code: '1250',
      name: 'Petty Cash',
      type: 'asset',
      parentId: null,
      isGroup: false,
    } satisfies CreateAccountInput)
  })

  it('trims what was typed, so a stray space does not become part of the code', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<ChartOfAccounts />, {
      bridge: {
        ledger: {
          ...listing().ledger,
          createAccount: () =>
            Promise.resolve({
              ok: true,
              data: account({ code: '1250', name: 'Petty Cash', type: 'asset' }),
            }),
        },
      },
    })

    const dialog = await openNewAccount(user)
    await user.type(within(dialog).getByLabelText('Code'), '  1250  ')
    await user.type(within(dialog).getByLabelText('Name'), '  Petty Cash  ')
    await user.click(within(dialog).getByRole('button', { name: 'Add account' }))

    await waitFor(() => expect(bridge.callsTo('ledger:createAccount')).toHaveLength(1))
    const sent = bridge.lastCallTo('ledger:createAccount')?.args[0] as CreateAccountInput
    expect(sent.code).toBe('1250')
    expect(sent.name).toBe('Petty Cash')
  })

  it('will not submit an account with no code or no name', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<ChartOfAccounts />, { bridge: listing() })

    const dialog = await openNewAccount(user)
    const submit = within(dialog).getByRole('button', { name: 'Add account' })
    expect(submit).toBeDisabled()

    await user.type(within(dialog).getByLabelText('Code'), '1250')
    expect(submit).toBeDisabled()

    await user.type(within(dialog).getByLabelText('Name'), 'Petty Cash')
    expect(submit).toBeEnabled()

    expect(bridge.callsTo('ledger:createAccount')).toHaveLength(0)
  })

  it('offers only parents of the chosen type', async () => {
    const user = userEvent.setup()
    renderScreen(<ChartOfAccounts />, { bridge: listing() })
    await screen.findByText('Current Account')

    const dialog = await openNewAccount(user)
    const parent = within(dialog).getByLabelText('Inside')

    /* Asset groups only — a child carries its parent's type. */
    expect(within(parent).getByRole('option', { name: /1200/ })).toBeInTheDocument()
    expect(within(parent).queryByRole('option', { name: /2000/ })).toBeNull()

    await user.selectOptions(within(dialog).getByLabelText('Type'), 'liability')

    expect(within(parent).getByRole('option', { name: /2000/ })).toBeInTheDocument()
    expect(within(parent).queryByRole('option', { name: /1200/ })).toBeNull()
  })

  /*
   * Asserted on what is SENT, not on what the select shows.
   *
   * Reading `expect(parent).toHaveValue('')` after the type changes proves nothing: the
   * chosen option has just been removed from the list, and a <select> whose value no
   * longer exists falls back to the first option on its own. So the field reads "Top
   * level" whether or not the state behind it was cleared — mutation testing found the
   * assertion passing with `setParentId('')` deleted outright. The state is only
   * observable where it is used, which is in the input crossing the bridge.
   */
  it('drops the chosen parent when the type changes, rather than sending a stale one', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<ChartOfAccounts />, {
      bridge: {
        ledger: {
          ...listing().ledger,
          createAccount: () =>
            Promise.resolve({
              ok: true,
              data: account({ code: '2200', name: 'Loans', type: 'liability' }),
            }),
        },
      },
    })
    await screen.findByText('Current Account')

    const dialog = await openNewAccount(user)
    await user.selectOptions(within(dialog).getByLabelText('Inside'), '1200')
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'liability')

    await user.type(within(dialog).getByLabelText('Code'), '2200')
    await user.type(within(dialog).getByLabelText('Name'), 'Loans')
    await user.click(within(dialog).getByRole('button', { name: 'Add account' }))

    await waitFor(() => expect(bridge.callsTo('ledger:createAccount')).toHaveLength(1))
    const sent = bridge.lastCallTo('ledger:createAccount')?.args[0] as CreateAccountInput
    expect(sent.type).toBe('liability')
    /* Not '1200' — a liability filed under Bank Accounts, which the select was no
     * longer showing and the user never asked for. */
    expect(sent.parentId).toBeNull()
  })

  it('confirms a created account and reloads the chart', async () => {
    const user = userEvent.setup()
    const created = account({ code: '1250', name: 'Petty Cash', type: 'asset' })
    const { bridge } = renderScreen(<ChartOfAccounts />, {
      bridge: {
        ledger: {
          listAccounts: () => Promise.resolve({ ok: true, data: CHART }),
          createAccount: () => Promise.resolve({ ok: true, data: created }),
        },
      },
    })

    const dialog = await openNewAccount(user)
    await user.type(within(dialog).getByLabelText('Code'), '1250')
    await user.type(within(dialog).getByLabelText('Name'), 'Petty Cash')
    await user.click(within(dialog).getByRole('button', { name: 'Add account' }))

    /* The user is told, by name — a silent success is indistinguishable from a
     * dropped click. */
    expect(await screen.findByText('Account added')).toBeInTheDocument()
    expect(screen.getByText('1250 · Petty Cash is in the chart.')).toBeInTheDocument()

    expect(screen.queryByRole('dialog')).toBeNull()
    /* Once on mount, once after the account was added. */
    await waitFor(() => expect(bridge.callsTo('ledger:listAccounts')).toHaveLength(2))
  })

  it('keeps the dialog and what was typed when main refuses the account', async () => {
    const user = userEvent.setup()
    renderScreen(<ChartOfAccounts />, {
      bridge: {
        ledger: {
          ...listing().ledger,
          createAccount: () =>
            Promise.resolve({
              ok: false,
              error: { code: 'ACCOUNT_CODE_TAKEN', message: 'That code is already in use.' },
            }),
        },
      },
    })

    const dialog = await openNewAccount(user)
    await user.type(within(dialog).getByLabelText('Code'), '1210')
    await user.type(within(dialog).getByLabelText('Name'), 'Another Current Account')
    await user.click(within(dialog).getByRole('button', { name: 'Add account' }))

    expect(await within(dialog).findByRole('alert')).toBeInTheDocument()
    /* Still open, still holding the work — retyping it is the user's punishment for
     * our error message otherwise. */
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Code')).toHaveValue('1210')
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Another Current Account')
    expect(screen.queryByText('Account added')).toBeNull()
  })

  it('starts a second attempt empty rather than holding the last one', async () => {
    const user = userEvent.setup()
    renderScreen(<ChartOfAccounts />, { bridge: listing() })

    const first = await openNewAccount(user)
    await user.type(within(first).getByLabelText('Code'), '1250')
    await user.click(within(first).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const second = await openNewAccount(user)
    expect(within(second).getByLabelText('Code')).toHaveValue('')
  })
})

/*
 * B24: the lede has always said an account could be renamed, renumbered or archived, and
 * nothing on the screen did any of it.
 */
describe('changing an account', () => {
  it('opens an account by its name and sends every field it edits', async () => {
    const user = userEvent.setup()
    const updateAccount = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        data: account({ code: '1211', name: 'Main Account', type: 'asset', parentId: '1000' }),
      }),
    )
    const { bridge } = renderScreen(<ChartOfAccounts />, {
      bridge: { ledger: { ...listing().ledger, updateAccount } },
    })

    await user.click(await screen.findByRole('button', { name: 'Current Account' }))
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByRole('heading', { name: 'Edit 1210 · Current Account' }),
    ).toBeInTheDocument()
    /* The type is a fact, not a field. */
    expect(within(dialog).queryByLabelText('Type')).toBeNull()

    await user.clear(within(dialog).getByLabelText('Code'))
    await user.type(within(dialog).getByLabelText('Code'), ' 1211 ')
    await user.clear(within(dialog).getByLabelText('Name'))
    await user.type(within(dialog).getByLabelText('Name'), 'Main Account')
    await user.selectOptions(within(dialog).getByLabelText('Inside'), '1000')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(updateAccount).toHaveBeenCalledWith({
        id: '1210',
        code: '1211',
        name: 'Main Account',
        parentId: '1000',
        description: null,
      }),
    )
    expect(await screen.findByText('1211 · Main Account is up to date.')).toBeInTheDocument()
    await waitFor(() => expect(bridge.callsTo('ledger:listAccounts')).toHaveLength(2))
  })

  it('never offers to move a group inside itself or its own children', async () => {
    const user = userEvent.setup()
    renderScreen(<ChartOfAccounts />, { bridge: listing() })

    await user.click(await screen.findByRole('button', { name: 'Assets' }))
    const parent = within(await screen.findByRole('dialog')).getByLabelText('Inside')
    expect(within(parent).queryByRole('option', { name: /1000/ })).toBeNull()
    expect(within(parent).queryByRole('option', { name: /1200/ })).toBeNull()
    expect(within(parent).queryByRole('option', { name: /2000/ })).toBeNull()
  })

  it('archives from the row, and shows a refusal from main in its own words', async () => {
    const user = userEvent.setup()
    const updateAccount = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        error: {
          code: 'ACCOUNT_IN_USE',
          message: 'Something in these books still needs this group.',
        },
      }),
    )
    renderScreen(<ChartOfAccounts />, {
      bridge: { ledger: { ...listing().ledger, updateAccount } },
    })

    await user.click(within(await rowFor('1200')).getByRole('button', { name: 'Archive' }))

    await waitFor(() =>
      expect(updateAccount).toHaveBeenCalledWith({ id: '1200', isArchived: true }),
    )
    expect(await screen.findByText(/still needs this group/)).toBeInTheDocument()
  })

  /* Main refuses it, and nothing yet moves a role, so the button would be a dead end. */
  it('does not offer to archive an account the software posts through, and says why', async () => {
    const user = userEvent.setup()
    renderScreen(<ChartOfAccounts />, { bridge: listing() })

    expect(within(await rowFor('1210')).queryByRole('button', { name: 'Archive' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Current Account' }))
    expect(
      await within(await screen.findByRole('dialog')).findByText(
        /posts through it as default-bank/,
      ),
    ).toBeInTheDocument()
  })

  it('offers Restore on an archived account', async () => {
    const user = userEvent.setup()
    const updateAccount = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        data: account({ code: '9000', name: 'Suspense', type: 'asset' }),
      }),
    )
    renderScreen(<ChartOfAccounts />, {
      bridge: { ledger: { ...listing().ledger, updateAccount } },
    })

    await user.click(within(await rowFor('9000')).getByRole('button', { name: 'Restore' }))
    await waitFor(() =>
      expect(updateAccount).toHaveBeenCalledWith({ id: '9000', isArchived: false }),
    )
    expect(await screen.findByText('9000 · Suspense can be posted to again.')).toBeInTheDocument()
  })
})
