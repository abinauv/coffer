/*
 * Small hooks the shell needs and React does not ship.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { keepInView } from './focus-in-view'

/**
 * Subscribes to a CSS media query.
 *
 * `useSyncExternalStore` rather than state-plus-effect so the first render already
 * has the right answer — a layout that flashes wide and then collapses is worse
 * than one that was never wrong.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof globalThis.matchMedia !== 'function') return () => {}
      const list = globalThis.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )

  const getSnapshot = useCallback(() => {
    if (typeof globalThis.matchMedia !== 'function') return false
    return globalThis.matchMedia(query).matches
  }, [query])

  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

/**
 * A callback that stays current without re-subscribing whatever holds it.
 * Lets a long-lived listener call the latest closure without churning effects.
 */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  })
  return ref
}

/**
 * Keeps the control the keyboard moves to inside the box that holds it.
 *
 * One listener for the whole app, because the rule is the app's and not any one screen's:
 * a browser scrolls a focused element into view only when NONE of it is showing, so a
 * control at the edge of a table that scrolls sideways keeps its focus ring under the
 * window edge (B38). See lib/focus-in-view.ts.
 */
export function useKeepFocusInView(): void {
  useEffect(() => {
    const onFocus = (event: FocusEvent): void => {
      const target = event.target
      if (target instanceof Element) keepInView(target)
    }
    document.addEventListener('focusin', onFocus)
    return () => document.removeEventListener('focusin', onFocus)
  }, [])
}
