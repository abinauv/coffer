/*
 * The application shell.
 *
 * TWO LAYOUTS, CHOSEN BY THE AREA OF THE ROUTE AND NOTHING ELSE. `welcome` has no
 * sidebar, because there is nothing to navigate between until a company is unlocked and
 * offering a nav rail would be a lie about what is reachable. `workspace` has one. Both
 * are asserted, in both directions, because "the sidebar is present" is satisfied by a
 * shell that always draws it.
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
 * workspace lands on the dashboard, and the dashboard reads the aged reports, the
 * document register and the receipts. That is not a fault in either batch — it is what
 * mounting the whole frame means — and the honest fix is for the frame's own harness to
 * answer them rather than for the dashboard to read less.
 */

import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JSX } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import type {
  AgedReport,
  CompanySummary,
  DocumentListRow,
  ReceiptSummary,
  Result,
} from '@shared/dto'
import { DEFAULT_COMPANY, renderScreen, type BridgeStub } from '@renderer/test/harness'
import type { Command } from '../../lib/command-registry'
import { DENSITY_STORAGE_KEY } from '../../lib/density'
import { SIDEBAR_STORAGE_KEY } from '../../lib/layout'
import { registerScreens } from '../../lib/screens'
import { THEME_STORAGE_KEY } from '../../lib/theme'
import { useCommands } from '../../store/commands'
import { useNavigation } from '../../store/navigation'
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
  reports: { aged: (input) => ok<AgedReport>({ ...NOTHING_OUTSTANDING, side: input.side }) },
  documents: { list: () => ok<DocumentListRow[]>([]) },
  receipts: { list: () => ok<ReceiptSummary[]>([]) },
  companyProfile: { get: () => ok(null) },
  parties: { list: () => ok([]) },
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

function sidebar(): HTMLElement | null {
  return screen.queryByRole('navigation', { name: 'Sections' })
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-density')
})

describe('the two layouts', () => {
  it('draws no sidebar while no company is open', () => {
    mount({ isCompanyOpen: false })

    expect(shell()).toHaveAttribute('data-area', 'welcome')
    expect(sidebar()).toBeNull()
  })

  it('draws one once a company is open', () => {
    mount({ isCompanyOpen: true })

    expect(shell()).toHaveAttribute('data-area', 'workspace')
    expect(sidebar()).toBeVisible()
  })

  it('always carries the title bar', () => {
    mount({ isCompanyOpen: false })

    expect(document.querySelector('.titlebar')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Search and commands' })).toBeVisible()
  })

  it('always carries the notifications region', () => {
    mount({ isCompanyOpen: false })

    expect(screen.getByRole('region', { name: 'Notifications' })).toBeVisible()
  })

  /* A keyboard user must be able to get past the title bar and the whole nav rail in
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

  it('offers closing the company only when there is one, and names it', () => {
    mount({ isCompanyOpen: true })

    expect(commandFor('company.close').hint).toBe('Acme Pvt Ltd')
  })

  it('offers no company command when none is open', () => {
    mount({ isCompanyOpen: false })

    expect(ids()).not.toContain('company.close')
  })
})

/*
 * THE SIDEBAR COMMAND IS REGISTERED BY THE WORKSPACE, not by the shell, so that it
 * cannot fire from the picker where there is no sidebar to collapse.
 */
describe('the sidebar command', () => {
  it('exists in the workspace and not in the welcome area', () => {
    mount({ isCompanyOpen: false })
    expect(ids()).not.toContain('view.toggle-sidebar')

    localStorage.clear()
    mount({ isCompanyOpen: true })
    expect(ids()).toContain('view.toggle-sidebar')
  })

  it('collapses the rail, and says what it will do next', () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'expanded')
    mount({ isCompanyOpen: true })

    expect(sidebar()).toHaveAttribute('data-collapsed', 'false')
    expect(commandFor('view.toggle-sidebar').title).toBe('Collapse the sidebar')

    run('view.toggle-sidebar')

    expect(sidebar()).toHaveAttribute('data-collapsed', 'true')
    expect(commandFor('view.toggle-sidebar').title).toBe('Expand the sidebar')
  })

  /* Once the user has taken a position, the window resizing under them must not
   * silently overrule it — so the toggle always writes an explicit preference. */
  it('remembers the choice rather than leaving it to the viewport', () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'expanded')
    mount({ isCompanyOpen: true })

    run('view.toggle-sidebar')

    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('collapsed')
  })

  it('takes the stored preference over the viewport on the first paint', () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'collapsed')
    mount({ isCompanyOpen: true })

    expect(sidebar()).toHaveAttribute('data-collapsed', 'true')
  })
})

describe('the palette', () => {
  it('is reachable from the title bar and lists the frame commands', async () => {
    const user = userEvent.setup()
    mount({ isCompanyOpen: true })

    await user.click(screen.getByRole('button', { name: 'Search and commands' }))

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
