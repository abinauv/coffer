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

import { useMemo } from 'react'
import type { JSX } from 'react'
import { DENSITY_LABELS, DENSITY_PREFERENCES } from '../../lib/density'
import { makeRoute, SETTINGS_SCREEN_ID, type Route } from '../../lib/routing'
import { describeLocation, navSections } from '../../lib/screens'
import type { Command } from '../../lib/command-registry'
import { SHORTCUTS } from '../../lib/shortcuts'
import { THEME_LABELS, THEME_PREFERENCES } from '../../lib/theme'
import { useCommands, useRegisterCommands } from '../../store/commands'
import { useCompany } from '../../store/company'
import { useDensity } from '../../store/density'
import { useNavigation } from '../../store/navigation'
import { useNavigationLayout } from '../../store/navigation-layout'
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
  const { layout, toggleRail: toggle } = useNavigationLayout()
  const isCollapsed = layout === 'icons'
  const sections = useSectionNavigation()

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
          shortcut: SHORTCUTS.toggleRail,
          run: onToggleRail,
        },
        /* Ctrl ] and Ctrl [ from the design system's Modern key map. Ctrl [ was Back, which
         * moved to Alt ←, the key every browser and file manager already uses for it. */
        {
          id: 'nav.section.next',
          title: 'Go to the next section',
          section: 'Go to',
          keywords: ['section', 'tab', 'right'],
          shortcut: SHORTCUTS.nextSection,
          run: () => onStep(1),
        },
        {
          id: 'nav.section.previous',
          title: 'Go to the previous section',
          section: 'Go to',
          keywords: ['section', 'tab', 'left'],
          shortcut: SHORTCUTS.previousSection,
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
        location: describeLocation(screens, screen.area, screen.id) ?? section.label,
        run: () => navigate(makeRoute(screen.area, screen.id)),
      })),
    )

    /* Settings is in the Company rail. Before a company is open there is no rail for it to
     * be in, so the frame offers it here — in any area whose rail has not already. */
    const settingsId = `go.${route.area}.${SETTINGS_SCREEN_ID}`
    const settings: Command[] = navigation.some((command) => command.id === settingsId)
      ? []
      : [
          {
            id: settingsId,
            title: 'Go to Settings',
            section: 'Go to',
            keywords: ['preferences', 'theme', 'density', 'navigation'],
            run: () => navigate(makeRoute(route.area, SETTINGS_SCREEN_ID)),
          },
        ]

    /* Settings has the controls. The palette keeps a command per choice as well, so somebody
     * at the keyboard can change one without leaving the screen they are on, and each says
     * which is on. The words are the ones Settings uses. */
    const appearance: Command[] = THEME_PREFERENCES.map((option) => ({
      id: `view.theme.${option}`,
      title: `Theme: ${THEME_LABELS[option].toLowerCase()}`,
      section: 'View',
      keywords: ['theme', 'appearance', 'dark mode', 'light mode', 'contrast'],
      ...(option === preference ? { hint: 'Current' } : {}),
      run: () => setPreference(option),
    }))

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
        shortcut: SHORTCUTS.palette,
        run: () => setPaletteOpen(true),
      },
      {
        id: 'nav.back',
        title: 'Go back',
        section: 'General',
        shortcut: SHORTCUTS.back,
        isDisabled: !canGoBack,
        run: back,
      },
    ]

    /*
     * LEAVING THE BOOKS, TWO WAYS, AND THE DIFFERENCE IS WHERE IT LANDS.
     *
     * Both close the company — main drops the connection and the shell leaves the
     * workspace either way. Lock stops at the unlock screen for the company that was
     * open, which is the door somebody who is stepping away from the machine wants to
     * come back through; Switch goes to the picker, which is the one somebody opening
     * another set of books wants. Closing behind them is the same act, so it is one
     * function with a different destination.
     */
    const leave = (to: Route): void => {
      void close().then((result) => {
        if (!result.ok) {
          show({
            tone: 'danger',
            title: 'Closing the company reported a problem',
            body: result.error.message,
          })
        }
        navigate(to)
      })
    }

    const companyCommands: Command[] = company
      ? [
          {
            id: 'company.lock',
            title: 'Lock the books now',
            section: 'Company',
            keywords: ['close', 'lock', 'leave', 'away from the desk'],
            hint: company.displayName,
            shortcut: SHORTCUTS.lock,
            run: () => leave(makeRoute('welcome', 'unlock', { id: company.id })),
          },
          {
            id: 'company.switch',
            title: 'Switch company',
            section: 'Company',
            keywords: ['close', 'another', 'change', 'open'],
            shortcut: SHORTCUTS.switchCompany,
            run: () => leave(makeRoute('welcome', 'companies')),
          },
        ]
      : []

    return [...frame, ...navigation, ...settings, ...appearance, ...densities, ...companyCommands]
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
