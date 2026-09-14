import { describe, expect, it } from 'vitest'
import type { AccountingPeriod } from '@shared/dto'
import { currentFiscalYear, fiscalYearsFrom } from './fiscal-year'

function periodOf(fiscalYearLabel: string, startDate: string, endDate: string): AccountingPeriod {
  return {
    id: `${fiscalYearLabel}-${startDate}`,
    fiscalYearLabel,
    index: 1,
    label: startDate,
    startDate,
    endDate,
    status: 'open',
    closedAt: null,
  }
}

describe('the financial years the books keep', () => {
  /* Out of order, interleaved, and more than one period per year — which is what a real
   * `listPeriods` returns and what a naive "first period wins" would get wrong. */
  const periods = [
    periodOf('2026-27', '2026-05-01', '2026-05-31'),
    periodOf('2025-26', '2025-04-01', '2025-04-30'),
    periodOf('2026-27', '2026-04-01', '2026-04-30'),
    periodOf('2025-26', '2026-03-01', '2026-03-31'),
    periodOf('2026-27', '2027-03-01', '2027-03-31'),
  ]

  it('lists each year once, earliest first, spanning its own periods', () => {
    expect(fiscalYearsFrom(periods)).toEqual([
      { label: '2025-26', from: '2025-04-01', to: '2026-03-31' },
      { label: '2026-27', from: '2026-04-01', to: '2027-03-31' },
    ])
  })

  it('has no years to offer when the books have no periods', () => {
    expect(fiscalYearsFrom([])).toEqual([])
  })

  /* Deliberately the SECOND year, so "the first one" cannot pass. */
  it('picks the year today falls in', () => {
    expect(currentFiscalYear(fiscalYearsFrom(periods), '2026-09-06')).toBe('2026-27')
  })

  it('counts both ends of a year as inside it', () => {
    const years = fiscalYearsFrom(periods)
    expect(currentFiscalYear(years, '2026-04-01')).toBe('2026-27')
    expect(currentFiscalYear(years, '2027-03-31')).toBe('2026-27')
    expect(currentFiscalYear(years, '2026-03-31')).toBe('2025-26')
  })

  /* Books whose periods all lie in the past still have a most recent year, and previewing
   * that is more use than previewing nothing. */
  it('falls back to the latest year the books keep', () => {
    expect(currentFiscalYear(fiscalYearsFrom(periods), '2030-01-01')).toBe('2026-27')
  })

  it('has nothing to fall back to when there are no years', () => {
    expect(currentFiscalYear([], '2026-09-06')).toBeNull()
  })
})
