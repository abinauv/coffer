import { describe, expect, it } from 'vitest'
import { isDecimalString } from '@main/domain/money'
import {
  classificationKindOf,
  defaultRateFor,
  findClassification,
  HSN_LENGTHS,
  indiaClassification,
  normaliseClassificationCode,
  rateSlabs,
  SAC_LENGTH,
  searchClassification,
  validateClassificationCode,
} from './classification'
import { BUNDLED_COMPLIANCE_PACK } from './compliance-pack'

describe('validateClassificationCode — accepted', () => {
  const accepted = [
    ['8471', 'a four-digit HSN heading'],
    ['847130', 'six digits — the subheading'],
    ['84713010', 'eight digits — the full tariff item'],
    ['0401', 'a leading zero is part of the code, not padding'],
    ['996511', 'a SAC'],
    ['999999', 'the top of chapter 99'],
    ['8471.30', 'dots are how the tariff prints it'],
    [' 8471 ', 'surrounding space'],
  ] as const

  for (const [code, why] of accepted) {
    it(`${JSON.stringify(code)} — ${why}`, () => {
      const result = validateClassificationCode(code)
      expect(result.isValid).toBe(true)
      expect(result.message).toBeNull()
    })
  }
})

describe('validateClassificationCode — rejected, with the reason', () => {
  const rejected = [
    ['', 'Enter an HSN or SAC code.', 'empty'],
    [
      '847',
      'An HSN code is 4, 6 or 8 digits and a service code is 6. This one has 3.',
      'too short',
    ],
    [
      '84713',
      'An HSN code is 4, 6 or 8 digits and a service code is 6. This one has 5.',
      'five digits is a truncated code, not a shorter one',
    ],
    [
      '8471301',
      'An HSN code is 4, 6 or 8 digits and a service code is 6. This one has 7.',
      'seven, likewise',
    ],
    [
      '847130101',
      'An HSN code is 4, 6 or 8 digits and a service code is 6. This one has 9.',
      'nine digits',
    ],
  ] as const

  for (const [code, message, why] of rejected) {
    it(`${JSON.stringify(code)} — ${why}`, () => {
      const result = validateClassificationCode(code)
      expect(result.isValid).toBe(false)
      expect(result.message).toBe(message)
    })
  }

  it('rejects anything that is not digits', () => {
    expect(validateClassificationCode('ABCD').message).toBe(
      "An HSN or SAC code is digits only. This one is 'ABCD'.",
    )
    expect(validateClassificationCode('84A1').isValid).toBe(false)
    expect(validateClassificationCode('-8471').isValid).toBe(false)
  })

  it('rejects a chapter-99 code that is not six digits', () => {
    /* 99 is services, and a service code is always six digits. A four- or eight-digit
     * code starting 99 is a typo, not a coarser or finer service code. */
    expect(validateClassificationCode('9965').message).toBe(
      'A code starting 99 is a service code, which is always 6 digits. This one has 4.',
    )
    expect(validateClassificationCode('99651100').isValid).toBe(false)
  })
})

describe('classificationKindOf', () => {
  it('reads six digits starting 99 as a service code', () => {
    expect(classificationKindOf('996511')).toBe('SAC')
    expect(classificationKindOf('998313')).toBe('SAC')
  })

  it('reads everything else valid as goods', () => {
    expect(classificationKindOf('8471')).toBe('HSN')
    expect(classificationKindOf('847130')).toBe('HSN')
    expect(classificationKindOf('84713010')).toBe('HSN')
  })

  it('is null when the code is not valid at all', () => {
    expect(classificationKindOf('9965')).toBeNull()
    expect(classificationKindOf('ABCDEF')).toBeNull()
  })
})

describe('normaliseClassificationCode', () => {
  it('drops the spaces and dots people read a code aloud with', () => {
    expect(normaliseClassificationCode(' 8471.30.10 ')).toBe('84713010')
    expect(normaliseClassificationCode('9965 11')).toBe('996511')
  })
})

