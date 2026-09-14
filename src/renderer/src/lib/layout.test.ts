import { describe, expect, it } from 'vitest'
import { parseRailPreference, resolveRailCollapsed, toggledRailPreference } from './layout'

describe('parseRailPreference', () => {
  it('accepts the two explicit values', () => {
    expect(parseRailPreference('expanded')).toBe('expanded')
    expect(parseRailPreference('collapsed')).toBe('collapsed')
  })

  it('falls back to auto for anything else', () => {
    for (const value of [null, undefined, '', 'yes', 0, {}]) {
      expect(parseRailPreference(value)).toBe('auto')
    }
  })
})

describe('resolveRailCollapsed', () => {
  it('follows the viewport when the user has not chosen', () => {
    expect(resolveRailCollapsed('auto', true)).toBe(true)
    expect(resolveRailCollapsed('auto', false)).toBe(false)
  })

  /* A stated preference outranks the window size in both directions — the
   * rail must not silently re-expand when the user widens the window. */
  it('honours an explicit choice at any width', () => {
    expect(resolveRailCollapsed('expanded', true)).toBe(false)
    expect(resolveRailCollapsed('expanded', false)).toBe(false)
    expect(resolveRailCollapsed('collapsed', true)).toBe(true)
    expect(resolveRailCollapsed('collapsed', false)).toBe(true)
  })
})

describe('toggledRailPreference', () => {
  it('always produces an explicit preference', () => {
    expect(toggledRailPreference('auto', false)).toBe('collapsed')
    expect(toggledRailPreference('auto', true)).toBe('expanded')
  })

  it('inverts what is currently shown', () => {
    expect(toggledRailPreference('expanded', false)).toBe('collapsed')
    expect(toggledRailPreference('collapsed', false)).toBe('expanded')
  })

  it('round-trips back to where it started', () => {
    const once = toggledRailPreference('auto', true)
    expect(resolveRailCollapsed(once, true)).toBe(false)
    const twice = toggledRailPreference(once, true)
    expect(resolveRailCollapsed(twice, true)).toBe(true)
  })
})
