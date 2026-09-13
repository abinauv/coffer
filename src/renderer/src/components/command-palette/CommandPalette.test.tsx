/*
 * The command palette.
 *
 * `searchCommands`, `groupMatches` and the registry itself are covered as pure functions
 * in lib/command-registry.test.ts. What is covered only here is the shell around them:
 * that what the registry holds is what the palette offers, that the keyboard drives it,
 * and that running a command closes it.
 *
 * TWO THINGS ARE ARRANGED DELIBERATELY.
 *
 * THE FIXTURE'S REGISTRATION ORDER DISAGREES WITH ITS RANKED ORDER. 'New invoice' is
 * registered before 'Invoices', and typing "invo" ranks them the other way round — a
 * prefix match beats a match in the middle of the title. A fixture listed in the order
 * the assertions expect cannot tell a ranked list from an unranked one.
 *
 * THE DISABLED COMMAND IS LAST. It is rendered as the final option in the list, so
 * "End goes to the last option" and "End goes to the last RUNNABLE option" are
 * different answers and the test can tell them apart.
 *
 * AND ONE LIMITATION, MEASURED. happy-dom does not translate Escape into the `cancel`
 * event a browser fires on a modal `<dialog>` — nothing at all happens. So the Escape
 * test dispatches the `cancel` the platform would have dispatched, and says so. See the
 * header of atoms/Dialog.test.tsx for the full table.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JSX, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Command } from '../../lib/command-registry'
import { useCommands, useRegisterCommands } from '../../store/commands'
import { renderScreen } from '../../test/harness'
import { CommandPalette } from './CommandPalette'

const runNewInvoice = vi.fn()
const runInvoices = vi.fn()
const runLedger = vi.fn()
const runBackup = vi.fn()
const runClosePeriod = vi.fn()

/* Module scope, so the array identity is stable — `useRegisterCommands` re-registers on
 * every change of identity, and a fresh array per render is an infinite loop. */
const COMMANDS: readonly Command[] = [
  {
    id: 'invoice.new',
    title: 'New invoice',
    section: 'Sales',
    shortcut: { key: 'i', ctrlOrCmd: true },
    run: runNewInvoice,
  },
  {
    id: 'invoice.list',
    title: 'Invoices',
    section: 'Sales',
    hint: 'Last raised 14 Aug',
    run: runInvoices,
  },
  {
    id: 'ledger.open',
    title: 'Open the general ledger',
    section: 'Ledger',
    keywords: ['journal'],
    run: runLedger,
  },
  { id: 'company.backup', title: 'Back up the company', section: 'Company', run: runBackup },
  {
    id: 'period.close',
    title: 'Close the period',
    section: 'Company',
    isDisabled: true,
    run: runClosePeriod,
  },
]

const LATER: readonly Command[] = [
  { id: 'party.new', title: 'New customer', section: 'Parties', run: () => {} },
]

function Registers({ commands }: { commands: readonly Command[] }): JSX.Element {
  useRegisterCommands(commands)
  return <></>
}

/** Opens the palette the way the title bar does, and reports whether it is open. */
function Opener(): JSX.Element {
  const { isPaletteOpen, setPaletteOpen } = useCommands()
  return (
    <>
      <button type="button" onClick={() => setPaletteOpen(true)}>
        open the palette
      </button>
      <p>palette: {isPaletteOpen ? 'open' : 'closed'}</p>
    </>
  )
}

function mount(extra: ReactNode = null): void {
  renderScreen(
    <>
      <Registers commands={COMMANDS} />
      {extra}
      <Opener />
      <CommandPalette />
    </>,
  )
}

async function open(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'open the palette' }))
  return await screen.findByRole('combobox', { name: 'Search commands' })
}

/**
 * One option, found by the text in its TITLE cell rather than by its accessible name.
 *
 * Two reasons, and the second is the general one. An option's accessible name is the
 * whole row — title, hint and keycaps — so `{ name: /Invoices/ }` would also be
 * satisfied by a hint that happened to say it. And highlighting splits the title across
 * `<mark>` elements, which `dom-accessibility-api` joins with a space: the matched
 * option's name is literally "Invo ices Last raised 14 Aug". Scope to the cell.
 */
