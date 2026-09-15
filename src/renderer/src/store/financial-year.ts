/*
 * The financial year today falls in, as the open company's regime names it.
 *
 * READ FROM THE PERIODS, NEVER WORKED OUT HERE. '2026-27' is India's spelling of a year
 * that starts in April; another regime's starts in January and is called '2026'. The
 * periods carry the regime's own label, so every place that prints the year says what the
 * books say. The title bar and the Overview both ask; each asks once per company.
 *
 * Nothing is answered until it is known, or when it cannot be read: the year is a courtesy
 * beside a name or a date, and a failure to fetch it is not worth a message in the way.
 */

import { useEffect, useState } from 'react'
import { callApi } from '../lib/api'
import { currentFiscalYear, fiscalYearsFrom } from '../lib/fiscal-year'
import { todayISO } from '../lib/today'

export function useCurrentFinancialYear(companyId: string | null): string | null {
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
