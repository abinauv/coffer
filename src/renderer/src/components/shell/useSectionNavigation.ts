/*
 * The section bar's and the rail's shared state: which section is showing, which rail
 * entry is marked, and where choosing a section goes.
 *
 * ONE CALL, IN THE WORKSPACE, AND BOTH HALVES READ ITS ANSWER. The section bar and the rail
 * could each derive this from the route, but "the section you came from" is memory, and
 * two memories are two answers the moment the route stops naming a section. The rules are
 * pure functions in lib/sections.ts; this is only the memory and the wiring.
 */

import { useCallback, useMemo, useState } from 'react'
import { makeRoute } from '../../lib/routing'
import { navSections, type NavGroupId, type NavSection } from '../../lib/screens'
import { adjacentSection, landingScreen, railScreenFor, resolveSection } from '../../lib/sections'
import { useNavigation } from '../../store/navigation'
import { useScreens } from '../../store/screens'

export interface MarkedRailEntry {
  id: string
  /** True when it is the screen on show; false when it is the register an editor came from. */
  isOpen: boolean
}

export interface SectionNavigation {
  sections: readonly NavSection[]
  current: NavSection | null
  marked: MarkedRailEntry | null
  select: (sectionId: NavGroupId) => void
  step: (by: 1 | -1) => void
}

type Remembered = Readonly<Partial<Record<NavGroupId, string>>>

export function useSectionNavigation(): SectionNavigation {
  const screens = useScreens()
  const { route, navigate } = useNavigation()

  const sections = useMemo(() => navSections(screens, 'workspace'), [screens])
  const railScreen = useMemo(() => railScreenFor(screens, route), [screens, route])

  const [lastShown, setLastShown] = useState<NavGroupId | null>(railScreen?.nav.group ?? null)
  const [remembered, setRemembered] = useState<Remembered>({})

  /*
   * REMEMBERED DURING RENDER, NOT IN AN EFFECT. An effect would draw one frame with the old
   * section before correcting itself. Setting state while rendering, guarded so it settles
   * on the second pass, is React's documented way to keep state in step with a changed
   * input.
   */
  if (railScreen !== null) {
    const group = railScreen.nav.group
    if (lastShown !== group) setLastShown(group)
    if (remembered[group] !== railScreen.id) {
      setRemembered({ ...remembered, [group]: railScreen.id })
    }
  }

  const current = resolveSection(sections, railScreen?.nav.group ?? null, lastShown)

  const select = useCallback(
    (sectionId: NavGroupId) => {
      const section = sections.find((candidate) => candidate.id === sectionId)
      if (section === undefined) return
      setLastShown(section.id)
      const target = landingScreen(section, remembered[section.id])
      if (target !== undefined) navigate(makeRoute('workspace', target.id))
    },
    [sections, remembered, navigate],
  )

  const step = useCallback(
    (by: 1 | -1) => {
      const next = adjacentSection(sections, current?.id ?? null, by)
      if (next !== null) select(next.id)
    },
    [sections, current, select],
  )

  const marked =
    railScreen === null ? null : { id: railScreen.id, isOpen: railScreen.id === route.screenId }

  return { sections, current, marked, select, step }
}
