/*
 * Routing.
 *
 * No router dependency and no URL. A desktop window has no address bar to type
 * into and no history to share, so a route here is a value the app holds, not a
 * string it parses. What is left is the part that actually matters — a history
 * stack, and one rule about when it resets.
 *
 * THE APP HAS TWO AREAS, and which one is active is not a navigation decision:
 *
 *   welcome    no company is open. The picker, creating a company, restoring one.
 *   workspace  a company is open. Sidebar, nav, the books.
 *
 * The area is derived from whether a company is open, never set by navigate().
 * Closing a company cannot leave a ledger screen reachable by pressing Back, so
 * `routeForCompany` clears the stack whenever the area flips.
 */

export type AppArea = 'welcome' | 'workspace'

export interface Route {
  area: AppArea
  /** The id of a screen registered for this area. See screens.ts. */
  screenId: string
  /** Screen arguments. Strings only, so a route stays comparable and loggable. */
  params: Readonly<Record<string, string>>
}

/** Where each area lands when it has nothing better to show. */
export const AREA_HOME: Readonly<Record<AppArea, string>> = {
  welcome: 'companies',
  workspace: 'overview',
}

/** Deep stacks are a sign of a lost user, not a feature. */
const MAX_HISTORY = 50

export function homeRoute(area: AppArea): Route {
  return { area, screenId: AREA_HOME[area], params: {} }
}

export function makeRoute(
  area: AppArea,
  screenId: string,
  params: Readonly<Record<string, string>> = {},
): Route {
  return { area, screenId, params }
}

export function areaForCompany(hasCompanyOpen: boolean): AppArea {
  return hasCompanyOpen ? 'workspace' : 'welcome'
}

export function isSameRoute(a: Route, b: Route): boolean {
  if (a.area !== b.area || a.screenId !== b.screenId) return false
  const aKeys = Object.keys(a.params)
  const bKeys = Object.keys(b.params)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => a.params[key] === b.params[key])
}

export function currentRoute(history: readonly Route[]): Route {
  return history[history.length - 1] ?? homeRoute('welcome')
}

export function canGoBack(history: readonly Route[]): boolean {
  return history.length > 1
}

export type NavigationMode = 'push' | 'replace'

export function navigate(
  history: readonly Route[],
  to: Route,
  mode: NavigationMode = 'push',
): readonly Route[] {
  /* Navigating to where you already are is not a history entry. Without this,
   * clicking the active nav item twice makes Back a no-op that looks broken. */
  if (mode === 'push' && isSameRoute(currentRoute(history), to)) return history
  const base = mode === 'replace' ? history.slice(0, -1) : history
  const next = [...base, to]
  return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next
}

export function goBack(history: readonly Route[]): readonly Route[] {
  return canGoBack(history) ? history.slice(0, -1) : history
}

/**
 * Reconciles the history with whether a company is open.
 *
 * Same area: untouched. Different area: replaced with that area's home, because
 * every entry in the old stack belongs to books that are no longer unlocked.
 */
export function routeForCompany(
  history: readonly Route[],
  hasCompanyOpen: boolean,
): readonly Route[] {
  const area = areaForCompany(hasCompanyOpen)
  if (history.length > 0 && currentRoute(history).area === area) return history
  return [homeRoute(area)]
}
