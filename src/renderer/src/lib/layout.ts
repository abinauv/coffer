/*
 * Layout decisions that are worth stating once rather than scattering through CSS.
 *
 * The window's floor is 1024×640 (src/main/index.ts). At that width the 208px rail
 * leaves 816px for content — enough, just, for a ledger table with a date, a
 * narration, two amount columns and a running balance, and not enough for it to
 * breathe. So the rail collapses to icons on its own below the threshold, giving the
 * table 968px — but only as a default, never overriding a user who has said what
 * they want.
 */

export const NARROW_VIEWPORT_QUERY = '(max-width: 1200px)'

/* A new key, not the old sidebar's. The rail is a different control, and the `sidebar`
 * navigation mode that arrives with Settings will want the old word back for itself. */
export const RAIL_STORAGE_KEY = 'coffer.rail-collapsed'

/** What the user asked for, or `auto` if they have not said. */
export type RailPreference = 'auto' | 'expanded' | 'collapsed'

export function parseRailPreference(value: unknown): RailPreference {
  return value === 'expanded' || value === 'collapsed' ? value : 'auto'
}

export function resolveRailCollapsed(
  preference: RailPreference,
  isNarrowViewport: boolean,
): boolean {
  if (preference === 'collapsed') return true
  if (preference === 'expanded') return false
  return isNarrowViewport
}

/**
 * What the collapse toggle should do next.
 *
 * Toggling always produces an explicit preference — once the user has taken a
 * position, the window resizing under them must not silently overrule it.
 */
export function toggledRailPreference(
  preference: RailPreference,
  isNarrowViewport: boolean,
): RailPreference {
  return resolveRailCollapsed(preference, isNarrowViewport) ? 'expanded' : 'collapsed'
}
