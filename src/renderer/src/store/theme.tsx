/*
 * Theme state.
 *
 * All the decisions live in lib/theme.ts and are unit tested there. This file is
 * the wiring: read the stored preference, listen to the OS, write the attribute,
 * persist the choice.
 *
 * Persistence is localStorage rather than IPC because a theme is a property of
 * this installation's interface, not of anyone's books — it must survive with no
 * company open and no database unlocked, which is exactly when the picker needs it.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { useMediaQuery } from '../lib/hooks'
import { browserStore, readPreference, writePreference } from '../lib/storage'
import {
  applyThemePreference,
  nextThemePreference,
  parseThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from '../lib/theme'

const DARK_QUERY = '(prefers-color-scheme: dark)'

interface ThemeContextValue {
  /** What the user asked for. */
  preference: ThemePreference
  /** What that resolves to right now. */
  theme: ResolvedTheme
  setPreference: (preference: ThemePreference) => void
  cyclePreference: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

/**
 * Applies the stored preference before React renders.
 *
 * The CSP forbids the inline script that normally does this in a web app, so the
 * attribute is written from the module entry point instead — still before first
 * paint, which is all that matters. Without it, a user on explicit dark sees one
 * frame of light paper at every launch.
 */
export function applyStoredTheme(): ThemePreference {
  const preference = parseThemePreference(readPreference(browserStore(), THEME_STORAGE_KEY))
  if (typeof document !== 'undefined') {
    applyThemePreference(document.documentElement, preference)
  }
  return preference
}

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    parseThemePreference(readPreference(browserStore(), THEME_STORAGE_KEY)),
  )
  const systemPrefersDark = useMediaQuery(DARK_QUERY)

  useEffect(() => {
    applyThemePreference(document.documentElement, preference)
  }, [preference])

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
    writePreference(browserStore(), THEME_STORAGE_KEY, next)
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      theme: resolveTheme(preference, systemPrefersDark),
      setPreference,
      cyclePreference: () => setPreference(nextThemePreference(preference)),
    }),
    [preference, systemPrefersDark, setPreference],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside a ThemeProvider')
  return value
}
