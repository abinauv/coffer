import { describe, expect, it } from 'vitest'
import type { TaxParty } from '@main/regimes/types'
import { INDIA_COUNTRY_CODE, jurisdictionOf, placeOfSupply } from './place-of-supply'

const tamilNadu: TaxParty = {
  registrationNumber: '33AABCC1234D1ZI',
  jurisdictionCode: '33',
  countryCode: 'in',
}

const karnataka: TaxParty = {
  registrationNumber: '29AAAAA0000A1ZY',
  jurisdictionCode: '29',
  countryCode: 'in',
}

describe('placeOfSupply — inside India', () => {
  it('is intra-jurisdiction when the two states match', () => {
    const place = placeOfSupply(tamilNadu, { ...tamilNadu, registrationNumber: null })
    expect(place).toEqual({
      jurisdictionCode: '33',
      countryCode: 'in',
      isIntraJurisdiction: true,
      isExport: false,
    })
  })

  it('is inter-jurisdiction when they differ, and reports the customer’s state', () => {
    const place = placeOfSupply(tamilNadu, karnataka)
    expect(place).toEqual({
      jurisdictionCode: '29',
      countryCode: 'in',
      isIntraJurisdiction: false,
      isExport: false,
    })
  })

  it('is symmetric in the sense that matters: the split does not depend on direction', () => {
    expect(placeOfSupply(tamilNadu, karnataka).isIntraJurisdiction).toBe(
      placeOfSupply(karnataka, tamilNadu).isIntraJurisdiction,
    )
  })
})

describe('placeOfSupply — where the state comes from', () => {
  it('takes the explicit jurisdiction code first', () => {
    /* A party can be registered in one state and supplied in another; the explicit code
     * is the one a user can see and correct, so it wins over the GSTIN. */
    const customer: TaxParty = {
      registrationNumber: '29AAAAA0000A1ZY',
      jurisdictionCode: '33',
      countryCode: 'in',
    }
    expect(jurisdictionOf(customer)).toBe('33')
    expect(placeOfSupply(tamilNadu, customer).isIntraJurisdiction).toBe(true)
  })

  it('falls back to the state code inside the GSTIN', () => {
    const customer: TaxParty = {
      registrationNumber: '33AABCC1234E1ZG',
      jurisdictionCode: null,
      countryCode: 'in',
    }
    expect(jurisdictionOf(customer)).toBe('33')
    expect(placeOfSupply(tamilNadu, customer).isIntraJurisdiction).toBe(true)
  })

  it('treats a blank jurisdiction code as absent', () => {
    const customer: TaxParty = {
      registrationNumber: '33AABCC1234E1ZG',
      jurisdictionCode: '   ',
      countryCode: 'in',
    }
    expect(jurisdictionOf(customer)).toBe('33')
  })

  it('is null when there is neither a code nor a readable GSTIN', () => {
    expect(
      jurisdictionOf({ registrationNumber: null, jurisdictionCode: null, countryCode: 'in' }),
    ).toBeNull()
    expect(
      jurisdictionOf({ registrationNumber: 'nonsense', jurisdictionCode: null, countryCode: 'in' }),
    ).toBeNull()
  })

  it('resolves to inter-state when either state is unknown', () => {
    /* Not a guess that they differ — an admission that we cannot show they match. IGST
     * charged where a state split was due is a correctable filing error; a state split
     * recorded against the wrong state is money paid to the wrong government. */
    const unknown: TaxParty = {
      registrationNumber: null,
      jurisdictionCode: null,
      countryCode: 'in',
    }
    expect(placeOfSupply(tamilNadu, unknown).isIntraJurisdiction).toBe(false)
    expect(placeOfSupply(unknown, tamilNadu).isIntraJurisdiction).toBe(false)
    expect(placeOfSupply(unknown, unknown).isIntraJurisdiction).toBe(false)
  })
})

describe('placeOfSupply — leaving India', () => {
  const overseas: TaxParty = {
    registrationNumber: null,
    jurisdictionCode: null,
    countryCode: 'ae',
  }

  it('flags an export and drops the Indian state', () => {
    expect(placeOfSupply(tamilNadu, overseas)).toEqual({
      jurisdictionCode: null,
      countryCode: 'ae',
      isIntraJurisdiction: false,
      isExport: true,
    })
  })

  it('is an export even when the customer carries an Indian state code', () => {
    /* The country decides. A stale state code left on a party that moved abroad must not
     * turn an export into a CGST/SGST pair. */
    const confused: TaxParty = {
      registrationNumber: '33AABCC1234E1ZG',
      jurisdictionCode: '33',
      countryCode: 'sg',
    }
    const place = placeOfSupply(tamilNadu, confused)
    expect(place.isExport).toBe(true)
    expect(place.isIntraJurisdiction).toBe(false)
    expect(place.jurisdictionCode).toBeNull()
  })

  it('normalises the country code’s case and padding', () => {
    expect(placeOfSupply(tamilNadu, { ...overseas, countryCode: ' AE ' }).countryCode).toBe('ae')
    expect(placeOfSupply(tamilNadu, { ...tamilNadu, countryCode: 'IN' }).isIntraJurisdiction).toBe(
      true,
    )
  })

  it('knows which country it is the regime for', () => {
    expect(INDIA_COUNTRY_CODE).toBe('in')
  })
})