function optionFor(title: string): HTMLElement {
  const found = [...document.querySelectorAll('.palette__item')].find(
    (item) => item.querySelector('.palette__item-title')?.textContent === title,
  )
  if (!(found instanceof HTMLElement)) throw new Error(`No option titled "${title}"`)
  return found
}

/** The titles of the options on offer, in the order they are drawn. */
function optionTitles(): string[] {
  return screen.queryAllByRole('option').map((option) => {
    const title = option.querySelector('.palette__item-title')
    return title?.textContent ?? ''
  })
}

/**
 * The option `aria-activedescendant` points at, resolved through the document.
 *
 * Resolved rather than compared as a string on purpose: an id that names no element is
 * the failure mode the palette's own comment warns about, and a test comparing two
 * strings would never notice it.
 */
function activeTitle(input: HTMLElement): string {
  const id = input.getAttribute('aria-activedescendant')
  if (id === null) return '<none>'
  const option = document.getElementById(id)
  if (option === null) throw new Error(`aria-activedescendant points at no element: ${id}`)
  expect(option).toHaveAttribute('aria-selected', 'true')
  return option.querySelector('.palette__item-title')?.textContent ?? ''
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('opening and closing', () => {
  it('is not on screen until it is opened', () => {
    mount()

    expect(screen.queryByRole('combobox', { name: 'Search commands' })).toBeNull()
    expect(screen.queryByRole('option')).toBeNull()
    expect(screen.getByText(/palette:/)).toHaveTextContent('palette: closed')
  })

  it('opens with the search field focused, so typing goes straight into it', async () => {
    const user = userEvent.setup()
    mount()

    const input = await open(user)

    await waitFor(() => expect(input).toHaveFocus())
  })

  /* Escape reaches the palette through the dialog's `cancel`, which happy-dom will not
   * produce from a keystroke — so the platform's event is dispatched directly. */
  it('closes when the platform reports the dialog was cancelled', async () => {
    const user = userEvent.setup()
    mount()

    await open(user)
    const dialog = document.querySelector('dialog')
    if (!(dialog instanceof HTMLDialogElement)) throw new Error('No dialog')

    act(() => {
      dialog.dispatchEvent(new Event('cancel', { bubbles: false, cancelable: true }))
    })

    expect(screen.getByText(/palette:/)).toHaveTextContent('palette: closed')
    expect(screen.queryByRole('combobox', { name: 'Search commands' })).toBeNull()
  })

  /*
   * A palette that reopens showing the last query runs the wrong command on a fast
   * return — the user types nothing, presses Enter, and gets whatever the previous
   * search had selected.
   */
  it('forgets the previous query when it is reopened', async () => {
    const user = userEvent.setup()
    mount()

    const input = await open(user)
    await user.type(input, 'invo')
    expect(input).toHaveValue('invo')

    const dialog = document.querySelector('dialog')
    if (!(dialog instanceof HTMLDialogElement)) throw new Error('No dialog')
    act(() => {
      dialog.dispatchEvent(new Event('cancel', { bubbles: false, cancelable: true }))
    })

    const reopened = await open(user)
    expect(reopened).toHaveValue('')
    expect(optionTitles()).toHaveLength(COMMANDS.length)
  })
})

describe('what it lists', () => {
  it('offers every registered command, in registration order, until asked otherwise', async () => {
    const user = userEvent.setup()
    mount()

    await open(user)

    expect(optionTitles()).toEqual([
      'New invoice',
      'Invoices',
      'Open the general ledger',
      'Back up the company',
      'Close the period',
    ])
  })

  it('groups them under their sections', async () => {
    const user = userEvent.setup()
    mount()

    await open(user)

    const sales = screen.getByRole('group', { name: 'Sales' })
    expect(within(sales).getAllByRole('option')).toHaveLength(2)
    expect(screen.getByRole('group', { name: 'Ledger' })).toBeVisible()
    expect(
      within(screen.getByRole('group', { name: 'Company' })).getAllByRole('option'),
    ).toHaveLength(2)
  })

  it('shows a command hint and its shortcut beside it', async () => {
    const user = userEvent.setup()
    mount()

    await open(user)

    const invoices = optionFor('Invoices')
    expect(within(invoices).getByText('Last raised 14 Aug')).toBeVisible()

    const newInvoice = optionFor('New invoice')
    expect([...newInvoice.querySelectorAll('kbd')].map((cap) => cap.textContent)).toEqual([
      'Ctrl',
      'I',
    ])
  })

  it('marks a disabled command as disabled rather than hiding it', async () => {
    const user = userEvent.setup()
    mount()

    await open(user)

    const closePeriod = optionFor('Close the period')
    expect(closePeriod).toHaveAttribute('aria-disabled', 'true')
    expect(optionFor('Invoices')).not.toHaveAttribute('aria-disabled')
  })
})

describe('filtering', () => {
  /*
   * RANKED, NOT MERELY FILTERED. 'Invoices' is registered second and must be listed
   * first, because "invo" begins it. Reverse the ranking and this assertion moves; drop
   * the ranking and it moves too.
   */
  it('narrows to what matches, best match first', async () => {
    const user = userEvent.setup()
    mount()

    const input = await open(user)
    await user.type(input, 'invo')

    expect(optionTitles()).toEqual(['Invoices', 'New invoice'])
  })

  it('finds a command by a keyword that is never shown', async () => {
    const user = userEvent.setup()
    mount()

    const input = await open(user)
    await user.type(input, 'journal')

    expect(optionTitles()).toEqual(['Open the general ledger'])
    expect(screen.queryByText('journal', { selector: '.palette__item-hint' })).toBeNull()
  })

  it('marks the characters that matched', async () => {
    const user = userEvent.setup()
    mount()

    const input = await open(user)
    await user.type(input, 'invo')

    const invoices = optionFor('Invoices')
    expect(invoices.querySelector('mark')).toHaveTextContent('Invo')
  })

  it('says what it found nothing for, and claims no popup', async () => {
    const user = userEvent.setup()
    mount()

    const input = await open(user)
    await user.type(input, 'zzz')

    expect(screen.getByText(/No command matches/)).toHaveTextContent('No command matches zzz.')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(input).not.toHaveAttribute('aria-controls')
    expect(input).not.toHaveAttribute('aria-activedescendant')
  })

  it('claims its popup while there is one', async () => {
    const user = userEvent.setup()
    mount()

    const input = await open(user)

    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(input).toHaveAttribute('aria-controls', 'command-palette-list')
    expect(screen.getByRole('listbox', { name: 'Commands' })).toHaveAttribute(
      'id',
      'command-palette-list',
    )
  })
})

describe('the keyboard', () => {
  it('starts on the first command', async () => {
    const user = userEvent.setup()
    mount()

    const input = await open(user)

    expect(activeTitle(input)).toBe('New invoice')
  })

  it('moves down and up, and wraps at both ends', async () => {
    const user = userEvent.setup()
    mount()

    const input = await open(user)

    await user.keyboard('{ArrowDown}')
    expect(activeTitle(input)).toBe('Invoices')

    await user.keyboard('{ArrowUp}')
    expect(activeTitle(input)).toBe('New invoice')

    /* Up from the top lands on the last RUNNABLE command, not on the last option. */
    await user.keyboard('{ArrowUp}')
    expect(activeTitle(input)).toBe('Back up the company')

    await user.keyboard('{ArrowDown}')
    expect(activeTitle(input)).toBe('New invoice')
  })

  it('moves with Ctrl+N and Ctrl+P as well as the arrows', async () => {
    const user = userEvent.setup()
    mount()

    const input = await open(user)

    await user.keyboard('{Control>}n{/Control}')
    expect(activeTitle(input)).toBe('Invoices')

    await user.keyboard('{Control>}p{/Control}')
    expect(activeTitle(input)).toBe('New invoice')
  })

  /*
   * END GOES TO THE LAST RUNNABLE COMMAND. 'Close the period' is disabled and is the
   * last option drawn, so an implementation that walked the rendered list instead of the
   * runnable one would land on it — and Enter would then do nothing at all.
   */
  it('jumps to the first and last runnable commands', async () => {
    const user = userEvent.setup()
    mount()

    const input = await open(user)

    await user.keyboard('{End}')
    expect(activeTitle(input)).toBe('Back up the company')

    await user.keyboard('{Home}')
    expect(activeTitle(input)).toBe('New invoice')
  })

  it('follows the filtered list rather than the full one', async () => {
    const user = userEvent.setup()
    mount()

    const input = await open(user)
    await user.type(input, 'invo')

    /* The selection resets to the top of the new results, not to wherever it was. */
    expect(activeTitle(input)).toBe('Invoices')

    await user.keyboard('{ArrowDown}')
    expect(activeTitle(input)).toBe('New invoice')

    await user.keyboard('{ArrowDown}')
    expect(activeTitle(input)).toBe('Invoices')
  })
})

describe('running a command', () => {
  it('runs the active one on Enter and closes the palette', async () => {
    const user = userEvent.setup()
    mount()

    const input = await open(user)
    await user.keyboard('{ArrowDown}')
    expect(activeTitle(input)).toBe('Invoices')

    await user.keyboard('{Enter}')

    expect(runInvoices).toHaveBeenCalledTimes(1)
    expect(runNewInvoice).not.toHaveBeenCalled()
    expect(screen.getByText(/palette:/)).toHaveTextContent('palette: closed')
  })

  it('runs the one that was clicked', async () => {
    const user = userEvent.setup()
    mount()

    await open(user)
    await user.click(optionFor('Open the general ledger'))

    expect(runLedger).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/palette:/)).toHaveTextContent('palette: closed')
  })

  it('does nothing when a disabled command is clicked, and stays open', async () => {
    const user = userEvent.setup()
    mount()

    await open(user)
    await user.click(optionFor('Close the period'))

    expect(runClosePeriod).not.toHaveBeenCalled()
    expect(screen.getByText(/palette:/)).toHaveTextContent('palette: open')
  })

  it('runs nothing on Enter when nothing matched', async () => {
    const user = userEvent.setup()
    mount()

    const input = await open(user)
    await user.type(input, 'zzz')
    await user.keyboard('{Enter}')

    expect(runNewInvoice).not.toHaveBeenCalled()
    expect(runInvoices).not.toHaveBeenCalled()
    expect(screen.getByText(/palette:/)).toHaveTextContent('palette: open')
  })
})

