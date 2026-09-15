/*
 * The words the create flow decides, as pure functions: what each step is called, what the
 * registration box says about what was typed, and why a button cannot run yet.
 *
 * Nothing here names a tax or a country. What the number is called, whether it is valid and
 * which jurisdiction it encodes all come from the regime, through `RegistrationCheck`
 * (CONVENTIONS §1.6).
 */

import type { RegistrationCheck } from '@shared/dto'

/** The three steps, as the step list names them. */
export const CREATE_STEPS = ['The company', 'The passphrase', 'Recovery codes'] as const

/**
 * The check that belongs to what is in the box now, or null.
 *
 * A check answers one keystroke late. A blank answer about a box that now holds a number,
 * or a number's answer about a box now empty, is a verdict about something no longer
 * there, and showing it would call a valid number invalid for a frame or the other way
 * round. Between two different numbers the last answer stands until the next one arrives;
 * the button reads the same, so it never flickers on and off while somebody types.
 */
export function currentCheck(
  check: RegistrationCheck | null,
  typed: string,
): RegistrationCheck | null {
  if (check === null) return null
  const isBlank = typed.trim() === ''
  return (check.status === 'blank') === isBlank ? check : null
}

/** The box's label: the regime's word for the number, and that it is optional. */
export function registrationLabel(check: RegistrationCheck | null): string {
  return `${check?.label ?? 'Registration number'} (optional)`
}

/** The line under the box, when there is no error to show instead. */
export function registrationHint(check: RegistrationCheck | null): string {
  if (check === null || check.status === 'blank') {
    return 'Leave it blank if the business is not registered. It can be added later in Business details.'
  }
  if (check.status === 'valid' && check.jurisdictionName !== null) {
    return `Registered in ${check.jurisdictionName} (${check.jurisdictionCode ?? ''}). That decides the tax on every invoice these books raise.`
  }
  return 'A valid number. It is saved into Business details when the company opens.'
}

/** The error under the box, for a number the regime does not accept. */
export function registrationError(check: RegistrationCheck | null): string | undefined {
  if (check?.status !== 'invalid') return undefined
  return check.message ?? 'That is not a number this regime accepts.'
}

/** Why Continue cannot run yet, beside it. Null when it can. */
export function companyStepHint(input: {
  displayName: string
  directoryPath: string
  isRegistrationInvalid: boolean
}): string | null {
  const missing: string[] = []
  if (input.displayName.trim() === '') missing.push('a business name')
  if (input.directoryPath.trim() === '') missing.push('a folder')
  if (missing.length > 0) return `Needs ${missing.join(' and ')}`
  if (input.isRegistrationInvalid) return 'Correct the registration number, or clear it'
  return null
}

/** Why Create the company cannot run yet, beside it. Null when it can. */
export function confirmationHint(input: {
  passphrase: string
  confirmation: string
}): string | null {
  if (input.passphrase === '') return 'Needs a passphrase'
  if (input.confirmation === '') return 'Type it again to confirm'
  if (input.confirmation !== input.passphrase) return 'The two do not match yet'
  return null
}

const COUNT_WORDS = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
]

/** A small count in words, as a sentence says it: "five codes". Figures past ten. */
export function countWord(count: number): string {
  return COUNT_WORDS[count] ?? String(count)
}
