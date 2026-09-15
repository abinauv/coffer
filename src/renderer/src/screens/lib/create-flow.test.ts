import { describe, expect, it } from 'vitest'
import type { RegistrationCheck } from '@shared/dto'
import {
  CREATE_STEPS,
  companyStepHint,
  confirmationHint,
  countWord,
  currentCheck,
  registrationError,
  registrationHint,
  registrationLabel,
} from './create-flow'

const BLANK: RegistrationCheck = {
  label: 'GSTIN / UIN',
  status: 'blank',
  normalised: null,
  jurisdictionCode: null,
  jurisdictionName: null,
  message: null,
}

const VALID: RegistrationCheck = {
  ...BLANK,
  status: 'valid',
  normalised: '33AABCC1234D1ZI',
  jurisdictionCode: '33',
  jurisdictionName: 'Tamil Nadu',
}

const INVALID: RegistrationCheck = {
  ...BLANK,
  status: 'invalid',
  message: 'The check character does not match.',
}

describe('the steps', () => {
  it('are the company, the passphrase and the codes, in that order', () => {
    expect(CREATE_STEPS).toEqual(['The company', 'The passphrase', 'Recovery codes'])
  })
})

describe('which check belongs to the box', () => {
  /* The check answers a keystroke late. Its verdict about a blank box is not a verdict about
   * a number, and the other way round. */
  it('drops a blank answer once a number is typed, and a number’s once the box is cleared', () => {
    expect(currentCheck(BLANK, '33A')).toBeNull()
    expect(currentCheck(VALID, '')).toBeNull()
    expect(currentCheck(VALID, '   ')).toBeNull()
  })

  it('keeps an answer that matches what is in the box', () => {
    expect(currentCheck(BLANK, '')).toBe(BLANK)
    expect(currentCheck(INVALID, '33AABCC1234D1Z')).toBe(INVALID)
  })

  it('has nothing before the first answer', () => {
    expect(currentCheck(null, '')).toBeNull()
  })
})

describe('what the box says', () => {
  it('takes its label from the regime, and says it is optional', () => {
    expect(registrationLabel(BLANK)).toBe('GSTIN / UIN (optional)')
  })

  /* No tax word is invented before the regime has answered. */
  it('uses a neutral label until the regime has answered', () => {
    expect(registrationLabel(null)).toBe('Registration number (optional)')
  })

  it('says blank is a correct answer', () => {
    expect(registrationHint(BLANK)).toMatch(/Leave it blank/)
    expect(registrationHint(null)).toMatch(/Leave it blank/)
  })

  it('names the jurisdiction a valid number encodes', () => {
    expect(registrationHint(VALID)).toBe(
      'Registered in Tamil Nadu (33). That decides the tax on every invoice these books raise.',
    )
  })

  it('says a valid number with no jurisdiction in it is valid, and no more', () => {
    expect(registrationHint({ ...VALID, jurisdictionCode: null, jurisdictionName: null })).toMatch(
      /^A valid number/,
    )
  })

  it('shows the regime’s reason as the error, only for an invalid number', () => {
    expect(registrationError(INVALID)).toBe('The check character does not match.')
    expect(registrationError({ ...INVALID, message: null })).toMatch(/not a number/)
    expect(registrationError(VALID)).toBeUndefined()
    expect(registrationError(null)).toBeUndefined()
  })
})

describe('why a button cannot run yet', () => {
  it('names everything the company step is missing', () => {
    expect(
      companyStepHint({ displayName: ' ', directoryPath: '', isRegistrationInvalid: false }),
    ).toBe('Needs a business name and a folder')
    expect(
      companyStepHint({ displayName: 'Acme', directoryPath: '', isRegistrationInvalid: false }),
    ).toBe('Needs a folder')
  })

  it('asks for the number to be corrected or cleared', () => {
    expect(
      companyStepHint({
        displayName: 'Acme',
        directoryPath: '/books',
        isRegistrationInvalid: true,
      }),
    ).toMatch(/registration number/)
  })

  it('says nothing when the company step can continue', () => {
    expect(
      companyStepHint({
        displayName: 'Acme',
        directoryPath: '/books',
        isRegistrationInvalid: false,
      }),
    ).toBeNull()
  })

  it('walks the passphrase step through its three missing states', () => {
    expect(confirmationHint({ passphrase: '', confirmation: '' })).toBe('Needs a passphrase')
    expect(confirmationHint({ passphrase: 'a b c d', confirmation: '' })).toBe(
      'Type it again to confirm',
    )
    expect(confirmationHint({ passphrase: 'a b c d', confirmation: 'a b c' })).toBe(
      'The two do not match yet',
    )
    expect(confirmationHint({ passphrase: 'a b c d', confirmation: 'a b c d' })).toBeNull()
  })
})

describe('countWord', () => {
  it('writes small counts in words and larger ones in figures', () => {
    expect(countWord(5)).toBe('five')
    expect(countWord(1)).toBe('one')
    expect(countWord(12)).toBe('12')
  })
})
