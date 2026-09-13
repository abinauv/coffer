/*
 * The workspace sidebar.
 *
 * Every item comes from the screen registry, so what this file tests is the mapping and
 * not a list: register a screen with nav metadata and it appears, in its group, in its
 * order. `navSections` is covered as a pure function in lib/screens.test.ts.
 *
 * THE FIXTURE IS ORDERED TO DISAGREE WITH THE ANSWER, twice over. The three probe
 * screens are registered Zulu, Alpha, Middle and must come out Middle, Alpha, Zulu —
 * Middle because its `order` is lower, and Alpha before Zulu because they share an order
 * and the tie is broken by label. A fixture registered in the expected order cannot tell
 * a sorted sidebar from an unsorted one, and one with no tie in it cannot tell the
 * tie-break from an accident of registration.
 *
 * The registry is the product's singleton, so the real screens are in it too. Assertions
 * are therefore about the probes' positions RELATIVE to each other rather than about the
 * whole list, which would change every time a screen was added.
 */

import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JSX } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_COMPANY, renderScreen } from '@renderer/test/harness'
import { registerScreens } from '../../lib/screens'
import { makeRoute, type Route } from '../../lib/routing'
import { useNavigation } from '../../store/navigation'
import { Sidebar } from './Sidebar'

/* The foot names the open company and prints where its file is, so the summary is a
 * fixture and not a flag. `renderScreen` opens it — see `RenderScreenOptions.company`. */
const ACME = DEFAULT_COMPANY

registerScreens([
  {
    id: 'probe-zulu',
    title: 'Zulu probe',
    area: 'workspace',
    nav: { label: 'Zulu probe', icon: 'ledger', group: 'reports', order: 900 },
    render: () => <p>zulu</p>,
  },
  {
    id: 'probe-alpha',
    title: 'Alpha probe',
    area: 'workspace',
    nav: { label: 'Alpha probe', icon: 'ledger', group: 'reports', order: 900 },
    render: () => <p>alpha</p>,
  },
  {
    id: 'probe-middle',
    title: 'Middle probe',
    area: 'workspace',
    nav: { label: 'Middle probe', icon: 'ledger', group: 'reports', order: 899 },
    render: () => <p>middle</p>,
  },
  {
    /* No `nav`, so it must never appear — a screen reachable only from another one. */
    id: 'probe-hidden',
    title: 'Hidden probe',
    area: 'workspace',
    render: () => <p>hidden</p>,
  },
])

let navigate: (to: Route) => void

/** Publishes `navigate` so a test can place the route, and prints where it ended up. */
function Driver(): JSX.Element {
  const nav = useNavigation()
  navigate = nav.navigate
  return <p>route: {nav.route.screenId}</p>
}

function mount(isCollapsed: boolean, onToggle = vi.fn()): { onToggle: ReturnType<typeof vi.fn> } {
  renderScreen(
    <>
      <Driver />
      <Sidebar isCollapsed={isCollapsed} onToggleCollapsed={onToggle} />
    </>,
    { company: ACME },
  )
  return { onToggle }
}

function goTo(screenId: string): void {
  act(() => {
    navigate(makeRoute('workspace', screenId))
  })
}

function nav(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Sections' })
}

/** Where a nav item sits among all of them, so order is asserted without a full list. */
function positionOf(label: string): number {
  const items = within(nav()).getAllByRole('button')
  return items.findIndex((item) => item.textContent?.includes(label) === true)
}

describe('what it lists', () => {
  it('is a labelled navigation landmark', () => {
    mount(false)

    expect(nav()).toBeVisible()
  })

  it('offers a button for every screen that declares nav metadata', () => {
    mount(false)

    expect(within(nav()).getByRole('button', { name: 'Alpha probe' })).toBeVisible()
    expect(within(nav()).getByRole('button', { name: 'Middle probe' })).toBeVisible()
    expect(within(nav()).getByRole('button', { name: 'Zulu probe' })).toBeVisible()
  })

  /* A screen without `nav` is reachable by route and not by the sidebar. It IS
   * registered — the assertion is about this list, not about the product. */
  it('leaves out a screen that declared none', () => {
    mount(false)

    expect(within(nav()).queryByRole('button', { name: 'Hidden probe' })).toBeNull()
  })

  it('orders by rank, then by label — not by registration', () => {
    mount(false)

    expect(positionOf('Middle probe')).toBeLessThan(positionOf('Alpha probe'))
    expect(positionOf('Alpha probe')).toBeLessThan(positionOf('Zulu probe'))
  })

  it('puts them under their group heading', () => {
    mount(false)

    expect(screen.getByRole('heading', { name: 'Reports' })).toBeVisible()
  })
})

