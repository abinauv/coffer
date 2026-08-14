import { describe, expect, it } from 'vitest'
import {
  detectPlatform,
  hasLeadingWindowControls,
  isFramelessViewport,
  primaryModifierLabel,
  resolveWindowChrome,
  type WindowChromeInput,
} from './platform'

describe('detectPlatform', () => {
  it('reads the three platforms Coffer ships on', () => {
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/43.4.0')).toBe(
      'win32',
    )
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) Electron/43.4.0')).toBe(
      'darwin',
    )
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64) Electron/43.4.0')).toBe('linux')
  })

  it('is case insensitive', () => {
    expect(detectPlatform('WINDOWS NT 10.0')).toBe('win32')
  })

  /* Linux is the fallback because it is the platform with no OS-drawn controls
   * to reserve space for — guessing it wrong costs the least. */
  it('falls back to linux for anything unrecognised', () => {
    expect(detectPlatform('')).toBe('linux')
    expect(detectPlatform('some-unknown-agent')).toBe('linux')
  })
})

describe('resolveWindowChrome', () => {
  const base: WindowChromeInput = {
    platform: 'win32',
    isFrameless: false,
    hasControlsOverlay: false,
  }

  /* Today main creates a normal window, so this is the mode that must look right
   * with no change to the main process at all. */
  it('is framed when the OS still draws a title bar', () => {
    expect(resolveWindowChrome(base)).toBe('framed')
    expect(resolveWindowChrome({ ...base, platform: 'darwin' })).toBe('framed')
  })

  it('is an OS overlay whenever one is reported, on any platform', () => {
    expect(resolveWindowChrome({ ...base, isFrameless: true, hasControlsOverlay: true })).toBe(
      'os-overlay',
    )
    expect(
      resolveWindowChrome({
        ...base,
        platform: 'linux',
        isFrameless: true,
        hasControlsOverlay: true,
      }),
    ).toBe('os-overlay')
  })

  it('is traffic lights on a frameless macOS window', () => {
    expect(resolveWindowChrome({ ...base, platform: 'darwin', isFrameless: true })).toBe(
      'os-traffic-lights',
    )
  })

  it('is bare when a window is frameless with no controls from anyone', () => {
    expect(resolveWindowChrome({ ...base, isFrameless: true })).toBe('frameless-bare')
    expect(resolveWindowChrome({ ...base, platform: 'linux', isFrameless: true })).toBe(
      'frameless-bare',
    )
  })
})

describe('isFramelessViewport', () => {
  it('is true when the web contents fill the window', () => {
    expect(isFramelessViewport({ outerHeight: 820, innerHeight: 820 })).toBe(true)
  })

  it('tolerates a fractional device pixel ratio', () => {
    expect(isFramelessViewport({ outerHeight: 820, innerHeight: 817 })).toBe(true)
  })

  it('is false when an OS title bar sits above the contents', () => {
    expect(isFramelessViewport({ outerHeight: 820, innerHeight: 792 })).toBe(false)
  })

  it('is false before layout, when the numbers are meaningless', () => {
    expect(isFramelessViewport({ outerHeight: 0, innerHeight: 0 })).toBe(false)
  })
})

describe('primaryModifierLabel', () => {
  it('names the platform modifier', () => {
    expect(primaryModifierLabel('darwin')).toBe('⌘')
    expect(primaryModifierLabel('win32')).toBe('Ctrl')
    expect(primaryModifierLabel('linux')).toBe('Ctrl')
  })
})

describe('hasLeadingWindowControls', () => {
  it('is true only for macOS traffic lights', () => {
    expect(hasLeadingWindowControls('os-traffic-lights')).toBe(true)
    expect(hasLeadingWindowControls('os-overlay')).toBe(false)
    expect(hasLeadingWindowControls('framed')).toBe(false)
    expect(hasLeadingWindowControls('frameless-bare')).toBe(false)
  })
})
