/*
 * The effect that repaints the OS-drawn window buttons.
 *
 * NOTHING THIS COMPONENT DOES IS VISIBLE IN THIS DOCUMENT. The minimise, maximise and
 * close glyphs are painted by Windows and Linux over our title bar, from values fixed
 * when the window was created — so the only observable effect is the call that crosses
 * the bridge, and every assertion below is on WHAT CROSSED IT: the exact colours, in the
 * `#rrggbb` form the handler in src/main/ipc/handlers/system.ts will accept, and how
 * many times.
 *
 * TWO THINGS THE TESTS HAVE TO ARRANGE, and both are properties of the code rather than
 * of the tests:
 *
 *   - THE TOKENS. The colours are read off the document with `getComputedStyle` so they
 *     cannot drift from styles/tokens.css. No stylesheet is loaded in a test, so each
 *     test writes the two custom properties itself; with none set, `overlayColorsFrom`
 *     reads nothing and correctly sends nothing, which is a case tested on purpose.
 *
 *   - THE COLOURS ARE UNIQUE PER TEST. `lastSent` is module scope on purpose: what the
 *     OS is currently painting is a property of the WINDOW, not of any component, so it
 *     deliberately outlives a mount. That also means it outlives a test. Giving every
 *     test its own pair keeps them independent of the order they run in — the
 *     alternative is a suite where the second test to use a colour passes for the wrong
 *     reason.
 */

import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThemeProvider, useTheme } from '@renderer/store/theme'
import type { JSX } from 'react'
import { installBridge, type FakeBridge } from '../../test/harness'
import { TitleBarSync } from './TitleBarSync'

const CHANNEL = 'system:setTitleBarOverlay'

function setTokens(chrome: string | null, muted: string | null): void {
  const style = document.documentElement.style
  if (chrome === null) style.removeProperty('--chrome')
  else style.setProperty('--chrome', chrome)
  if (muted === null) style.removeProperty('--ink-muted')
  else style.setProperty('--ink-muted', muted)
}

/** Lets the effect's `requestAnimationFrame` run, and the call it makes settle. */
async function afterNextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
  })
}

/** A button that changes the resolved theme, which is what the effect depends on. */
function ThemeSwitch(): JSX.Element {
  const { setPreference } = useTheme()
  return (
    <>
      <button type="button" onClick={() => setPreference('dark')}>
        Go dark
      </button>
      <TitleBarSync />
    </>
  )
}

function mount(ui: JSX.Element = <TitleBarSync />) {
  return render(<ThemeProvider>{ui}</ThemeProvider>)
}

beforeEach(() => {
  /* A theme preference persisted by an earlier test would change which theme this one
   * starts on, and the effect keys off exactly that. */
  window.localStorage.clear()
  document.documentElement.removeAttribute('style')
})

afterEach(() => {
  document.documentElement.removeAttribute('style')
})

