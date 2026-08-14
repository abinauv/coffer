/*
 * Navigation state.
 *
 * A history stack of routes, reconciled against whether a company is open. The
 * rules are in lib/routing.ts and tested there; this is the wiring, plus the one
 * effect that makes the area a consequence of the company rather than something a
 * screen can navigate itself into.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import {
  canGoBack,
  currentRoute,
  goBack,
  homeRoute,
  navigate as navigateHistory,
  routeForCompany,
  type NavigationMode,
  type Route,
} from '../lib/routing'
import { useCompany } from './company'

interface NavigationContextValue {
  route: Route
  history: readonly Route[]
  canGoBack: boolean
  navigate: (to: Route, mode?: NavigationMode) => void
  back: () => void
  /** Returns to the current area's landing screen. */
  home: () => void
}

const NavigationContext = createContext<NavigationContextValue | null>(null)

export function NavigationProvider({ children }: { children: ReactNode }): JSX.Element {
  const { isOpen } = useCompany()
  const [history, setHistory] = useState<readonly Route[]>(() => [
    homeRoute(isOpen ? 'workspace' : 'welcome'),
  ])

  /* Opening or closing a company changes which area exists, so the stack is
   * rebuilt rather than pushed onto — see routeForCompany for why Back must not
   * be able to reach a screen belonging to books that are no longer unlocked. */
  useEffect(() => {
    setHistory((current) => routeForCompany(current, isOpen))
  }, [isOpen])

  const navigate = useCallback((to: Route, mode: NavigationMode = 'push') => {
    setHistory((current) => navigateHistory(current, to, mode))
  }, [])

  const back = useCallback(() => setHistory((current) => goBack(current)), [])

  const route = currentRoute(history)

  const home = useCallback(() => {
    setHistory((current) => [homeRoute(currentRoute(current).area)])
  }, [])

  const value = useMemo<NavigationContextValue>(
    () => ({ route, history, canGoBack: canGoBack(history), navigate, back, home }),
    [route, history, navigate, back, home],
  )

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>
}

export function useNavigation(): NavigationContextValue {
  const value = useContext(NavigationContext)
  if (!value) throw new Error('useNavigation must be used inside a NavigationProvider')
  return value
}
