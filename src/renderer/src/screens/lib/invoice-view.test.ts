import { describe, expect, it } from 'vitest'
import { INVOICE_KIND, PAGE_SIZE, statusFilters, statusLabel, statusTone } from './invoice-view'

describe('statusLabel', () => {
  it('names the three states a document can be in', () => {
    expect(statusLabel('draft')).toBe('Draft')
    expect(statusLabel('issued')).toBe('Issued')
    expect(statusLabel('cancelled')).toBe('Cancelled')
  })

  /* A kind of status this build does not know is shown as it arrived rather than as a
   * blank cell — the same rule `accountTypeLabel` follows. */
  it('shows an unknown status rather than hiding it', () => {
    expect(statusLabel('superseded')).toBe('superseded')
  })
})

describe('statusTone', () => {
  /*
   * THE ASSERTION WORTH HAVING. Cancelling is the correct way to undo an issued
   * invoice — the entry is reversed, the number is kept, the series has no hole. A red
   * badge against it would put a warning on the one action that fixes a mistake
   * properly, and make well-kept books look alarming.
   */
  it('never marks a cancelled document as a problem', () => {
    expect(statusTone('cancelled')).not.toBe('negative')
    expect(statusTone('cancelled')).not.toBe('warning')
    expect(statusTone('cancelled')).toBe('neutral')
  })

  it('gives the draft the accent, because it is the row with something left to do', () => {
    expect(statusTone('draft')).toBe('accent')
    expect(statusTone('issued')).toBe('positive')
  })

  it('does not colour a status it does not know', () => {
    expect(statusTone('superseded')).toBe('neutral')
  })
})

describe('statusFilters', () => {
  it('offers no filter first, then the three states', () => {
    expect(statusFilters().map((filter) => filter.value)).toEqual([
      '',
      'draft',
      'issued',
      'cancelled',
    ])
  })

  it('labels the unfiltered option as all rather than as nothing', () => {
    expect(statusFilters()[0]?.label).toBe('All')
  })
})

describe('the register constants', () => {
  it('lists invoices and not the other four kinds', () => {
    expect(INVOICE_KIND).toBe('sales-invoice')
  })

  /* A page has to be smaller than the repository's own cap of 500, or the extra row that
   * answers "is there another page" is the row the repository truncated and Next never
   * appears. */
  it('asks for a page the repository will not truncate', () => {
    expect(PAGE_SIZE + 1).toBeLessThan(500)
  })
})
