/*
 * Errors raised by the security module.
 *
 * ONE RULE ABOVE ALL OTHERS: an error from this module never carries key material.
 * No passphrase, no recovery code, no DEK, no derived key, no ciphertext ever appears
 * in a message, in a property, or in anything a logger might reach. Every message here
 * is a fixed string with no interpolation of caller input — that is deliberate, and
 * `errors.test.ts` asserts it.
 *
 * The `code` is stable and machine-readable. The IPC layer maps it onto the `AppError`
 * envelope in src/shared/dto.ts; the message is already written for a human to read,
 * so a handler can pass it straight through.
 */

export type SecurityErrorCode =
  /** A passphrase was empty or whitespace-only. A caller-side bug, or an empty form. */
  | 'PASSPHRASE_EMPTY'
  /** The passphrase did not unlock the vault. */
  | 'PASSPHRASE_INVALID'
  /** A stored Argon2 PHC hash string could not be parsed. */
  | 'PASSPHRASE_HASH_MALFORMED'
  /** A recovery code was not in the expected shape or alphabet. */
  | 'RECOVERY_CODE_MALFORMED'
  /** A well-formed recovery code that matches no slot in this vault. */
  | 'RECOVERY_CODE_INVALID'
  /** The code is genuine but was already spent. Recovery codes are single-use. */
  | 'RECOVERY_CODE_ALREADY_USED'
  /** KDF parameters outside the accepted range — too weak to trust, or large enough to be a denial of service. */
  | 'KDF_PARAMS_INVALID'
  /** Key material of the wrong length or shape was handed to a primitive. */
  | 'KEY_MATERIAL_INVALID'
  /** The vault file is not a vault, or is missing/mistyped required fields. */
  | 'VAULT_MALFORMED'
  /** Authentication failed: the vault has been modified since it was written. */
  | 'VAULT_TAMPERED'
  /** A vault written by a newer format version than this build understands. */
  | 'VAULT_UNSUPPORTED_VERSION'
  /** The vault file could not be read from or written to disk. */
  | 'VAULT_IO_FAILED'
  /** An X25519 key was not a valid public or private key. */
  | 'SEALED_BOX_INVALID_KEY'
  /** A sealed box did not open: wrong key pair, or the ciphertext was altered. */
  | 'SEALED_BOX_OPEN_FAILED'
  /** A sealed request envelope was not parseable. */
  | 'SEALED_REQUEST_MALFORMED'

/**
 * The only error type this module throws.
 *
 * Construct it with a fixed message. If you find yourself wanting to interpolate a
 * value into the message to make debugging easier, that value is exactly what must not
 * be there — describe the field instead of quoting it.
 */
export class SecurityError extends Error {
  readonly code: SecurityErrorCode

  constructor(code: SecurityErrorCode, message: string) {
    super(message)
    this.name = 'SecurityError'
    this.code = code
  }
}

export function isSecurityError(value: unknown): value is SecurityError {
  return value instanceof SecurityError
}
