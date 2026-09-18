/*
 * The screen host.
 *
 * It does two things, and the second is the one that costs somebody an afternoon when it
 * is missing: it renders whichever screen the route names, and when nothing matches it
 * says exactly what is absent and how to supply it rather than painting a blank pane.
 *
 * The screens here are registered by this file rather than borrowed from the product. A
 * test that asserted on a real screen would be asserting on that screen's contents, and
 * would have to change every time they did.
 *
 * ONE THING TO KNOW ABOUT THE SETUP. `useScreens` reaches the singleton registry, which
 * the store populates by importing every module under `screens/` for its side effects.
 * So the real screens are registered too, and the route starts on the welcome area's
 * home — the company picker — until a test navigates away. That is why `companies:list`
 * is stubbed: the picker asks for it on mount, and a channel nothing answers fails the
 * test by name (test/setup.ts).
 */

import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CompanySummary, Result } from '@shared/dto'
import { renderScreen, type BridgeStub } from '@renderer/test/harness'
import { registerScreens } from '../../lib/screens'
import { makeRoute, type NavigationMode, type Route } from '../../lib/routing'
import type { Command } from '../../lib/command-registry'
import { useCommands, useRegisterCommands } from '../../store/commands'
import { useNavigation } from '../../store/navigation'
import { ScreenHost } from './ScreenHost'

function Probe({ route, onNavigate }: { route: Route; onNavigate: () => void }): JSX.Element {
  return (
    <>
      <p>probe for {route.params['docId'] ?? 'nothing'}</p>
      <button type="button" onClick={onNavigate}>
        go elsewhere
      </button>
    </>
  )
}

/*
 * A screen that counts its own mounts and holds state from the moment it mounted.
 *
 * Both halves are needed. The counter says whether React tore the subtree down; the
 * state says what that costs — `openedWith` is seeded once and never updated, which is
 * the shape of every editor in the product (`DocumentEditor` reads `route.params['id']`
 * and loads the record into local state). If the host does not remount, the count stays
 * at one AND the screen goes on showing the record it was opened with while the route
 * names another.
 */
let mounts = 0

function Counting({ route }: { route: Route }): JSX.Element {
  const [openedWith] = useState(() => route.params['docId'] ?? 'nothing')
  useEffect(() => {
    mounts += 1
  }, [])

  return (
    <>
      <p>routed to {route.params['docId'] ?? 'nothing'}</p>
      <p>opened with {openedWith}</p>
    </>
  )
}

const seen: Command[] = []

const OWN_COMMANDS: readonly Command[] = [
  { id: 'probe.plain', title: 'Plain', section: 'Probe', run: () => {} },
  { id: 'probe.own', title: 'Own', section: 'Probe', location: 'Somewhere else', run: () => {} },
]

/* Registers two commands and reports what the registry then holds. */
function Commanding(): JSX.Element {
  useRegisterCommands(OWN_COMMANDS)
  seen.splice(0, seen.length, ...useCommands().commands)
  return <p>commanding</p>
}

/* A screen with a button that goes somewhere, and one that puts the caret in a field. */
function Focusing(): JSX.Element {
  return (
    <>
      <p>focusing probe</p>
      <input aria-label="First field" autoFocus />
    </>
  )
}

registerScreens([
  {
    id: 'host-focus',
    title: 'Focusing probe',
    area: 'welcome',
    render: () => <Focusing />,
  },
  {
    id: 'host-commands',
    title: 'Commanding probe',
    area: 'welcome',
    render: () => <Commanding />,
  },
  {
    id: 'host-probe',
    title: 'Host probe',
    area: 'welcome',
    render: ({ route, navigate }) => (
      <Probe route={route} onNavigate={() => navigate(makeRoute('welcome', 'host-other'))} />
    ),
  },
  {
    id: 'host-other',
    title: 'The other probe',
    area: 'welcome',
    render: () => <p>the other probe</p>,
  },
  {
    id: 'host-counter',
    title: 'Counting probe',
    area: 'welcome',
    render: ({ route }) => <Counting route={route} />,
  },
])

