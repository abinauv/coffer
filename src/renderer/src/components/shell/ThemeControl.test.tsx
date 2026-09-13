/*
 * The appearance control.
 *
 * THREE STATES, NOT TWO, AND THE THIRD IS THE POINT. "Follow the system" is a real
 * preference and not the absence of one, and the contract with styles/tokens.css says so
 * in a way that is easy to get wrong: `system` REMOVES `data-theme` rather than writing
 * the resolved value into it. The dark block is guarded by `:root:not([data-theme='light'])`,
 * so stamping `data-theme="light"` for a user on `system` would pin them to light and
 * break the OS follow at dusk — while looking completely correct at the moment it was
 * written, in the afternoon.
 *
 * So every test here checks the ATTRIBUTE ON THE DOCUMENT as well as which radio is
 * checked, and the un-stamped state gets its own assertions in both directions: it is
 * absent when the preference is `system`, and it comes back off when the user returns to
 * `system` from an explicit choice.
 *
 * `lib/theme.ts` covers the decisions as pure functions. What only this file covers is
 * that the control is wired to them.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { BRAND } from '../../../../branding'
import { ICON_PATHS } from '../../lib/icons'
import { THEME_LABELS, THEME_STORAGE_KEY, type ThemePreference } from '../../lib/theme'
import { ThemeProvider } from '../../store/theme'
import { ThemeControl } from './ThemeControl'

/* Total over the closed union: the label a user hears, and the glyph they see. */
const OPTIONS: Readonly<Record<ThemePreference, { label: string; icon: keyof typeof ICON_PATHS }>> =
  {
    system: { label: 'Match system', icon: 'monitor' },
    light: { label: 'Light', icon: 'sun' },
    dark: { label: 'Dark', icon: 'moon' },
  }

const EVERY_PREFERENCE = Object.keys(OPTIONS) as readonly ThemePreference[]

function mount(stored?: ThemePreference, isCompact = false): void {
  if (stored !== undefined) localStorage.setItem(THEME_STORAGE_KEY, stored)
  render(
    <ThemeProvider>
      <ThemeControl isCompact={isCompact} />
    </ThemeProvider>,
  )
}

function radio(preference: ThemePreference): HTMLElement {
  return screen.getByRole('radio', { name: OPTIONS[preference].label })
}

/** What the document is stamped with, or null when it carries no stamp at all. */
function stamp(): string | null {
  return document.documentElement.getAttribute('data-theme')
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('the group', () => {
  it('is a radio group named for the product', () => {
    mount()

    const group = screen.getByRole('radiogroup', { name: `${BRAND.name} appearance` })
    expect(group).toBeVisible()
    expect(screen.getAllByRole('radio')).toHaveLength(3)
  })

  it.each(EVERY_PREFERENCE)('offers %s under the label a user hears', (preference) => {
    mount()

    expect(radio(preference)).toBeVisible()
  })

  it.each(EVERY_PREFERENCE)('draws the %s option its own glyph', (preference) => {
    mount()

    expect(radio(preference).querySelector('path')).toHaveAttribute(
      'd',
      ICON_PATHS[OPTIONS[preference].icon],
    )
  })

  it('labels the options the same way THEME_LABELS does', () => {
    mount()

    for (const preference of EVERY_PREFERENCE) {
      expect(radio(preference)).toHaveAccessibleName(THEME_LABELS[preference])
    }
  })
})

describe('the three states', () => {
  /*
   * THE UN-STAMPED DEFAULT. Nothing stored means `system`, and `system` means the
   * document carries NO `data-theme` at all — the attribute records the choice, never
   * the outcome.
   */
  it('follows the system and stamps nothing when nothing was chosen', () => {
    mount()

    expect(radio('system')).toBeChecked()
    expect(radio('light')).not.toBeChecked()
    expect(radio('dark')).not.toBeChecked()
    expect(stamp()).toBeNull()
  })

  it('stamps light when light was chosen explicitly', () => {
    mount('light')

    expect(radio('light')).toBeChecked()
    expect(radio('system')).not.toBeChecked()
    expect(stamp()).toBe('light')
  })

  it('stamps dark when dark was chosen explicitly', () => {
    mount('dark')

    expect(radio('dark')).toBeChecked()
    expect(radio('system')).not.toBeChecked()
    expect(stamp()).toBe('dark')
  })

  /* Anything unrecognised — corrupt, or from a future version — is system, not a crash
   * and not a coin toss. */
  it('falls back to the system when what was stored makes no sense', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia')
    render(
      <ThemeProvider>
        <ThemeControl />
      </ThemeProvider>,
    )

    expect(radio('system')).toBeChecked()
    expect(stamp()).toBeNull()
  })
})

