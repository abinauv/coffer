/*
 * The screen registry — the seam this shell exists to provide.
 *
 * A screen is a value: an id, the area it belongs to, optional navigation
 * metadata, and a render function. Adding one to the product is one call to
 * `registerScreens` from a module under `src/renderer/src/screens/`, and nothing
 * in the shell changes. The section bar and rail build themselves from `nav`, the router resolves
 * `screenId` against `id`, and the command palette gets a "Go to …" command for
 * every navigable screen for free.
 *
 * Modules under `screens/` are imported for their side effects by the provider in
 * store/screens.tsx, so a new screen folder needs no wiring at all.
 */

import type { ReactNode } from 'react'
import type { IconName } from './icons'
import type { AppArea, Route } from './routing'

/*
 * The six sections, in the order the section bar draws them. A screen names one.
 *
 * SIX, AND NO "WORK" SECTION. The dashboard used to be the only screen in a group of its
 * own, which put a seventh tab across the top holding one item. It lives under Accounts now,
 * first in that rail, and stays the workspace's home (`AREA_HOME`).
 *
 * RECEIPTS AND PAYMENTS SIT ON THEIR TRADE SIDE. A receipt is under Sales beside the invoice
 * it settles, a payment under Purchases beside the bill. The design's single "Receipts &
 * payments" item under Accounts assumed one register; there are four, one per kind.
 */
export const NAV_GROUPS = [
  { id: 'sales', label: 'Sales' },
  { id: 'purchases', label: 'Purchases' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'reports', label: 'Reports' },
  { id: 'company', label: 'Company' },
] as const

export type NavGroupId = (typeof NAV_GROUPS)[number]['id']

/** A section's name as the section bar draws it, for a sentence that points somewhere. */
export function navGroupLabel(id: NavGroupId): string {
  return NAV_GROUPS.find((group) => group.id === id)?.label ?? id
}

export interface ScreenNav {
  /** The rail's label. Usually shorter than the screen title. */
  label: string
  icon: IconName
  group: NavGroupId
  /** Rank within the group. Ties fall back to the label. */
  order: number
}

export interface ScreenContext {
  route: Route
  navigate: (to: Route) => void
}

export interface ScreenDefinition {
  /** Matched against `Route.screenId`. Unique within its area. */
  id: string
  /** Shown in the title bar and as the screen heading. */
  title: string
  area: AppArea
  /** Present when the screen should appear in the rail. */
  nav?: ScreenNav
  /**
   * For a screen with no `nav`: the id of the rail screen it is opened from.
   *
   * An editor is not in the rail — there is no "the" invoice to land on — but while one is
   * open the rail still has to say where you are. It highlights this screen, and the section
   * bar the section this screen is in. Absent on a screen that belongs to no one register,
   * such as the list of every party; the rail then keeps showing the section you came from.
   */
  navParent?: string
  render: (context: ScreenContext) => ReactNode
}

export interface ScreenRegistry {
  register(screens: readonly ScreenDefinition[]): () => void
  list(): readonly ScreenDefinition[]
  subscribe(listener: () => void): () => void
}

