import { describe, expect, it } from 'vitest'
import {
  GSTIN_LENGTH,
  gstinCheckCharacter,
  gstinJurisdictionCode,
  gstinJurisdictionName,
  normaliseGstin,
  validateGstin,
} from './gstin'
import fixture from './__fixtures__/gstin.json'

interface ValidCase {
  value: string
  normalised: string
  jurisdictionCode: string
  jurisdictionName: string
  why: string
}

interface InvalidCase {
  value: string
  message: string
  jurisdictionCode: string | null
  why: string
}

interface CheckCase {
  firstFourteen: string
  checkCharacter: string
}

const golden = fixture as unknown as {
  valid: ValidCase[]
  invalid: InvalidCase[]
  checkCharacters: CheckCase[]
}

describe('validateGstin — accepted', () => {
  for (const entry of golden.valid) {
    it(`${entry.value} — ${entry.why}`, () => {
      const result = validateGstin(entry.value)
      expect(result.isValid).toBe(true)
      expect(result.message).toBeNull()
      expect(result.derivedJurisdictionCode).toBe(entry.jurisdictionCode)
      /* The form it should be KEPT in, not the form it arrived in. Validation
       * upper-cases and strips spaces before it looks at anything, so what the caller
       * typed can differ from what is right — and what is right is what goes on the
       * invoice. */
      expect(result.normalisedValue).toBe(entry.normalised)
    })

    it(`${entry.value} normalises and resolves its state`, () => {
      expect(normaliseGstin(entry.value)).toBe(entry.normalised)
      expect(gstinJurisdictionCode(entry.value)).toBe(entry.jurisdictionCode)
      expect(gstinJurisdictionName(entry.value)).toBe(entry.jurisdictionName)
    })
  }
})

describe('validateGstin — rejected, with the reason the user needs', () => {
  for (const entry of golden.invalid) {
    it(`${JSON.stringify(entry.value)} — ${entry.why}`, () => {
      const result = validateGstin(entry.value)
      expect(result.isValid).toBe(false)
      expect(result.message).toBe(entry.message)
      /* Nothing to keep. A number that is wrong has no canonical form, and offering one
       * would invite a caller to store it anyway. */
      expect(result.normalisedValue).toBeNull()
      expect(result.derivedJurisdictionCode ?? null).toBe(entry.jurisdictionCode)
    })
  }

  it('every rejection says something specific', () => {
    for (const entry of golden.invalid) {
      const message = validateGstin(entry.value).message ?? ''
      /* A finished sentence, and never one of the non-messages CONVENTIONS §5 rules out. */
      expect(message).toMatch(/\.$/)
      expect(message).not.toMatch(/invalid|malformed|error|Something went wrong/i)
    }
  })

  it('covers every structural position', () => {
    /* One failure mode per position, plus length, unknown state and checksum. If a
     * position stops being checked its case disappears, and this count drops. */
    expect(golden.invalid.length).toBeGreaterThanOrEqual(18)
  })
})

describe('gstinCheckCharacter', () => {
  for (const entry of golden.checkCharacters) {
    it(`${entry.firstFourteen} checks to ${entry.checkCharacter}`, () => {
      expect(gstinCheckCharacter(entry.firstFourteen)).toBe(entry.checkCharacter)
    })
  }

  it('catches every single-character substitution in a valid GSTIN', () => {
    /* The property the algorithm is chosen for. Change any one character of a valid
     * GSTIN, and either the structure check or the checksum must reject it. */
    const valid = '33AABCC1234D1ZI'
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    let checked = 0

    for (let position = 0; position < GSTIN_LENGTH; position += 1) {
      for (const replacement of alphabet) {
        if (valid.charAt(position) === replacement) {
          continue
        }
        const mutated = valid.slice(0, position) + replacement + valid.slice(position + 1)
        expect(validateGstin(mutated).isValid, `${mutated} should not validate`).toBe(false)
        checked += 1
      }
    }

    expect(checked).toBe(GSTIN_LENGTH * 35)
  })

  it('refuses to compute over the wrong number of characters', () => {
    expect(() => gstinCheckCharacter('33AABCC1234D1')).toThrow()
    expect(() => gstinCheckCharacter('33AABCC1234D1ZI')).toThrow()
  })

  it('refuses a character outside the base-36 alphabet', () => {
    expect(() => gstinCheckCharacter('33AABCC1234D1-')).toThrow()
  })
})

describe('gstinJurisdictionCode', () => {
  it('is null when the leading digits are not a state code', () => {
    expect(gstinJurisdictionCode('88AABCC1234D1Z3')).toBeNull()
    expect(gstinJurisdictionCode('X')).toBeNull()
    expect(gstinJurisdictionCode('')).toBeNull()
  })

  it('reads a state code from a partial GSTIN, which is what live typing gives it', () => {
    expect(gstinJurisdictionCode('33AAB')).toBe('33')
    expect(gstinJurisdictionName('33')).toBe('Tamil Nadu')
  })
})
