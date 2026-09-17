/*
 * The application shell.
 *
 * TWO LAYOUTS, CHOSEN BY THE AREA OF THE ROUTE AND NOTHING ELSE. `welcome` has no section
 * bar, rail or status bar, because there is nothing to navigate between until a company is
 * unlocked and offering navigation would be a lie about what is reachable. `workspace` has
 * all three. Both are asserted, in both directions, because "the rail is present" is
 * satisfied by a shell that always draws it.
 *
 * What the section bar and the rail do with a route is ContextRail.test.tsx's; this file
 * asserts that the frame draws them and owns their commands.
 *
 * AND THE COMMANDS THE FRAME OWNS. Everything keyboard-reachable in Coffer goes through
 * the registry, so the assertions here are on WHAT REACHED THE REGISTRY rather than on
 * what the palette happens to draw — a command whose title renders correctly but whose
 * `isDisabled` is wrong looks identical on screen and does nothing when you press Enter.
 *
 * The regime is supplied directly rather than through `OpenCompanyRegime`: the gate that
 * provider implements is tested in store/regime.test.tsx, and it would only add a round
 * trip between every assertion here and the shell it is about.
 *
 * THE PROVIDERS COME FROM `renderScreen` NOW, and the company with them. This file used
 * to nest seven providers by hand and carry its own `Opener` calling `adopt`; five other
 * files carried the same pair, because the harness supplied everything a screen expects
 * EXCEPT the company the shell's whole structure is derived from.
 *
 * AND THE SHELL'S TESTS INHERIT THE LANDING SCREEN'S READS, which is why `BRIDGE` below
 * answers channels no assertion here mentions. `AppShell` renders the active screen, the
 * workspace lands on the Overview, and the Overview reads the aged reports, its own two
 * figures and the counts of documents and receipts. That is not a fault in either batch — it is what
 * mounting the whole frame means — and the honest fix is for the frame's own harness to
 * answer them rather than for the dashboard to read less. The title bar's read of the
 * periods, for the financial year, is answered the same way.
 */

import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JSX } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AgedReport, CompanySummary, DocumentListRow, Result } from '@shared/dto'
import { DEFAULT_COMPANY, renderScreen, type BridgeStub } from '@renderer/test/harness'
import type { Command } from '../../lib/command-registry'
import { DENSITY_STORAGE_KEY } from '../../lib/density'
import { RAIL_STORAGE_KEY } from '../../lib/layout'
import { registerScreens } from '../../lib/screens'
import { THEME_STORAGE_KEY } from '../../lib/theme'
import { useCommands } from '../../store/commands'
import { useNavigation } from '../../store/navigation'
import { formatShortcut } from '../../lib/keys'
import { SHORTCUTS } from '../../lib/shortcuts'
import { AppShell } from './AppShell'

const ACME: CompanySummary = DEFAULT_COMPANY

/* A workspace screen of this file's own, so the "Go to …" commands can be asserted
 * against something that does not move when the product grows. */
registerScreens([
  {
    id: 'shell-probe',
    title: 'The shell probe screen',
    area: 'workspace',
    nav: { label: 'Shell probe', icon: 'ledger', group: 'reports', order: 990 },
    render: () => <p>the shell probe screen</p>,
  },
])

let commands: readonly Command[] = []
let route = ''

function Probe(): JSX.Element {
  commands = useCommands().commands
  route = useNavigation().route.screenId
  return <></>
}

const ok = <T,>(data: T): Promise<Result<T>> => Promise.resolve({ ok: true, data })

/*
 * An aged report with nothing on it, for the dashboard the workspace lands on.
 *
 * EMPTY AND VALID RATHER THAN A REFUSAL. A stub answering `ok: false` would also stop the
 * misses, and would render the frame around a page of error notices — the one state of
 * the dashboard the shell's tests have no reason to be looking at. Nothing here is
 * asserted on; it exists so the frame draws its ordinary contents.
 */
const NOTHING_OUTSTANDING: AgedReport = {
  side: 'sales',
  asAtDate: '2026-08-14',
  accountId: 'account-1',
  accountCode: '1300',
  accountName: 'Accounts Receivable',
  buckets: [],
  parties: [],
  totals: { buckets: [], onAccount: '0.00', overdue: '0.00', total: '0.00' },
  controlBalance: '0.00',
  ties: true,
}

