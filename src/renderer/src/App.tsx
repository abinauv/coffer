/*
 * Application root — the composition point, and nothing more.
 *
 * The provider order is not arbitrary:
 *
 *   Platform    everything below wants to know the OS and the window chrome.
 *   Theme       independent, but must be above anything that reads it.
 *   Density     the same, and for the same reason.
 *   Toasts      above the rest so any provider below can report a failure.
 *   Company     the fact the shell's structure is derived from.
 *   Regime      the open company's rules. Under Company because it needs to know
 *               which one, and above the shell because a screen that draws money
 *               may not render before the rules that say how it is written.
 *   Navigation  derives its area from Company, so it sits under it.
 *   Commands    contributed by everything, consumed by the palette.
 *   Backup      the open company's one backup flow, shared by the rail, the Overview
 *               and the palette. Under Commands because it registers one.
 *
 * No business logic lives here, and no screen is named here. Screens register
 * themselves — see store/screens.ts.
 */

import type { JSX } from 'react'
import { AppShell } from './components/shell/AppShell'
import { BackupProvider } from './store/backup'
import { CommandProvider } from './store/commands'
import { CompanyProvider } from './store/company'
import { DensityProvider } from './store/density'
import { NavigationProvider } from './store/navigation'
import { OpenCompanyRegime } from './store/regime'
import { PlatformProvider } from './store/platform'
import { ThemeProvider } from './store/theme'
import { ToastProvider } from './store/toasts'

export function App(): JSX.Element {
  return (
    <PlatformProvider>
      <ThemeProvider>
        <DensityProvider>
          <ToastProvider>
            <CompanyProvider>
              <OpenCompanyRegime>
                <NavigationProvider>
                  <CommandProvider>
                    <BackupProvider>
                      <AppShell />
                    </BackupProvider>
                  </CommandProvider>
                </NavigationProvider>
              </OpenCompanyRegime>
            </CompanyProvider>
          </ToastProvider>
        </DensityProvider>
      </ThemeProvider>
    </PlatformProvider>
  )
}
