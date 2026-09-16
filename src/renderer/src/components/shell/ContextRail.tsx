/*
 * The contextual rail: the screens inside the section you are in, and nothing else.
 *
 * Six things, then six things, never thirty-four. The section bar says which part of the
 * business; this says which screen. Every entry comes from the screen registry, so there is
 * no list of screens in this file and there never should be.
 *
 * WHILE AN EDITOR IS OPEN, ITS REGISTER STAYS MARKED. An editor has no entry of its own —
 * there is no "the" invoice to land on — and a rail that marked nothing while you typed one
 * would have lost track of where you are. The register is marked as `aria-current="true"`,
 * and only the screen actually on show is `page`.
 *
 * COLLAPSED, IT IS ICONS WITH TOOLTIPS. Narrow windows collapse it on their own
 * (lib/layout.ts). The words stay in the DOM as each button's name, so an icon rail is as
 * usable with a screen reader as the full one.
 */

import { useId } from 'react'
import type { JSX } from 'react'
import type { NavSection, NavigableScreen } from '../../lib/screens'
import { makeRoute } from '../../lib/routing'
import { railBackupLine } from '../../screens/lib/backup-view'
import { useBackup } from '../../store/backup'
import { useCompany } from '../../store/company'
import { useCommands } from '../../store/commands'
import { useNavigation } from '../../store/navigation'
import { Button, Icon, IconButton, Kbd, Tooltip } from '../atoms'
import type { MarkedRailEntry } from './useSectionNavigation'

interface ContextRailProps {
  section: NavSection | null
  marked: MarkedRailEntry | null
  isCollapsed: boolean
  onToggleCollapsed: () => void
}

export function ContextRail({
  section,
  marked,
  isCollapsed,
  onToggleCollapsed,
}: ContextRailProps): JSX.Element {
  const { navigate } = useNavigation()
  const { backUp, isBackingUp } = useBackup()
  const { company } = useCompany()
  const headingId = useId()

  return (
    <nav
      className="rail"
      data-collapsed={isCollapsed ? 'true' : 'false'}
      {...(section === null ? { 'aria-label': 'Screens' } : { 'aria-labelledby': headingId })}
    >
      <div className="rail__scroll">
        {section === null ? (
          !isCollapsed && (
            <p className="rail__empty">No sections yet. Screens appear here as they register.</p>
          )
        ) : (
          <>
            {/* Hidden rather than removed when collapsed: it is still the rail's name. */}
            <h2
              id={headingId}
              className={isCollapsed ? 'visually-hidden' : 'rail__heading caps-label'}
            >
              {section.label}
            </h2>
            <ul className="rail__list">
              {section.screens.map((screen) => (
                <li key={screen.id}>
                  <RailItem
                    screen={screen}
                    marked={marked?.id === screen.id ? marked : null}
                    isCollapsed={isCollapsed}
                    onSelect={() => navigate(makeRoute('workspace', screen.id))}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="rail__foot">
        {/* WHEN, NOT WHETHER. The rail says when an archive was last written from this
            machine; whether that file is still in the folder is something only the folder
            can answer, and Company → Backups is where the path is. */}
        {!isCollapsed && company !== null && (
          <p className="rail__backup-when">{railBackupLine(company.lastBackup)}</p>
        )}
        {isCollapsed ? (
          <Tooltip label="Back up now" placement="right" delayMs={250}>
            <IconButton
              icon="archive"
              label="Back up now"
              variant="ghost"
              size="sm"
              isBusy={isBackingUp}
              onClick={() => void backUp()}
            />
          </Tooltip>
        ) : (
          <Button
            className="rail__backup"
            icon="archive"
            size="sm"
            isBusy={isBackingUp}
            onClick={() => void backUp()}
          >
            Back up now
          </Button>
        )}
        <IconButton
          icon={isCollapsed ? 'chevron-right' : 'panel-left'}
          label={isCollapsed ? 'Expand the rail' : 'Collapse the rail'}
          variant="ghost"
          size="sm"
          onClick={onToggleCollapsed}
        />
      </div>
    </nav>
  )
}

interface RailItemProps {
  screen: NavigableScreen
  marked: MarkedRailEntry | null
  isCollapsed: boolean
  onSelect: () => void
}

function RailItem({ screen, marked, isCollapsed, onSelect }: RailItemProps): JSX.Element {
  const { commands } = useCommands()
  /* The keycap is the one on the screen's own Go to command, so the rail cannot show a key
   * that does not fire. None has one yet; the Modern key map gives them out. */
  const shortcut = commands.find((command) => command.id === `go.workspace.${screen.id}`)?.shortcut

  const button = (
    <button
      type="button"
      className="rail__item focus-inset"
      data-active={marked !== null ? 'true' : 'false'}
      aria-current={marked === null ? undefined : marked.isOpen ? 'page' : 'true'}
      onClick={onSelect}
    >
      {isCollapsed && (
        <Icon name={screen.nav.icon} size={16} strokeWidth={marked !== null ? 1.95 : 1.7} />
      )}
      <span className={isCollapsed ? 'visually-hidden' : 'rail__item-label'}>
        {screen.nav.label}
      </span>
      {!isCollapsed && shortcut !== undefined && (
        <span aria-hidden="true">
          <Kbd shortcut={shortcut} className="rail__item-key" />
        </span>
      )}
    </button>
  )

  /* Collapsed, the icon is the only label there is, so the tooltip stops being a nicety
   * and becomes the name of the control. */
  return isCollapsed ? (
    <Tooltip label={screen.nav.label} placement="right" delayMs={250}>
      {button}
    </Tooltip>
  ) : (
    button
  )
}
