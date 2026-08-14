/*
 * The workspace sidebar.
 *
 * Every item comes from the screen registry — a screen that declares `nav` appears
 * here, in its group, in its order. There is no list of screens in this file and
 * there never should be, or adding a screen becomes two edits in two places and
 * one of them gets forgotten.
 */

import type { JSX } from 'react'
import { navSections, type NavigableScreen } from '../../lib/screens'
import { makeRoute } from '../../lib/routing'
import { useCompany } from '../../store/company'
import { useNavigation } from '../../store/navigation'
import { useScreens } from '../../store/screens'
import { Icon, IconButton, Tooltip } from '../atoms'

interface SidebarProps {
  isCollapsed: boolean
  onToggleCollapsed: () => void
}

export function Sidebar({ isCollapsed, onToggleCollapsed }: SidebarProps): JSX.Element {
  const screens = useScreens()
  const { route, navigate } = useNavigation()
  const { company } = useCompany()
  const sections = navSections(screens, 'workspace')

  return (
    <nav className="sidebar" data-collapsed={isCollapsed ? 'true' : 'false'} aria-label="Sections">
      <div className="sidebar__scroll">
        {sections.length === 0 && !isCollapsed && (
          <p className="sidebar__empty">No sections yet. Screens appear here as they register.</p>
        )}

        {sections.map((section) => (
          <div key={section.id} className="sidebar__section">
            {/* The heading is hidden rather than removed when collapsed: the
                grouping still exists for anyone listening to it. */}
            <h2 className={isCollapsed ? 'visually-hidden' : 'sidebar__heading caps-label'}>
              {section.label}
            </h2>
            <ul className="sidebar__list">
              {section.screens.map((screen) => (
                <li key={screen.id}>
                  <NavItem
                    screen={screen}
                    isActive={route.screenId === screen.id}
                    isCollapsed={isCollapsed}
                    onSelect={() => navigate(makeRoute('workspace', screen.id))}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="sidebar__foot">
        {!isCollapsed && company && (
          <div className="sidebar__company">
            <span className="sidebar__company-name truncate">{company.displayName}</span>
            <span className="sidebar__company-path truncate" title={company.filePath}>
              {company.filePath}
            </span>
          </div>
        )}
        <IconButton
          icon={isCollapsed ? 'chevron-right' : 'panel-left'}
          label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          variant="ghost"
          size="sm"
          onClick={onToggleCollapsed}
        />
      </div>
    </nav>
  )
}

interface NavItemProps {
  screen: NavigableScreen
  isActive: boolean
  isCollapsed: boolean
  onSelect: () => void
}

function NavItem({ screen, isActive, isCollapsed, onSelect }: NavItemProps): JSX.Element {
  const button = (
    <button
      type="button"
      className="sidebar__item focus-inset"
      data-active={isActive ? 'true' : 'false'}
      /* `page` rather than `true`: this is where you are in the app, not merely
       * the selected control. */
      aria-current={isActive ? 'page' : undefined}
      onClick={onSelect}
    >
      <Icon name={screen.nav.icon} size={16} strokeWidth={isActive ? 1.95 : 1.7} />
      <span className={isCollapsed ? 'visually-hidden' : 'sidebar__item-label truncate'}>
        {screen.nav.label}
      </span>
    </button>
  )

  /* Collapsed, the icon is the only label there is, so the tooltip stops being a
   * nicety and becomes the name of the control. */
  return isCollapsed ? (
    <Tooltip label={screen.nav.label} placement="right" delayMs={250}>
      {button}
    </Tooltip>
  ) : (
    button
  )
}
