import { describe, expect, it } from 'vitest'
import { COUNTRY_CODES, countryName, countryOptions } from './countries'

describe('COUNTRY_CODES', () => {
  it('holds every assigned ISO 3166-1 code once, in lower case', () => {
    expect(COUNTRY_CODES).toHaveLength(249)
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length)
    for (const code of COUNTRY_CODES) expect(code).toMatch(/^[a-z]{2}$/)
  })
})

describe('countryName', () => {
  it('names a code from the platform', () => {
    expect(countryName('in')).toBe('India')
    expect(countryName('PT')).toBe('Portugal')
  })

  it('gives back anything that is not two letters as it came', () => {
    expect(countryName('eu-vat')).toBe('eu-vat')
    expect(countryName('')).toBe('')
  })
})

describe('countryOptions', () => {
  it('offers every country, ordered by name, sending the code', () => {
    const options = countryOptions('in')
    expect(options).toHaveLength(249)
    expect(options.find((option) => option.code === 'in')?.label).toBe('India')
    const labels = options.map((option) => option.label)
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'en')))
  })

  /* A select whose value is not an option shows the first one, and saves it next time. */
  it('keeps a code the list does not know, first, and says so', () => {
    const [first] = countryOptions('xx')
    expect(first).toEqual({ code: 'xx', label: 'XX — not a country code' })
  })

  it('adds nothing for an empty record', () => {
    expect(countryOptions('')).toHaveLength(249)
  })
})