let navigate: (to: Route, mode?: NavigationMode) => void

function Navigator(): JSX.Element {
  navigate = useNavigation().navigate
  return <></>
}

const LISTS: BridgeStub = {
  companies: {
    list: () => Promise.resolve<Result<CompanySummary[]>>({ ok: true, data: [] }),
  },
}

/*
 * NO COMPANY IS OPENED, and that is the point of the fixture rather than an omission: the
 * route starts on the welcome area's home and every probe screen this file registers is a
 * welcome screen, so opening one would move the host off the area under test.
 */
function mount(): void {
  renderScreen(
    <>
      <Navigator />
      <ScreenHost />
    </>,
    { bridge: LISTS },
  )
}

/** Navigating from outside a screen, the way a nav item or a command does. */
function goTo(screenId: string, params: Record<string, string> = {}): void {
  act(() => {
    navigate(makeRoute('welcome', screenId, params))
  })
}

/*
 * Handing the host a fresh route object for the place it is already on.
 *
 * `replace` rather than `push`, because `navigate` refuses to push a route equal to the
 * current one — so a push of the same parameters in a different order returns the same
 * history, the host never re-renders, and the tests below would pass without the key
 * having been consulted at all. Replacing pushes a new array and a new route object of
 * equal content, which is precisely the render the key has to survive.
 */
function replaceWith(screenId: string, params: Record<string, string>): void {
  act(() => {
    navigate(makeRoute('welcome', screenId, params), 'replace')
  })
}

beforeEach(() => {
  mounts = 0
  mount()
})

describe('rendering the route', () => {
  it('renders the screen the route names', () => {
    goTo('host-probe')

    expect(screen.getByText(/probe for/)).toBeVisible()
  })

  it('hands the screen the route it is on, parameters and all', () => {
    goTo('host-probe', { docId: 'inv-2026-0001' })

    expect(screen.getByText(/probe for/)).toHaveTextContent('probe for inv-2026-0001')
  })

  it('hands the screen a navigate that actually moves', async () => {
    const user = userEvent.setup()
    goTo('host-probe')

    await user.click(screen.getByRole('button', { name: 'go elsewhere' }))

    expect(screen.getByText('the other probe')).toBeVisible()
    expect(screen.queryByText(/probe for/)).toBeNull()
  })

  it('swaps one screen for another rather than stacking them', () => {
    goTo('host-probe')
    expect(screen.getByText(/probe for/)).toBeVisible()

    goTo('host-other')

    expect(screen.getByText('the other probe')).toBeVisible()
    expect(screen.queryByText(/probe for/)).toBeNull()
  })

  it('wraps whatever it renders in the screen container', () => {
    goTo('host-probe')

    const container = screen.getByText(/probe for/).closest('.screen')
    expect(container).not.toBeNull()
    expect(container).not.toHaveClass('screen--missing')
  })
})

/*
 * WHEN A SCREEN IS TORN DOWN, AND WHEN IT IS NOT.
 *
 * The host keys the screen so that changing a route's PARAMETERS remounts it. Until
 * 0016 the key was `area/screenId` alone and the parameters were not in it, so moving
 * from one document to the next kept the mounted screen and everything it was holding:
 * one record's figures under another's heading, which is the failure the key exists to
 * prevent and which its own comment claimed it did.
 *
 * THE OTHER DIRECTION MATTERS EXACTLY AS MUCH, and is why this is not a one-line fix. A
 * key that is not STABLE for the same parameters remounts on renders that changed
 * nothing and throws away a half-typed form — so every test here that asserts a remount
 * has a partner asserting that a bare re-render does not cause one.
 */
