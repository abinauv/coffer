/*
 * Platform detection and window chrome.
 *
 * The renderer needs the platform before the first IPC round trip completes — the
 * title bar has to reserve the right amount of space on its first paint or the
 * window controls land on top of the app's own buttons. So the user-agent string
 * gives an immediate answer and `system.getAppInfo()` refines it a moment later.
 *
 * WINDOW CHROME. Coffer draws its own title bar, which means main must stop
 * drawing one. Which of the four modes below applies is decided by main's
 * BrowserWindow options; the renderer detects the result rather than assuming it,
 * so the same build is correct whether or not that change has landed.
 */

import type { Platform } from '@shared/dto'

export type { Platform }

export function detectPlatform(userAgent: string): Platform {
  const ua = userAgent.toLowerCase()
  if (ua.includes('mac os x') || ua.includes('macintosh')) return 'darwin'
  if (ua.includes('windows')) return 'win32'
  return 'linux'
}

/** How the window's controls are being drawn, and by whom. */
export type WindowChrome =
  /** The OS draws a full title bar above our content. We are a plain header. */
  | 'framed'
  /** Windows/Linux: the OS paints minimise/maximise/close over our top-right. */
  | 'os-overlay'
  /** macOS `titleBarStyle: 'hidden'`: traffic lights float over our top-left. */
  | 'os-traffic-lights'
  /** Frameless with no OS controls at all. Nothing can close the window but a
   *  menu accelerator, so this mode is a misconfiguration rather than a design. */
  | 'frameless-bare'

export interface WindowChromeInput {
  platform: Platform
  /** True when the web contents fill the window — no OS title bar above them. */
  isFrameless: boolean
  /** True when `navigator.windowControlsOverlay` reports a visible overlay. */
  hasControlsOverlay: boolean
}

export function resolveWindowChrome(input: WindowChromeInput): WindowChrome {
  if (input.hasControlsOverlay) return 'os-overlay'
  if (!input.isFrameless) return 'framed'
  if (input.platform === 'darwin') return 'os-traffic-lights'
  return 'frameless-bare'
}

/**
 * Frameless detection without an API for it.
 *
 * There is no direct signal for `titleBarStyle: 'hidden'` on macOS, but there is
 * an indirect one: with an OS title bar the window is taller than its web
 * contents by the height of that bar, and without one the two agree. A few pixels
 * of tolerance absorbs fractional device pixel ratios.
 */
export function isFramelessViewport(size: { outerHeight: number; innerHeight: number }): boolean {
  if (size.outerHeight <= 0 || size.innerHeight <= 0) return false
  return size.outerHeight - size.innerHeight <= 4
}

/** The modifier this platform calls its primary one. */
export function primaryModifierLabel(platform: Platform): string {
  return platform === 'darwin' ? '⌘' : 'Ctrl'
}

/** True where the OS puts window controls on the left of the title bar. */
export function hasLeadingWindowControls(chrome: WindowChrome): boolean {
  return chrome === 'os-traffic-lights'
}
