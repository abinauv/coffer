import { describe, expect, it } from 'vitest'
import type { AccountingPeriod, TaxReturnIssue } from '@shared/dto'
import {
  defaultPeriod,
  dueNote,
  dueTitle,
  groupIssues,
  issueSummary,
  periodOptions,
  requestedPeriod,
} from './tax-return-view'

function period(index: number, start: string, end: string, year = '2026-27'): AccountingPeriod {
  return {
    id: `p${index}`,
    fiscalYearLabel: year,
    index,
    label: start.slice(0, 7),
    startDate: start,
    endDate: end,
    status: 'open',
    closedAt: null,
  }
}

const PERIODS = [
  period(1, '2026-07-01', '2026-07-31'),
  period(2, '2026-08-01', '2026-08-31'),
  period(3, '2026-09-01', '2026-09-30'),
  period(4, '2026-10-01', '2026-10-31'),
]

const issue = (
  severity: 'error' | 'warning',
  over: Partial<TaxReturnIssue> = {},
): TaxReturnIssue => ({
  code: 'SOMETHING',
  severity,
  message: 'A thing.',
  documentNumber: null,
  ...over,
})

describe('the periods on offer', () => {
  /* A period that has not started has no documents in it yet. */
  it('offers every period that has started, newest first', () => {
    expect(periodOptions(PERIODS, '2026-09-17').map((option) => option.from)).toEqual([
      '2026-09-01',
      '2026-08-01',
      '2026-07-01',
    ])
  })

  it('names the fiscal year only when the books span more than one', () => {
    expect(periodOptions(PERIODS, '2026-09-17')[0]?.label).toBe('2026-09')
    const twoYears = [...PERIODS, period(5, '2025-08-01', '2025-08-31', '2025-26')]
    expect(periodOptions(twoYears, '2026-09-17').at(-1)?.label).toBe('2025-08 (2025-26)')
  })

  it('opens on the latest month that has finished', () => {
    const options = periodOptions(PERIODS, '2026-09-17')
    expect(defaultPeriod(options, '2026-09-17')?.from).toBe('2026-08-01')
  })

  /* A company set up this month still gets a table rather than an empty picker. */
  it('opens on the month in progress when nothing has finished', () => {
    const options = periodOptions([period(3, '2026-09-01', '2026-09-30')], '2026-09-17')
    expect(defaultPeriod(options, '2026-09-17')?.from).toBe('2026-09-01')
    expect(defaultPeriod([], '2026-09-17')).toBeNull()
  })

  it('honours a link only when it names a period on offer', () => {
    const options = periodOptions(PERIODS, '2026-09-17')
    expect(requestedPeriod(options, '2026-07-01', '2026-07-31')?.from).toBe('2026-07-01')
    expect(requestedPeriod(options, '2026-10-01', '2026-10-31')).toBeNull()
    expect(requestedPeriod(options, undefined, '2026-07-31')).toBeNull()
  })
})

describe('what main found', () => {
  it('puts what stops filing before what was assumed', () => {
    const groups = groupIssues([issue('warning'), issue('error'), issue('warning')])
    expect(groups.errors).toHaveLength(1)
    expect(groups.warnings).toHaveLength(2)
  })

  it('says how many things stop it being filed, and how many were assumed', () => {
    expect(issueSummary([issue('error')])).toBe('One thing stops this being filed as it stands.')
    expect(issueSummary([issue('error'), issue('error'), issue('warning')])).toBe(
      'Two things stop this being filed as it stands, and one thing was assumed rather than read from the books.',
    )
    expect(issueSummary([issue('warning'), issue('warning')])).toBe(
      'Nothing stops this being filed, but two things were assumed rather than read from the books.',
    )
  })

  /* It never calls a return ready: its shape is unchecked whatever its issues are. */
  it('never says the return is ready', () => {
    const quiet = issueSummary([])
    expect(quiet).toBe('Nothing in these documents was found to question.')
    expect(quiet).not.toMatch(/ready|correct|valid|safe to file/i)
  })
})

describe('the Overview line', () => {
  it('names the form and the period it was given', () => {
    expect(dueTitle('Form A', 'August 2026')).toBe('Form A for August 2026 has not been looked at')
    expect(dueNote(1)).toMatch(/^One document is dated then\./)
    expect(dueNote(12)).toMatch(/^12 documents are dated then\./)
  })
})