describe('remounting on the route', () => {
  it('remounts when a parameter changes, rather than carrying state across records', () => {
    goTo('host-counter', { docId: 'inv-2026-0001' })
    expect(mounts).toBe(1)
    expect(screen.getByText(/opened with/)).toHaveTextContent('opened with inv-2026-0001')

    goTo('host-counter', { docId: 'inv-2026-0002' })

    expect(mounts).toBe(2)
    /* Both lines, because the bug is the two DISAGREEING. The route always said the
     * second document; what the stale mount showed underneath it was the first one. */
    expect(screen.getByText(/routed to/)).toHaveTextContent('routed to inv-2026-0002')
    expect(screen.getByText(/opened with/)).toHaveTextContent('opened with inv-2026-0002')
  })

  it('remounts when a parameter is added to a route that had none', () => {
    /* The save-a-new-draft path: `DocumentEditor` creates, then navigates to the same
     * editor with `{ id }` on it. An empty parameter set and a populated one are not
     * the same screen state. */
    goTo('host-counter')
    expect(mounts).toBe(1)

    goTo('host-counter', { docId: 'inv-2026-0001' })

    expect(mounts).toBe(2)
    expect(screen.getByText(/opened with/)).toHaveTextContent('opened with inv-2026-0001')
  })

  it('remounts when a parameter is dropped from a route that had one', () => {
    /* The other side of the same condition. Going from a named document back to a blank
     * editor must not leave the old document's answers in the form — and "the new route
     * has no parameters" is the case a key that only reads the ones present gets wrong. */
    goTo('host-counter', { docId: 'inv-2026-0001' })
    expect(mounts).toBe(1)

    goTo('host-counter')

    expect(mounts).toBe(2)
    expect(screen.getByText(/opened with/)).toHaveTextContent('opened with nothing')
  })

  it('does not remount when the same parameters arrive in a different order', () => {
    /*
     * THE HALF THAT MAKES THIS DANGEROUS. `{ partyId, documentId }` is built in that
     * order by the settlement panel and in whatever order the aged report assembles a
     * target, and the two name one record. A key built from insertion order would tear
     * the screen down between them and lose whatever had been typed into it.
     */
    goTo('host-counter', { docId: 'inv-2026-0001', partyId: 'party-7' })
    expect(mounts).toBe(1)

    replaceWith('host-counter', { partyId: 'party-7', docId: 'inv-2026-0001' })

    expect(mounts).toBe(1)
  })

  it('does not remount a screen that has no parameters at all', () => {
    /*
     * THE DECISION, WRITTEN DOWN: no parameters and an empty set of them are one screen
     * state, not two. `makeRoute` defaults its third argument to `{}`, so a nav item
     * that omits it and a command that passes `{}` hand the host the same value — and
     * the key must not invent a difference between them, or a register would be torn
     * down and rebuilt every time it was reached by the other spelling.
     */
    goTo('host-counter')
    expect(mounts).toBe(1)

    replaceWith('host-counter', {})

    expect(mounts).toBe(1)
  })

  it('tells two records apart even when a parameter value contains the separator', () => {
    /*
     * These are different records. A key joined on `=` and `&` with nothing escaped
     * collapses them onto one string — a silent failure to remount, which is the
     * original bug wearing a different hat. The fixture is built so that the naive join
     * produces exactly the same text for both.
     */
    goTo('host-counter', { docId: 'x&partyId=party-7' })
    expect(mounts).toBe(1)

    goTo('host-counter', { docId: 'x', partyId: 'party-7' })

    expect(mounts).toBe(2)
  })

  it('does not remount when the route has not moved at all', () => {
    /* The control. Without it a key that changed on every render would satisfy every
     * "it remounted" assertion above and nothing here would notice. */
    goTo('host-counter', { docId: 'inv-2026-0001' })
    expect(mounts).toBe(1)

    replaceWith('host-counter', { docId: 'inv-2026-0001' })

    expect(mounts).toBe(1)
  })

  it('remounts when the screen changes, not only when its parameters do', () => {
    goTo('host-counter', { docId: 'inv-2026-0001' })
    goTo('host-probe')
    goTo('host-counter', { docId: 'inv-2026-0001' })

    /* Back on the route it started on, and it is a second mount: the screen was
     * unmounted in between, so there is nothing left over to carry. */
    expect(mounts).toBe(2)
  })
})

