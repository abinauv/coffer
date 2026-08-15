/*
 * Screen registration — the seam Batch 0.3 and every phase after it plug into.
 *
 * HOW TO ADD A SCREEN. Create a module under `src/renderer/src/screens/` that
 * calls `registerScreens` at module scope:
 *
 *   registerScreens([
 *     {
 *       id: 'companies',
 *       title: 'Your companies',
 *       area: 'welcome',
 *       render: () => <CompanyPicker />,
 *     },
 *   ])
 *
 * That is all. No import to add, no switch statement to extend, no file in this
 * folder to edit — the provider below imports everything under `screens/` for its
 * side effects, so a new folder is discovered by existing. The sidebar builds
 * itself from the optional `nav` field and the palette gets a "Go to" command for
 * every navigable screen.
 *
 * A module may also export a `screen` or `screens` binding instead of calling
 * `registerScreens`; both are picked up. Anything exported under those names that
 * is not a valid screen is reported rather than rendered, because the alternative
 * is a blank pane and no explanation.
 */

import { useEffect, useSyncExternalStore } from 'react'
import {
  isScreenDefinition,
  registerScreens,
  screenRegistry,
  type ScreenDefinition,
} from '../lib/screens'

/* Re-exported so the documented import path keeps working. The definition lives in
 * lib/screens.ts because the glob below hoists above this module's body — see the
 * note there. */
export { registerScreens }

/**
 * Loads every module under `screens/` so its registration runs.
 *
 * `eager` because a desktop app bundles everything anyway and a lazily-loaded
 * screen would not be in the registry when the sidebar first asks for it.
 */
function discoverScreens(): void {
  const modules = import.meta.glob<Record<string, unknown>>(
    [
      '../screens/**/*.ts',
      '../screens/**/*.tsx',
      '!../screens/**/*.test.ts',
      '!../screens/**/*.test.tsx',
    ],
    { eager: true },
  )

  const found: ScreenDefinition[] = []
  const rejected: string[] = []

  for (const [path, module] of Object.entries(modules)) {
    for (const key of ['screen', 'screens', 'default']) {
      const exported = module[key]
      if (exported === undefined) continue
      const candidates = Array.isArray(exported) ? exported : [exported]
      for (const candidate of candidates) {
        if (isScreenDefinition(candidate)) found.push(candidate)
        else if (key !== 'default') rejected.push(`${path} → ${key}`)
      }
    }
  }

  if (found.length > 0) screenRegistry().register(found)
  if (rejected.length > 0) {
    console.warn(
      `Coffer: ignoring ${rejected.length} export(s) that do not describe a screen:\n  ` +
        rejected.join('\n  '),
    )
  }
}

discoverScreens()

export function useScreens(): readonly ScreenDefinition[] {
  const store = screenRegistry()
  return useSyncExternalStore(store.subscribe, store.list, store.list)
}

/**
 * Registers screens for as long as the caller is mounted. The module-scope
 * `registerScreens` is the normal path; this exists for a screen whose definition
 * depends on something only known at runtime.
 */
export function useRegisterScreens(screens: readonly ScreenDefinition[]): void {
  useEffect(() => screenRegistry().register(screens), [screens])
}
