import { describe, expect, it } from 'vitest'
import {
  applyDensityPreference,
  DENSITY_LABELS,
  DENSITY_PREFERENCES,
  DENSITY_STORAGE_KEY,
  densityAttribute,
  parseDensityPreference,
  type DensityTarget,
} from './density'

function target(): DensityTarget & { attributes: Map<string, string> } {
  const attributes = new Map<string, string>()
  return {
    attributes,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
  }
}

describe('parseDensityPreference', () => {
  it('reads the two preferences back', () => {
    expect(parseDensityPreference('comfortable')).toBe('comfortable')
    expect(parseDensityPreference('compact')).toBe('compact')
  })

  /* A corrupt or future value must not shrink the interface on somebody who never asked. */
  it('falls back to comfortable for anything it does not recognise', () => {
    for (const value of [null, undefined, '', 'Compact', 'dense', 42, {}]) {
      expect(parseDensityPreference(value)).toBe('comfortable')
    }
  })
})

describe('the attribute', () => {
  /* The bare :root block in tokens.css IS comfortable. Writing `data-density="comfortable"`
   * would match no rule, so the attribute is removed instead — the same shape as theme. */
  it('names compact and removes itself for comfortable', () => {
    expect(densityAttribute('compact')).toBe('compact')
    expect(densityAttribute('comfortable')).toBeNull()
  })

  it('writes compact onto the element, and takes it off again', () => {
    const element = target()

    applyDensityPreference(element, 'compact')
    expect(element.attributes.get('data-density')).toBe('compact')

    applyDensityPreference(element, 'comfortable')
    expect(element.attributes.has('data-density')).toBe(false)
  })
})

describe('the vocabulary', () => {
  it('stores under its own key, beside the theme', () => {
    expect(DENSITY_STORAGE_KEY).toBe('coffer.density')
  })

  it('labels every preference it offers', () => {
    for (const preference of DENSITY_PREFERENCES) {
      expect(DENSITY_LABELS[preference]).not.toBe('')
    }
  })
})
