import { describe, expect, it } from 'vitest'
import { figureClassName, figureSign } from './figures'

describe('figureSign', () => {
  it('reads a leading minus as negative', () => {
    expect(figureSign('-1,200.00')).toBe('negative')
    expect(figureSign('-₹1,200.00')).toBe('negative')
    expect(figureSign('₹ -1,200.00')).toBe('negative')
  })

  it('reads the accounting parenthesis as negative', () => {
    expect(figureSign('(1,200.00)')).toBe('negative')
    expect(figureSign('(₹1,200.00)')).toBe('negative')
  })

  it('accepts the typographic minus signs a formatter may emit', () => {
    expect(figureSign('−1,200.00')).toBe('negative')
    expect(figureSign('–1,200.00')).toBe('negative')
  })

  it('reads a plain amount as positive', () => {
    expect(figureSign('1,200.00')).toBe('positive')
    expect(figureSign('₹1,20,000.55')).toBe('positive')
    expect(figureSign('0.01')).toBe('positive')
  })

  /* Zero is neither owed nor owing, and colouring it red because the formatter
   * produced '-0.00' would be a lie. */
  it('reads every form of zero as zero', () => {
    expect(figureSign('0')).toBe('zero')
    expect(figureSign('0.00')).toBe('zero')
    expect(figureSign('-0.00')).toBe('zero')
    expect(figureSign('(0.00)')).toBe('zero')
    expect(figureSign('₹0.00')).toBe('zero')
  })

  it('reads a placeholder with no digits as zero', () => {
    expect(figureSign('')).toBe('zero')
    expect(figureSign('   ')).toBe('zero')
    expect(figureSign('—')).toBe('zero')
  })

  /* A dash after the digits is a range or a suffix, not a sign. */
  it('ignores a dash that follows the first digit', () => {
    expect(figureSign('1,200.00-')).toBe('positive')
    expect(figureSign('2026-04-01')).toBe('positive')
  })

  it('ignores surrounding whitespace', () => {
    expect(figureSign('  -45.00  ')).toBe('negative')
  })
})

describe('figureClassName', () => {
  it('marks only the states that need marking', () => {
    expect(figureClassName('1,200.00')).toBe('figure')
    expect(figureClassName('-1,200.00')).toBe('figure figure--negative')
    expect(figureClassName('0.00')).toBe('figure figure--zero')
  })

  it('appends an extra class', () => {
    expect(figureClassName('-5.00', 'table__amount')).toBe('figure figure--negative table__amount')
  })
})
