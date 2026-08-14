/*
 * The frame every screen sits in.
 *
 * Two layouts, chosen by the area of the current route and nothing else:
 *
 *   welcome    no company is open. Title bar and a centred canvas. No sidebar,
 *              because there is nothing to navigate between until a company is
 *              unlocked, and offering one would be a lie about what is reachable.
 *   workspace  a company is open. Title bar, sidebar, content.
 *
 * The shell also owns the commands that belong to the frame itself. Business
 * commands are contributed by the screens that own them — nothing in this file
 * should ever grow a case for an invoice.
 */

import { useCallback, useMemo, useState } from 'react'
import type { JSX } from 'react'
import {
  NARROW_VIEWPORT_QUERY,
  resolveSidebarCollapsed,
  SIDEBAR_STORAGE_KEY,
  parseSidebarPreference,
  toggledSidebarPreference,
  type SidebarPreference,
} from '../../lib/layout'
import { useMediaQuery } from '../../lib/hooks'
import { makeRoute } from '../../lib/routing'
import { navSections } from '../../lib/screens'
import { browserStore, readPreference, writePreference } from '../../lib/storage'
import type { Command } from '../../lib/command-registry'
import { useCommands, useRegisterCommands } from '../../store/commands'
import { useCompany } from '../../store/company'
import { useNavigation } from '../../store/navigation'
import { useScreens } from '../../store/screens'
import { useTheme } from '../../store/theme'
import { useToasts } from '../../store/toasts'
import { CommandPalette } from '../command-palette/CommandPalette'
import { ToastViewport } from '../toast/ToastViewport'
import { ScreenHost } from './ScreenHost'
import { Sidebar } from './Sidebar'
import { TitleBar } from './TitleBar'

export function AppShell(): JSX.Element {
  const { route } = useNavigation()

  return (
    <div className="app" data-area={route.area}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <TitleBar />
      {route.area === 'workspace' ? <Workspace /> : <Welcome />}
      <ShellCommands />
      <CommandPalette />
      <ToastViewport />
    </div>
  )
}

function Workspace(): JSX.Element {
  const [preference, setPreferenceState] = useState<SidebarPreference>(() =>
    parseSidebarPreference(readPreference(browserStore(), SIDEBAR_STORAGE_KEY)),
  )
  const isNarrow = useMediaQuery(NARROW_VIEWPORT_QUERY)
  const isCollapsed = resolveSidebarCollapsed(preference, isNarrow)

  const toggle = useCallback(() => {
    setPreferenceState((current) => {
      const next = toggledSidebarPreference(current, isNarrow)
      writePreference(browserStore(), SIDEBAR_STORAGE_KEY, next)
      return next
    })
  }, [isNarrow])

  return (
    <div className="app__body">
      <Sidebar isCollapsed={isCollapsed} onToggleCollapsed={toggle} />
      <main className="app__main" id="main" tabIndex={-1}>
        <ScreenHost />
      </main>
      <SidebarCommand onToggle={toggle} isCollapsed={isCollapsed} />
    </div>
  )
}

function Welcome(): JSX.Element {
  return (
    <div className="app__body app__body--welcome">
      <main className="app__canvas" id="main" tabIndex={-1}>
        <ScreenHost />
      </main>
    </div>
  )
}

/** Registered only while the workspace exists, so it cannot fire from the picker. */
function SidebarCommand({
  onToggle,
  isCollapsed,
}: {
  onToggle: () => void
  isCollapsed: boolean
}): JSX.Element {
  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: 'view.toggle-sidebar',
          title: isCollapsed ? 'Expand the sidebar' : 'Collapse the sidebar',
          section: 'View',
          keywords: ['nav', 'navigation', 'panel'],
          shortcut: { key: 'b', ctrlOrCmd: true },
          run: onToggle,
        },
      ],
      [onToggle, isCollapsed],
    ),
  )
  return <></>
}

/**
 * The frame's own commands.
 *
 * Including a "Go to …" for every navigable screen, built from the registry — so
 * a screen becomes keyboard-reachable the moment it declares nav metadata, with
 * no entry to add here.
 */
function ShellCommands(): JSX.Element {
  const { setPaletteOpen } = useCommands()
  const { preference, setPreference } = useTheme()
  const { company, close } = useCompany()
  const { route, navigate, back, canGoBack } = useNavigation()
  const { show } = useToasts()
  const screens = useScreens()

  const commands = useMemo<Command[]>(() => {
    const navigation: Command[] = navSections(screens, route.area).flatMap((section) =>
      section.screens.map((screen) => ({
        id: `go.${screen.area}.${screen.id}`,
        title: `Go to ${screen.nav?.label ?? screen.title}`,
        section: 'Go to',
        keywords: [section.label, screen.title],
        run: () => navigate(makeRoute(screen.area, screen.id)),
      })),
    )

    const appearance: Command[] = (['system', 'light', 'dark'] as const).map((option) => ({
      id: `view.theme.${option}`,
      title: option === 'system' ? 'Appearance: match system' : `Appearance: ${option}`,
      section: 'View',
      keywords: ['theme', 'dark mode', 'light mode', 'contrast'],
      ...(option === preference ? { hint: 'Current' } : {}),
      run: () => setPreference(option),
    }))

    const frame: Command[] = [
      {
        id: 'palette.open',
        title: 'Show all commands',
        section: 'General',
        keywords: ['palette', 'search', 'help'],
        shortcut: { key: 'k', ctrlOrCmd: true },
        run: () => setPaletteOpen(true),
      },
      {
        id: 'nav.back',
        title: 'Go back',
        section: 'General',
        shortcut: { key: '[', ctrlOrCmd: true },
        isDisabled: !canGoBack,
        run: back,
      },
    ]

    const companyCommands: Command[] = company
      ? [
          {
            id: 'company.close',
            title: 'Close this company',
            section: 'Company',
            keywords: ['lock', 'switch', 'sign out'],
            hint: company.displayName,
            run: () => {
              void close().then((result) => {
                if (!result.ok) {
                  show({
                    tone: 'danger',
                    title: 'Closing the company reported a problem',
                    body: result.error.message,
                  })
                }
              })
            },
          },
        ]
      : []

    return [...frame, ...navigation, ...appearance, ...companyCommands]
  }, [
    screens,
    route.area,
    navigate,
    preference,
    setPreference,
    setPaletteOpen,
    canGoBack,
    back,
    company,
    close,
    show,
  ])

  useRegisterCommands(commands)
  return <></>
}
