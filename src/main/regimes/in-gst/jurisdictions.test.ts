import { describe, expect, it } from 'vitest'
import {
  findJurisdiction,
  INDIAN_JURISDICTIONS,
  intraStateComponentFor,
  isKnownJurisdictionCode,
  jurisdictionName,
  jurisdictions,
} from './jurisdictions'

describe('the code list', () => {
  it('covers 01 to 38 with no gaps, plus 97 and 99', () => {
    const codes = INDIAN_JURISDICTIONS.map((entry) => entry.code)
    const expected = [
      ...Array.from({ length: 38 }, (_, index) => String(index + 1).padStart(2, '0')),
      '97',
      '99',
    ]
    expect(codes).toEqual(expected)
  })

  it('has no duplicate codes and no duplicate names', () => {
    expect(new Set(INDIAN_JURISDICTIONS.map((entry) => entry.code)).size).toBe(
      INDIAN_JURISDICTIONS.length,
    )
    expect(new Set(INDIAN_JURISDICTIONS.map((entry) => entry.name)).size).toBe(
      INDIAN_JURISDICTIONS.length,
    )
  })

  it('names the ones most often relied on', () => {
    expect(jurisdictionName('33')).toBe('Tamil Nadu')
    expect(jurisdictionName('27')).toBe('Maharashtra')
    expect(jurisdictionName('29')).toBe('Karnataka')
    expect(jurisdictionName('07')).toBe('Delhi')
    expect(jurisdictionName('24')).toBe('Gujarat')
    expect(jurisdictionName('09')).toBe('Uttar Pradesh')
  })

  it('is null for a code that was never issued', () => {
    expect(jurisdictionName('88')).toBeNull()
    expect(jurisdictionName('00')).toBeNull()
    expect(jurisdictionName('')).toBeNull()
    expect(isKnownJurisdictionCode('39')).toBe(false)
  })
})

describe('SGST or UTGST — the half a state levies', () => {
  it('is SGST for a state', () => {
    expect(intraStateComponentFor('33')).toBe('SGST')
    expect(intraStateComponentFor('27')).toBe('SGST')
  })

  it('is UTGST for a union territory without a legislature', () => {
    for (const code of ['04', '26', '31', '35', '38']) {
      expect(intraStateComponentFor(code), code).toBe('UTGST')
    }
  })

  it('is SGST for the three union territories that have one', () => {
    /* Delhi, Puducherry and Jammu & Kashmir are union territories and still levy SGST.
     * Deriving the component from the word 'territory' would get all three wrong. */
    for (const code of ['01', '07', '34']) {
      expect(findJurisdiction(code)?.type, code).toBe('union-territory')
      expect(intraStateComponentFor(code), code).toBe('SGST')
    }
  })

  it('falls back to SGST for a code it does not recognise', () => {
    expect(intraStateComponentFor('88')).toBe('SGST')
  })
})

describe('retired codes', () => {
  it('still resolve, because documents carrying them already exist', () => {
    expect(jurisdictionName('28')).toBe('Andhra Pradesh (before bifurcation)')
    expect(jurisdictionName('25')).toBe('Daman and Diu')
    expect(isKnownJurisdictionCode('28')).toBe(true)
  })

  it('are marked, so nothing offers them as a choice', () => {
    expect(findJurisdiction('28')?.status).toBe('superseded')
    expect(findJurisdiction('25')?.status).toBe('superseded')
    expect(findJurisdiction('37')?.status).toBe('current')
  })
})

describe('jurisdictions() — what a picker shows', () => {
  const pickable = jurisdictions()

  it('offers the 36 codes that can be chosen today', () => {
    /* 38 codes issued, less 25 and 28 which are retired, less 97 and 99 which are
     * registration artefacts rather than places. */
    expect(pickable).toHaveLength(36)
  })

  it('excludes retired codes and the two non-places', () => {
    const codes = pickable.map((entry) => entry.code)
    expect(codes).not.toContain('25')
    expect(codes).not.toContain('28')
    expect(codes).not.toContain('97')
    expect(codes).not.toContain('99')
    expect(codes).toContain('26')
    expect(codes).toContain('37')
  })

  it('gives a picker only what a picker needs', () => {
    for (const entry of pickable) {
      expect(Object.keys(entry).sort()).toEqual(['code', 'name'])
    }
  })

  it('is in code order', () => {
    const codes = pickable.map((entry) => entry.code)
    expect([...codes].sort()).toEqual(codes)
  })
})
