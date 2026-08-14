/*
 * Layout decisions that are worth stating once rather than scattering through CSS.
 *
 * The window's floor is 1024×640 (src/main/index.ts). At that width a 232px
 * sidebar leaves under 800px for content, which a ledger table with a date, a
 * narration, two amount columns and a running balance does not fit into. So the
 * sidebar collapses to icons on its own below the threshold — but only as a
 * default, never overriding a user who has said what they want.
 */

export const NARROW_VIEWPORT_QUERY = '(max-width: 1200px)'

export const SIDEBAR_STORAGE_KEY = 'coffer.sidebar-collapsed'

/** What the user asked for, or `auto` if they have not said. */
export type SidebarPreference = 'auto' | 'expanded' | 'collapsed'

export function parseSidebarPreference(value: unknown): SidebarPreference {
  return value === 'expanded' || value === 'collapsed' ? value : 'auto'
}

export function resolveSidebarCollapsed(
  preference: SidebarPreference,
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
export function toggledSidebarPreference(
  preference: SidebarPreference,
  isNarrowViewport: boolean,
): SidebarPreference {
  return resolveSidebarCollapsed(preference, isNarrowViewport) ? 'expanded' : 'collapsed'
}
