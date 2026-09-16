import { describe, expect, it } from 'vitest'
import {
  formatShortcut,
  matchesShortcut,
  shouldIgnoreWhileTyping,
  type KeyStroke,
  type Shortcut,
} from './keys'

function stroke(overrides: Partial<KeyStroke> = {}): KeyStroke {
  return { key: 'k', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...overrides }
}

describe('matchesShortcut', () => {
  const palette: Shortcut = { key: 'k', ctrlOrCmd: true }

  it('takes Ctrl on Windows and Linux', () => {
    expect(matchesShortcut(palette, stroke({ ctrlKey: true }), 'win32')).toBe(true)
    expect(matchesShortcut(palette, stroke({ ctrlKey: true }), 'linux')).toBe(true)
  })

  it('takes Cmd on macOS', () => {
    expect(matchesShortcut(palette, stroke({ metaKey: true }), 'darwin')).toBe(true)
  })

  it('does not accept the other platform modifier', () => {
    expect(matchesShortcut(palette, stroke({ metaKey: true }), 'win32')).toBe(false)
    expect(matchesShortcut(palette, stroke({ ctrlKey: true }), 'darwin')).toBe(false)
  })

  it('rejects the combination with both modifiers held', () => {
    expect(matchesShortcut(palette, stroke({ ctrlKey: true, metaKey: true }), 'win32')).toBe(false)
    expect(matchesShortcut(palette, stroke({ ctrlKey: true, metaKey: true }), 'darwin')).toBe(false)
  })

  it('needs the modifier when the shortcut asks for one', () => {
    expect(matchesShortcut(palette, stroke(), 'win32')).toBe(false)
  })

  it('rejects a modifier the shortcut did not ask for', () => {
    expect(matchesShortcut({ key: '/' }, stroke({ key: '/', ctrlKey: true }), 'win32')).toBe(false)
    expect(matchesShortcut(palette, stroke({ ctrlKey: true, shiftKey: true }), 'win32')).toBe(false)
    expect(matchesShortcut(palette, stroke({ ctrlKey: true, altKey: true }), 'win32')).toBe(false)
  })

  it('matches shift and alt when asked for', () => {
    const shortcut: Shortcut = { key: 'p', ctrlOrCmd: true, shift: true }
    expect(
      matchesShortcut(shortcut, stroke({ key: 'p', ctrlKey: true, shiftKey: true }), 'win32'),
    ).toBe(true)
    expect(matchesShortcut(shortcut, stroke({ key: 'p', ctrlKey: true }), 'win32')).toBe(false)
  })

  it('compares the key case insensitively, so Shift does not break it', () => {
    expect(matchesShortcut(palette, stroke({ key: 'K', ctrlKey: true }), 'win32')).toBe(true)
  })

  it('rejects a different key', () => {
    expect(matchesShortcut(palette, stroke({ key: 'j', ctrlKey: true }), 'win32')).toBe(false)
  })
})

describe('shouldIgnoreWhileTyping', () => {
  const bare: Shortcut = { key: '/' }
  const modified: Shortcut = { key: 'k', ctrlOrCmd: true }

  /* Escape types nothing, so a field has no claim on it: it is the step-back key. */
  it('never ignores Escape, whatever has focus', () => {
    expect(shouldIgnoreWhileTyping({ key: 'Escape' }, { tagName: 'INPUT' })).toBe(false)
    expect(shouldIgnoreWhileTyping({ key: 'Escape' }, { tagName: 'TEXTAREA' })).toBe(false)
    expect(shouldIgnoreWhileTyping({ key: 'Escape' }, { isContentEditable: true })).toBe(false)
  })

  it('suppresses an unmodified shortcut inside a text field', () => {
    expect(shouldIgnoreWhileTyping(bare, { tagName: 'INPUT' })).toBe(true)
    expect(shouldIgnoreWhileTyping(bare, { tagName: 'TEXTAREA' })).toBe(true)
    expect(shouldIgnoreWhileTyping(bare, { tagName: 'SELECT' })).toBe(true)
    expect(shouldIgnoreWhileTyping(bare, { tagName: 'DIV', isContentEditable: true })).toBe(true)
  })

  it('lets an unmodified shortcut through elsewhere', () => {
    expect(shouldIgnoreWhileTyping(bare, { tagName: 'BUTTON' })).toBe(false)
    expect(shouldIgnoreWhileTyping(bare, null)).toBe(false)
  })

  /* Cmd+K from inside a search box is exactly what people expect to work. */
  it('always lets a modified shortcut through', () => {
    expect(shouldIgnoreWhileTyping(modified, { tagName: 'INPUT' })).toBe(false)
    expect(shouldIgnoreWhileTyping({ key: 'f', alt: true }, { tagName: 'INPUT' })).toBe(false)
  })

  it('is not confused by lower-case tag names', () => {
    expect(shouldIgnoreWhileTyping(bare, { tagName: 'input' })).toBe(true)
  })

  /* Alt+← is Back. In a field it is a word left on macOS, and Ctrl+← is a word left on
   * Windows, so a caret key is the field's whatever modifier comes with it. */
  it('leaves a caret key to the field, even with a modifier held', () => {
    const back: Shortcut = { key: 'ArrowLeft', alt: true }
    expect(shouldIgnoreWhileTyping(back, { tagName: 'INPUT' })).toBe(true)
    expect(shouldIgnoreWhileTyping({ key: 'Home', ctrlOrCmd: true }, { tagName: 'TEXTAREA' })).toBe(
      true,
    )
    expect(shouldIgnoreWhileTyping(back, { tagName: 'BUTTON' })).toBe(false)
    expect(shouldIgnoreWhileTyping(back, null)).toBe(false)
  })
})

describe('formatShortcut', () => {
  it('uses symbols with no separator on macOS', () => {
    expect(formatShortcut({ key: 'k', ctrlOrCmd: true }, 'darwin')).toBe('⌘K')
    expect(formatShortcut({ key: 'p', ctrlOrCmd: true, shift: true }, 'darwin')).toBe('⇧⌘P')
  })

  it('uses words joined by plus elsewhere', () => {
    expect(formatShortcut({ key: 'k', ctrlOrCmd: true }, 'win32')).toBe('Ctrl+K')
    expect(formatShortcut({ key: 'p', ctrlOrCmd: true, shift: true }, 'linux')).toBe('Ctrl+Shift+P')
  })

  it('names the keys that have no printable glyph', () => {
    expect(formatShortcut({ key: 'Escape' }, 'win32')).toBe('Esc')
    expect(formatShortcut({ key: 'Enter' }, 'win32')).toBe('↵')
    expect(formatShortcut({ key: 'ArrowUp' }, 'win32')).toBe('↑')
  })

  it('leaves a multi-character key as written', () => {
    expect(formatShortcut({ key: 'F1' }, 'win32')).toBe('F1')
  })
})
