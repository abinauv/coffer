/*
 * The title bar.
 *
 * Coffer draws its own, so this strip is the only thing between the user and the OS
 * window controls. Three of its four jobs are worth an assertion apiece:
 *
 *   IT SAYS WHOSE BOOKS ARE OPEN. A shell that keeps showing a company name after the
 *   company has been closed is a shell that invites someone to act on the wrong file, so
 *   the name is asserted in BOTH directions — present with a company, gone without one.
 *   IT IS THE PALETTE'S DISCOVERABLE AFFORDANCE. A user who does not know Ctrl+K has to
 *   be able to find the commands, so the click is asserted against what it changed:
 *   whether the palette is open.
 *   IT LAYS ITSELF OUT FROM A DETECTED MODE, never a guessed one. `data-chrome` is what
 *   the CSS reads to reserve space for OS-drawn buttons; the four modes are covered as
 *   pure functions in lib/platform.test.ts, and what is covered here is that the
 *   attribute is actually written.
 */

import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JSX } from 'react'
import { describe, expect, it } from 'vitest'
import type { AppInfo, Platform } from '@shared/dto'
import {
  DEFAULT_APP_INFO,
  DEFAULT_COMPANY,
  renderScreen,
  type BridgeStub,
} from '@renderer/test/harness'
import { BRAND } from '../../../../branding'
import { useCommands } from '../../store/commands'
import { TitleBar } from './TitleBar'

/* The strip prints the display name, so the name is asserted and the summary is a
 * fixture. `renderScreen` opens it — see `RenderScreenOptions.company`. */
const ACME = DEFAULT_COMPANY

function appInfo(over: Partial<AppInfo>): BridgeStub {
  const info: AppInfo = { ...DEFAULT_APP_INFO, ...over }
  return {
    system: {
      getAppInfo: () => Promise.resolve({ ok: true, data: info }),
      setTitleBarOverlay: () => Promise.resolve({ ok: true, data: undefined }),
    },
  }
}

/** Prints whether the palette is open, so a click is asserted against what it changed. */
function PaletteProbe(): JSX.Element {
  const { isPaletteOpen } = useCommands()
  return <p>palette: {isPaletteOpen ? 'open' : 'closed'}</p>
}

interface Options {
  platform?: Platform
  isCompanyOpen?: boolean
}

function mount({ platform = 'linux', isCompanyOpen = false }: Options = {}): void {
  renderScreen(
    <>
      <PaletteProbe />
      <TitleBar />
    </>,
    { bridge: appInfo({ platform }), company: isCompanyOpen ? ACME : null },
  )
}

describe('what it names', () => {
  it('says the product', () => {
    mount()

    expect(screen.getByText(BRAND.name)).toBeVisible()
  })

  it('says which company is open', () => {
    mount({ isCompanyOpen: true })

    expect(screen.getByTitle('Acme Pvt Ltd')).toHaveTextContent('Acme Pvt Ltd')
  })

  it('says nothing about a company when none is open', () => {
    mount({ isCompanyOpen: false })

    /* The name is rendered in the other direction by the test above, so its absence
     * here is a claim about this state rather than about every screen in the product. */
    expect(screen.queryByText('Acme Pvt Ltd')).toBeNull()
    expect(screen.getByText(BRAND.name)).toBeVisible()
  })

  it('shows the running version once main has answered', async () => {
    mount()

    expect(await screen.findByText(DEFAULT_APP_INFO.version)).toBeVisible()
  })

  it('draws the mark decoratively, so the product name is not read twice', () => {
    mount()

    const mark = document.querySelector('.brand-mark')
    expect(mark).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('the search button', () => {
  it('is named for what it does and says it opens a dialog', () => {
    mount()

    const button = screen.getByRole('button', { name: 'Search and commands' })
    expect(button).toHaveAttribute('aria-haspopup', 'dialog')
  })

  it('opens the palette', async () => {
    const user = userEvent.setup()
    mount()
    expect(screen.getByText(/palette:/)).toHaveTextContent('palette: closed')

    await user.click(screen.getByRole('button', { name: 'Search and commands' }))

    expect(screen.getByText(/palette:/)).toHaveTextContent('palette: open')
  })

  /*
   * The shortcut is drawn beside the label and hidden from assistive technology — the
   * button's name must stay "Search and commands" rather than becoming
   * "Search and commands Ctrl+K", which is what a screen reader would otherwise say.
   */
  it('shows the shortcut without letting it into the name', async () => {
    mount({ platform: 'win32' })

    expect(await screen.findByText('Ctrl+K')).toBeVisible()
    expect(screen.getByText('Ctrl+K')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByRole('button', { name: 'Search and commands' })).toHaveAccessibleName(
      'Search and commands',
    )
  })

  it('writes the shortcut in the notation of the platform it is running on', async () => {
    mount({ platform: 'darwin' })

    expect(await screen.findByText('⌘K')).toBeVisible()
  })
})

describe('the trailing controls', () => {
  it('carries the appearance control, compact', () => {
    mount()

    const group = screen.getByRole('radiogroup', { name: `${BRAND.name} appearance` })
    expect(group).toHaveClass('theme-control--compact')
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeVisible()
  })
})

describe('the window chrome', () => {
  /*
   * The mode is DETECTED, and the CSS reads it off this attribute to decide which end of
   * the bar to keep clear. `resolveWindowChrome` is covered as a pure function in
   * lib/platform.test.ts; what is covered here is that its answer reaches the markup.
   *
   * happy-dom reports `outerHeight === innerHeight`, which is the frameless case — no OS
   * title bar above the web contents. So the two assertions below differ only in the
   * platform, and they land on two different modes: without an OS bar, macOS floats its
   * traffic lights over our top-left and everything else offers nothing at all.
   */
  it('lays itself out from the mode it detected, not from a constant', async () => {
    mount({ platform: 'linux' })

    const bar = document.querySelector('.titlebar')
    await waitFor(() => expect(bar).toHaveAttribute('data-chrome', 'frameless-bare'))
    /* The same answer reaches the root, which is where the insets are computed. */
    expect(document.documentElement.dataset['windowChrome']).toBe('frameless-bare')
  })

  it('reserves the leading corner on macOS instead', async () => {
    mount({ platform: 'darwin' })

    await waitFor(() =>
      expect(document.querySelector('.titlebar')).toHaveAttribute(
        'data-chrome',
        'os-traffic-lights',
      ),
    )
  })

  it('is draggable, or a frameless window cannot be moved at all', () => {
    mount()

    expect(document.querySelector('.titlebar')).toHaveClass('drag-region')
  })
})
