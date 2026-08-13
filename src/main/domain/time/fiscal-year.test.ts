import { describe, expect, it } from 'vitest'
import { addDays, daysBetween, TimeError, type DateString } from './calendar-date'
import {
  aprilToMarch,
  containsDate,
  createFiscalYearRule,
  fiscalYearEndDate,
  fiscalYearFor,
  fiscalYearLabelOf,
  fiscalYearOf,
  fiscalYearStartDate,
  fiscalYearStartYearOf,
  januaryToDecember,
  periodOf,
  periodsOf,
  type FiscalYearRule,
  type PeriodGranularity,
} from './fiscal-year'
import fixture from './__fixtures__/fiscal-year.json'

interface RuleSpec {
  id: string
  startMonth: number
  startDay: number
  exported?: string
  why?: string
}

interface DateCase {
  rule: string
  date: DateString
  startYear: number
  label: string
  startDate: DateString
  endDate: DateString
  why?: string
}

interface PeriodExpectation {
  index: number
  label: string
  startDate: DateString
  endDate: DateString
}

interface PeriodCase {
  rule: string
  startYear: number
  granularity: PeriodGranularity
  expected: PeriodExpectation[]
  why?: string
}

interface LookupCase {
  rule: string
  date: DateString
  granularity: PeriodGranularity
  index: number
  label: string
}

interface ContainmentCase {
  rule: string
  startYear: number
  date: DateString
  contains: boolean
  why?: string
}

interface FiscalYearFixture {
  rules: RuleSpec[]
  dates: DateCase[]
  periods: PeriodCase[]
  periodLookups: LookupCase[]
  containment: ContainmentCase[]
}

const golden = fixture as unknown as FiscalYearFixture

const exported: Record<string, FiscalYearRule> = {
  aprilToMarch,
  januaryToDecember,
}

function build(spec: RuleSpec): FiscalYearRule {
  return createFiscalYearRule({
    id: spec.id,
    startMonth: spec.startMonth,
    startDay: spec.startDay,
  })
}

/* Where the fixture names an exported rule, the golden cases run against that rule —
 * not against a copy built from the same spec. Changing `aprilToMarch` therefore breaks
 * every April-to-March case here, which is the point of pinning it. */
const rules = new Map<string, FiscalYearRule>(
  golden.rules.map((spec) => [
    spec.id,
    spec.exported === undefined ? build(spec) : (exported[spec.exported] ?? build(spec)),
  ]),
)

function ruleFor(id: string): FiscalYearRule {
  const rule = rules.get(id)
  if (rule === undefined) {
    throw new Error(`fixture refers to unknown rule ${id}`)
  }
  return rule
}

describe('the shipped rules are the ones the fixture describes', () => {
  for (const spec of golden.rules) {
    if (spec.exported === undefined) {
      continue
    }
    it(`${spec.exported} starts on ${String(spec.startDay)}/${String(spec.startMonth)}`, () => {
      const rule = exported[spec.exported ?? '']
      expect(rule).toBeDefined()
      expect(rule?.id).toBe(spec.id)
      expect(rule?.startMonth).toBe(spec.startMonth)
      expect(rule?.startDay).toBe(spec.startDay)
    })

    it(`${spec.exported} behaves identically to the same rule built by hand`, () => {
      const shipped = ruleFor(spec.id)
      const rebuilt = build(spec)
      for (const startYear of [1999, 2026, 2027, 2028, 2099]) {
        expect(fiscalYearFor(shipped, startYear)).toEqual(fiscalYearFor(rebuilt, startYear))
      }
    })
  }

  it('ships an April-to-March rule and a January-to-December rule', () => {
    expect(aprilToMarch.startMonth).toBe(4)
    expect(januaryToDecember.startMonth).toBe(1)
    expect(aprilToMarch.id).not.toBe(januaryToDecember.id)
  })
})

