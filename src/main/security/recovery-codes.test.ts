import { describe, expect, it } from 'vitest'

import {
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_ENTROPY_BITS,
  RECOVERY_CODE_LENGTH,
  formatRecoveryCode,
  generateRecoveryCode,
  generateRecoveryCodes,
  isRecoveryCodeWellFormed,
  normalizeRecoveryCode,
  recoveryCodeSecret,
} from './recovery-codes'

describe('the alphabet', () => {
  it('has exactly 32 symbols, so a random byte maps onto it without bias', () => {
    expect(RECOVERY_CODE_ALPHABET).toHaveLength(32)
    expect(new Set(RECOVERY_CODE_ALPHABET).size).toBe(32)
  })

  /* These four are the whole reason for choosing Crockford's alphabet. Someone reading
   * their own handwriting back cannot tell 1 from I or l, or 0 from O. */
  it.each(['I', 'L', 'O', 'U'])('leaves out the confusable letter %s', (letter) => {
    expect(RECOVERY_CODE_ALPHABET).not.toContain(letter)
  })

  it('states the entropy the length actually delivers', () => {
    expect(RECOVERY_CODE_ENTROPY_BITS).toBe(RECOVERY_CODE_LENGTH * 5)
    expect(RECOVERY_CODE_ENTROPY_BITS).toBeGreaterThanOrEqual(100)
  })
})

describe('generateRecoveryCode', () => {
  it('is 20 symbols printed as four groups of five', () => {
    const code = generateRecoveryCode()
    expect(code).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/)
    expect(code.replace(/-/g, '')).toHaveLength(RECOVERY_CODE_LENGTH)
  })

  it('only ever uses symbols from the alphabet', () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      for (const symbol of generateRecoveryCode().replace(/-/g, '')) {
        expect(RECOVERY_CODE_ALPHABET).toContain(symbol)
      }
    }
  })

  it('does not repeat itself', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateRecoveryCode()))
    expect(codes.size).toBe(500)
  })

  /* A masking bug that dropped part of the alphabet would still produce codes that look
   * fine. Over 400 codes — 8000 symbols — every one of the 32 symbols should appear. */
  it('reaches the whole alphabet', () => {
    const seen = new Set<string>()
    for (let attempt = 0; attempt < 400; attempt++) {
      for (const symbol of generateRecoveryCode().replace(/-/g, '')) {
        seen.add(symbol)
      }
    }
    expect(seen.size).toBe(32)
  })
})

describe('generateRecoveryCodes', () => {
  it('issues five by default', () => {
    expect(generateRecoveryCodes()).toHaveLength(RECOVERY_CODE_COUNT)
  })

  it('issues distinct codes', () => {
    expect(new Set(generateRecoveryCodes(20)).size).toBe(20)
  })

  it.each([0, -1, 1.5, 33])('rejects a count of %s', (count) => {
    expect(() => generateRecoveryCodes(count)).toThrow(
      expect.objectContaining({ code: 'KEY_MATERIAL_INVALID' }),
    )
  })
})

describe('normalizeRecoveryCode', () => {
  const code = generateRecoveryCode()
  const bare = code.replace(/-/g, '')

  it('leaves a freshly generated code alone but for the hyphens', () => {
    expect(normalizeRecoveryCode(code)).toBe(bare)
  })

  it('accepts lower case', () => {
    expect(normalizeRecoveryCode(code.toLowerCase())).toBe(bare)
  })

  it('accepts spaces, tabs and newlines wherever they land', () => {
    expect(normalizeRecoveryCode(` ${code.split('').join(' ')} \n`)).toBe(bare)
  })

  it('accepts a code with no separators at all', () => {
    expect(normalizeRecoveryCode(bare)).toBe(bare)
  })

  it('accepts separators in the wrong places', () => {
    expect(normalizeRecoveryCode(`${bare.slice(0, 3)}-${bare.slice(3)}`)).toBe(bare)
  })

  /* The repair rules. Someone transcribing by hand writes what they think they see. */
  it.each([
    ['O', '0'],
    ['o', '0'],
    ['I', '1'],
    ['i', '1'],
    ['L', '1'],
    ['l', '1'],
  ])('reads a written %s as %s', (written, meant) => {
    const typed = `${written}${'2'.repeat(19)}`
    expect(normalizeRecoveryCode(typed)).toBe(`${meant}${'2'.repeat(19)}`)
  })

  it.each([
    ['too short', '2'.repeat(19)],
    ['too long', '2'.repeat(21)],
    ['empty', ''],
    ['only separators', '----'],
    ['containing U, which is not in the alphabet', `U${'2'.repeat(19)}`],
    ['containing punctuation', `${'2'.repeat(19)}!`],
    ['containing an accented letter', `É${'2'.repeat(19)}`],
  ])('rejects a code that is %s', (_label, value) => {
    expect(() => normalizeRecoveryCode(value)).toThrow(
      expect.objectContaining({ code: 'RECOVERY_CODE_MALFORMED' }),
    )
    expect(isRecoveryCodeWellFormed(value)).toBe(false)
  })

  it('never repeats the code back in the error it throws', () => {
    const secretLookingCode = 'ABCDE-FGHJK-MNPQR-STVW!'
    try {
      normalizeRecoveryCode(secretLookingCode)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as Error).message).not.toContain('ABCDE')
    }
  })
})

describe('formatRecoveryCode', () => {
  it('is the inverse of stripping the hyphens', () => {
    const code = generateRecoveryCode()
    expect(formatRecoveryCode(code.replace(/-/g, ''))).toBe(code)
  })
})

describe('recoveryCodeSecret', () => {
  it('is the canonical form as bytes', () => {
    const code = generateRecoveryCode()
    expect(recoveryCodeSecret(code).toString('ascii')).toBe(code.replace(/-/g, ''))
  })

  it('is identical however the user typed it', () => {
    const code = generateRecoveryCode()
    const typedCarelessly = ` ${code.toLowerCase().replace(/-/g, ' ')} `
    expect(recoveryCodeSecret(code).equals(recoveryCodeSecret(typedCarelessly))).toBe(true)
  })

  it('differs between two codes', () => {
    expect(
      recoveryCodeSecret(generateRecoveryCode()).equals(recoveryCodeSecret(generateRecoveryCode())),
    ).toBe(false)
  })
})
