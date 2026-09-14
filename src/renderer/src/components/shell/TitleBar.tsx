/*
 * The window title bar.
 *
 * Coffer draws its own so the top strip can carry the open company's name and year,
 * the command palette and the release stage instead of an empty OS bar. It has to be
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

import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { BRAND } from '../../../../branding'
import { callApi } from '../../lib/api'
import { currentFiscalYear, fiscalYearsFrom } from '../../lib/fiscal-year'
import { type Shortcut } from '../../lib/keys'
import { todayISO } from '../../lib/today'
import { useCommands } from '../../store/commands'
import { useCompany } from '../../store/company'
import { useAppInfo, useWindowChrome } from '../../store/platform'
import { Badge, Icon, Kbd } from '../atoms'
import { BrandMark } from './BrandMark'
import { Wordmark } from './Wordmark'

const PALETTE_SHORTCUT: Shortcut = { key: 'k', ctrlOrCmd: true }

export function TitleBar(): JSX.Element {
  const chrome = useWindowChrome()
  const appInfo = useAppInfo()
  const { company } = useCompany()
  const { setPaletteOpen } = useCommands()
  const year = useCurrentFinancialYear(company?.id ?? null)

  return (
    <header className="titlebar drag-region" data-chrome={chrome}>
      <div className="titlebar__lead">
        {/* The product's name until a company is open; then the company's, beside the mark.
            Whose books these are is the thing worth the room. */}
        {company === null ? (
          <Wordmark markSize={17} />
        ) : (
          <>
            <BrandMark size={17} />
            <span className="titlebar__company truncate" title={company.displayName}>
              {company.displayName}
            </span>
            {year !== null && (
              <span className="titlebar__year">
                <span className="visually-hidden">financial year </span>
                {year}
              </span>
            )}
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
          <span className="titlebar__search-label">Search or run a command</span>
          <span className="titlebar__search-hint" aria-hidden="true">
            <Kbd shortcut={PALETTE_SHORTCUT} />
          </span>
        </button>
      </div>

      <div className="titlebar__trail">
        <Badge tone="warning">{BRAND.releaseStage}</Badge>
        {appInfo && (
          <span className="titlebar__version" title={`${BRAND.name} ${appInfo.version}`}>
            {appInfo.version}
          </span>
        )}
      </div>
    </header>
  )
}

/**
 * The financial year today falls in, as the open company's regime names it.
 *
 * READ FROM THE PERIODS, NEVER WORKED OUT HERE. '2026-27' is India's spelling of a year
 * that starts in April; another regime's starts in January and is called '2026'. The
 * periods carry the regime's own label, so the title bar says what the books say.
 *
 * Nothing is shown until it is known, or when it cannot be read: the year is a courtesy
 * in the corner, and a failure to fetch it is not worth a message in the way.
 */
function useCurrentFinancialYear(companyId: string | null): string | null {
  const [found, setFound] = useState<{ companyId: string; label: string | null } | null>(null)

  useEffect(() => {
    if (companyId === null) return
    let isCurrent = true
    void callApi((api) => api.ledger.listPeriods()).then((result) => {
      if (!isCurrent) return
      setFound({
        companyId,
        label: result.ok ? currentFiscalYear(fiscalYearsFrom(result.data), todayISO()) : null,
      })
    })
    return () => {
      isCurrent = false
    }
  }, [companyId])

  /* An answer about the company before this one is no answer about this one. */
  return found !== null && found.companyId === companyId ? found.label : null
}