describe('choosing', () => {
  it('stamps the document and remembers the choice', async () => {
    const user = userEvent.setup()
    mount()

    await user.click(radio('dark'))

    expect(radio('dark')).toBeChecked()
    expect(stamp()).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  /*
   * AND BACK AGAIN, WHICH IS THE HALF THAT BREAKS. Returning to `system` must REMOVE the
   * attribute. Writing the resolved value instead looks identical on the screen it was
   * tested on and leaves the user pinned to whichever theme they happened to be in.
   */
  it('takes the stamp off again when the user returns to the system', async () => {
    const user = userEvent.setup()
    mount('dark')
    expect(stamp()).toBe('dark')

    await user.click(radio('system'))

    expect(radio('system')).toBeChecked()
    expect(stamp()).toBeNull()
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
  })

  it('moves the choice rather than adding to it', async () => {
    const user = userEvent.setup()
    mount()

    await user.click(radio('light'))

    expect(radio('light')).toBeChecked()
    expect(radio('system')).not.toBeChecked()
    expect(radio('dark')).not.toBeChecked()
  })
})

describe('the keyboard', () => {
  /* One tab stop for the whole group, on the selected option: that is what makes a
   * radio group one control rather than three. */
  it('puts only the selected option in the tab order', async () => {
    const user = userEvent.setup()
    mount('light')

    await user.tab()

    expect(radio('light')).toHaveFocus()
    expect(radio('system')).toHaveAttribute('tabindex', '-1')
    expect(radio('dark')).toHaveAttribute('tabindex', '-1')
  })

  it('moves the selection forward with ArrowRight and ArrowDown', () => {
    mount()

    fireEvent.keyDown(radio('system'), { key: 'ArrowRight' })
    expect(radio('light')).toBeChecked()

    fireEvent.keyDown(radio('light'), { key: 'ArrowDown' })
    expect(radio('dark')).toBeChecked()
  })

  it('moves it back with ArrowLeft and ArrowUp', () => {
    mount('dark')

    fireEvent.keyDown(radio('dark'), { key: 'ArrowLeft' })
    expect(radio('light')).toBeChecked()

    fireEvent.keyDown(radio('light'), { key: 'ArrowUp' })
    expect(radio('system')).toBeChecked()
  })

  /* Wrapping in both directions, which is what a radio group does and what a plain
   * index bump does not. */
  it('wraps round at both ends', () => {
    mount()

    fireEvent.keyDown(radio('system'), { key: 'ArrowLeft' })
    expect(radio('dark')).toBeChecked()
    expect(stamp()).toBe('dark')

    fireEvent.keyDown(radio('dark'), { key: 'ArrowRight' })
    expect(radio('system')).toBeChecked()
    expect(stamp()).toBeNull()
  })

  it('leaves other keys to whatever else wanted them', () => {
    mount()

    const event = fireEvent.keyDown(radio('system'), { key: 'Tab' })

    expect(radio('system')).toBeChecked()
    /* fireEvent returns false when a handler prevented the default. */
    expect(event).toBe(true)
  })
})

describe('compact', () => {
  it('drops the words but keeps the name a screen reader reads', () => {
    mount('system', true)

    /* The glyph is all that is drawn; the name comes from `aria-label`. */
    expect(radio('light')).toHaveAccessibleName('Light')
    expect(radio('light').textContent).toBe('')
    expect(screen.getByRole('radiogroup')).toHaveClass('theme-control--compact')
  })

  it('shows the words when it is not compact', () => {
    mount('system', false)

    expect(radio('light')).toHaveTextContent('Light')
    expect(screen.getByRole('radiogroup')).not.toHaveClass('theme-control--compact')
  })
})