/*
 * A ROUTE WITH NO SCREEN IS A MISTAKE SOMEBODY HAS TO FIND, so the placeholder names the
 * route it could not resolve and the call that would supply it. Asserting only that
 * "something was rendered" would pass against a blank pane, which is the thing this is
 * here to prevent.
 */
describe('a route nothing answers', () => {
  it('names the area and the screen id it could not resolve', () => {
    goTo('ledger-for-1997')

    expect(screen.getByRole('heading', { name: /No screen registered/ })).toBeVisible()
    /* Both halves of the route, each in its own code element — the area alone would not
     * tell anyone which registration is missing. */
    const codes = [...document.querySelectorAll('.missing-screen__body code')].map(
      (code) => code.textContent,
    )
    expect(codes).toContain('welcome')
    expect(codes).toContain('ledger-for-1997')
  })

  it('says how to supply it', () => {
    goTo('ledger-for-1997')

    const body = screen.getByText(/A module under/)
    expect(body).toHaveTextContent('registerScreens')
    expect(body).toHaveTextContent('src/renderer/src/screens/')
  })

  it('marks the pane as the missing one rather than looking like a screen', () => {
    goTo('ledger-for-1997')

    expect(
      screen.getByRole('heading', { name: /No screen registered/ }).closest('.screen'),
    ).toHaveClass('screen--missing')
  })

  it('finds a screen registered for another area no more than one that does not exist', () => {
    /* `findScreen` matches on area AND id. A lookup by id alone would resolve this to
     * the workspace screen of the same name and render a ledger over the picker. */
    goTo('overview')

    expect(screen.getByRole('heading', { name: /No screen registered/ })).toBeVisible()
  })
})

describe('where a screen’s commands live', () => {
  /*
   * Screens §04: a palette result says which screen it acts on. A screen's commands are
   * given the screen's place by the host, so no call site spells its own — and one that
   * names a place of its own keeps it. A welcome screen has no rail place, so it is placed
   * by its title.
   */
  it('gives the commands a screen registers its place, and keeps one they name', () => {
    goTo('host-commands')

    expect(screen.getByText('commanding')).toBeInTheDocument()
    expect(seen.find((command) => command.id === 'probe.plain')?.location).toBe('Commanding probe')
    expect(seen.find((command) => command.id === 'probe.own')?.location).toBe('Somewhere else')
  })
})

/*
 * WHERE THE KEYBOARD IS AFTER A SCREEN CHANGES (B38).
 *
 * Activating a button that opens a screen removes that button from the page, and the
 * browser answers by putting focus on the body — so the next Tab starts at the skip link
 * and walks the title bar, the section bar and the rail again. The new screen takes focus
 * instead, unless something inside it has already claimed it.
 */
describe('the keyboard, when the screen changes', () => {
  it('puts focus on the screen when the last focused thing went away with the old one', async () => {
    const user = userEvent.setup()
    mount()
    goTo('host-probe')

    await user.click(screen.getByRole('button', { name: 'go elsewhere' }))

    expect(screen.getByText('the other probe').closest('.screen')).toHaveFocus()
  })

  /* The screen is a region, not a control: it is focusable only on purpose. */
  it('keeps the screen out of the tab order', () => {
    mount()
    goTo('host-other')

    expect(screen.getByText('the other probe').closest('.screen')).toHaveAttribute(
      'tabindex',
      '-1',
    )
  })

  it('leaves the caret where a screen has put it itself', () => {
    mount()
    goTo('host-focus')

    expect(screen.getByLabelText('First field')).toHaveFocus()
  })

  /* A window that has just opened answers its first Tab with the skip link, as any page
   * does. Focus moves on a CHANGE of screen, not on the first one. */
  it('takes no focus from the screen the window opened on', () => {
    mount()

    expect(document.body).toHaveFocus()
  })
})