export function createScreenRegistry(): ScreenRegistry {
  const registrations = new Map<symbol, readonly ScreenDefinition[]>()
  const listeners = new Set<() => void>()
  let snapshot: readonly ScreenDefinition[] = []

  function rebuild(): void {
    const byKey = new Map<string, ScreenDefinition>()
    for (const screens of registrations.values()) {
      for (const screen of screens) byKey.set(`${screen.area}/${screen.id}`, screen)
    }
    snapshot = [...byKey.values()]
    for (const listener of listeners) listener()
  }

  return {
    register(screens) {
      const token = Symbol('screen-registration')
      registrations.set(token, [...screens])
      rebuild()
      return () => {
        if (registrations.delete(token)) rebuild()
      }
    },
    list: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export function findScreen(
  screens: readonly ScreenDefinition[],
  area: AppArea,
  screenId: string,
): ScreenDefinition | undefined {
  return screens.find((screen) => screen.area === area && screen.id === screenId)
}

/**
 * Where a screen lives, as a sentence points at it: "Company → Business details".
 *
 * A screen outside the rail is placed by the rail entry it opens from — the invoice editor
 * lives at "Sales → Sales invoices". Null for a screen the rail cannot place, which a caller
 * should say some other way rather than invent a path for.
 */
export function describeLocation(
  screens: readonly ScreenDefinition[],
  area: AppArea,
  screenId: string,
): string | null {
  const screen = findScreen(screens, area, screenId)
  const placed =
    screen?.nav !== undefined
      ? screen
      : screen?.navParent === undefined
        ? undefined
        : findScreen(screens, area, screen.navParent)
  if (placed?.nav === undefined) return null
  return `${navGroupLabel(placed.nav.group)} → ${placed.nav.label}`
}

/** A screen that appears in the rail, with its nav metadata proven present. */
export type NavigableScreen = ScreenDefinition & { nav: ScreenNav }

export interface NavSection {
  id: NavGroupId
  label: string
  screens: readonly NavigableScreen[]
}

/** The sections and their rails, grouped and ordered. Groups with no screens are dropped. */
export function navSections(
  screens: readonly ScreenDefinition[],
  area: AppArea,
): readonly NavSection[] {
  const navigable = screens.filter(
    (screen): screen is NavigableScreen => screen.area === area && screen.nav !== undefined,
  )

  return NAV_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    screens: navigable
      .filter((screen) => screen.nav.group === group.id)
      .sort((a, b) => a.nav.order - b.nav.order || a.nav.label.localeCompare(b.nav.label)),
  })).filter((section) => section.screens.length > 0)
}

/**
 * Validates a value discovered by module scan before it is trusted as a screen.
 * A screen module that exports the wrong shape should be reported, not rendered.
 */
export function isScreenDefinition(value: unknown): value is ScreenDefinition {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ScreenDefinition>
  if (typeof candidate.id !== 'string' || candidate.id === '') return false
  if (typeof candidate.title !== 'string') return false
  if (candidate.area !== 'welcome' && candidate.area !== 'workspace') return false
  if (typeof candidate.render !== 'function') return false
  if (candidate.nav !== undefined) {
    const nav = candidate.nav as Partial<ScreenNav>
    if (typeof nav.label !== 'string') return false
    if (typeof nav.icon !== 'string') return false
    if (typeof nav.order !== 'number') return false
    if (!NAV_GROUPS.some((group) => group.id === nav.group)) return false
  }
  if (candidate.navParent !== undefined) {
    if (typeof candidate.navParent !== 'string' || candidate.navParent === '') return false
  }
  return true
}

/* ---- The application's registry ------------------------------------------ */

/*
 * The singleton lives HERE, in a leaf module, rather than beside `registerScreens`'s
 * documentation in store/screens.ts. That placement is load-bearing.
 *
 * store/screens.ts discovers screens with `import.meta.glob({ eager: true })`, which
 * Vite compiles into ordinary static imports — and static imports are hoisted above
 * the module body. Every screen module therefore runs, and calls `registerScreens`,
 * before any `let` or `const` in store/screens.ts has initialised. A singleton
 * declared there sits in its temporal dead zone at exactly the moment the first
 * screen registers, and the app dies with "Cannot access 'registry' before
 * initialization" and a blank window.
 *
 * This module imports only types, so a screen module importing `registerScreens`
 * from here forces it to be fully evaluated first. That is an ESM guarantee rather
 * than an ordering we hope holds.
 */

let instance: ScreenRegistry | null = null

/** The application's screen registry. Created on first use. */
export function screenRegistry(): ScreenRegistry {
  instance ??= createScreenRegistry()
  return instance
}

/**
 * Register screens for the life of the module. Call at module scope.
 *
 * Import it from here, not from store/screens.ts — see the note above.
 */
export function registerScreens(screens: readonly ScreenDefinition[]): () => void {
  return screenRegistry().register(screens)
}
