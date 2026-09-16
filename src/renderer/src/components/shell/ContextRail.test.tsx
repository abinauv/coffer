/*
 * The section bar and the contextual rail, driven together the way the workspace draws them.
 *
 * TOGETHER, BECAUSE THEY SHARE ONE MEMORY. Which section is showing is derived from the
 * route until the route stops naming one, and then it is whatever was showing last. A test
 * of either half alone could not see the two disagree, so `Frame` below mounts both from a
 * single `useSectionNavigation`, exactly as `AppShell` does, with no screen underneath.
 *
 * THE PROBES ARE REGISTERED TO DISAGREE WITH THE ANSWER. Zulu is registered before Alpha
 * and must come out after it (same order, broken by label), and Middle before both (lower
 * order). A fixture registered in the expected order cannot tell a sorted rail from an
 * unsorted one.
 *
 * The registry is the product's singleton, so the real screens are in it too — which is what
 * the last block wants: it walks every one of them and proves each is two clicks away.
 */

import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JSX } from 'react'
import { describe, expect, it } from 'vitest'
import { DEFAULT_COMPANY, renderScreen, type BridgeStub } from '@renderer/test/harness'
import { makeRoute, type Route } from '../../lib/routing'
import {
  NAV_GROUPS,
  registerScreens,
  screenRegistry,
  type ScreenDefinition,
} from '../../lib/screens'
import { useNavigation } from '../../store/navigation'
import { ContextRail } from './ContextRail'
import { SectionBar } from './SectionBar'
import { useSectionNavigation } from './useSectionNavigation'

registerScreens([
  {
    id: 'probe-zulu',
    title: 'Zulu probe',
    area: 'workspace',
    nav: { label: 'Zulu probe', icon: 'ledger', group: 'inventory', order: 900 },
    render: () => <p>zulu</p>,
  },
  {
    id: 'probe-alpha',
    title: 'Alpha probe',
    area: 'workspace',
    nav: { label: 'Alpha probe', icon: 'ledger', group: 'inventory', order: 900 },
    render: () => <p>alpha</p>,
  },
  {
    id: 'probe-middle',
    title: 'Middle probe',
    area: 'workspace',
    nav: { label: 'Middle probe', icon: 'ledger', group: 'inventory', order: 899 },
    render: () => <p>middle</p>,
  },
  /* An editor of Alpha's: not in the rail, and Alpha stays marked while it is open. */
  {
    id: 'probe-alpha-editor',
    title: 'Alpha editor',
    area: 'workspace',
    navParent: 'probe-alpha',
    render: () => <p>alpha editor</p>,
  },
  /* Belongs to no register, like the list of every party. */
  {
    id: 'probe-loose',
    title: 'Loose probe',
    area: 'workspace',
    render: () => <p>loose</p>,
  },
])

let navigate: (to: Route) => void

function Frame({ isCollapsed = false }: { isCollapsed?: boolean }): JSX.Element {
  const nav = useNavigation()
  navigate = nav.navigate
  const sections = useSectionNavigation()
  return (
    <>
      <p>route: {nav.route.screenId}</p>
      <SectionBar
        sections={sections.sections}
        currentId={sections.current?.id ?? null}
        onSelect={sections.select}
      />
      <ContextRail
        section={sections.current}
        marked={sections.marked}
        isCollapsed={isCollapsed}
        onToggleCollapsed={() => {}}
      />
    </>
  )
}

function mount({
  isCollapsed = false,
  bridge = {} as BridgeStub,
  company = DEFAULT_COMPANY,
} = {}): void {
  renderScreen(<Frame isCollapsed={isCollapsed} />, { company, bridge })
}

function goTo(screenId: string): void {
  act(() => {
    navigate(makeRoute('workspace', screenId))
  })
}

function sectionBar(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Sections' })
}

function sectionButton(label: string): HTMLElement {
  return within(sectionBar()).getByRole('button', { name: label })
}

function rail(name: string): HTMLElement {
  return screen.getByRole('navigation', { name })
}

function route(): string {
  return (screen.getByText(/^route:/).textContent ?? '').replace('route: ', '')
}

