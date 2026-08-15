/*
 * Reading the company list.
 *
 * The registry is main's, and `availability` is a fact about the filesystem at the moment
 * `companies.list()` ran — a drive can be unplugged a second later. So nothing here
 * caches across screens: each screen that needs the list asks for it, and offers a way to
 * ask again.
 */

import { useCallback, useEffect, useState } from 'react'
import { callApi } from '@renderer/lib/api'
import type { AppError, CompanySummary } from '@shared/dto'
import { sortCompanies } from './availability'

export interface CompanyList {
  /** Null until the first answer arrives — which is not the same as an empty registry. */
  companies: readonly CompanySummary[] | null
  error: AppError | null
  isLoading: boolean
  refresh: () => Promise<void>
}

export function useCompanies(): CompanyList {
  const [companies, setCompanies] = useState<readonly CompanySummary[] | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [isLoading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    const result = await callApi((api) => api.companies.list())
    if (result.ok) {
      setCompanies(sortCompanies(result.data))
      setError(null)
    } else {
      setError(result.error)
      /* The previous list is kept: a registry read that failed once does not mean the
       * companies stopped existing, and blanking the screen would say that it does. */
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { companies, error, isLoading, refresh }
}

/** One company from a list read, by id. Null while loading, and when it is not there. */
export function findCompany(
  companies: readonly CompanySummary[] | null,
  id: string | undefined,
): CompanySummary | null {
  if (companies === null || id === undefined || id === '') return null
  return companies.find((company) => company.id === id) ?? null
}