describe('where you are', () => {
  /* `page` rather than `true`: this is where you are in the app, not merely which
   * control is selected. */
  it('marks the current screen, and only it', () => {
    mount(false)
    goTo('probe-alpha')

    expect(within(nav()).getByRole('button', { name: 'Alpha probe' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(nav()).getByRole('button', { name: 'Zulu probe' })).not.toHaveAttribute(
      'aria-current',
    )
  })

  it('moves the mark when the route moves', () => {
    mount(false)
    goTo('probe-alpha')

    goTo('probe-zulu')

    expect(within(nav()).getByRole('button', { name: 'Zulu probe' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(nav()).getByRole('button', { name: 'Alpha probe' })).not.toHaveAttribute(
      'aria-current',
    )
  })

  /* What crossed the boundary, not what is drawn: the click has to change the ROUTE,
   * which is the thing the rest of the shell reads. */
  it('navigates to the screen that was clicked', async () => {
    const user = userEvent.setup()
    mount(false)

    await user.click(within(nav()).getByRole('button', { name: 'Middle probe' }))

    expect(screen.getByText(/route:/)).toHaveTextContent('route: probe-middle')
  })
})

describe('collapsed', () => {
  it('keeps the name of every item even though the words are hidden', () => {
    mount(true)

    /* The label is still in the DOM and still the button's accessible name — an icon
     * rail whose buttons are unnamed is unusable with a screen reader. */
    const item = within(nav()).getByRole('button', { name: 'Alpha probe' })
    expect(item.querySelector('span')).toHaveClass('visually-hidden')
  })

  it('shows the words when it is not collapsed', () => {
    mount(false)

    const item = within(nav()).getByRole('button', { name: 'Alpha probe' })
    expect(item.querySelector('span')).toHaveClass('sidebar__item-label')
  })

  /* Collapsed, the icon is the only label there is, so the tooltip stops being a
   * nicety and becomes the name of the control. */
  it('gives every item a tooltip', () => {
    mount(true)

    /* One per item — every button in the nav except the collapse toggle at its foot. */
    const tooltips = within(nav()).queryAllByRole('tooltip').length
    expect(tooltips).toBeGreaterThan(0)
    expect(tooltips).toBe(within(nav()).getAllByRole('button').length - 1)
  })

  it('needs none when the words are on screen', () => {
    mount(false)

    expect(within(nav()).queryAllByRole('tooltip')).toHaveLength(0)
  })

  it('hides the section heading rather than dropping it', () => {
    mount(true)

    /* The grouping still exists for anyone listening to it. */
    expect(screen.getByRole('heading', { name: 'Reports' })).toHaveClass('visually-hidden')
  })

  it('shows the heading in the ordinary way when expanded', () => {
    mount(false)

    expect(screen.getByRole('heading', { name: 'Reports' })).toHaveClass('sidebar__heading')
  })
})

describe('the foot', () => {
  it('says which company is open, and where its file is', () => {
    mount(false)

    expect(screen.getByText('Acme Pvt Ltd')).toBeVisible()
    expect(screen.getByText('/books/acme.coffer')).toHaveAttribute('title', '/books/acme.coffer')
  })

  it('drops the company block when there is no room for it', () => {
    mount(true)

    expect(screen.queryByText('Acme Pvt Ltd')).toBeNull()
    expect(screen.queryByText('/books/acme.coffer')).toBeNull()
  })

  it('offers a toggle that says what it will do next', async () => {
    const user = userEvent.setup()
    const { onToggle } = mount(false)

    const button = screen.getByRole('button', { name: 'Collapse sidebar' })
    await user.click(button)

    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('offers the other half of the toggle when it is collapsed', async () => {
    const user = userEvent.setup()
    const { onToggle } = mount(true)

    expect(screen.queryByRole('button', { name: 'Collapse sidebar' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }))

    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
