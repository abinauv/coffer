/*
 * Keeps the OS-drawn window buttons in the same theme as everything else.
 *
 * On Windows and Linux the minimise, maximise and close glyphs are painted by the system
 * over our title bar, in colours fixed when the window was created. Switch to dark and
 * they stay light — three bright buttons on a near-black bar — until the renderer sends
 * new ones, because the renderer is the only side that knows which theme is showing.
 *
 * WHY IT LIVES IN A SCREEN. The natural home is the shell, beside the ThemeProvider that
 * already owns this decision. This batch does not own those files, so the effect rides
 * along in `ScreenFrame`, which every screen renders — and every route in the product is
 * a screen, so it is mounted whenever the window is. Noted in the batch report; moving it
 * up into the shell is a three-line change and should happen.
 *
 * The colours are read off the document rather than hard-coded, so they follow
 * styles/tokens.css and cannot drift from the title bar they sit in.
 */

import { useEffect } from 'react'
import { callApi } from '@renderer/lib/api'
import { useTheme } from '@renderer/store/theme'
import type { TitleBarOverlayColors } from '@shared/dto'
import { isSameOverlay, overlayColorsFrom } from '../lib/title-bar'

/*
 * Module scope, not a ref: what the OS is currently painting is a property of the window,
 * not of any component. A screen that mounts, unmounts and mounts again should not send
 * the same two colours three times.
 */
let lastSent: TitleBarOverlayColors | null = null

export function TitleBarSync(): null {
  const { theme } = useTheme()

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined

    /*
     * On the next frame, not in this effect. The attribute that selects the palette is
     * written by the ThemeProvider's own effect, and a parent's effect runs after its
     * children's — reading the tokens here would read the theme we are leaving. A frame
     * later, the document has caught up.
     */
    const frame = window.requestAnimationFrame(() => {
      const computed = window.getComputedStyle(document.documentElement)
      const colors = overlayColorsFrom((token) => computed.getPropertyValue(token))
      if (colors === null || isSameOverlay(colors, lastSent)) return
      lastSent = colors
      /* A window whose buttons stayed the wrong colour is not worth interrupting anyone
       * over, and there is nothing the user could do about it. Failure is left quiet. */
      void callApi((api) => api.system.setTitleBarOverlay(colors))
    })

    return () => window.cancelAnimationFrame(frame)
  }, [theme])

  return null
}
