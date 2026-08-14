/*
 * The screen registry — the seam this shell exists to provide.
 *
 * A screen is a value: an id, the area it belongs to, optional navigation
 * metadata, and a render function. Adding one to the product is one call to
 * `registerScreens` from a module under `src/renderer/src/screens/`, and nothing
 * in the shell changes. The sidebar builds itself from `nav`, the router resolves
 * `screenId` against `id`, and the command palette gets a "Go to …" command for
 * every navigable screen for free.
 *
 * Modules under `screens/` are imported for their side effects by the provider in
 * store/screens.tsx, so a new screen folder needs no wiring at all.
 */

import type { ReactNode } from 'react'
import type { IconName } from './icons'
import type { AppArea, Route } from './routing'

/** Sidebar sections, in the order they appear. A screen names one. */
export const NAV_GROUPS = [
  { id: 'work', label: 'Work' },
  { id: 'sales', label: 'Sales' },
  { id: 'purchases', label: 'Purchases' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'reports', label: 'Reports' },
  { id: 'company', label: 'Company' },
] as const

export type NavGroupId = (typeof NAV_GROUPS)[number]['id']

export interface ScreenNav {
  /** Sidebar label. Usually shorter than the screen title. */
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
  /** Present when the screen should appear in the sidebar. */
  nav?: ScreenNav
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

/** A screen that appears in the sidebar, with its nav metadata proven present. */
export type NavigableScreen = ScreenDefinition & { nav: ScreenNav }

export interface NavSection {
  id: NavGroupId
  label: string
  screens: readonly NavigableScreen[]
}

/** The sidebar, grouped and ordered. Groups with no screens are dropped. */
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
  return true
}