const BRIDGE: BridgeStub = {
  companies: {
    list: () => ok<CompanySummary[]>([]),
    close: () => ok<void>(undefined),
  },
  /* The dashboard's reads. See the header: the frame renders the active screen, so the
   * frame's tests answer whatever that screen asks for. */
  reports: {
    aged: (input) => ok<AgedReport>({ ...NOTHING_OUTSTANDING, side: input.side }),
    overviewFigures: (input) =>
      ok({
        asAtDate: input.asAtDate,
        cashAndBank: { total: '0.00', accounts: [] },
        monthToDate: { fromDate: input.asAtDate, toDate: input.asAtDate, netProfit: '0.00' },
      }),
    taxReturnsDue: () => ok([]),
  },
  documents: { list: () => ok<DocumentListRow[]>([]), count: () => ok(0) },
  receipts: { count: () => ok(0) },
  companyProfile: { get: () => ok(null) },
  parties: { list: () => ok([]) },
  ledger: { listPeriods: () => ok([]) },
}

function mount({ isCompanyOpen = false } = {}): void {
  renderScreen(
    <>
      <Probe />
      <AppShell />
    </>,
    {
      bridge: BRIDGE,
      company: isCompanyOpen ? ACME : null,
      /* The shell draws its own, and two landmarks named `Notifications` is an ambiguity
       * `getByRole` reports as a failure rather than as the duplicate it is. */
      toastViewport: false,
    },
  )
}

function ids(): string[] {
  return commands.map((command) => command.id)
}

function commandFor(id: string): Command {
  const found = commands.find((command) => command.id === id)
  if (!found) throw new Error(`No command registered as '${id}'. Registered: ${ids().join(', ')}`)
  return found
}

function run(id: string): void {
  act(() => {
    void commandFor(id).run()
  })
}

function shell(): HTMLElement {
  const app = document.querySelector('.app')
  if (!(app instanceof HTMLElement)) throw new Error('No shell was rendered')
  return app
}

function sectionBar(): HTMLElement | null {
  return screen.queryByRole('navigation', { name: 'Sections' })
}

/* Named by its section. The workspace lands on the Overview, which is under Accounts. */
function rail(): HTMLElement | null {
  return document.querySelector('nav.rail')
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-density')
})