describe('the scheme the regime exposes', () => {
  it('presents HSN and SAC as one field, because a line has one code', () => {
    expect(indiaClassification.code).toBe('HSN')
    expect(indiaClassification.label).toBe('HSN / SAC')
    expect(indiaClassification.validLengths).toEqual([4, 6, 8])
    expect(SAC_LENGTH).toBe(6)
    expect(HSN_LENGTHS).toEqual([4, 6, 8])
  })

  it('hands out a copy of validLengths, not the regime’s own array', () => {
    /* The contract's array is mutable; a caller must not be able to reach through it. */
    expect(indiaClassification.validLengths).not.toBe(HSN_LENGTHS)
  })

  it('validates through the same function as everything else', () => {
    expect(indiaClassification.validate('8471').isValid).toBe(true)
    expect(indiaClassification.validate('84713').isValid).toBe(false)
  })
})

describe('the bundled seed data', () => {
  it('carries a pack version and an effective date', () => {
    expect(BUNDLED_COMPLIANCE_PACK.packVersion).toBe('2026.04.0')
    expect(BUNDLED_COMPLIANCE_PACK.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('holds codes that all validate under this regime’s own rules', () => {
    for (const entry of BUNDLED_COMPLIANCE_PACK.classificationCodes) {
      expect(validateClassificationCode(entry.code).isValid, entry.code).toBe(true)
      expect(classificationKindOf(entry.code), entry.code).toBe(entry.kind)
    }
  })

  it('has no duplicate codes', () => {
    const codes = BUNDLED_COMPLIANCE_PACK.classificationCodes.map((entry) => entry.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('states every rate as a decimal string that is one of the slabs', () => {
    const slabs = new Set(rateSlabs())
    for (const entry of BUNDLED_COMPLIANCE_PACK.classificationCodes) {
      expect(isDecimalString(entry.defaultRatePct), entry.code).toBe(true)
      expect(slabs.has(entry.defaultRatePct), `${entry.code} @ ${entry.defaultRatePct}`).toBe(true)
    }
  })

  it('offers the rate slabs as decimal strings', () => {
    expect(rateSlabs()).toEqual(['0', '0.25', '1.5', '3', '5', '12', '18', '28', '40'])
  })

  it('pins a few entries, so a silent edit to a rate fails here', () => {
    expect(defaultRateFor('8471')).toBe('18')
    expect(defaultRateFor('7113')).toBe('3')
    expect(defaultRateFor('4901')).toBe('0')
    expect(defaultRateFor('996511')).toBe('5')
    expect(defaultRateFor('998314')).toBe('18')
  })

  it('is null for a code the pack does not carry', () => {
    expect(defaultRateFor('1234')).toBeNull()
    expect(findClassification('1234')).toBeNull()
  })

  it('describes what a code is', () => {
    expect(findClassification('8471')?.description).toContain('data processing')
    expect(findClassification(' 8471 ')?.code).toBe('8471')
  })
})

describe('searchClassification', () => {
  it('matches a code prefix', () => {
    expect(searchClassification('84').map((entry) => entry.code)).toEqual(['8415', '8471'])
  })

  it('matches a word in the description, case-insensitively', () => {
    const hits = searchClassification('Information Technology')
    expect(hits.map((entry) => entry.code)).toEqual(['998313', '998314'])
  })

  it('returns everything for an empty term', () => {
    expect(searchClassification('  ')).toHaveLength(
      BUNDLED_COMPLIANCE_PACK.classificationCodes.length,
    )
  })

  it('returns nothing when nothing matches', () => {
    expect(searchClassification('zzzz')).toEqual([])
  })
})

describe('a pack other than the bundled one', () => {
  it('is what every lookup reads from, so Phase 5 can swap it without touching this code', () => {
    const pack = {
      ...BUNDLED_COMPLIANCE_PACK,
      packVersion: '2027.01.0',
      classificationCodes: [
        { code: '8471', kind: 'HSN' as const, description: 'Computers', defaultRatePct: '5' },
      ],
    }
    expect(defaultRateFor('8471', pack)).toBe('5')
    expect(findClassification('7113', pack)).toBeNull()
    expect(searchClassification('comp', pack)).toHaveLength(1)
    expect(rateSlabs(pack)).toEqual(rateSlabs())
  })
})
