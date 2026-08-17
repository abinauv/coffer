import { describe, expect, it } from 'vitest'
import { counterScopeOf, formatDocumentNumber, paddedSequence, previewOf } from './numbering'
import type { NumberingSeries } from './types'

/* Deliberately not the shape any of the assertions below expect: a plain running series
 * with no prefix, no year and no padding, so a function that ignored the series entirely
 * could not accidentally produce the right answer. */
const plain: NumberingSeries = {
  id: 'series-1',
  kind: 'sales-invoice',
  label: 'Plain',
  prefix: '',
  suffix: '',
  separator: '',
  includeFiscalYear: false,
  width: 1,
  resetOn: 'never',
}

const indianInvoice: NumberingSeries = {
  ...plain,
  label: 'Sales',
  prefix: 'INV',
  separator: '/',
  includeFiscalYear: true,
  width: 4,
  resetOn: 'fiscal-year',
}

describe('paddedSequence', () => {
  it('pads to the series width', () => {
    expect(paddedSequence(7, 4)).toBe('0007')
    expect(paddedSequence(1234, 4)).toBe('1234')
  })

  it('grows past the width rather than truncating', () => {
    /* A three-digit series that reaches 1000 must print 1000. Truncating to '000' would
     * hand out a number an earlier document already carries. */
    expect(paddedSequence(1000, 3)).toBe('1000')
    expect(paddedSequence(123456, 2)).toBe('123456')
  })

  it('leaves a number alone when the series asks for no padding', () => {
    expect(paddedSequence(42, 0)).toBe('42')
    expect(paddedSequence(42, -3)).toBe('42')
  })
})

describe('formatDocumentNumber', () => {
  it('assembles prefix, year and sequence the way an Indian invoice reads', () => {
    expect(formatDocumentNumber(indianInvoice, { fiscalYearLabel: '2026-27', sequence: 1 })).toBe(
      'INV/2026-27/0001',
    )
    expect(formatDocumentNumber(indianInvoice, { fiscalYearLabel: '2026-27', sequence: 137 })).toBe(
      'INV/2026-27/0137',
    )
  })

  it('drops an empty prefix instead of leaving a separator in front', () => {
    const noPrefix: NumberingSeries = { ...indianInvoice, prefix: '' }
    expect(formatDocumentNumber(noPrefix, { fiscalYearLabel: '2026-27', sequence: 9 })).toBe(
      '2026-27/0009',
    )
  })

  it('appends a suffix through the same separator', () => {
    const withSuffix: NumberingSeries = { ...indianInvoice, suffix: 'A' }
    expect(formatDocumentNumber(withSuffix, { fiscalYearLabel: '2026-27', sequence: 9 })).toBe(
      'INV/2026-27/0009/A',
    )
  })

  it('runs the parts together when the series has no separator', () => {
    const runOn: NumberingSeries = { ...plain, prefix: 'SI', width: 5 }
    expect(formatDocumentNumber(runOn, { fiscalYearLabel: null, sequence: 42 })).toBe('SI00042')
  })

  it('omits the year when the series does not include it', () => {
    const yearless: NumberingSeries = { ...indianInvoice, includeFiscalYear: false }
    expect(formatDocumentNumber(yearless, { fiscalYearLabel: '2026-27', sequence: 1 })).toBe(
      'INV/0001',
    )
  })

  it('refuses to build a number whose shape needs a year it was not given', () => {
    /* Dropping the segment quietly would produce 'INV/0001' — which next year's first
     * invoice would also produce. */
    expect(() =>
      formatDocumentNumber(indianInvoice, { fiscalYearLabel: null, sequence: 1 }),
    ).toThrow(/includes the fiscal year/)
  })

  it('is the same for every kind, because numbering is a property of the series', () => {
    const quotationSeries: NumberingSeries = { ...indianInvoice, kind: 'quotation', prefix: 'QT' }
    expect(formatDocumentNumber(quotationSeries, { fiscalYearLabel: '2026-27', sequence: 1 })).toBe(
      'QT/2026-27/0001',
    )
  })
})

describe('previewOf', () => {
  it('shows the first number the series would hand out', () => {
    expect(previewOf(indianInvoice, '2026-27')).toBe('INV/2026-27/0001')
  })

  it('goes through the same code path a real allocation does', () => {
    /* A lookalike preview that agreed with nothing would be worse than none. */
    expect(previewOf(indianInvoice, '2026-27')).toBe(
      formatDocumentNumber(indianInvoice, { fiscalYearLabel: '2026-27', sequence: 1 }),
    )
  })
})

describe('counterScopeOf', () => {
  it('keeps one counter per year for a series that resets', () => {
    expect(counterScopeOf(indianInvoice, '2026-27')).toBe('2026-27')
    expect(counterScopeOf(indianInvoice, '2027-28')).toBe('2027-28')
  })

  it('keeps a single counter for a series that never resets', () => {
    expect(counterScopeOf(plain, '2026-27')).toBeNull()
    expect(counterScopeOf(plain, '2027-28')).toBeNull()
  })

  it('reads resetOn and not includeFiscalYear', () => {
    /*
     * The two are independent, and both combinations are things a real business asks for:
     * a series that prints the year while the sequence runs on, and one that starts again
     * each year without saying so.
     */
    const printsYearRunsOn: NumberingSeries = {
      ...indianInvoice,
      includeFiscalYear: true,
      resetOn: 'never',
    }
    const resetsQuietly: NumberingSeries = {
      ...indianInvoice,
      includeFiscalYear: false,
      resetOn: 'fiscal-year',
    }

    expect(counterScopeOf(printsYearRunsOn, '2026-27')).toBeNull()
    expect(counterScopeOf(resetsQuietly, '2026-27')).toBe('2026-27')
  })
})
