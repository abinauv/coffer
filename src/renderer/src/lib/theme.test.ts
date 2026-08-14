import { describe, expect, it } from 'vitest'
import {
  applyThemePreference,
  isThemePreference,
  nextThemePreference,
  parseThemePreference,
  resolveTheme,
  THEME_PREFERENCES,
  themeAttribute,
  type ThemeTarget,
} from './theme'

/** Records what the shell would have written onto <html>. */
function fakeTarget(): ThemeTarget & { attributes: Map<string, string> } {
  const attributes = new Map<string, string>()
  return {
    attributes,
    setAttribute: (name, value) => void attributes.set(name, value),
    removeAttribute: (name) => void attributes.delete(name),
  }
}

describe('resolveTheme', () => {
  it('follows the system when the preference is system', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('ignores the system when the preference is explicit', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('light', false)).toBe('light')
    expect(resolveTheme('dark', true)).toBe('dark')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('covers every preference against both system states', () => {
    for (const preference of THEME_PREFERENCES) {
      for (const systemPrefersDark of [true, false]) {
        expect(['light', 'dark']).toContain(resolveTheme(preference, systemPrefersDark))
      }
    }
  })
})

describe('themeAttribute', () => {
  /* The load-bearing case. Writing data-theme="light" for a `system` user would
   * match :root:not([data-theme='light']) and pin them out of OS dark mode. */
  it('is null for system, so the attribute is removed rather than resolved', () => {
    expect(themeAttribute('system')).toBeNull()
  })

  it('is the preference itself when explicit', () => {
    expect(themeAttribute('light')).toBe('light')
    expect(themeAttribute('dark')).toBe('dark')
  })
})

describe('applyThemePreference', () => {
  it('writes the attribute for an explicit choice', () => {
    const target = fakeTarget()
    applyThemePreference(target, 'dark')
    expect(target.attributes.get('data-theme')).toBe('dark')

    applyThemePreference(target, 'light')
    expect(target.attributes.get('data-theme')).toBe('light')
  })

  it('removes the attribute when returning to system', () => {
    const target = fakeTarget()
    applyThemePreference(target, 'dark')
    applyThemePreference(target, 'system')
    expect(target.attributes.has('data-theme')).toBe(false)
  })

  it('is safe to apply system first, with no attribute present', () => {
    const target = fakeTarget()
    applyThemePreference(target, 'system')
    expect(target.attributes.size).toBe(0)
  })
})

describe('parseThemePreference', () => {
  it('accepts the three known values', () => {
    expect(parseThemePreference('system')).toBe('system')
    expect(parseThemePreference('light')).toBe('light')
    expect(parseThemePreference('dark')).toBe('dark')
  })

  it('falls back to system for anything else', () => {
    for (const value of [null, undefined, '', 'DARK', 'sepia', 7, {}, []]) {
      expect(parseThemePreference(value)).toBe('system')
    }
  })

  it('narrows with isThemePreference', () => {
    expect(isThemePreference('dark')).toBe(true)
    expect(isThemePreference('sepia')).toBe(false)
  })
})

describe('nextThemePreference', () => {
  it('cycles system to light to dark and back', () => {
    expect(nextThemePreference('system')).toBe('light')
    expect(nextThemePreference('light')).toBe('dark')
    expect(nextThemePreference('dark')).toBe('system')
  })

  it('returns to the start after one full cycle', () => {
    let preference = nextThemePreference('system')
    preference = nextThemePreference(preference)
    preference = nextThemePreference(preference)
    expect(preference).toBe('system')
  })
})
