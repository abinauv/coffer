/*
 * The title bar.
 *
 * Coffer draws its own, so this strip is the only thing between the user and the OS
 * window controls. Three of its jobs are worth an assertion apiece:
 *
 *   IT SAYS WHOSE BOOKS ARE OPEN, AND WHICH YEAR. A shell that keeps showing a company name
 *   after the company has been closed is a shell that invites someone to act on the wrong
 *   file, so the name is asserted in BOTH directions — present with a company, gone without
 *   one. The year is the regime's own label, read from the periods and never composed.
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
import type { AccountingPeriod, AppInfo, Platform, Result } from '@shared/dto'
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

function period(fiscalYearLabel: string, startDate: string, endDate: string): AccountingPeriod {
  return {
    id: `${fiscalYearLabel}-${startDate}`,
    fiscalYearLabel,
    index: 1,
    label: startDate,
    startDate,
    endDate,
    status: 'open',
    closedAt: null,
  }
}

/* One year only, so the answer is the same whatever day the suite runs on: the year today
 * falls in, or failing that the latest the books keep. Both are this one. */
const ONE_YEAR: readonly AccountingPeriod[] = [
  period('2026-27', '2026-04-01', '2026-04-30'),
  period('2026-27', '2027-03-01', '2027-03-31'),
]

type Periods = () => Promise<Result<AccountingPeriod[]>>

function bridgeFor(over: Partial<AppInfo>, periods?: Periods): BridgeStub {
  const info: AppInfo = { ...DEFAULT_APP_INFO, ...over }
  return {
    system: {
      getAppInfo: () => Promise.resolve({ ok: true, data: info }),
      setTitleBarOverlay: () => Promise.resolve({ ok: true, data: undefined }),
    },
    ledger: {
      listPeriods: periods ?? (() => Promise.resolve({ ok: true, data: [...ONE_YEAR] })),
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
  periods?: Periods
}

function mount({ platform = 'linux', isCompanyOpen = false, periods }: Options = {}): void {
  renderScreen(
    <>
      <PaletteProbe />
      <TitleBar />
    </>,
    { bridge: bridgeFor({ platform }, periods), company: isCompanyOpen ? ACME : null },
  )
}

function searchHint(): Element | null {
  return document.querySelector('.titlebar__search-hint')
}

describe('what it names', () => {
  it('says the product while no company is open', () => {
    mount()

    expect(screen.getByText(BRAND.name)).toBeVisible()
  })

  it('says which company is open', async () => {
    mount({ isCompanyOpen: true })

    expect(screen.getByTitle('Acme Pvt Ltd')).toHaveTextContent('Acme Pvt Ltd')
    await screen.findByText('2026-27')
  })

  /* Whose books these are is worth the room the product's name had. The mark stays. */
  it('gives the product name’s place to the company once one is open', async () => {
    mount({ isCompanyOpen: true })

    expect(screen.queryByText(BRAND.name)).toBeNull()
    expect(document.querySelector('.brand-mark')).toBeInTheDocument()
    await screen.findByText('2026-27')
  })

  it('says nothing about a company when none is open', () => {
    mount({ isCompanyOpen: false })

    /* The name is rendered in the other direction by the test above, so its absence
     * here is a claim about this state rather than about every screen in the product. */
    expect(screen.queryByText('Acme Pvt Ltd')).toBeNull()
    expect(screen.getByText(BRAND.name)).toBeVisible()
  })

  it('names the financial year the regime’s way, and says what the figure is', async () => {
    mount({ isCompanyOpen: true })

    const year = await screen.findByText('2026-27')
    expect(year.closest('.titlebar__year')).toHaveTextContent('financial year 2026-27')
  })

  /* A courtesy in the corner: a failure to read it is not worth a message in the way. */
  it('shows no year when the periods cannot be read', async () => {
    let asked = 0
    mount({
      isCompanyOpen: true,
      periods: () => {
        asked += 1
        return Promise.resolve({
          ok: false,
          error: { code: 'IPC_FAILED', message: 'The books are closing.' },
        })
      },
    })

    await waitFor(() => expect(asked).toBe(1))
    expect(document.querySelector('.titlebar__year')).toBeNull()
    expect(screen.getByTitle('Acme Pvt Ltd')).toBeVisible()
  })

  it('asks for no year while no company is open', () => {
    let asked = 0
    mount({
      isCompanyOpen: false,
      periods: () => {
        asked += 1
        return Promise.resolve({ ok: true, data: [...ONE_YEAR] })
      },
    })

    expect(asked).toBe(0)
    expect(document.querySelector('.titlebar__year')).toBeNull()
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

    const button = screen.getByRole('button', { name: 'Search or run a command' })
    expect(button).toHaveAttribute('aria-haspopup', 'dialog')
  })

  it('opens the palette', async () => {
    const user = userEvent.setup()
    mount()
    expect(screen.getByText(/palette:/)).toHaveTextContent('palette: closed')

    await user.click(screen.getByRole('button', { name: 'Search or run a command' }))

    expect(screen.getByText(/palette:/)).toHaveTextContent('palette: open')
  })

  /*
   * The shortcut is drawn beside the label as keycaps and hidden from assistive technology
   * — the button's name must stay "Search or run a command" rather than becoming
   * "Search or run a command Ctrl K", which is what a screen reader would otherwise say.
   */
  it('shows the shortcut without letting it into the name', async () => {
    mount({ platform: 'win32' })

    await waitFor(() => expect(searchHint()).toHaveTextContent('CtrlK'))
    expect(searchHint()).toHaveAttribute('aria-hidden', 'true')
    const keys = [...(searchHint()?.querySelectorAll('kbd') ?? [])].map((key) => key.textContent)
    expect(keys).toEqual(['Ctrl', 'K'])
    expect(screen.getByRole('button', { name: 'Search or run a command' })).toHaveAccessibleName(
      'Search or run a command',
    )
  })

  it('writes the shortcut in the notation of the platform it is running on', async () => {
    mount({ platform: 'darwin' })

    await waitFor(() => expect(searchHint()).toHaveTextContent('⌘K'))
  })
})

describe('the trailing end', () => {
  it('says how finished the product is, in the word branding.ts gives', () => {
    mount()

    expect(screen.getByText(BRAND.releaseStage)).toHaveClass('badge')
  })

  /* Appearance is chosen from the palette until Settings exists, not from the title bar. */
  it('carries no appearance control', () => {
    mount()

    expect(screen.queryByRole('radiogroup')).toBeNull()
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