describe('which fiscal year a date falls in — golden cases', () => {
  for (const entry of golden.dates) {
    const label = `${entry.rule}: ${entry.date} is in ${entry.label}${entry.why === undefined ? '' : ` (${entry.why})`}`
    it(label, () => {
      const rule = ruleFor(entry.rule)
      const fiscalYear = fiscalYearOf(rule, entry.date)
      expect(fiscalYear.startYear).toBe(entry.startYear)
      expect(fiscalYear.label).toBe(entry.label)
      expect(fiscalYear.startDate).toBe(entry.startDate)
      expect(fiscalYear.endDate).toBe(entry.endDate)
      expect(fiscalYear.ruleId).toBe(rule.id)
    })
  }

  it('agrees with the individual accessors', () => {
    for (const entry of golden.dates) {
      const rule = ruleFor(entry.rule)
      expect(fiscalYearStartYearOf(rule, entry.date)).toBe(entry.startYear)
      expect(fiscalYearLabelOf(rule, entry.date)).toBe(entry.label)
      expect(fiscalYearStartDate(rule, entry.startYear)).toBe(entry.startDate)
      expect(fiscalYearEndDate(rule, entry.startYear)).toBe(entry.endDate)
      expect(fiscalYearFor(rule, entry.startYear)).toEqual(fiscalYearOf(rule, entry.date))
    }
  })

  it('always contains the date it was derived from', () => {
    for (const entry of golden.dates) {
      expect(containsDate(fiscalYearOf(ruleFor(entry.rule), entry.date), entry.date)).toBe(true)
    }
  })

  it('a date and its fiscal year label do not always share a calendar year', () => {
    /* The case the April assumption gets wrong everywhere it is hardcoded. */
    expect(fiscalYearLabelOf(aprilToMarch, '2026-03-31')).toBe('2025-26')
    expect(fiscalYearLabelOf(aprilToMarch, '2026-04-01')).toBe('2026-27')
    expect(fiscalYearLabelOf(januaryToDecember, '2026-03-31')).toBe('2026')
  })
})

describe('fiscal year boundaries', () => {
  it('ends the day before the next one starts, for every rule', () => {
    for (const spec of golden.rules) {
      const rule = ruleFor(spec.id)
      for (const startYear of [1999, 2000, 2026, 2027, 2028, 2099]) {
        expect(fiscalYearEndDate(rule, startYear)).toBe(
          addDays(fiscalYearStartDate(rule, startYear + 1), -1),
        )
      }
    }
  })

  it('is 366 days long when it contains a leap day', () => {
    /* April 2027 to March 2028 spans 29 February 2028. */
    expect(daysBetween('2027-04-01', '2028-03-31') + 1).toBe(366)
    expect(daysBetween('2026-04-01', '2027-03-31') + 1).toBe(365)
    const leapYear = fiscalYearFor(aprilToMarch, 2027)
    expect(daysBetween(leapYear.startDate, leapYear.endDate) + 1).toBe(366)
  })

  it('consecutive years are contiguous and do not overlap', () => {
    for (const spec of golden.rules) {
      const rule = ruleFor(spec.id)
      const first = fiscalYearFor(rule, 2026)
      const second = fiscalYearFor(rule, 2027)
      expect(addDays(first.endDate, 1)).toBe(second.startDate)
      expect(containsDate(first, second.startDate)).toBe(false)
      expect(containsDate(second, first.endDate)).toBe(false)
    }
  })
})

describe('containment — golden cases', () => {
  for (const entry of golden.containment) {
    it(`${entry.rule} ${String(entry.startYear)} ${entry.contains ? 'contains' : 'excludes'} ${entry.date}`, () => {
      const fiscalYear = fiscalYearFor(ruleFor(entry.rule), entry.startYear)
      expect(containsDate(fiscalYear, entry.date)).toBe(entry.contains)
    })
  }
})

describe('periods — golden cases', () => {
  for (const entry of golden.periods) {
    it(`${entry.rule} ${String(entry.startYear)} has ${String(entry.expected.length)} ${entry.granularity}s`, () => {
      const periods = periodsOf(ruleFor(entry.rule), entry.startYear, entry.granularity)
      expect(
        periods.map((period) => ({
          index: period.index,
          label: period.label,
          startDate: period.startDate,
          endDate: period.endDate,
        })),
      ).toEqual(entry.expected)
    })

    it(`${entry.rule} ${String(entry.startYear)} ${entry.granularity}s tile the year exactly`, () => {
      const rule = ruleFor(entry.rule)
      const fiscalYear = fiscalYearFor(rule, entry.startYear)
      const periods = periodsOf(rule, entry.startYear, entry.granularity)

      expect(periods[0]?.startDate).toBe(fiscalYear.startDate)
      expect(periods[periods.length - 1]?.endDate).toBe(fiscalYear.endDate)

      for (let index = 1; index < periods.length; index += 1) {
        const previous = periods[index - 1]
        const current = periods[index]
        expect(previous).toBeDefined()
        expect(current).toBeDefined()
        if (previous === undefined || current === undefined) {
          continue
        }
        expect(addDays(previous.endDate, 1)).toBe(current.startDate)
        expect(current.index).toBe(index + 1)
        expect(current.fiscalYearLabel).toBe(fiscalYear.label)
      }
    })
  }
})

