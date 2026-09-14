/*
 * The renderer's state, in one import.
 *
 * Small contexts rather than one store: theme, density, toasts, commands, the open
 * company and where the user is. They are separate because they change at wildly
 * different rates — a toast timer must not re-render the sidebar — and because
 * each one is small enough to hold in your head.
 *
 * No state library. React's own context and hooks carry this much comfortably,
 * and every rule any of them encodes lives as a pure function in `lib/` with its
 * own tests. If a screen later needs cached server state, that is a fetching
 * concern, not a reason to reach for a store.
 */

export { ThemeProvider, useTheme, applyStoredTheme } from './theme'
export { DensityProvider, useDensity, applyStoredDensity } from './density'
export { ToastProvider, useToasts } from './toasts'
export { CommandProvider, useCommands, useRegisterCommands } from './commands'
export { CompanyProvider, useCompany } from './company'
export { BackupProvider, useBackup } from './backup'
export { NavigationProvider, useNavigation } from './navigation'
export { PlatformProvider, usePlatform, useWindowChrome, useAppInfo } from './platform'
export { registerScreens, useScreens, useRegisterScreens } from './screens'
