/*
 * Theme resolution.
 *
 * Three preferences, two outcomes. `system` means "whatever the OS says, now and
 * whenever it changes"; `light` and `dark` are explicit and outrank the OS.
 *
 * The contract with styles/tokens.css is the `data-theme` attribute, and the one
 * subtlety worth stating: `system` REMOVES the attribute rather than writing a
 * resolved value into it. The dark block is guarded by
 * `:root:not([data-theme='light'])`, so writing `data-theme="light"` while the user
 * is on `system` would pin them to light and break the OS follow. The attribute
 * records the choice, never the outcome.
 *
 * Everything here is pure and takes its inputs as arguments — no `window`, no
 * `document`, no `localStorage` — so it can be tested under a node environment.
 */

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

/** Every preference, in the order the segmented control shows them. */
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']

export const THEME_STORAGE_KEY = 'coffer.theme'

export const THEME_LABELS: Readonly<Record<ThemePreference, string>> = {
  system: 'Match system',
  light: 'Light',
  dark: 'Dark',
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

/** Anything unrecognised — absent, corrupt, from a future version — means system. */
export function parseThemePreference(value: unknown): ThemePreference {
  return isThemePreference(value) ? value : 'system'
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === 'light') return 'light'
  if (preference === 'dark') return 'dark'
  return systemPrefersDark ? 'dark' : 'light'
}

/**
 * The value for the `data-theme` attribute, or null when the attribute must be
 * removed. See the note at the top of this file — `system` is null, not 'light'.
 */
export function themeAttribute(preference: ThemePreference): 'light' | 'dark' | null {
  return preference === 'system' ? null : preference
}

/** The narrowest slice of an element this module needs. Keeps it testable. */
export interface ThemeTarget {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

export function applyThemePreference(target: ThemeTarget, preference: ThemePreference): void {
  const attribute = themeAttribute(preference)
  if (attribute === null) target.removeAttribute('data-theme')
  else target.setAttribute('data-theme', attribute)
}

/** Cycles system → light → dark → system, for a single toggle affordance. */
export function nextThemePreference(current: ThemePreference): ThemePreference {
  const index = THEME_PREFERENCES.indexOf(current)
  const next = THEME_PREFERENCES[(index + 1) % THEME_PREFERENCES.length]
  return next ?? 'system'
}
