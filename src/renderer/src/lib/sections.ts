/*
 * Where you are, in sections: the rules the section bar and the rail share.
 *
 * The workspace answers "where am I" on two axes. The section bar says which part of the
 * business, the rail says which screen inside it. Both are derived from the route and the
 * screen registry here, as pure functions, so the two can never disagree about it and a
 * test can pin every case without drawing either.
 *
 * THREE KINDS OF SCREEN, AND EACH HAS AN ANSWER.
 *
 *   in the rail        it declares `nav`, and it is its own rail entry.
 *   opened from one    an editor declares `navParent`. The rail marks its register, and
 *                      the section bar that register's section.
 *   belongs to none    the list of every party. There is no honest entry to mark, so
 *                      nothing is marked, and the section you came from stays on screen
 *                      rather than the rail jumping somewhere unrelated.
 */

import type { Route } from './routing'
import {
  findScreen,
  type NavGroupId,
  type NavigableScreen,
  type NavSection,
  type ScreenDefinition,
} from './screens'

/** The rail entry a route belongs to: its own screen, or the one it was opened from. */
export function railScreenFor(
  screens: readonly ScreenDefinition[],
  route: Route,
): NavigableScreen | null {
  const current = findScreen(screens, route.area, route.screenId)
  if (current === undefined) return null
  if (current.nav !== undefined) return { ...current, nav: current.nav }
  if (current.navParent === undefined) return null

  const parent = findScreen(screens, route.area, current.navParent)
  /* A parent that is itself not in the rail would mark nothing visible, which is the same
   * as marking nothing. The reachability test keeps every declared parent navigable. */
  return parent?.nav !== undefined ? { ...parent, nav: parent.nav } : null
}

/**
 * The section to show.
 *
 * The route's own when it has one. Otherwise the one shown last, so opening the list of
 * every party from the palette leaves the rail where it was. Otherwise the first, which is
 * only the case before anything has been shown at all.
 */
export function resolveSection(
  sections: readonly NavSection[],
  routeSection: NavGroupId | null,
  lastShown: NavGroupId | null,
): NavSection | null {
  return (
    sections.find((section) => section.id === routeSection) ??
    sections.find((section) => section.id === lastShown) ??
    sections[0] ??
    null
  )
}

/**
 * The section `step` away from `currentId`, wrapping at both ends.
 *
 * Wrapping, because Ctrl ] from Company going nowhere reads as a broken key, and six
 * sections are few enough that going round is never a long way. A current section that is
 * not in the list (it has no screens registered) starts from the first.
 */
export function adjacentSection(
  sections: readonly NavSection[],
  currentId: NavGroupId | null,
  step: 1 | -1,
): NavSection | null {
  if (sections.length === 0) return null
  const index = sections.findIndex((section) => section.id === currentId)
  if (index === -1) return sections[0] ?? null
  return sections[(index + step + sections.length) % sections.length] ?? null
}

/**
 * Where choosing a section lands.
 *
 * The screen you last had open in it, so going to Reports and back to Sales returns you to
 * the register you left rather than to the top of the rail. The first screen when there is
 * none, or when the one remembered is no longer in the rail.
 */
export function landingScreen(
  section: NavSection,
  rememberedId: string | undefined,
): NavigableScreen | undefined {
  return section.screens.find((screen) => screen.id === rememberedId) ?? section.screens[0]
}
