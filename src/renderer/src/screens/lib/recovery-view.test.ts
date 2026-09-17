import { describe, expect, it } from 'vitest'
import { RECOVERY_CODE_SET_SIZE, isRecoveryLow, recoveryView } from './recovery-view'

describe('the meter', () => {
  it('fills one segment per unspent code', () => {
    const view = recoveryView(3)

    expect(view.remaining).toBe(3)
    expect(view.issued).toBe(RECOVERY_CODE_SET_SIZE)
    expect(view.spent).toBe(2)
    expect(view.valueText).toBe('3 of 5 unused')
  })

  it('draws an empty bar rather than none when every code is spent', () => {
    const view = recoveryView(0)

    expect(view.issued).toBe(RECOVERY_CODE_SET_SIZE)
    expect(view.spent).toBe(RECOVERY_CODE_SET_SIZE)
    expect(view.valueText).toBe('0 of 5 unused')
  })

  /* A vault with more codes than this build issues is not a reason to draw a broken bar. */
  it('grows the bar rather than overflowing it when a vault holds more', () => {
    const view = recoveryView(8)

    expect(view.issued).toBe(8)
    expect(view.spent).toBe(0)
    expect(view.valueText).toBe('8 of 8 unused')
  })

  it('survives a count that could not be true', () => {
    expect(recoveryView(-4).remaining).toBe(0)
    expect(recoveryView(Number.NaN).remaining).toBe(0)
    expect(recoveryView(2.7).remaining).toBe(2)
  })
})

describe('the tone', () => {
  it('turns at two left, and again at none', () => {
    expect(recoveryView(5).tone).toBe('positive')
    expect(recoveryView(3).tone).toBe('positive')
    expect(recoveryView(2).tone).toBe('warning')
    expect(recoveryView(1).tone).toBe('warning')
    expect(recoveryView(0).tone).toBe('negative')
  })
})

describe('what the line says', () => {
  it('says the passphrase is the only way in, and that a new set is still possible', () => {
    const line = recoveryView(0).line

    expect(line).toContain('passphrase is now the only way')
    expect(line).toContain('issue a new set')
  })

  it('counts the spent ones once any have been used', () => {
    expect(recoveryView(4).line).toContain('1 has been used')
    expect(recoveryView(3).line).toContain('2 have been used')
  })

  /* A full set is the state the user was left in. Congratulating them on it is noise. */
  it('says what a full set is for rather than praising it', () => {
    const line = recoveryView(5).line

    expect(line).toContain('All 5 are unused')
    expect(line).not.toMatch(/safe|good|well done/i)
  })

  it('does not tell somebody with one code left to cross anything off', () => {
    expect(recoveryView(1).line).toBe(
      'One code is left. It opens these books once, and then the passphrase is the only way in.',
    )
  })
})

describe('when the Overview should mention them', () => {
  it('stays quiet above two, so the list is not permanent furniture', () => {
    expect(isRecoveryLow(5)).toBe(false)
    expect(isRecoveryLow(3)).toBe(false)
    expect(isRecoveryLow(2)).toBe(true)
    expect(isRecoveryLow(0)).toBe(true)
  })
})