describe('TitleBarSync', () => {
  it('draws nothing of its own', async () => {
    setTokens('#101112', '#202122')
    const bridge = installBridge()
    const { container } = mount()
    await afterNextFrame()

    /* It is an effect wearing a component's clothes. Anything it rendered would appear
     * in the middle of every page in the product. */
    expect(container).toBeEmptyDOMElement()
    expect(bridge.callsTo(CHANNEL)).toHaveLength(1)
  })

  it('sends the two colours it read off the document', async () => {
    setTokens('#121722', '#8b95a3')
    const bridge = installBridge()
    mount()
    await afterNextFrame()

    /* By value, both of them. A test asserting only that a call happened passes against
     * a component that sends the background twice, which paints the glyphs invisible. */
    expect(bridge.lastCallTo(CHANNEL)?.args[0]).toEqual({
      color: '#121722',
      symbolColor: '#8b95a3',
    })
  })

  it('normalises what the token literally said into what the OS accepts', async () => {
    /* The handler rejects anything that is not six hex digits, rightly — these values
     * go straight to the OS. A token may be written short, and a browser may hand back
     * the functional form, so what crosses has to be normalised on this side. Both
     * forms in one render: this is about the payload, not about two code paths. */
    setTokens('#2c3', 'rgb(139, 149, 163)')
    const bridge = installBridge()
    mount()
    await afterNextFrame()

    expect(bridge.lastCallTo(CHANNEL)?.args[0]).toEqual({
      color: '#22cc33',
      symbolColor: '#8b95a3',
    })
  })

  it('does not send the same two colours twice', async () => {
    setTokens('#131415', '#161718')
    const bridge = installBridge()

    const first = mount()
    await afterNextFrame()
    expect(bridge.callsTo(CHANNEL)).toHaveLength(1)

    /* Mounted, unmounted, mounted again — which is what happens on every navigation,
     * because every route in the product renders a ScreenFrame. Three sends of two
     * unchanged colours is three IPC round trips the window did not need. */
    first.unmount()
    mount()
    await afterNextFrame()

    expect(bridge.callsTo(CHANNEL)).toHaveLength(1)
  })

  it('sends again when the theme changes the colours under it', async () => {
    setTokens('#1a1b1c', '#1d1e1f')
    const bridge = installBridge()
    const { getByRole } = mount(<ThemeSwitch />)
    await afterNextFrame()
    expect(bridge.callsTo(CHANNEL)).toHaveLength(1)

    /* The tokens change with the theme in the real app, because the palette is selected
     * by an attribute the ThemeProvider writes. Here the new palette is written
     * directly, and the theme switch is what re-runs the effect. */
    setTokens('#f4f1ea', '#5a6472')
    fireEvent.click(getByRole('button', { name: 'Go dark' }))
    await afterNextFrame()

    expect(bridge.callsTo(CHANNEL)).toHaveLength(2)
    /* Three bright buttons on a near-black bar is what this call exists to prevent, so
     * the SECOND payload is the one that matters. */
    expect(bridge.lastCallTo(CHANNEL)?.args[0]).toEqual({
      color: '#f4f1ea',
      symbolColor: '#5a6472',
    })
  })

  it('sends nothing rather than half a repaint', async () => {
    /* Each condition on its own. With only ever one token missing in a fixture,
     * deleting either half of `color === null || symbolColor === null` changes no
     * result — and what gets through is a call with `undefined` in it, which the
     * handler rejects and the window keeps its old glyphs either way. */
    setTokens('#242526', null)
    const backgroundOnly = installBridge()
    const first = mount()
    await afterNextFrame()
    expect(backgroundOnly.callsTo(CHANNEL)).toHaveLength(0)
    first.unmount()

    setTokens(null, '#272829')
    const symbolOnly = installBridge()
    const second = mount()
    await afterNextFrame()
    expect(symbolOnly.callsTo(CHANNEL)).toHaveLength(0)
    second.unmount()

    setTokens(null, null)
    const neither = installBridge()
    mount()
    await afterNextFrame()
    expect(neither.callsTo(CHANNEL)).toHaveLength(0)
  })

  it('sends nothing when a token is not a colour it can be sure of', async () => {
    /* A named colour is valid CSS and is not six hex digits. Sending a wrong colour is
     * worse than leaving the buttons as they are, so nothing is sent at all. */
    setTokens('chartreuse', '#2a2b2c')
    const bridge = installBridge()
    mount()
    await afterNextFrame()

    expect(bridge.callsTo(CHANNEL)).toHaveLength(0)
  })

  it('sends nothing when the screen it was on is already gone', async () => {
    setTokens('#2d2e2f', '#303132')
    const bridge = installBridge()

    /* Unmounted before the frame arrives — an ordinary navigation, since the effect
     * deliberately waits a frame for the ThemeProvider's own attribute write. Without
     * the `cancelAnimationFrame`, this is a call made on behalf of a screen that no
     * longer exists. */
    mount().unmount()
    await afterNextFrame()

    expect(bridge.callsTo(CHANNEL)).toHaveLength(0)
  })

  it('is quiet when main refuses the colours', async () => {
    setTokens('#333435', '#363738')
    const bridge: FakeBridge = installBridge({
      system: {
        setTitleBarOverlay: () =>
          Promise.resolve({
            ok: false,
            error: { code: 'INVALID_ARGUMENT', message: 'That is not a colour.' },
          }),
      },
    })
    const { container } = mount()
    await afterNextFrame()

    /* A window whose buttons stayed the wrong colour is not worth interrupting anyone
     * over, and there is nothing the user could do about it. The call was made and the
     * refusal changed nothing on screen. */
    expect(bridge.callsTo(CHANNEL)).toHaveLength(1)
    expect(container).toBeEmptyDOMElement()
  })

  it('survives the bridge throwing rather than answering', async () => {
    setTokens('#393a3b', '#3c3d3e')
    const bridge = installBridge({
      system: {
        setTitleBarOverlay: () => {
          throw new Error('The window is gone.')
        },
      },
    })
    const { container } = mount()

    /* `callApi` turns a throw into a Result, and this caller discards it. A rejection
     * escaping here would be an unhandled rejection inside an animation frame, on every
     * screen in the product. */
    await expect(afterNextFrame()).resolves.toBeUndefined()
    expect(bridge.callsTo(CHANNEL)).toHaveLength(1)
    expect(container).toBeEmptyDOMElement()
  })
})
