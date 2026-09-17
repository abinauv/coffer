/*
 * The open company.
 *
 * Exactly one company is open at a time, or none — that is the whole model, and it
 * follows from the architecture rather than from a UI choice: a company IS a
 * database file plus its vault (ARCHITECTURE §6.3), so "open" means main holds an
 * unlocked connection. The renderer only mirrors that fact.
 *
 * Which is why nothing here caches anything from inside the books. It holds the
 * registry summary main sent back and the count of unspent recovery codes, and
 * every figure a screen shows is fetched from main when it is shown.
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type { CompanySummary, OpenCompanyResult, Result } from '@shared/dto'
import { callApi } from '../lib/api'

interface CompanyContextValue {
  company: CompanySummary | null
  /** Unspent single-use recovery codes. Zero is a state worth warning about. */
  recoveryCodesRemaining: number
  isOpen: boolean
  /** Records the result of an open/create/recover the picker has already run. */
  adopt: (result: OpenCompanyResult) => void
  /** Asks main to close, then clears local state whatever main answered. */
  close: () => Promise<Result<void>>
  /** Reflects a rename or a re-read of the registry entry. */
  update: (company: CompanySummary) => void
  /**
   * Records that a fresh set of recovery codes was issued: the count, and only the count.
   * The codes themselves are never held here — they belong to the screen that showed
   * them, for exactly as long as it is on screen.
   */
  recordRecoveryCodes: (remaining: number) => void
}

const CompanyContext = createContext<CompanyContextValue | null>(null)

export function CompanyProvider({ children }: { children: ReactNode }): JSX.Element {
  const [company, setCompany] = useState<CompanySummary | null>(null)
  const [recoveryCodesRemaining, setRecoveryCodesRemaining] = useState(0)

  const adopt = useCallback((result: OpenCompanyResult) => {
    setCompany(result.company)
    setRecoveryCodesRemaining(result.recoveryCodesRemaining)
  }, [])

  const close = useCallback(async () => {
    const result = await callApi((api) => api.companies.close())
    /* The books are unreachable from here either way — main holds the connection
     * and we do not. Staying on a workspace screen after a failed close would
     * show stale figures with no way to refresh them, so the shell always
     * returns to the picker and the error is surfaced as a toast. */
    setCompany(null)
    setRecoveryCodesRemaining(0)
    return result
  }, [])

  const update = useCallback((next: CompanySummary) => setCompany(next), [])

  const recordRecoveryCodes = useCallback(
    (remaining: number) => setRecoveryCodesRemaining(remaining),
    [],
  )

  const value = useMemo<CompanyContextValue>(
    () => ({
      company,
      recoveryCodesRemaining,
      isOpen: company !== null,
      adopt,
      close,
      update,
      recordRecoveryCodes,
    }),
    [company, recoveryCodesRemaining, adopt, close, update, recordRecoveryCodes],
  )

  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>
}

export function useCompany(): CompanyContextValue {
  const value = useContext(CompanyContext)
  if (!value) throw new Error('useCompany must be used inside a CompanyProvider')
  return value
}
