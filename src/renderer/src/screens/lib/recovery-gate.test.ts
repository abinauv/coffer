import { describe, expect, it } from 'vitest'
import {
  challengeIndex,
  CODE_LENGTH,
  gateHint,
  gateState,
  isWellFormedCode,
  matchesCode,
  normalizeCode,
} from './recovery-gate'

const CODES = ['A1B2C-3D4E5-F6G7H-8J9K0', 'ZYXWV-TSRQP-NMKJH-GFEDC', 'M4NPQ-R5STV-W6XYZ-01234']

describe('normalizeCode', () => {
  it('ignores case, hyphens and spaces', () => {
    expect(normalizeCode('a1b2c-3d4e5 f6g7h 8j9k0')).toBe('A1B2C3D4E5F6G7H8J9K0')
  })

  it('repairs the characters people mis-copy by hand', () => {
    /* O is a zero, I and L are ones — the same repairs the vault makes. */
    expect(normalizeCode('OIL')).toBe('011')
  })

  it('keeps characters outside the alphabet so they can be rejected', () => {
    expect(normalizeCode('U')).toBe('U')
  })
})

describe('isWellFormedCode', () => {
  it('accepts a printed code', () => {
    expect(isWellFormedCode(CODES[0] ?? '')).toBe(true)
  })

  it('accepts one typed without the hyphens', () => {
    expect(isWellFormedCode('a1b2c3d4e5f6g7h8j9k0')).toBe(true)
  })

  it('rejects a code of the wrong length', () => {
    expect(isWellFormedCode('A1B2C-3D4E5')).toBe(false)
    expect(isWellFormedCode(`${'A'.repeat(CODE_LENGTH)}A`)).toBe(false)
  })

  it('rejects a character that is not in the alphabet', () => {
    expect(isWellFormedCode('U1B2C3D4E5F6G7H8J9K0')).toBe(false)
  })
})

describe('matchesCode', () => {
  it('matches regardless of how it was typed', () => {
    expect(matchesCode('A1B2C-3D4E5-F6G7H-8J9K0', ' a1b2c3d4e5 f6g7h8j9k0 ')).toBe(true)
  })

  it('does not match a different code', () => {
    expect(matchesCode(CODES[0] ?? '', CODES[1] ?? '')).toBe(false)
  })

  it('never matches when there is nothing to match against', () => {
    expect(matchesCode('', '')).toBe(false)
  })
})

describe('challengeIndex', () => {
  it('stays inside the set', () => {
    for (const fraction of [0, 0.25, 0.5, 0.75, 0.999999, 1, Number.NaN]) {
      const index = challengeIndex(5, fraction)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(5)
    }
  })

  it('picks a different code for different draws', () => {
    expect(challengeIndex(5, 0)).toBe(0)
    expect(challengeIndex(5, 0.9)).toBe(4)
  })
})

describe('gateState', () => {
  const base = { codes: CODES, challenge: 1, typed: '', hasAcknowledged: false }

  it('holds the user until they type the code we asked for', () => {
    expect(gateState(base)).toEqual({ canContinue: false, blockedBy: 'code-missing' })
  })

  it('says so when the wrong code is typed', () => {
    expect(gateState({ ...base, typed: CODES[0] ?? '' }).blockedBy).toBe('code-mismatch')
  })

  it('is not satisfied by the checkbox alone', () => {
    expect(gateState({ ...base, hasAcknowledged: true }).canContinue).toBe(false)
  })

  it('is not satisfied by the code alone either', () => {
    const state = gateState({ ...base, typed: CODES[1] ?? '' })
    expect(state.canContinue).toBe(false)
    expect(state.blockedBy).toBe('acknowledgement')
  })

  it('opens once the right code is back and the box is ticked', () => {
    const state = gateState({ ...base, typed: 'zyxwv tsrqp nmkjh gfedc', hasAcknowledged: true })
    expect(state).toEqual({ canContinue: true, blockedBy: null })
  })

  it('cannot be passed by asking for a code that is not there', () => {
    const state = gateState({ ...base, challenge: 99, typed: '', hasAcknowledged: true })
    expect(state.canContinue).toBe(false)
  })
})

describe('gateHint', () => {
  it('names the code being asked for', () => {
    expect(gateHint({ canContinue: false, blockedBy: 'code-missing' }, 2)).toContain('code 2')
    expect(gateHint({ canContinue: false, blockedBy: 'code-mismatch' }, 2)).toContain('code 2')
  })

  it('points at the box when only the box is left', () => {
    expect(gateHint({ canContinue: false, blockedBy: 'acknowledgement' }, 1)).toContain('box')
  })

  it('warns that this is the last time the codes are shown', () => {
    expect(gateHint({ canContinue: true, blockedBy: null }, 1)).toContain('not be shown again')
  })
})
