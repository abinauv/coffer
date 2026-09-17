/*
 * Settings, rendered.
 *
 * What the rules in lib/ cannot show: that each control writes the store the shell reads, so
 * a choice is on screen the moment it is made and still there at the next launch; that a
 * radio is named by its choice alone, with the sentence about it as a description; and that
 * nothing is offered which is not built — two layouts, a keyboard described rather than
 * picked from a list of one, and no language at all.
 */

import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JSX } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_COMPANY, renderScreen } from '@renderer/test/harness'
import { DENSITY_STORAGE_KEY } from '@renderer/lib/density'
import { RAIL_STORAGE_KEY } from '@renderer/lib/layout'
import { makeRoute } from '@renderer/lib/routing'
import { THEME_STORAGE_KEY } from '@renderer/lib/theme'
import { useNavigation } from '@renderer/store/navigation'
import { useNavigationLayout } from '@renderer/store/navigation-layout'
import { Settings } from './Settings'

/** Prints the layout the shell would draw, so a choice is asserted against what it changed. */
function LayoutProbe(): JSX.Element {
  return <p>layout: {useNavigationLayout().layout}</p>
}

function mount(area: 'workspace' | 'welcome' = 'workspace'): void {
  renderScreen(
    <>
      <LayoutProbe />
      <Settings area={area} />
    </>,
    { company: area === 'workspace' ? DEFAULT_COMPANY : null },
  )
}

function group(name: string): HTMLElement {
  return screen.getByRole('group', { name })
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-density')
})

describe('navigation', () => {
  it('offers the two layouts that exist, and no others', () => {
    mount()

    const names = within(group('Navigation'))
      .getAllByRole('radio')
      .map((radio) => radio.closest('.settings__layout')?.querySelector('label')?.textContent)
    expect(names).toEqual(['Section bar and rail', 'Icon rail'])
  })

  /* The sentence under a card is its description, not part of its name. */
  it('names each layout by its name, and describes it with the sentence under it', () => {
    mount()

    expect(screen.getByRole('radio', { name: 'Icon rail' })).toHaveAccessibleDescription(
      /drawn as icons/,
    )
  })

  it('marks the layout on screen', () => {
    localStorage.setItem(RAIL_STORAGE_KEY, 'collapsed')
    mount()

    expect(screen.getByRole('radio', { name: 'Icon rail' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Section bar and rail' })).not.toBeChecked()
  })

  it('changes the layout as it is chosen, and remembers it', async () => {
    const user = userEvent.setup()
    localStorage.setItem(RAIL_STORAGE_KEY, 'expanded')
    mount()
    expect(screen.getByText('layout: sections')).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'Icon rail' }))

    expect(screen.getByText('layout: icons')).toBeInTheDocument()
    expect(localStorage.getItem(RAIL_STORAGE_KEY)).toBe('collapsed')
    expect(screen.getByRole('radio', { name: 'Icon rail' })).toBeChecked()
  })

  /* Nobody has chosen, so the window's width is deciding, and the screen says so — until a
   * choice is made, when the sentence would be false. */
  it('says the width decides until somebody chooses', async () => {
    const user = userEvent.setup()
    mount()
    expect(group('Navigation')).toHaveAccessibleDescription(/Until you choose/)

    await user.click(screen.getByRole('radio', { name: 'Section bar and rail' }))

    expect(group('Navigation')).not.toHaveAccessibleDescription(/Until you choose/)
    expect(localStorage.getItem(RAIL_STORAGE_KEY)).toBe('expanded')
  })
})

describe('theme', () => {
  it('offers following the system, light and dark, with the stored one chosen', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    mount()

    const radios = within(group('Theme')).getAllByRole('radio')
    expect(radios.map((radio) => radio.closest('label')?.textContent)).toEqual([
      'Follow system',
      'Light',
      'Dark',
    ])
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked()
  })

  it('applies a theme as it is chosen, and remembers it', async () => {
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')

    /* Following the system REMOVES the attribute: writing a resolved value would pin it. */
    await user.click(screen.getByRole('radio', { name: 'Follow system' }))
    expect(document.documentElement).not.toHaveAttribute('data-theme')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
  })
})

describe('density', () => {
  it('applies a density as it is chosen, and remembers it', async () => {
    const user = userEvent.setup()
    mount()
    expect(screen.getByRole('radio', { name: 'Comfortable' })).toBeChecked()

    await user.click(screen.getByRole('radio', { name: 'Compact' }))

    expect(document.documentElement).toHaveAttribute('data-density', 'compact')
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe('compact')
  })

  /* Native radios: the arrow keys move the choice, as they do in every other radio group. */
  it('moves with the arrow keys', async () => {
    const user = userEvent.setup()
    mount()

    screen.getByRole('radio', { name: 'Comfortable' }).focus()
    await user.keyboard('{ArrowRight}')

    expect(screen.getByRole('radio', { name: 'Compact' })).toBeChecked()
    expect(document.documentElement).toHaveAttribute('data-density', 'compact')
  })
})

describe('what is not offered', () => {
  /* One key map is built. A picker with one entry would promise a second. */
  it('describes the keyboard rather than offering a choice of one', () => {
    mount()

    const keyboard = screen.getByRole('region', { name: 'Keyboard' })
    expect(within(keyboard).queryAllByRole('radio')).toHaveLength(0)
    expect(within(keyboard).getByText('Search or run any command')).toBeInTheDocument()
  })

  /* D6: no language until a translation exists. */
  it('offers no language', () => {
    mount()

    expect(screen.queryByText(/language/i)).not.toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(7)
  })
})

describe('before a company is open', () => {
  function Opener(): JSX.Element {
    const { navigate } = useNavigation()
    return (
      <button type="button" onClick={() => navigate(makeRoute('welcome', 'settings'))}>
        open settings
      </button>
    )
  }

  it('offers the same choices, and a way back to where it was opened from', async () => {
    const user = userEvent.setup()
    renderScreen(<WelcomeHost />, { company: null })

    await user.click(screen.getByRole('button', { name: 'open settings' }))
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument()
  })

  function WelcomeHost(): JSX.Element {
    const { route } = useNavigation()
    return route.screenId === 'settings' ? <Settings area="welcome" /> : <Opener />
  }
})
