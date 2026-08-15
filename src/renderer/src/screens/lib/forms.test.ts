import { describe, expect, it } from 'vitest'
import type { PassphraseStrength } from '@shared/dto'
import {
  needsWeakConfirmation,
  validateChangePassphrase,
  validateCreate,
  validateRecover,
  validateRename,
  validateRestore,
  validateUnlock,
} from './forms'

function strength(score: PassphraseStrength['score'], isWeak: boolean): PassphraseStrength {
  return { score, label: 'Weak', suggestion: 'Make it longer.', isWeak }
}

const VALID_CODE = 'A1B2C-3D4E5-F6G7H-8J9K0'

describe('validateCreate', () => {
  const complete = {
    displayName: 'Acme Traders',
    directoryPath: 'D:\\books',
    passphrase: 'correct horse battery staple',
    confirmation: 'correct horse battery staple',
  }

  it('accepts a complete form', () => {
    const state = validateCreate(complete)
    expect(state.canSubmit).toBe(true)
    expect(state.errors).toEqual({})
  })

  it('asks for each missing piece by name', () => {
    const state = validateCreate({
      displayName: '   ',
      directoryPath: '',
      passphrase: '',
      confirmation: '',
    })
    expect(state.canSubmit).toBe(false)
    expect(state.errors.displayName).toBeDefined()
    expect(state.errors.directoryPath).toBeDefined()
    expect(state.errors.passphrase).toBeDefined()
  })

  it('holds the mismatch message until the second field has been used', () => {
    const typing = { ...complete, confirmation: 'corr' }
    expect(validateCreate(typing, false).errors.confirmation).toBeUndefined()
    expect(validateCreate(typing, true).errors.confirmation).toBeDefined()
    expect(validateCreate(typing, false).canSubmit).toBe(false)
  })

  /*
   * The rule this batch exists to protect. There is no key escrow (ARCHITECTURE
   * §6.3.1), so a weak passphrase is warned about and never refused.
   */
  it('submits a passphrase of any strength at all', () => {
    const weak = { ...complete, passphrase: 'a', confirmation: 'a' }
    expect(validateCreate(weak).canSubmit).toBe(true)
    expect(validateCreate(weak).errors.passphrase).toBeUndefined()
  })
})

describe('needsWeakConfirmation', () => {
  it('interrupts once for a weak passphrase', () => {
    expect(needsWeakConfirmation(strength(0, true), false)).toBe(true)
  })

  it('does not interrupt twice', () => {
    expect(needsWeakConfirmation(strength(0, true), true)).toBe(false)
  })

  it('does not interrupt for a strong one', () => {
    expect(needsWeakConfirmation(strength(4, false), false)).toBe(false)
  })

  it('does not interrupt before the meter has answered', () => {
    expect(needsWeakConfirmation(null, false)).toBe(false)
  })
})

describe('validateUnlock', () => {
  it('needs a passphrase and nothing else', () => {
    expect(validateUnlock('').canSubmit).toBe(false)
    expect(validateUnlock('').errors.passphrase).toBeDefined()
    expect(validateUnlock(' ').canSubmit).toBe(true)
  })
})

describe('validateRecover', () => {
  const complete = {
    recoveryCode: VALID_CODE,
    newPassphrase: 'a new passphrase entirely',
    confirmation: 'a new passphrase entirely',
  }

  it('accepts a well-formed code and a matching new passphrase', () => {
    expect(validateRecover(complete).canSubmit).toBe(true)
  })

  it('explains the shape of a code rather than just rejecting it', () => {
    const state = validateRecover({ ...complete, recoveryCode: 'A1B2C' })
    expect(state.canSubmit).toBe(false)
    expect(state.errors.recoveryCode).toContain('20 characters')
  })

  it('asks for a code before complaining about its shape', () => {
    expect(validateRecover({ ...complete, recoveryCode: '' }).errors.recoveryCode).toContain(
      'from your sheet',
    )
  })

  it('requires the new passphrase twice', () => {
    const state = validateRecover({ ...complete, confirmation: 'something else' })
    expect(state.canSubmit).toBe(false)
    expect(state.errors.confirmation).toBeDefined()
  })

  it('never judges the strength of the new passphrase', () => {
    expect(validateRecover({ ...complete, newPassphrase: 'x', confirmation: 'x' }).canSubmit).toBe(
      true,
    )
  })
})

describe('validateChangePassphrase', () => {
  const complete = {
    currentPassphrase: 'the old one',
    newPassphrase: 'the new one',
    confirmation: 'the new one',
  }

  it('accepts a complete form', () => {
    expect(validateChangePassphrase(complete).canSubmit).toBe(true)
  })

  it('refuses to change a passphrase into itself', () => {
    const state = validateChangePassphrase({
      currentPassphrase: 'same',
      newPassphrase: 'same',
      confirmation: 'same',
    })
    expect(state.canSubmit).toBe(false)
    expect(state.errors.newPassphrase).toContain('already use')
  })

  it('needs the current passphrase', () => {
    const state = validateChangePassphrase({ ...complete, currentPassphrase: '' })
    expect(state.canSubmit).toBe(false)
    expect(state.errors.currentPassphrase).toBeDefined()
  })
})

describe('validateRename', () => {
  it('needs a name that is actually different', () => {
    expect(validateRename('Acme Traders', 'Acme Traders').canSubmit).toBe(false)
    expect(validateRename('  ', 'Acme').canSubmit).toBe(false)
    expect(validateRename('Acme Trading Co', 'Acme').canSubmit).toBe(true)
  })
})

describe('validateRestore', () => {
  it('needs both the archive and somewhere to put it', () => {
    expect(validateRestore({ archivePath: '', directoryPath: '' }).canSubmit).toBe(false)
    expect(
      validateRestore({ archivePath: 'D:\\a.coffer-backup.zip', directoryPath: '' }).errors
        .directoryPath,
    ).toContain('empty folder')
    expect(
      validateRestore({ archivePath: 'D:\\a.coffer-backup.zip', directoryPath: 'D:\\out' })
        .canSubmit,
    ).toBe(true)
  })
})