describe('the section bar', () => {
  it('draws the sections in the order the design fixes, and no seventh', () => {
    mount()

    const labels = within(sectionBar())
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(labels).toEqual(NAV_GROUPS.map((group) => group.label))
    expect(labels).toEqual(['Sales', 'Purchases', 'Inventory', 'Accounts', 'Reports', 'Company'])
  })

  /* `true`, not `page`: the page is the rail's to name. */
  it('marks the section of the screen on show, and only it', () => {
    mount()
    goTo('probe-middle')

    expect(sectionButton('Inventory')).toHaveAttribute('aria-current', 'true')
    expect(sectionButton('Sales')).not.toHaveAttribute('aria-current')
  })

  it('lands on the first screen of a section chosen for the first time', async () => {
    const user = userEvent.setup()
    mount()

    await user.click(sectionButton('Inventory'))

    /* Items is first in Inventory (order 0), ahead of every probe (899 and up). */
    expect(route()).toBe('items')
  })

  /* Going to Reports and back to Inventory returns to the screen you left, not the top. */
  it('returns to the screen last open in a section', async () => {
    const user = userEvent.setup()
    mount()
    goTo('probe-zulu')

    await user.click(sectionButton('Reports'))
    expect(route()).not.toBe('probe-zulu')
    await user.click(sectionButton('Inventory'))

    expect(route()).toBe('probe-zulu')
  })
})

