/*
 * Platform and window chrome.
 *
 * Answers two questions the shell needs before it can draw its first frame: which
 * OS this is (so shortcuts read ⌘K rather than Ctrl+K) and who is drawing the
 * window controls (so the title bar reserves the right space on the right side).
 *
 * Both start from a synchronous guess and are corrected from `system.getAppInfo()`
 * a moment later. A guess that is right in every real case beats a title bar that
 * lays itself out twice.
 */

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type { AppInfo, Platform } from '@shared/dto'
import { callApi } from '../lib/api'
import {
  detectPlatform,
  isFramelessViewport,
  resolveWindowChrome,
  type WindowChrome,
} from '../lib/platform'

interface PlatformContextValue {
  platform: Platform
  chrome: WindowChrome
  /** Null until `system.getAppInfo()` answers, or if it never does. */
  appInfo: AppInfo | null
}

const PlatformContext = createContext<PlatformContextValue | null>(null)

/** Chromium exposes the overlay only when main asked for `titleBarOverlay`. */
function hasControlsOverlay(): boolean {
  const overlay = (navigator as Navigator & { windowControlsOverlay?: { visible: boolean } })
    .windowControlsOverlay
  return overlay?.visible === true
}

function detectChrome(platform: Platform): WindowChrome {
  return resolveWindowChrome({
    platform,
    isFrameless: isFramelessViewport({
      outerHeight: window.outerHeight,
      innerHeight: window.innerHeight,
    }),
    hasControlsOverlay: hasControlsOverlay(),
  })
}

export function PlatformProvider({ children }: { children: ReactNode }): JSX.Element {
  const [platform, setPlatform] = useState<Platform>(() => detectPlatform(navigator.userAgent))
  const [chrome, setChrome] = useState<WindowChrome>(() => detectChrome(platform))
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    let isActive = true
    void callApi((api) => api.system.getAppInfo()).then((result) => {
      if (!isActive || !result.ok) return
      setAppInfo(result.data)
      setPlatform(result.data.platform)
      setChrome(detectChrome(result.data.platform))
    })
    return () => {
      isActive = false
    }
  }, [])

  /* An overlay can appear, disappear or change width — the user toggles full
   * screen, or Windows changes its control layout. Both are resize events. */
  useEffect(() => {
    function recheck(): void {
      setChrome(detectChrome(platform))
    }
    window.addEventListener('resize', recheck)
    const overlay = (
      navigator as Navigator & {
        windowControlsOverlay?: { addEventListener?: (type: string, fn: () => void) => void }
      }
    ).windowControlsOverlay
    overlay?.addEventListener?.('geometrychange', recheck)
    return () => window.removeEventListener('resize', recheck)
  }, [platform])

  /* The title bar's insets are chosen in CSS from this attribute, so the layout
   * is correct on the first paint rather than after a measure-and-adjust pass. */
  useEffect(() => {
    document.documentElement.dataset['windowChrome'] = chrome
  }, [chrome])

  const value = useMemo<PlatformContextValue>(
    () => ({ platform, chrome, appInfo }),
    [platform, chrome, appInfo],
  )

  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>
}

function usePlatformContext(): PlatformContextValue {
  const value = useContext(PlatformContext)
  if (!value) throw new Error('usePlatform must be used inside a PlatformProvider')
  return value
}

export function usePlatform(): Platform {
  return usePlatformContext().platform
}

export function useWindowChrome(): WindowChrome {
  return usePlatformContext().chrome
}

export function useAppInfo(): AppInfo | null {
  return usePlatformContext().appInfo
}
