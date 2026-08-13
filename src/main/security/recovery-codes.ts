/*
 * Recovery codes — five chances to keep your books after forgetting a passphrase.
 *
 * Five codes are generated when a company is created, shown once, and never shown
 * again. Each one independently unwraps the same DEK (see vault.ts), so losing the
 * passphrase does not lose the books. Each one works exactly once: redeeming a code
 * destroys the wrapped key material in its slot, so a code found on paper afterwards
 * opens nothing.
 *
 * WHAT IS STORED. Never the code. The vault keeps a per-slot salt and a 32-byte
 * verifier, both one-way functions of the code, plus the DEK wrapped under a key
 * derived from it. There is no path from anything on disk back to a printable code —
 * which is exactly why SECURITY.md can promise that a lost code is lost for good.
 *
 * THE ALPHABET. People write these on paper and read them back weeks later, often in
 * their own handwriting, often having lost the printed sheet and copied it by hand.
 * Crockford's Base32 is used unchanged: the 32 symbols
 *
 *     0 1 2 3 4 5 6 7 8 9 A B C D E F G H J K M N P Q R S T V W X Y Z
 *
 * omit I, L, O and U. The first three are dropped because they are indistinguishable
 * from 1, 1 and 0 in handwriting, and U because removing it keeps accidental words out
 * of a code. On the way back in, the ambiguity is repaired rather than punished:
 * a transcribed O becomes 0, and I or L become 1, so a user who wrote what they saw
 * gets in. Hyphens, spaces and lower case are all accepted and ignored.
 *
 * THE LENGTH. Twenty symbols, five bits each: 100 bits of entropy from the OS CSPRNG,
 * printed as four groups of five. That is far beyond any offline search — the codes are
 * strong because they are random, not because a KDF made them expensive, which is why
 * they use the lighter Argon2 profile (see argon2.ts).
 */

import { randomBytes } from 'node:crypto'

import { SecurityError } from './errors'

/** How many codes are issued at setup. */
export const RECOVERY_CODE_COUNT = 5

/** Symbols in a code, before formatting. */
export const RECOVERY_CODE_LENGTH = 20

/** Symbols per printed group. */
export const RECOVERY_CODE_GROUP_SIZE = 5

/** Crockford's Base32 alphabet: no I, no L, no O, no U. */
export const RECOVERY_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Entropy of a single code, in bits. 20 symbols from a 32-symbol alphabet. */
export const RECOVERY_CODE_ENTROPY_BITS = 100

/*
 * Transcription repairs, applied before validation. Crockford's decoding rules.
 * `U` is deliberately absent: it is not in the alphabet and is not a plausible
 * misreading of anything in it, so it is rejected rather than guessed at.
 */
const TRANSCRIPTION_FIXES = new Map<string, string>([
  ['O', '0'],
  ['I', '1'],
  ['L', '1'],
])

/**
 * Generate one recovery code in its printed form, `A1B2C-3D4E5-F6G7H-8J9K0`.
 *
 * The symbols are drawn uniformly: the alphabet has exactly 32 entries and 256 is a
 * whole multiple of 32, so masking a random byte to its low 5 bits introduces no bias.
 */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_LENGTH)
  let symbols = ''
  for (const byte of bytes) {
    symbols += RECOVERY_CODE_ALPHABET.charAt(byte & 0x1f)
  }
  bytes.fill(0)
  return formatRecoveryCode(symbols)
}

/**
 * Generate the set issued at setup.
 *
 * Duplicates are not checked for and do not need to be: two 100-bit values colliding is
 * not an event that happens.
 */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 32) {
    throw new SecurityError('KEY_MATERIAL_INVALID', 'The number of recovery codes is out of range.')
  }
  return Array.from({ length: count }, () => generateRecoveryCode())
}

/** Insert the grouping hyphens into a bare 20-symbol code. */
export function formatRecoveryCode(normalized: string): string {
  const groups: string[] = []
  for (let i = 0; i < normalized.length; i += RECOVERY_CODE_GROUP_SIZE) {
    groups.push(normalized.slice(i, i + RECOVERY_CODE_GROUP_SIZE))
  }
  return groups.join('-')
}

/**
 * Put a typed-in code into its one canonical form: upper case, no separators,
 * transcription errors repaired, exactly 20 symbols from the alphabet.
 *
 * This is the only function that decides whether a code is well formed, and it must be
 * deterministic — the same code always has to normalise to the same string, or the key
 * derived from it will not match.
 *
 * @throws SecurityError `RECOVERY_CODE_MALFORMED` — note the message names no input.
 */
export function normalizeRecoveryCode(code: string): string {
  if (typeof code !== 'string') {
    throw malformed()
  }
  let normalized = ''
  for (const rawSymbol of code.toUpperCase()) {
    if (
      rawSymbol === '-' ||
      rawSymbol === ' ' ||
      rawSymbol === '\t' ||
      rawSymbol === '\n' ||
      rawSymbol === '\r'
    ) {
      continue
    }
    const symbol = TRANSCRIPTION_FIXES.get(rawSymbol) ?? rawSymbol
    if (!RECOVERY_CODE_ALPHABET.includes(symbol)) {
      throw malformed()
    }
    normalized += symbol
    if (normalized.length > RECOVERY_CODE_LENGTH) {
      throw malformed()
    }
  }
  if (normalized.length !== RECOVERY_CODE_LENGTH) {
    throw malformed()
  }
  return normalized
}

/** True when `code` would normalise without complaint. Never throws. */
export function isRecoveryCodeWellFormed(code: string): boolean {
  try {
    normalizeRecoveryCode(code)
    return true
  } catch {
    return false
  }
}

/**
 * The bytes a recovery code contributes to key derivation: its canonical form, as
 * ASCII. There is no base32 decode step — the entropy is in the 20 symbols themselves,
 * and feeding Argon2 the canonical text avoids an entire class of encoding bug for no
 * loss of strength.
 *
 * The caller owns the buffer and should zero it once the key is derived.
 *
 * @throws SecurityError `RECOVERY_CODE_MALFORMED`
 */
export function recoveryCodeSecret(code: string): Buffer {
  return Buffer.from(normalizeRecoveryCode(code), 'ascii')
}

function malformed(): SecurityError {
  return new SecurityError(
    'RECOVERY_CODE_MALFORMED',
    'That is not a recovery code. Enter all 20 characters from your recovery sheet.',
  )
}
