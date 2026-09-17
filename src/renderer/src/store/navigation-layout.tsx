/*
 * Navigation layout state.
 *
 * The decisions are in lib/layout.ts; this is the wiring — read the stored preference, watch
 * the window's width, persist the choice. localStorage for the reason store/theme.tsx gives:
 * how the workspace is laid out is a property of this installation's interface, not of
 * anyone's books, and Settings can change it before any company is open.
 *
 * A CONTEXT OF ITS OWN, NOT A FIELD ON NAVIGATION. `store/navigation.tsx` is the history
 * stack and changes on every screen someone opens; this changes when somebody asks it to.
 * Sharing one context would re-render everything that reads the route whenever the rail
 * collapsed, and everything that reads the layout on every route.
 *
 * ONE PREFERENCE, THREE CONTROLS. Settings → Navigation, the rail's own collapse button and
 * Ctrl B all write the value this provider holds, so none of them can show a layout the
 * others do not.
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { useMediaQuery } from '../lib/hooks'
import {
  NARROW_VIEWPORT_QUERY,
  parseRailPreference,
  RAIL_STORAGE_KEY,
  railPreferenceFor,
  resolveNavigationLayout,
  toggledRailPreference,
  type NavigationLayout,
  type RailPreference,
} from '../lib/layout'
import { browserStore, readPreference, writePreference } from '../lib/storage'

interface NavigationLayoutContextValue {
  /** What is drawn now. */
  layout: NavigationLayout
  /** False until somebody has chosen, while the window's width decides. */
  isChosen: boolean
  setLayout: (layout: NavigationLayout) => void
  /** The rail's collapse button and Ctrl B: the other layout from the one on screen. */
  toggleRail: () => void
}

const NavigationLayoutContext = createContext<NavigationLayoutContextValue | null>(null)

export function NavigationLayoutProvider({ children }: { children: ReactNode }): JSX.Element {
  const [preference, setPreferenceState] = useState<RailPreference>(() =>
    parseRailPreference(readPreference(browserStore(), RAIL_STORAGE_KEY)),
  )
  const isNarrow = useMediaQuery(NARROW_VIEWPORT_QUERY)

  const store = useCallback((next: RailPreference) => {
    setPreferenceState(next)
    writePreference(browserStore(), RAIL_STORAGE_KEY, next)
  }, [])

  const setLayout = useCallback(
    (layout: NavigationLayout) => store(railPreferenceFor(layout)),
    [store],
  )

  const toggleRail = useCallback(
    () => store(toggledRailPreference(preference, isNarrow)),
    [store, preference, isNarrow],
  )

  const value = useMemo<NavigationLayoutContextValue>(
    () => ({
      layout: resolveNavigationLayout(preference, isNarrow),
      isChosen: preference !== 'auto',
      setLayout,
      toggleRail,
    }),
    [preference, isNarrow, setLayout, toggleRail],
  )

  return (
    <NavigationLayoutContext.Provider value={value}>{children}</NavigationLayoutContext.Provider>
  )
}

export function useNavigationLayout(): NavigationLayoutContextValue {
  const value = useContext(NavigationLayoutContext)
  if (!value) {
    throw new Error('useNavigationLayout must be used inside a NavigationLayoutProvider')
  }
  return value
}