describe('periods — properties', () => {
  it('a year has twelve months and four quarters under every rule', () => {
    for (const spec of golden.rules) {
      const rule = ruleFor(spec.id)
      expect(periodsOf(rule, 2027, 'month')).toHaveLength(12)
      expect(periodsOf(rule, 2027, 'quarter')).toHaveLength(4)
    }
  })

  it('every day of the year falls in exactly one month and one quarter', () => {
    for (const spec of golden.rules) {
      const rule = ruleFor(spec.id)
      /* 2027-28 contains 29 February 2028 under the April rule. */
      const fiscalYear = fiscalYearFor(rule, 2027)
      const months = periodsOf(rule, 2027, 'month')
      const quarters = periodsOf(rule, 2027, 'quarter')

      let date = fiscalYear.startDate
      let days = 0
      while (date <= fiscalYear.endDate) {
        const matchingMonths = months.filter(
          (period) => date >= period.startDate && date <= period.endDate,
        )
        const matchingQuarters = quarters.filter(
          (period) => date >= period.startDate && date <= period.endDate,
        )
        expect(matchingMonths, `${spec.id} ${date}`).toHaveLength(1)
        expect(matchingQuarters, `${spec.id} ${date}`).toHaveLength(1)
        date = addDays(date, 1)
        days += 1
      }
      expect(days).toBe(daysBetween(fiscalYear.startDate, fiscalYear.endDate) + 1)
    }
  })

  it('quarters are three months each', () => {
    const months = periodsOf(aprilToMarch, 2027, 'month')
    const quarters = periodsOf(aprilToMarch, 2027, 'quarter')
    for (const [index, quarter] of quarters.entries()) {
      expect(quarter.startDate).toBe(months[index * 3]?.startDate)
      expect(quarter.endDate).toBe(months[index * 3 + 2]?.endDate)
    }
  })
})

describe('periodOf — golden cases', () => {
  for (const entry of golden.periodLookups) {
    it(`${entry.rule}: ${entry.date} is ${entry.label}`, () => {
      const period = periodOf(ruleFor(entry.rule), entry.date, entry.granularity)
      expect(period.index).toBe(entry.index)
      expect(period.label).toBe(entry.label)
      expect(period.granularity).toBe(entry.granularity)
      expect(entry.date >= period.startDate && entry.date <= period.endDate).toBe(true)
    })
  }
})

describe('createFiscalYearRule', () => {
  it('accepts a custom label', () => {
    const rule = createFiscalYearRule({
      id: 'custom',
      startMonth: 4,
      label: (startYear) => `FY${String(startYear)}/${String(startYear + 1)}`,
    })
    expect(rule.label(2026)).toBe('FY2026/2027')
    expect(fiscalYearOf(rule, '2026-05-01').label).toBe('FY2026/2027')
  })

  it('defaults startDay to the 1st', () => {
    expect(createFiscalYearRule({ id: 'x', startMonth: 7 }).startDay).toBe(1)
  })

  it('rejects a rule that cannot produce well-formed periods', () => {
    expect(() => createFiscalYearRule({ id: '', startMonth: 4 })).toThrow(TimeError)
    expect(() => createFiscalYearRule({ id: 'x', startMonth: 0 })).toThrow(TimeError)
    expect(() => createFiscalYearRule({ id: 'x', startMonth: 13 })).toThrow(TimeError)
    expect(() => createFiscalYearRule({ id: 'x', startMonth: 4.5 })).toThrow(TimeError)
    expect(() => createFiscalYearRule({ id: 'x', startMonth: 4, startDay: 0 })).toThrow(TimeError)
    /* The 29th would make a month step clamp, so periods would stop tiling the year. */
    expect(() => createFiscalYearRule({ id: 'x', startMonth: 4, startDay: 29 })).toThrow(TimeError)
    expect(() => createFiscalYearRule({ id: 'x', startMonth: 4, startDay: 31 })).toThrow(TimeError)
  })

  it('rejects a start year that is not a whole number', () => {
    expect(() => fiscalYearStartDate(aprilToMarch, 2026.5)).toThrow(TimeError)
  })

  it('nothing in the module assumes April', () => {
    const july = createFiscalYearRule({ id: 'july-june', startMonth: 7 })
    expect(fiscalYearOf(july, '2026-06-30').label).toBe('2025-26')
    expect(fiscalYearOf(july, '2026-07-01').label).toBe('2026-27')
    expect(periodsOf(july, 2026, 'month')[0]?.label).toBe('Jul 2026')
  })
})
