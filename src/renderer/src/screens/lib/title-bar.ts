/*
 * The colours the OS paints its own window buttons in.
 *
 * On Windows and Linux those buttons are drawn by the system over our title bar, from
 * values fixed when the window was created (src/main/index.ts). Nothing repaints them
 * when the user switches theme, so a dark-mode window keeps light-mode minimise, maximise
 * and close glyphs until somebody sends new colours across — which is what
 * `system.setTitleBarOverlay` is for. macOS ignores it; its traffic lights follow the
 * system appearance on their own.
 *
 * The values come from the same two tokens the title bar itself uses, read off the
 * document rather than copied into this file. A second hard-coded palette in the renderer
 * is a palette that drifts from styles/tokens.css the first time a shade is adjusted.
 */

import type { TitleBarOverlayColors } from '@shared/dto'

/** The background behind the buttons. */
export const OVERLAY_BACKGROUND_TOKEN = '--chrome'

/** The glyphs themselves. */
export const OVERLAY_SYMBOL_TOKEN = '--ink-muted'

/**
 * Normalise a CSS colour to the `#rrggbb` the main process accepts.
 *
 * `getPropertyValue` hands back whatever the token literally says, and the handler in
 * src/main/ipc/handlers/system.ts rejects anything that is not six hex digits — rightly,
 * since these values go straight to the OS. Shorthand hex and the `rgb()` form a browser
 * may return are converted; anything else returns null and the call is not made at all,
 * because sending a wrong colour is worse than leaving the buttons as they are.
 */
export function toHexColor(value: string): string | null {
  const text = value.trim().toLowerCase()
  if (text === '') return null

  if (text.startsWith('#')) {
    const digits = text.slice(1)
    if (/^[0-9a-f]{6}$/.test(digits)) return `#${digits}`
    if (/^[0-9a-f]{3}$/.test(digits)) {
      return `#${[...digits].map((digit) => `${digit}${digit}`).join('')}`
    }
    /* Eight digits is #rrggbbaa. The alpha is dropped: the OS overlay has no notion of
     * transparency, and a title bar is never see-through. */
    if (/^[0-9a-f]{8}$/.test(digits)) return `#${digits.slice(0, 6)}`
    return null
  }

  const functional = /^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)/.exec(text)
  if (functional === null) return null
  const channels = [functional[1], functional[2], functional[3]].map((part) => Number(part))
  if (channels.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255)) {
    return null
  }
  return `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`
}

/** Reads one custom property. The document supplies this in the app; tests supply a map. */
export type TokenReader = (token: string) => string | null | undefined

/**
 * The overlay colours for whatever theme is showing, or null when either token cannot be
 * read as a colour — in which case nothing is sent.
 */
export function overlayColorsFrom(read: TokenReader): TitleBarOverlayColors | null {
  const color = toHexColor(read(OVERLAY_BACKGROUND_TOKEN) ?? '')
  const symbolColor = toHexColor(read(OVERLAY_SYMBOL_TOKEN) ?? '')
  if (color === null || symbolColor === null) return null
  return { color, symbolColor }
}

/** True when these are the colours already sent. Saves an IPC call per navigation. */
export function isSameOverlay(
  a: TitleBarOverlayColors | null,
  b: TitleBarOverlayColors | null,
): boolean {
  if (a === null || b === null) return a === b
  return a.color === b.color && a.symbolColor === b.symbolColor
}
