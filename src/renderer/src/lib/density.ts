/*
 * Density resolution.
 *
 * Two preferences. `comfortable` is the default and `compact` trades padding for rows —
 * someone entering forty purchase bills on a Friday afternoon wants thirty rows on screen.
 *
 * The contract with styles/tokens.css is the `data-density` attribute, and it follows the
 * same rule as `data-theme`: the default REMOVES the attribute rather than writing it, so
 * the bare `:root` block is the comfortable one and only compact is ever named.
 *
 * Pure and argument-driven, like lib/theme.ts, so it is testable with no DOM.
 */

export type DensityPreference = 'comfortable' | 'compact'

/** Every preference, in the order a control shows them. */
export const DENSITY_PREFERENCES: readonly DensityPreference[] = ['comfortable', 'compact']

export const DENSITY_STORAGE_KEY = 'coffer.density'

export const DENSITY_LABELS: Readonly<Record<DensityPreference, string>> = {
  comfortable: 'Comfortable',
  compact: 'Compact',
}

export function isDensityPreference(value: unknown): value is DensityPreference {
  return value === 'comfortable' || value === 'compact'
}

/** Anything unrecognised — absent, corrupt, from a future version — means comfortable. */
export function parseDensityPreference(value: unknown): DensityPreference {
  return isDensityPreference(value) ? value : 'comfortable'
}

/** The value for `data-density`, or null when the attribute must be removed. */
export function densityAttribute(preference: DensityPreference): 'compact' | null {
  return preference === 'compact' ? 'compact' : null
}

/** The narrowest slice of an element this module needs. */
export interface DensityTarget {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

export function applyDensityPreference(target: DensityTarget, preference: DensityPreference): void {
  const attribute = densityAttribute(preference)
  if (attribute === null) target.removeAttribute('data-density')
  else target.setAttribute('data-density', attribute)
}