describe('the rail', () => {
  it('lists the current section’s screens under its name, and nothing from any other', () => {
    mount()
    goTo('probe-middle')

    const inventory = rail('Inventory')
    expect(within(inventory).getByRole('heading', { name: 'Inventory' })).toBeVisible()
    expect(within(inventory).getByRole('button', { name: 'Alpha probe' })).toBeVisible()
    expect(within(inventory).queryByRole('button', { name: 'Sales invoices' })).toBeNull()
  })

  it('orders by rank, then by label — not by registration', () => {
    mount()
    goTo('probe-middle')

    const labels = within(rail('Inventory'))
      .getAllByRole('button')
      .map((button) => button.textContent ?? '')
    const at = (label: string): number => labels.findIndex((text) => text.includes(label))
    expect(at('Middle probe')).toBeLessThan(at('Alpha probe'))
    expect(at('Alpha probe')).toBeLessThan(at('Zulu probe'))
  })

  it('leaves out a screen that declared no rail entry', () => {
    mount()
    goTo('probe-alpha')

    expect(within(rail('Inventory')).queryByRole('button', { name: 'Alpha editor' })).toBeNull()
    expect(within(rail('Inventory')).queryByRole('button', { name: 'Loose probe' })).toBeNull()
  })

  it('marks the screen on show as the page', () => {
    mount()
    goTo('probe-alpha')

    const inventory = rail('Inventory')
    expect(within(inventory).getByRole('button', { name: 'Alpha probe' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(inventory).getByRole('button', { name: 'Zulu probe' })).not.toHaveAttribute(
      'aria-current',
    )
  })

  /* The editor is the page; its register is where you are in the rail. */
  it('keeps an editor’s register marked while the editor is open', () => {
    mount()
    goTo('probe-alpha-editor')

    expect(sectionButton('Inventory')).toHaveAttribute('aria-current', 'true')
    const alpha = within(rail('Inventory')).getByRole('button', { name: 'Alpha probe' })
    expect(alpha).toHaveAttribute('aria-current', 'true')
    expect(alpha).toHaveAttribute('data-active', 'true')
  })

  /* Opening the list of every party from the palette must not throw the rail elsewhere. */
  it('stays on the section it was showing for a screen that belongs to none', () => {
    mount()
    goTo('probe-zulu')

    goTo('probe-loose')

    expect(rail('Inventory')).toBeVisible()
    expect(sectionButton('Inventory')).toHaveAttribute('aria-current', 'true')
    for (const button of within(rail('Inventory')).getAllByRole('button')) {
      expect(button).not.toHaveAttribute('aria-current')
    }
  })

  it('navigates to the screen that was clicked', async () => {
    const user = userEvent.setup()
    mount()
    goTo('probe-alpha')

    await user.click(within(rail('Inventory')).getByRole('button', { name: 'Middle probe' }))

    expect(route()).toBe('probe-middle')
  })
})

describe('collapsed', () => {
  /* An icon rail whose buttons are unnamed is unusable with a screen reader. */
  it('keeps the name of every item even though the words are hidden', () => {
    mount({ isCollapsed: true })
    goTo('probe-alpha')

    const item = within(rail('Inventory')).getByRole('button', { name: 'Alpha probe' })
    expect(item.querySelector('.visually-hidden')).toHaveTextContent('Alpha probe')
  })

  it('gives every item a tooltip, because the icon is the only label on screen', () => {
    mount({ isCollapsed: true })
    goTo('probe-alpha')

    const list = within(rail('Inventory')).getByRole('list')
    expect(within(list).getAllByRole('tooltip')).toHaveLength(
      within(list).getAllByRole('button').length,
    )
  })

  it('hides the section heading rather than dropping it: it is still the rail’s name', () => {
    mount({ isCollapsed: true })
    goTo('probe-alpha')

    expect(screen.getByRole('heading', { name: 'Inventory' })).toHaveClass('visually-hidden')
  })

  it('offers Back up now as a named icon', () => {
    mount({ isCollapsed: true })

    expect(screen.getByRole('button', { name: 'Back up now' })).toHaveClass('button--icon-only')
  })
})

describe('the foot', () => {
  /* The one flow in store/backup.tsx, reached from here. Cancelling the folder picker
   * writes nothing, which is enough to prove the button reaches it. */
  it('backs the company up from any screen', async () => {
    const user = userEvent.setup()
    const calls: string[] = []
    mount({
      bridge: {
        system: {
          chooseDirectory: () => {
            calls.push('chooseDirectory')
            return Promise.resolve({ ok: true, data: null })
          },
        },
      },
    })
    goTo('probe-alpha')

    await user.click(screen.getByRole('button', { name: 'Back up now' }))

    expect(calls).toEqual(['chooseDirectory'])
  })

  /*
   * WHEN, NOT WHETHER. The rail says when an archive was last written from this machine.
   * Whether that file is still in the folder is something only the folder can answer, and
   * Company → Backups is where the path is.
   */
  it('says when this company was last backed up', () => {
    mount({
      company: {
        ...DEFAULT_COMPANY,
        lastBackup: {
          at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          path: '/backups/acme.zip',
          sizeBytes: 2048,
        },
      },
    })

    expect(screen.getByText('Backed up 2 days ago')).toBeVisible()
  })

  it('says so plainly when there has never been one', () => {
    mount()
    expect(screen.getByText('No backup yet')).toBeVisible()
  })

  /* Collapsed, the rail is icons: one line of prose in a 48px column is not a line. */
  it('leaves it out when the rail is collapsed to icons', () => {
    mount({ isCollapsed: true })
    expect(screen.queryByText('No backup yet')).toBeNull()
  })

  it('says what the collapse toggle will do next', () => {
    mount()
    expect(screen.getByRole('button', { name: 'Collapse the rail' })).toBeVisible()
  })

  it('offers the other half of the toggle when collapsed', () => {
    mount({ isCollapsed: true })
    expect(screen.getByRole('button', { name: 'Expand the rail' })).toBeVisible()
  })
})

/*
 * EVERY SCREEN IN THE PRODUCT, TWO CLICKS AWAY.
 *
 * Walks the real registry rather than a list, so a screen added tomorrow is covered the day
 * it registers. A rail screen is a section click and a rail click from anywhere. A screen
 * outside the rail must name a parent that is in it, or the rail loses track of where you
 * are the moment it opens — with one named exception, the list of every party, which
 * belongs to both sides and so to neither.
 */
describe('reachability', () => {
  const NO_PARENT_BY_DESIGN = new Set(['parties'])

  function productScreens(): readonly ScreenDefinition[] {
    return screenRegistry()
      .list()
      .filter((definition) => definition.area === 'workspace')
      .filter((definition) => !definition.id.startsWith('probe-'))
  }

  it('finds the product’s screens in the registry', () => {
    const navigable = productScreens().filter((definition) => definition.nav !== undefined)
    expect(navigable.length).toBeGreaterThanOrEqual(24)
  })

  it('reaches every rail screen with a section click and a rail click', async () => {
    const user = userEvent.setup()
    mount()

    for (const definition of productScreens()) {
      if (definition.nav === undefined) continue
      const section = NAV_GROUPS.find((group) => group.id === definition.nav?.group)
      if (section === undefined) throw new Error(`${definition.id} names no section`)

      goTo('probe-loose')
      await user.click(sectionButton(section.label))
      await user.click(
        within(rail(section.label)).getByRole('button', { name: definition.nav.label }),
      )

      expect(route(), `${section.label} → ${definition.nav.label}`).toBe(definition.id)
    }
  })

  /* Collapsed, the rail is its icons and nothing else. */
  it('never draws two screens in one rail with the same icon', () => {
    for (const group of NAV_GROUPS) {
      const icons = productScreens()
        .filter((definition) => definition.nav?.group === group.id)
        .map((definition) => `${String(definition.nav?.icon)} (${definition.id})`)
      const glyphs = icons.map((entry) => entry.split(' ')[0])
      expect(new Set(glyphs).size, `${group.label}: ${icons.join(', ')}`).toBe(glyphs.length)
    }
  })

  it('gives every screen outside the rail a parent that is in it', () => {
    const all = productScreens()
    for (const definition of all) {
      if (definition.nav !== undefined || NO_PARENT_BY_DESIGN.has(definition.id)) continue
      const parent = all.find((candidate) => candidate.id === definition.navParent)
      expect(parent?.nav, `${definition.id} → ${String(definition.navParent)}`).toBeDefined()
    }
  })
})
