/*
 * Density state.
 *
 * The decisions are in lib/density.ts; this is the wiring — read the stored preference,
 * write the attribute, persist the choice. localStorage for the reason store/theme.tsx
 * gives: density is a property of this installation's interface, not of anyone's books,
 * and it has to hold before any company is open.
 *
 * Settings will own the control (design plan, Phase 8). Until then the command palette
 * does, through the commands the shell registers.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import {
  applyDensityPreference,
  DENSITY_STORAGE_KEY,
  parseDensityPreference,
  type DensityPreference,
} from '../lib/density'
import { browserStore, readPreference, writePreference } from '../lib/storage'

interface DensityContextValue {
  preference: DensityPreference
  setPreference: (preference: DensityPreference) => void
}

const DensityContext = createContext<DensityContextValue | null>(null)

/**
 * Applies the stored preference before React renders, for the same reason as the theme:
 * a compact user should not see one comfortable frame at every launch.
 */
export function applyStoredDensity(): DensityPreference {
  const preference = parseDensityPreference(readPreference(browserStore(), DENSITY_STORAGE_KEY))
  if (typeof document !== 'undefined') {
    applyDensityPreference(document.documentElement, preference)
  }
  return preference
}

export function DensityProvider({ children }: { children: ReactNode }): JSX.Element {
  const [preference, setPreferenceState] = useState<DensityPreference>(() =>
    parseDensityPreference(readPreference(browserStore(), DENSITY_STORAGE_KEY)),
  )

  useEffect(() => {
    applyDensityPreference(document.documentElement, preference)
  }, [preference])

  const setPreference = useCallback((next: DensityPreference) => {
    setPreferenceState(next)
    writePreference(browserStore(), DENSITY_STORAGE_KEY, next)
  }, [])

  const value = useMemo<DensityContextValue>(
    () => ({ preference, setPreference }),
    [preference, setPreference],
  )

  return <DensityContext.Provider value={value}>{children}</DensityContext.Provider>
}

export function useDensity(): DensityContextValue {
  const value = useContext(DensityContext)
  if (!value) throw new Error('useDensity must be used inside a DensityProvider')
  return value
}
