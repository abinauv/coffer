import { describe, expect, it } from 'vitest'
import { inGstRegime } from './in-gst'
import { availableRegimes, DEFAULT_REGIME_ID, findRegime, getRegime, isRegimeId } from './index'

describe('the registry', () => {
  it('resolves India by its ISO country code', () => {
    expect(getRegime('in')).toBe(inGstRegime)
    expect(findRegime('in')).toBe(inGstRegime)
    expect(isRegimeId('in')).toBe(true)
  })

  it('defaults to the one regime that exists', () => {
    expect(DEFAULT_REGIME_ID).toBe('in')
    expect(findRegime(DEFAULT_REGIME_ID)).toBeDefined()
  })

  it('lists what is installed, for a picker', () => {
    expect(availableRegimes()).toEqual([{ id: 'in', label: 'India — GST' }])
  })

  it('returns undefined for an id it does not know, rather than throwing', () => {
    /* The id comes off disk when a company is opened. A downgrade or a hand-edited file
     * is a real situation, and the caller needs to handle it rather than catch it. */
    expect(findRegime('gb')).toBeUndefined()
    expect(isRegimeId('gb')).toBe(false)
  })

  it('throws from getRegime, naming what is installed', () => {
    expect(() => getRegime('gb')).toThrow(/No tax regime 'gb'/)
    expect(() => getRegime('gb')).toThrow(/Installed regimes: in/)
  })

  it('re-exports the contract, so nothing has to import two paths to use a regime', () => {
    const regime = getRegime('in')
    expect(regime.classification.code).toBe('HSN')
    expect(regime.fiscalYear.id).toBe('april-march')
    expect(regime.numberFormat.currencyCode).toBe('INR')
  })

  it('hands out the same instance every time', () => {
    /* A regime is stateless data plus pure functions; rebuilding one per call would be
     * waste, and identity is what lets a caller cache against it. */
    expect(getRegime('in')).toBe(getRegime('in'))
  })

  it('every registered regime answers to the id it is registered under', () => {
    for (const entry of availableRegimes()) {
      expect(getRegime(entry.id).id).toBe(entry.id)
    }
  })
})