describe('the two layouts', () => {
  it('draws no section bar, rail or status bar while no company is open', () => {
    mount({ isCompanyOpen: false })

    expect(shell()).toHaveAttribute('data-area', 'welcome')
    expect(sectionBar()).toBeNull()
    expect(rail()).toBeNull()
    expect(screen.queryByRole('contentinfo')).toBeNull()
  })

  it('draws all three once a company is open, landing on Accounts', () => {
    mount({ isCompanyOpen: true })

    expect(shell()).toHaveAttribute('data-area', 'workspace')
    expect(sectionBar()).toBeVisible()
    expect(screen.getByRole('navigation', { name: 'Accounts' })).toBe(rail())
    expect(screen.getByRole('contentinfo')).toHaveTextContent('/books/acme.coffer')
  })

  it('always carries the title bar', () => {
    mount({ isCompanyOpen: false })

    expect(document.querySelector('.titlebar')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Search or run a command' })).toBeVisible()
  })

  it('always carries the notifications region', () => {
    mount({ isCompanyOpen: false })

    expect(screen.getByRole('region', { name: 'Notifications' })).toBeVisible()
  })

  /* A keyboard user must be able to get past the title bar, the section bar and the rail in
   * one keystroke, and the target has to be focusable or the link goes nowhere. */
  it('offers a skip link that points at a focusable main', async () => {
    const user = userEvent.setup()
    mount({ isCompanyOpen: true })

    const link = screen.getByRole('link', { name: 'Skip to content' })
    expect(link).toHaveAttribute('href', '#main')

    const main = document.getElementById('main')
    expect(main?.tagName).toBe('MAIN')
    expect(main).toHaveAttribute('tabindex', '-1')

    await user.tab()
    expect(link).toHaveFocus()
  })
})

describe('the commands the frame owns', () => {
  it('registers the palette and the way back', () => {
    mount()

    expect(ids()).toContain('palette.open')
    expect(commandFor('palette.open').shortcut).toEqual({ key: 'k', ctrlOrCmd: true })
    expect(ids()).toContain('nav.back')
  })

  /* Ctrl [ belongs to the previous section now, as the design's key map has it. */
  it('puts Back on Alt ←, which every browser and file manager already uses', () => {
    mount()

    expect(commandFor('nav.back').shortcut).toEqual({ key: 'ArrowLeft', alt: true })
  })

  it('goes back on Alt ←', async () => {
    const user = userEvent.setup()
    mount({ isCompanyOpen: true })
    run('go.workspace.shell-probe')
    expect(route).toBe('shell-probe')

    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}')

    expect(route).toBe('overview')
  })

  /*
   * BACK IS OFFERED AND REFUSED, rather than hidden. A command that disappears when it
   * cannot run makes the palette's contents jump around; one that is listed and disabled
   * says why it is greyed. Both states are asserted, because "disabled" alone is
   * satisfied by a command that is always disabled.
   */
  it('disables Back until there is somewhere to go back to', () => {
    mount({ isCompanyOpen: true })
    expect(commandFor('nav.back').isDisabled).toBe(true)

    run('go.workspace.shell-probe')

    expect(route).toBe('shell-probe')
    expect(commandFor('nav.back').isDisabled).toBe(false)
  })

  it('offers a Go to for every navigable screen in the area it is in', () => {
    mount({ isCompanyOpen: true })

    const go = commandFor('go.workspace.shell-probe')
    expect(go.title).toBe('Go to Shell probe')
    expect(go.section).toBe('Go to')
  })

  /* The welcome area has its own screens and none of the workspace's. Offering "Go to
   * the ledger" from the picker would be offering a route into books that are locked. */
  it('offers none of the workspace screens while no company is open', () => {
    mount({ isCompanyOpen: false })

    expect(ids().filter((id) => id.startsWith('go.workspace.'))).toEqual([])
  })

  it('registers the appearance choices and marks the current one', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    mount()

    expect(ids()).toContain('view.theme.system')
    expect(ids()).toContain('view.theme.light')
    expect(ids()).toContain('view.theme.dark')
    expect(commandFor('view.theme.dark').hint).toBe('Current')
    expect(commandFor('view.theme.light').hint).toBeUndefined()
    expect(commandFor('view.theme.system').hint).toBeUndefined()
  })

  it('moves the mark when the appearance changes', () => {
    mount()
    expect(commandFor('view.theme.system').hint).toBe('Current')

    run('view.theme.light')

    expect(commandFor('view.theme.light').hint).toBe('Current')
    expect(commandFor('view.theme.system').hint).toBeUndefined()
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
  })

  it('registers both densities and marks the one stored', () => {
    localStorage.setItem(DENSITY_STORAGE_KEY, 'compact')
    mount()

    expect(commandFor('view.density.compact').hint).toBe('Current')
    expect(commandFor('view.density.comfortable').hint).toBeUndefined()
    expect(commandFor('view.density.compact').title).toBe('Density: compact')
  })

  /* The whole preference end to end: the command, the attribute tokens.css keys on, and
   * the stored value that survives a relaunch. Comfortable REMOVES the attribute. */
  it('switches density from the palette, writes the attribute and remembers it', () => {
    mount()
    expect(commandFor('view.density.comfortable').hint).toBe('Current')

    run('view.density.compact')
    expect(document.documentElement).toHaveAttribute('data-density', 'compact')
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe('compact')
    expect(commandFor('view.density.compact').hint).toBe('Current')

    run('view.density.comfortable')
    expect(document.documentElement).not.toHaveAttribute('data-density')
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe('comfortable')
  })

  /*
   * TWO WAYS OUT OF THE BOOKS, AND THE DIFFERENCE IS WHERE EACH ONE LANDS. Both close the
   * company; Lock stops at the unlock screen for the company that was open and Switch goes
   * to the picker. Only Lock names the company, because only Lock is about that one.
   */
  it('offers locking the books only when a company is open, and names it', () => {
    mount({ isCompanyOpen: true })

    expect(commandFor('company.lock').hint).toBe('Acme Pvt Ltd')
    expect(commandFor('company.lock').shortcut).toEqual(SHORTCUTS.lock)
    expect(commandFor('company.switch').shortcut).toEqual(SHORTCUTS.switchCompany)
  })

  it('offers neither way out when no company is open', () => {
    mount({ isCompanyOpen: false })

    expect(ids()).not.toContain('company.lock')
    expect(ids()).not.toContain('company.switch')
  })
})

/*
 * THE RAIL AND SECTION COMMANDS ARE REGISTERED BY THE WORKSPACE, not by the shell, so that
 * none of them can fire from the picker where there is nothing to collapse or step through.
 */