/*
 * WHAT THE PALETTE OFFERS IS WHAT IS ACTUALLY AVAILABLE. A screen contributes its
 * commands while it is mounted and takes them away when it goes, so a palette listing a
 * command whose screen has been left is a palette offering an action that cannot work.
 */
describe('registration', () => {
  it('picks up a command contributed by something else on screen', async () => {
    const user = userEvent.setup()
    mount(<Registers commands={LATER} />)

    await open(user)

    expect(optionTitles()).toContain('New customer')
    expect(screen.getByRole('group', { name: 'Parties' })).toBeVisible()
  })

  it('drops it again when its owner leaves', async () => {
    const user = userEvent.setup()

    function Host(): JSX.Element {
      const { isPaletteOpen } = useCommands()
      return (
        <>
          {/* Registered only while the palette is closed, so opening it takes the
              command away — a stand-in for a screen being navigated away from. */}
          {!isPaletteOpen && <Registers commands={LATER} />}
          <p>parties: {isPaletteOpen ? 'gone' : 'here'}</p>
        </>
      )
    }

    renderScreen(
      <>
        <Registers commands={COMMANDS} />
        <Host />
        <Opener />
        <CommandPalette />
      </>,
    )

    expect(screen.getByText(/parties:/)).toHaveTextContent('parties: here')

    await open(user)

    expect(optionTitles()).not.toContain('New customer')
    expect(optionTitles()).toContain('New invoice')
    expect(screen.queryByRole('group', { name: 'Parties' })).toBeNull()
  })
})

describe('the pointer', () => {
  it('makes the option under the pointer the active one', async () => {
    const user = userEvent.setup()
    mount()

    const input = await open(user)
    await user.pointer({
      target: optionFor('Back up the company'),
      coords: { x: 1, y: 1 },
    })

    expect(activeTitle(input)).toBe('Back up the company')
  })

  it('leaves the selection alone when the pointer is over a disabled command', async () => {
    const user = userEvent.setup()
    mount()

    const input = await open(user)
    await user.pointer({
      target: optionFor('Close the period'),
      coords: { x: 1, y: 1 },
    })

    expect(activeTitle(input)).toBe('New invoice')
  })
})

/* Not through `renderScreen`: the point is the error, and it must name the provider a
 * reader has to go and add. */
describe('outside a CommandProvider', () => {
  it('throws, naming the provider', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => render(<CommandPalette />)).toThrow(/CommandProvider/)

    quiet.mockRestore()
  })
})
