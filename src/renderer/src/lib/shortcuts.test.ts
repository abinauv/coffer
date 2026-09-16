import { describe, expect, it } from 'vitest'
import { formatShortcut } from './keys'
import { SHORTCUTS } from './shortcuts'

const entries = Object.entries(SHORTCUTS)

describe('the key map', () => {
  /*
   * THE TEST THIS FILE EXISTS FOR. Two commands on one chord is a binding that works
   * until both screens are on at once, and then fires whichever registered last — which
   * is a defect nobody can reproduce on purpose.
   */
  it.each(['win32', 'darwin', 'linux'] as const)('binds each chord once on %s', (platform) => {
    const written = entries.map(([name, shortcut]) => [name, formatShortcut(shortcut, platform)])
    const chords = written.map(([, chord]) => chord)
    expect(new Set(chords).size, JSON.stringify(written)).toBe(chords.length)
  })

  /* Every binding is a chord a field cannot swallow: a modifier, or a key that types
   * nothing. An unmodified letter as a shortcut would be lost inside every input. */
  it('holds no binding a text field would eat', () => {
    for (const [name, shortcut] of entries) {
      const isModified = 'ctrlOrCmd' in shortcut || 'alt' in shortcut
      expect(isModified || shortcut.key === 'Escape', name).toBe(true)
    }
  })

  it('writes the modern map the way the design system does', () => {
    expect(formatShortcut(SHORTCUTS.palette, 'win32')).toBe('Ctrl+K')
    expect(formatShortcut(SHORTCUTS.accept, 'win32')).toBe('Ctrl+↵')
    expect(formatShortcut(SHORTCUTS.switchCompany, 'win32')).toBe('Ctrl+Shift+O')
    /* macOS prints symbols, in its own order, with no separator. */
    expect(formatShortcut(SHORTCUTS.switchCompany, 'darwin')).toBe('⇧⌘O')
    expect(formatShortcut(SHORTCUTS.stepBack, 'darwin')).toBe('Esc')
  })
})
