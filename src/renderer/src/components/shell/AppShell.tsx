/*
 * The frame every screen sits in.
 *
 * Two layouts, chosen by the area of the current route and nothing else:
 *
 *   welcome    no company is open. Title bar and a centred canvas. No navigation,
 *              because there is nothing to navigate between until a company is
 *              unlocked, and offering any would be a lie about what is reachable.
 *   workspace  a company is open. Title bar, section bar, rail, content, status bar.
 *
 * The shell also owns the commands that belong to the frame itself. Business
 * commands are contributed by the screens that own them — nothing in this file
 * should ever grow a case for an invoice.
 */

import { useCallback, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { DENSITY_LABELS, DENSITY_PREFERENCES } from '../../lib/density'
import {
  NARROW_VIEWPORT_QUERY,
  parseRailPreference,
  RAIL_STORAGE_KEY,
  resolveRailCollapsed,
  toggledRailPreference,
  type RailPreference,
} from '../../lib/layout'
import { useMediaQuery } from '../../lib/hooks'
import { makeRoute } from '../../lib/routing'
import { navSections } from '../../lib/screens'
import { browserStore, readPreference, writePreference } from '../../lib/storage'
import type { Command } from '../../lib/command-registry'
import { useCommands, useRegisterCommands } from '../../store/commands'
import { useCompany } from '../../store/company'
import { useDensity } from '../../store/density'
import { useNavigation } from '../../store/navigation'
import { useScreens } from '../../store/screens'
import { useTheme } from '../../store/theme'
import { useToasts } from '../../store/toasts'
import { CommandPalette } from '../command-palette/CommandPalette'
import { ToastViewport } from '../toast/ToastViewport'
import { ContextRail } from './ContextRail'
import { ScreenHost } from './ScreenHost'
import { SectionBar } from './SectionBar'
import { StatusBar } from './StatusBar'
import { TitleBar } from './TitleBar'
import { useSectionNavigation } from './useSectionNavigation'

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
  const [preference, setPreferenceState] = useState<RailPreference>(() =>
    parseRailPreference(readPreference(browserStore(), RAIL_STORAGE_KEY)),
  )
  const isNarrow = useMediaQuery(NARROW_VIEWPORT_QUERY)
  const isCollapsed = resolveRailCollapsed(preference, isNarrow)
  const sections = useSectionNavigation()

  const toggle = useCallback(() => {
    setPreferenceState((current) => {
      const next = toggledRailPreference(current, isNarrow)
      writePreference(browserStore(), RAIL_STORAGE_KEY, next)
      return next
    })
  }, [isNarrow])

  return (
    <div className="app__body app__body--workspace">
      <SectionBar
        sections={sections.sections}
        currentId={sections.current?.id ?? null}
        onSelect={sections.select}
      />
      <ContextRail
        section={sections.current}
        marked={sections.marked}
        isCollapsed={isCollapsed}
        onToggleCollapsed={toggle}
      />
      <main className="app__main" id="main" tabIndex={-1}>
        <ScreenHost />
      </main>
      <StatusBar />
      <WorkspaceCommands onToggleRail={toggle} isCollapsed={isCollapsed} onStep={sections.step} />
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

/** Registered only while the workspace exists, so none of them can fire from the picker. */
function WorkspaceCommands({
  onToggleRail,
  isCollapsed,
  onStep,
}: {
  onToggleRail: () => void
  isCollapsed: boolean
  onStep: (by: 1 | -1) => void
}): JSX.Element {
  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: 'view.toggle-rail',
          title: isCollapsed ? 'Expand the rail' : 'Collapse the rail to icons',
          section: 'View',
          keywords: ['nav', 'navigation', 'panel', 'sidebar', 'icons'],
          shortcut: { key: 'b', ctrlOrCmd: true },
          run: onToggleRail,
        },
        /* Ctrl ] and Ctrl [ from the design system's Modern key map. Ctrl [ was Back, which
         * moved to Alt ←, the key every browser and file manager already uses for it. */
        {
          id: 'nav.section.next',
          title: 'Go to the next section',
          section: 'Go to',
          keywords: ['section', 'tab', 'right'],
          shortcut: { key: ']', ctrlOrCmd: true },
          run: () => onStep(1),
        },
        {
          id: 'nav.section.previous',
          title: 'Go to the previous section',
          section: 'Go to',
          keywords: ['section', 'tab', 'left'],
          shortcut: { key: '[', ctrlOrCmd: true },
          run: () => onStep(-1),
        },
      ],
      [onToggleRail, isCollapsed, onStep],
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
  const density = useDensity()
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

    /* Until Settings exists (design plan, Phase 8), the palette is where density is chosen.
     * One command per preference rather than a toggle, so the palette says which is on. */
    const densities: Command[] = DENSITY_PREFERENCES.map((option) => ({
      id: `view.density.${option}`,
      title: `Density: ${DENSITY_LABELS[option].toLowerCase()}`,
      section: 'View',
      keywords: ['density', 'compact', 'comfortable', 'rows', 'spacing'],
      ...(option === density.preference ? { hint: 'Current' } : {}),
      run: () => density.setPreference(option),
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
        shortcut: { key: 'ArrowLeft', alt: true },
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

    return [...frame, ...navigation, ...appearance, ...densities, ...companyCommands]
  }, [
    screens,
    route.area,
    navigate,
    preference,
    setPreference,
    density,
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
