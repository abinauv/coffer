import { describe, expect, it } from 'vitest'
import { parseSidebarPreference, resolveSidebarCollapsed, toggledSidebarPreference } from './layout'

describe('parseSidebarPreference', () => {
  it('accepts the two explicit values', () => {
    expect(parseSidebarPreference('expanded')).toBe('expanded')
    expect(parseSidebarPreference('collapsed')).toBe('collapsed')
  })

  it('falls back to auto for anything else', () => {
    for (const value of [null, undefined, '', 'yes', 0, {}]) {
      expect(parseSidebarPreference(value)).toBe('auto')
    }
  })
})

describe('resolveSidebarCollapsed', () => {
  it('follows the viewport when the user has not chosen', () => {
    expect(resolveSidebarCollapsed('auto', true)).toBe(true)
    expect(resolveSidebarCollapsed('auto', false)).toBe(false)
  })

  /* A stated preference outranks the window size in both directions — the
   * sidebar must not silently re-expand when the user widens the window. */
  it('honours an explicit choice at any width', () => {
    expect(resolveSidebarCollapsed('expanded', true)).toBe(false)
    expect(resolveSidebarCollapsed('expanded', false)).toBe(false)
    expect(resolveSidebarCollapsed('collapsed', true)).toBe(true)
    expect(resolveSidebarCollapsed('collapsed', false)).toBe(true)
  })
})

describe('toggledSidebarPreference', () => {
  it('always produces an explicit preference', () => {
    expect(toggledSidebarPreference('auto', false)).toBe('collapsed')
    expect(toggledSidebarPreference('auto', true)).toBe('expanded')
  })

  it('inverts what is currently shown', () => {
    expect(toggledSidebarPreference('expanded', false)).toBe('collapsed')
    expect(toggledSidebarPreference('collapsed', false)).toBe('expanded')
  })

  it('round-trips back to where it started', () => {
    const once = toggledSidebarPreference('auto', true)
    expect(resolveSidebarCollapsed(once, true)).toBe(false)
    const twice = toggledSidebarPreference(once, true)
    expect(resolveSidebarCollapsed(twice, true)).toBe(true)
  })
})
