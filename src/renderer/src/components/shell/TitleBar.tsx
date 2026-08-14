/*
 * The window title bar.
 *
 * Coffer draws its own so the top strip can carry the open company's name, the
 * command palette and the theme control instead of an empty OS bar. It has to be
 * correct in four situations, which is what `WindowChrome` enumerates:
 *
 *   framed             main still creates a normal window. This bar is just a
 *                      header under the OS one. Nothing overlaps; the drag region
 *                      is harmless and still works.
 *   os-traffic-lights  macOS with `titleBarStyle: 'hidden'`. The lights float over
 *                      our top-left, so the leading inset opens up to clear them.
 *   os-overlay         Windows/Linux with `titleBarOverlay`. The OS paints its
 *                      controls over our top-right; the trailing inset is read
 *                      from the `titlebar-area-*` environment variables so it is
 *                      exactly right whatever width the OS chose.
 *   frameless-bare     frameless with no OS controls. Nothing can minimise or
 *                      close the window from here — see the report; this mode is
 *                      a misconfiguration, and the bar refuses to pretend it can
 *                      offer buttons that would have nothing to call.
 *
 * The renderer never guesses which mode it is in. It detects it (store/platform)
 * and lays out from a data attribute, so the same build is right before and after
 * main changes its BrowserWindow options.
 */

import type { JSX } from 'react'
import { BRAND } from '../../../../branding'
import { formatShortcut, type Shortcut } from '../../lib/keys'
import { useCommands } from '../../store/commands'
import { useCompany } from '../../store/company'
import { useAppInfo, usePlatform, useWindowChrome } from '../../store/platform'
import { Icon } from '../atoms'
import { BrandMark } from './BrandMark'
import { ThemeControl } from './ThemeControl'

const PALETTE_SHORTCUT: Shortcut = { key: 'k', ctrlOrCmd: true }

export function TitleBar(): JSX.Element {
  const chrome = useWindowChrome()
  const platform = usePlatform()
  const appInfo = useAppInfo()
  const { company } = useCompany()
  const { setPaletteOpen } = useCommands()

  return (
    <header className="titlebar drag-region" data-chrome={chrome}>
      <div className="titlebar__lead">
        <BrandMark size={17} />
        <span className="titlebar__product">{BRAND.name}</span>
        {company && (
          <>
            <span className="titlebar__divider" aria-hidden="true" />
            <span className="titlebar__company truncate" title={company.displayName}>
              {company.displayName}
            </span>
          </>
        )}
      </div>

      <div className="titlebar__centre">
        {/* Double duty: the palette's discoverable affordance and the app's only
            search field. Labelled as a button because it opens a dialog rather
            than filtering in place. */}
        <button
          type="button"
          className="titlebar__search"
          onClick={() => setPaletteOpen(true)}
          aria-haspopup="dialog"
        >
          <Icon name="search" size={13} />
          <span className="titlebar__search-label">Search and commands</span>
          <span className="titlebar__search-hint" aria-hidden="true">
            {formatShortcut(PALETTE_SHORTCUT, platform)}
          </span>
        </button>
      </div>

      <div className="titlebar__trail">
        <ThemeControl isCompact />
        {appInfo && (
          <span className="titlebar__version" title={`${BRAND.name} ${appInfo.version}`}>
            {appInfo.version}
          </span>
        )}
      </div>
    </header>
  )
}
