/*
 * Keyboard shortcuts.
 *
 * A shortcut is declared once, on the command that owns it (see command-registry.ts).
 * The shell installs a single listener and matches against the registry, so there is
 * no second place where a key binding can be defined and drift.
 *
 * `ctrlOrCmd` is one flag, not two, because the same command is Ctrl on Windows and
 * Linux and Cmd on macOS, and matching both everywhere would swallow Cmd-key
 * combinations the OS owns.
 */

import type { Platform } from '@shared/dto'

export interface Shortcut {
  /** A `KeyboardEvent.key` value. Compared case-insensitively. */
  key: string
  /** Cmd on macOS, Ctrl elsewhere. */
  ctrlOrCmd?: boolean
  shift?: boolean
  alt?: boolean
}

/** The fields of a KeyboardEvent this module reads. */
export interface KeyStroke {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export function matchesShortcut(shortcut: Shortcut, event: KeyStroke, platform: Platform): boolean {
  if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) return false

  const wantsPrimary = shortcut.ctrlOrCmd === true
  const primaryHeld = platform === 'darwin' ? event.metaKey : event.ctrlKey
  /* The other modifier must be absent, or Ctrl+Cmd+K would fire a Cmd+K binding. */
  const otherHeld = platform === 'darwin' ? event.ctrlKey : event.metaKey
  if (wantsPrimary !== primaryHeld) return false
  if (otherHeld) return false

  if ((shortcut.shift === true) !== event.shiftKey) return false
  if ((shortcut.alt === true) !== event.altKey) return false
  return true
}

/**
 * Whether a shortcut should be ignored because the user is typing.
 *
 * An unmodified letter must never steal a keystroke from a field. A modified one
 * still fires — Cmd+K from inside a search box is exactly what people expect.
 */
export function shouldIgnoreWhileTyping(
  shortcut: Shortcut,
  target: { tagName?: string; isContentEditable?: boolean } | null,
): boolean {
  if (shortcut.ctrlOrCmd === true || shortcut.alt === true) return false
  if (!target) return false
  if (target.isContentEditable === true) return true
  const tag = (target.tagName ?? '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** The parts of a shortcut, in the order the platform writes them. */
export function shortcutParts(shortcut: Shortcut, platform: Platform): string[] {
  const parts: string[] = []
  if (platform === 'darwin') {
    /* macOS orders modifiers Ctrl-Alt-Shift-Cmd and prints them as symbols. */
    if (shortcut.alt === true) parts.push('⌥')
    if (shortcut.shift === true) parts.push('⇧')
    if (shortcut.ctrlOrCmd === true) parts.push('⌘')
  } else {
    if (shortcut.ctrlOrCmd === true) parts.push('Ctrl')
    if (shortcut.alt === true) parts.push('Alt')
    if (shortcut.shift === true) parts.push('Shift')
  }
  parts.push(displayKey(shortcut.key))
  return parts
}

export function formatShortcut(shortcut: Shortcut, platform: Platform): string {
  const parts = shortcutParts(shortcut, platform)
  return platform === 'darwin' ? parts.join('') : parts.join('+')
}

function displayKey(key: string): string {
  const named: Record<string, string> = {
    arrowup: '↑',
    arrowdown: '↓',
    arrowleft: '←',
    arrowright: '→',
    enter: '↵',
    escape: 'Esc',
    ' ': 'Space',
    backspace: '⌫',
    tab: '⇥',
  }
  const mapped = named[key.toLowerCase()]
  if (mapped !== undefined) return mapped
  return key.length === 1 ? key.toUpperCase() : key
}
