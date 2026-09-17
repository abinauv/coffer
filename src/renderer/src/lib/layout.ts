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

/** The widest window, in CSS pixels, that collapses the rail while nobody has chosen. */
export const NARROW_VIEWPORT_MAX_PX = 1200

export const NARROW_VIEWPORT_QUERY = `(max-width: ${NARROW_VIEWPORT_MAX_PX}px)`

/* A new key, not the old sidebar's. The rail is a different control, and a `sidebar`
 * navigation layout, if one is ever built, will want the old word back for itself. */
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

/*
 * THE NAVIGATION SETTING IS THE RAIL PREFERENCE, NAMED FOR WHAT IT DRAWS.
 *
 * Settings → Navigation offers the two layouts that exist: the section bar with the rail
 * as words, and the section bar with the rail as icons. The rail's own collapse button and
 * Ctrl B change the same stored value, so the setting and the button can never disagree
 * about what is on screen — they are two controls for one fact, not two facts.
 */
export type NavigationLayout = 'sections' | 'icons'

/** Every layout, in the order Settings shows them. */
export const NAVIGATION_LAYOUTS: readonly NavigationLayout[] = ['sections', 'icons']

/** What the layout on screen is: the choice if there is one, otherwise the window's width. */
export function resolveNavigationLayout(
  preference: RailPreference,
  isNarrowViewport: boolean,
): NavigationLayout {
  return resolveRailCollapsed(preference, isNarrowViewport) ? 'icons' : 'sections'
}

/** Choosing a layout is always an explicit preference, for the reason the toggle's is. */
export function railPreferenceFor(layout: NavigationLayout): RailPreference {
  return layout === 'icons' ? 'collapsed' : 'expanded'
}