describe('the workspace commands', () => {
  it('exist in the workspace and not in the welcome area', () => {
    mount({ isCompanyOpen: false })
    expect(ids()).not.toContain('view.toggle-rail')
    expect(ids()).not.toContain('nav.section.next')
    expect(ids()).not.toContain('nav.section.previous')

    localStorage.clear()
    mount({ isCompanyOpen: true })
    expect(ids()).toContain('view.toggle-rail')
    expect(ids()).toContain('nav.section.next')
    expect(ids()).toContain('nav.section.previous')
  })

  it('collapses the rail, and says what it will do next', () => {
    localStorage.setItem(RAIL_STORAGE_KEY, 'expanded')
    mount({ isCompanyOpen: true })

    expect(rail()).toHaveAttribute('data-collapsed', 'false')
    expect(commandFor('view.toggle-rail').title).toBe('Collapse the rail to icons')

    run('view.toggle-rail')

    expect(rail()).toHaveAttribute('data-collapsed', 'true')
    expect(commandFor('view.toggle-rail').title).toBe('Expand the rail')
  })

  /* Once the user has taken a position, the window resizing under them must not
   * silently overrule it — so the toggle always writes an explicit preference. */
  it('remembers the choice rather than leaving it to the viewport', () => {
    localStorage.setItem(RAIL_STORAGE_KEY, 'expanded')
    mount({ isCompanyOpen: true })

    run('view.toggle-rail')

    expect(localStorage.getItem(RAIL_STORAGE_KEY)).toBe('collapsed')
  })

  it('takes the stored preference over the viewport on the first paint', () => {
    localStorage.setItem(RAIL_STORAGE_KEY, 'collapsed')
    mount({ isCompanyOpen: true })

    expect(rail()).toHaveAttribute('data-collapsed', 'true')
  })

  it('binds the next and previous section to Ctrl ] and Ctrl [', () => {
    mount({ isCompanyOpen: true })

    expect(commandFor('nav.section.next').shortcut).toEqual({ key: ']', ctrlOrCmd: true })
    expect(commandFor('nav.section.previous').shortcut).toEqual({ key: '[', ctrlOrCmd: true })
  })

  /* Between the probe (Reports) and the Overview (Accounts), which is next to it: each
   * section lands on the screen last open in it, so no other screen is ever drawn. */
  it('steps through the sections from the keyboard', async () => {
    const user = userEvent.setup()
    mount({ isCompanyOpen: true })
    run('go.workspace.shell-probe')

    await user.keyboard('{Control>}[[{/Control}')
    expect(route).toBe('overview')
    expect(screen.getByRole('navigation', { name: 'Accounts' })).toBe(rail())

    await user.keyboard('{Control>}]{/Control}')
    expect(route).toBe('shell-probe')
    expect(screen.getByRole('navigation', { name: 'Reports' })).toBe(rail())
  })
})

describe('the palette', () => {
  it('is reachable from the title bar and lists the frame commands', async () => {
    const user = userEvent.setup()
    mount({ isCompanyOpen: true })

    await user.click(screen.getByRole('button', { name: 'Search or run a command' }))

    const search = await screen.findByRole('combobox', { name: 'Search commands' })
    expect(search).toBeVisible()
    const listbox = screen.getByRole('listbox', { name: 'Commands' })
    expect(within(listbox).getByText('Go to Shell probe')).toBeVisible()
  })

  /* The one shortcut the shell owns outright: Ctrl+K from anywhere. It is declared on
   * the command, and the single global listener is what makes it work. */
  it('opens on its shortcut', async () => {
    const user = userEvent.setup()
    mount({ isCompanyOpen: true })

    await user.keyboard('{Control>}k{/Control}')

    expect(await screen.findByRole('combobox', { name: 'Search commands' })).toBeVisible()
  })

  it('navigates when a Go to command is run from it', async () => {
    const user = userEvent.setup()
    mount({ isCompanyOpen: true })

    await user.keyboard('{Control>}k{/Control}')
    const search = await screen.findByRole('combobox', { name: 'Search commands' })
    await user.type(search, 'Shell probe')
    await user.keyboard('{Enter}')

    expect(route).toBe('shell-probe')
    expect(screen.getByText('the shell probe screen')).toBeVisible()
  })
})

/*
 * LEAVING THE BOOKS FROM THE KEYBOARD, and where each key lands.
 *
 * Both close the company, so both leave the workspace; the difference is the door they
 * stop at. Asserted through the route, because that is the whole of the difference.
 */
describe('locking and switching', () => {
  it('locks to the unlock screen of the company that was open', async () => {
    const user = userEvent.setup()
    mount({ isCompanyOpen: true })

    await user.keyboard('{Control>}l{/Control}')

    await waitFor(() => expect(route).toBe('unlock'))
  })

  it('switches to the picker', async () => {
    const user = userEvent.setup()
    mount({ isCompanyOpen: true })

    await user.keyboard('{Control>}{Shift>}o{/Shift}{/Control}')

    await waitFor(() => expect(route).toBe('companies'))
  })

  /*
   * ONE CHORD, ONE COMMAND, at any moment. Two commands on one chord is a binding that
   * works until both screens are on at once and then fires whichever registered last —
   * a defect nobody can reproduce on purpose. `shortcuts.test.ts` holds the map itself;
   * this holds what is actually registered with a company open and a screen drawn.
   */
  it('claims no chord twice', async () => {
    mount({ isCompanyOpen: true })
    await screen.findByRole('navigation', { name: 'Accounts' })

    const chords = commands
      .filter((command) => command.shortcut !== undefined)
      .map((command) => `${command.id}:${formatShortcut(command.shortcut!, 'win32')}`)
    const keys = chords.map((entry) => entry.split(':')[1])

    expect(new Set(keys).size, chords.join(', ')).toBe(keys.length)
  })
})
