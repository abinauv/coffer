/*
 * Form rules for the company screens.
 *
 * Two things are worth saying about what is NOT here.
 *
 * STRENGTH NEVER BLOCKS. `canSubmit` for the create form does not read the passphrase
 * score at all, and there is a test that proves it: a passphrase scoring zero still
 * submits. With no key escrow (ARCHITECTURE §6.3.1) refusing a user their own passphrase
 * leaves them nothing to fall back on, so the meter warns loudly and the user decides.
 * `needsWeakConfirmation` is how the warning gets in the way once, not how it wins.
 *
 * NOTHING HERE SEES A PASSPHRASE TWICE. The rules read lengths and equality; no message
 * produced here ever contains the text of a passphrase or a recovery code.
 */

import type { PassphraseStrength } from '@shared/dto'
import { isWellFormedCode } from './recovery-gate'

/** A message to show under one field. Absent means the field is fine. */
export type FieldErrors<Field extends string> = Partial<Record<Field, string>>

export interface FormState<Field extends string> {
  errors: FieldErrors<Field>
  canSubmit: boolean
}

// ---- Creating a company ----------------------------------------------------

export type CreateField = 'displayName' | 'directoryPath' | 'passphrase' | 'confirmation'

export interface CreateInput {
  displayName: string
  directoryPath: string
  passphrase: string
  confirmation: string
}

/**
 * Validates the create form.
 *
 * `hasTouchedConfirmation` keeps "they do not match" from appearing on the first
 * keystroke of the second field, when it is true and useless.
 */
export function validateCreate(
  input: CreateInput,
  hasTouchedConfirmation = true,
): FormState<CreateField> {
  const errors: FieldErrors<CreateField> = {}

  if (input.displayName.trim() === '') {
    errors.displayName = 'Give this company a name. You can change it later.'
  }
  if (input.directoryPath.trim() === '') {
    errors.directoryPath = 'Choose the folder to keep this company in.'
  }
  if (input.passphrase === '') {
    errors.passphrase = 'Choose a passphrase. It is what encrypts these books.'
  }
  if (hasTouchedConfirmation && input.confirmation !== input.passphrase) {
    errors.confirmation =
      'These two do not match. Check both — nothing is stored to compare against.'
  }

  /* Deliberately blind to strength. See the note at the top of this file. */
  const canSubmit =
    input.displayName.trim() !== '' &&
    input.directoryPath.trim() !== '' &&
    input.passphrase !== '' &&
    input.confirmation === input.passphrase

  return { errors, canSubmit }
}

/**
 * Whether to interrupt once before creating.
 *
 * A weak passphrase is a decision, not a mistake, so it is confirmed rather than
 * refused — and confirmed exactly once, not on every keystroke.
 */
export function needsWeakConfirmation(
  strength: PassphraseStrength | null,
  hasConfirmedWeak: boolean,
): boolean {
  if (hasConfirmedWeak) return false
  return strength?.isWeak === true
}

// ---- Unlocking -------------------------------------------------------------

export type UnlockField = 'passphrase'

export function validateUnlock(passphrase: string): FormState<UnlockField> {
  const errors: FieldErrors<UnlockField> = {}
  if (passphrase === '') errors.passphrase = 'Enter the passphrase for this company.'
  return { errors, canSubmit: passphrase !== '' }
}

// ---- Recovering ------------------------------------------------------------

export type RecoverField = 'recoveryCode' | 'newPassphrase' | 'confirmation'

export interface RecoverInput {
  recoveryCode: string
  newPassphrase: string
  confirmation: string
}

/**
 * Validates the recovery form.
 *
 * The code is checked for shape only — whether it is one of *this company's* codes is
 * something only the vault can answer, and pretending otherwise here would produce a
 * confident message about a code that is perfectly fine.
 */
export function validateRecover(
  input: RecoverInput,
  hasTouchedConfirmation = true,
): FormState<RecoverField> {
  const errors: FieldErrors<RecoverField> = {}
  const code = input.recoveryCode.trim()

  if (code === '') {
    errors.recoveryCode = 'Enter one of the recovery codes from your sheet.'
  } else if (!isWellFormedCode(code)) {
    errors.recoveryCode =
      'A code is 20 characters in four groups of five, like A1B2C-3D4E5-F6G7H-8J9K0.'
  }
  if (input.newPassphrase === '') {
    errors.newPassphrase = 'Choose the passphrase you will use from now on.'
  }
  if (hasTouchedConfirmation && input.confirmation !== input.newPassphrase) {
    errors.confirmation = 'These two do not match.'
  }

  const canSubmit =
    isWellFormedCode(code) &&
    input.newPassphrase !== '' &&
    input.confirmation === input.newPassphrase

  return { errors, canSubmit }
}

// ---- Changing the passphrase ----------------------------------------------

export type ChangePassphraseField = 'currentPassphrase' | 'newPassphrase' | 'confirmation'

export interface ChangePassphraseFormInput {
  currentPassphrase: string
  newPassphrase: string
  confirmation: string
}

export function validateChangePassphrase(
  input: ChangePassphraseFormInput,
  hasTouchedConfirmation = true,
): FormState<ChangePassphraseField> {
  const errors: FieldErrors<ChangePassphraseField> = {}

  if (input.currentPassphrase === '') {
    errors.currentPassphrase = 'Enter the passphrase you use now.'
  }
  if (input.newPassphrase === '') {
    errors.newPassphrase = 'Choose the new passphrase.'
  } else if (input.newPassphrase === input.currentPassphrase && input.currentPassphrase !== '') {
    errors.newPassphrase = 'That is the passphrase you already use. Choose a different one.'
  }
  if (hasTouchedConfirmation && input.confirmation !== input.newPassphrase) {
    errors.confirmation = 'These two do not match.'
  }

  const canSubmit =
    input.currentPassphrase !== '' &&
    input.newPassphrase !== '' &&
    input.newPassphrase !== input.currentPassphrase &&
    input.confirmation === input.newPassphrase

  return { errors, canSubmit }
}

// ---- Renaming --------------------------------------------------------------

export function validateRename(displayName: string, current: string): FormState<'displayName'> {
  const errors: FieldErrors<'displayName'> = {}
  const trimmed = displayName.trim()
  if (trimmed === '') errors.displayName = 'A company needs a name.'
  return { errors, canSubmit: trimmed !== '' && trimmed !== current.trim() }
}

// ---- Restoring -------------------------------------------------------------

export type RestoreField = 'archivePath' | 'directoryPath'

export function validateRestore(input: {
  archivePath: string
  directoryPath: string
}): FormState<RestoreField> {
  const errors: FieldErrors<RestoreField> = {}
  if (input.archivePath.trim() === '') {
    errors.archivePath = 'Choose the backup archive to restore.'
  }
  if (input.directoryPath.trim() === '') {
    errors.directoryPath = 'Choose an empty folder to restore into.'
  }
  return {
    errors,
    canSubmit: input.archivePath.trim() !== '' && input.directoryPath.trim() !== '',
  }
}
