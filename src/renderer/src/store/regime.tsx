/*
 * The open company's tax regime, as the screens see it.
 *
 * WHY THIS IS NOT IN store/company.tsx. That provider holds the registry summary main
 * sent back and deliberately caches nothing from inside the books — every figure a screen
 * shows is fetched when it is shown. This is not a figure. It is the RULES: the number
 * format, the jurisdictions, the rate slabs, the tax components. They are read off the
 * company file when it opens and cannot change while it is open, so fetching them per
 * screen would be one round trip per render for a constant.
 *
 * TWO COMPONENTS, AND THE SPLIT IS WHAT MAKES SCREENS TESTABLE. `RegimeProvider` is
 * dumb: it takes a description and publishes it. `OpenCompanyRegime` is the one that
 * knows about companies and IPC. A screen test renders the dumb one with a literal and
 * needs neither a company nor a bridge stub for a channel it never meant to exercise.
 *
 * `useNumberFormat` THROWS RATHER THAN FALLING BACK. A default would be the Indian
 * grouping coming back in through the side door — silently right for one country and
 * silently wrong for every other, which is exactly the bug this batch exists to remove.
 * There is no correct number format when the books are not open, so asking for one there
 * is a mistake in the caller, and it is better found on the first render than in a
 * screenshot from a user in Lisbon.
 */

import { createContext, useContext, useEffect, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type { AppError, NumberFormat, RegimeDescription } from '@shared/dto'
import { callApi } from '../lib/api'
import { useCompany } from './company'

const RegimeContext = createContext<RegimeDescription | null | undefined>(undefined)

/**
 * Publishes a regime description. Null means no company is open.
 *
 * Takes the value rather than fetching it, so that a test can render a screen under a
 * regime that is not the bundled one without arranging a company to be open.
 */
export function RegimeProvider({
  value,
  children,
}: {
  value: RegimeDescription | null
  children: ReactNode
}): JSX.Element {
  return <RegimeContext.Provider value={value}>{children}</RegimeContext.Provider>
}

/**
 * Fetches the description when a company opens, and holds the shell until it arrives.
 *
 * THE GATE IS DELIBERATE AND IT IS SMALL. Between a company opening and this answering
 * there is one IPC call, inside a transition that is already replacing the whole shell —
 * the welcome screens are going away and the workspace is arriving. Rendering the
 * workspace before the rules are known would mean drawing money under a format nothing
 * has vouched for, and the alternative to a gate is a default, which is the thing being
 * removed.
 *
 * A FAILURE IS FATAL TO THE WORKSPACE AND SAYS SO. Not a toast: a toast is dismissible
 * and this is not a transient condition. If these books name a regime this build does not
 * have, every figure in them would be formatted by a guess and every tax picker would
 * offer another country's rates. The books stay shut, and the message says which.
 */
export function OpenCompanyRegime({ children }: { children: ReactNode }): JSX.Element {
  const { company } = useCompany()
  const companyId = company?.id ?? null

  const [regime, setRegime] = useState<RegimeDescription | null>(null)
  const [error, setError] = useState<AppError | null>(null)

  useEffect(() => {
    if (companyId === null) {
      setRegime(null)
      setError(null)
      return
    }

    /* Guards against a close-and-reopen resolving out of order and publishing the
     * previous company's rules over the current one's. */
    let current = true
    setRegime(null)
    setError(null)

    void (async () => {
      const result = await callApi((api) => api.regime.describe())
      if (!current) return
      if (result.ok) setRegime(result.data)
      else setError(result.error)
    })()

    return () => {
      current = false
    }
  }, [companyId])

  if (companyId !== null && error !== null) {
    return (
      <div className="screen screen--missing">
        <div className="missing-screen">
          <h1 className="missing-screen__title">These books&rsquo; tax rules could not be read</h1>
          <p className="missing-screen__body">{error.message}</p>
        </div>
      </div>
    )
  }

  /* Open, and the rules are still on their way. See the note above on why this is a gate
   * and not a default. */
  if (companyId !== null && regime === null) return <></>

  return <RegimeProvider value={regime}>{children}</RegimeProvider>
}

/**
 * The open company's regime, or null when none is open.
 *
 * Use this where the absence is a state worth drawing. Where it is not — anywhere money
 * is rendered — use `useNumberFormat`, which refuses to guess.
 */
export function useRegime(): RegimeDescription | null {
  const value = useContext(RegimeContext)
  if (value === undefined) throw new Error('useRegime must be used inside a RegimeProvider')
  return value
}

/**
 * How to write a number in these books.
 *
 * @throws when no company is open. A screen that shows money belongs to the workspace,
 * and the workspace does not render until the rules have arrived.
 */
export function useNumberFormat(): NumberFormat {
  const regime = useRegime()
  if (regime === null) {
    throw new Error(
      'useNumberFormat needs an open company. Every amount is written the way that ' +
        "company's tax regime writes numbers, and there is no sensible default — see " +
        'src/renderer/src/store/regime.tsx.',
    )
  }
  return regime.numberFormat
}
