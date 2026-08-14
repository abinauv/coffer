import { describe, expect, it } from 'vitest'
import { D } from '@main/domain/money'
import { aprilToMarch, fiscalYearLabelOf, fiscalYearOf, periodsOf } from '@main/domain/time'
import type { NumberFormatRule, TaxRegime } from '@main/regimes/types'
import { inGstRegime } from './regime'

const regime: TaxRegime = inGstRegime

describe('the regime satisfies its own contract', () => {
  it('identifies itself by ISO country code', () => {
    expect(regime.id).toBe('in')
    expect(regime.label).toBe('India — GST')
  })

  it('implements every member of TaxRegime', () => {
    expect(typeof regime.computeTax).toBe('function')
    expect(typeof regime.placeOfSupply).toBe('function')
    expect(typeof regime.validateRegistrationNumber).toBe('function')
    expect(typeof regime.jurisdictionName).toBe('function')
    expect(typeof regime.jurisdictions).toBe('function')
    expect(typeof regime.amountInWords).toBe('function')
    expect(regime.classification).toBeDefined()
    expect(regime.fiscalYear).toBeDefined()
    expect(regime.numberFormat).toBeDefined()
    expect(regime.filings.length).toBeGreaterThan(0)
  })

  it('routes each member to the module that owns it', () => {
    expect(regime.validateRegistrationNumber('33AABCC1234D1ZI').isValid).toBe(true)
    expect(regime.jurisdictionName('33')).toBe('Tamil Nadu')
    expect(regime.jurisdictions().length).toBe(36)
    expect(regime.classification.validate('8471').isValid).toBe(true)
    expect(regime.amountInWords(D('1234.50'))).toBe(
      'Rupees One Thousand Two Hundred Thirty Four and Fifty Paise Only',
    )
    expect(
      regime.placeOfSupply(
        { registrationNumber: null, jurisdictionCode: '33', countryCode: 'in' },
        { registrationNumber: null, jurisdictionCode: '33', countryCode: 'in' },
      ).isIntraJurisdiction,
    ).toBe(true)
  })
})

describe('the fiscal year', () => {
  it('is the April-to-March rule from domain/time, not a copy of it', () => {
    /* Redeclaring the rule here would be a second place for it to be wrong. */
    expect(regime.fiscalYear).toBe(aprilToMarch)
    expect(regime.fiscalYear.id).toBe('april-march')
    expect(regime.fiscalYear.startMonth).toBe(4)
    expect(regime.fiscalYear.startDay).toBe(1)
  })

  it('puts 31 March in the year that started the previous April', () => {
    expect(fiscalYearLabelOf(regime.fiscalYear, '2026-03-31')).toBe('2025-26')
    expect(fiscalYearLabelOf(regime.fiscalYear, '2026-04-01')).toBe('2026-27')
  })

  it('runs 1 April to 31 March', () => {
    const year = fiscalYearOf(regime.fiscalYear, '2026-08-14')
    expect(year.label).toBe('2026-27')
    expect(year.startDate).toBe('2026-04-01')
    expect(year.endDate).toBe('2027-03-31')
  })

  it('has quarters that start in April, July, October and January', () => {
    const quarters = periodsOf(regime.fiscalYear, 2026, 'quarter')
    expect(quarters.map((quarter) => quarter.startDate)).toEqual([
      '2026-04-01',
      '2026-07-01',
      '2026-10-01',
      '2027-01-01',
    ])
    expect(quarters[3]?.endDate).toBe('2027-03-31')
  })
})

describe('the number format', () => {
  const format: NumberFormatRule = regime.numberFormat

  it('is the lakh/crore grouping in rupees', () => {
    expect(format.groupSizes).toEqual([3, 2])
    expect(format.decimalSeparator).toBe('.')
    expect(format.groupSeparator).toBe(',')
    expect(format.currencyCode).toBe('INR')
    expect(format.currencySymbol).toBe('₹')
  })

  it('describes the grouping well enough for a formatter that knows no regime', () => {
    /* The formatter below is deliberately generic — it reads the rule and nothing else.
     * If [3, 2] did not mean what it is supposed to mean, these would come out western. */
    const group = (digits: string, rule: NumberFormatRule): string => {
      const parts: string[] = []
      let rest = digits
      let index = 0
      while (rest.length > 0) {
        const size = rule.groupSizes[Math.min(index, rule.groupSizes.length - 1)] ?? 3
        if (rest.length <= size) {
          parts.unshift(rest)
          break
        }
        parts.unshift(rest.slice(-size))
        rest = rest.slice(0, -size)
        index += 1
      }
      return parts.join(rule.groupSeparator)
    }

    expect(group('1234567', format)).toBe('12,34,567')
    expect(group('100000', format)).toBe('1,00,000')
    expect(group('10000000', format)).toBe('1,00,00,000')
    expect(group('999', format)).toBe('999')
    expect(group('1000', format)).toBe('1,000')
    expect(group('1234567890', format)).toBe('1,23,45,67,890')

    /* And the same formatter with a thousands rule, to show the rule is doing the work. */
    expect(group('1234567', { ...format, groupSizes: [3] })).toBe('1,234,567')
  })
})

describe('the filings it declares', () => {
  it('declares GSTR-1, GSTR-3B and GSTR-2B', () => {
    expect(regime.filings.map((filing) => filing.id)).toEqual(['gstr-1', 'gstr-3b', 'gstr-2b'])
  })

  it('gives each a frequency and a description that says what it is for', () => {
    for (const filing of regime.filings) {
      expect(['monthly', 'quarterly', 'annual']).toContain(filing.frequency)
      expect(filing.label.length).toBeGreaterThan(0)
      expect(filing.description.length).toBeGreaterThan(40)
    }
  })

  it('has unique ids, because they are what a filing is stored against', () => {
    const ids = regime.filings.map((filing) => filing.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('says GSTR-2B is not something you submit', () => {
    const gstr2b = regime.filings.find((filing) => filing.id === 'gstr-2b')
    expect(gstr2b?.description).toContain('Nothing is submitted')
  })
})

describe('a document taxed through the interface, end to end', () => {
  it('derives the place of supply and then splits the tax on it', () => {
    const supplier = {
      registrationNumber: '33AABCC1234D1ZI',
      jurisdictionCode: null,
      countryCode: 'in',
    }
    const customer = {
      registrationNumber: '29AAAAA0000A1ZY',
      jurisdictionCode: null,
      countryCode: 'in',
    }

    const place = regime.placeOfSupply(supplier, customer)
    expect(place.isIntraJurisdiction).toBe(false)

    const result = regime.computeTax({
      supplier,
      customer,
      placeOfSupply: place,
      lines: [
        { lineId: 'L1', taxableAmount: '10000.00', ratePct: '18', classificationCode: '8471' },
        {
          lineId: 'freight',
          taxableAmount: '750.00',
          ratePct: '5',
          classificationCode: '996511',
          isCharge: true,
        },
      ],
      date: '2026-08-14',
    })

    expect(result.totalTax).toBe('1837.50')
    expect(regime.amountInWords(D(result.totalTax))).toBe(
      'Rupees One Thousand Eight Hundred Thirty Seven and Fifty Paise Only',
    )
  })
})
