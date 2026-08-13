/*
 * The data encryption key — the key that actually encrypts a company's books.
 *
 * A DEK is 32 random bytes, generated once when a company is created and never changed
 * for the life of that database. SQLCipher encrypts with it; nothing else does.
 *
 * WHY A DEK AT ALL, RATHER THAN KEYING THE DATABASE FROM THE PASSPHRASE DIRECTLY:
 * because a passphrase must be changeable, and re-keying a SQLCipher database rewrites
 * every page of it. On a large set of books that is a long, interruptible, destructive
 * operation — a power cut halfway through a re-key is exactly the "silent corruption of
 * financial data" that SECURITY.md calls a security issue. With a DEK, changing the
 * passphrase rewrites one small key slot and the database is never touched. It also
 * lets several independent secrets (the passphrase, five recovery codes) each open the
 * same database without any of them knowing about the others.
 *
 * THE DEK NEVER TOUCHES DISK IN THE CLEAR. Every persisted form is
 * AES-256-GCM(KEK, DEK) where the KEK is derived from a secret the user holds. Lose
 * every secret and the books are gone; that is the design, stated plainly in
 * SECURITY.md.
 *
 * WRAPPING, IN FULL:
 *
 *     slotKey  = Argon2id(secret, salt, params)                 32 bytes
 *     kek      = HKDF-SHA256(slotKey, info = ".../kek/v1")      32 bytes
 *     verifier = HKDF-SHA256(slotKey, info = ".../verifier/v1") 32 bytes, stored
 *     wrapped  = AES-256-GCM(kek, nonce, DEK, aad)              32 bytes + 16 byte tag
 *
 * Only `verifier` and `wrapped` are written down. The verifier is a one-way function of
 * the secret and answers "is this the right secret for this slot" without touching the
 * ciphertext; it is what lets the vault tell a wrong passphrase apart from a tampered
 * file, and what lets a spent recovery code still be recognised after its ciphertext has
 * been destroyed. It gives an offline attacker nothing the GCM tag did not already give
 * them, and the two subkeys are separated by HKDF so that neither can stand in for the
 * other.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

import { type Argon2Params, SALT_BYTES, constantTimeEqual, deriveKey } from './argon2'
import { SecurityError } from './errors'

/** AES-256 key length. Also the DEK length and the verifier length. */
export const DEK_BYTES = 32

/** GCM nonce length. 12 bytes is the only size AES-GCM is specified for. */
export const NONCE_BYTES = 12

/** GCM authentication tag length. */
export const TAG_BYTES = 16

/** Length of the stored slot verifier. */
export const VERIFIER_BYTES = 32

const KEK_INFO = 'coffer/dek-wrap/kek/v1'
const VERIFIER_INFO = 'coffer/dek-wrap/verifier/v1'

/** The ciphertext of a wrapped DEK, with the nonce and tag it needs to be opened. */
export interface WrappedDek {
  readonly nonce: Buffer
  readonly ciphertext: Buffer
  readonly tag: Buffer
}

/** Everything that must be stored so that one secret can unwrap the DEK again. */
export interface DekWrapping {
  readonly salt: Buffer
  readonly verifier: Buffer
  readonly wrapped: WrappedDek
}

/**
 * The result of trying to unwrap.
 *
 * The three cases are deliberately distinct, and the distinction is the point of
 * storing a verifier. `wrong-secret` means the secret does not belong to this slot.
 * `tampered` means the secret was right and the ciphertext still failed to
 * authenticate — the file has been modified. Neither ever yields plaintext.
 */
export type UnwrapOutcome =
  | { readonly status: 'unwrapped'; readonly dek: Buffer }
  | { readonly status: 'wrong-secret' }
  | { readonly status: 'tampered' }

/** A fresh DEK from the OS CSPRNG. */
export function generateDek(): Buffer {
  return randomBytes(DEK_BYTES)
}

/** True when `dek` is exactly the right length to be a DEK. */
export function isValidDek(dek: Buffer): boolean {
  return Buffer.isBuffer(dek) && dek.length === DEK_BYTES
}

/**
 * @throws SecurityError `KEY_MATERIAL_INVALID`
 */
export function assertValidDek(dek: Buffer): void {
  if (!isValidDek(dek)) {
    throw new SecurityError(
      'KEY_MATERIAL_INVALID',
      'The data encryption key is not the right size.',
    )
  }
}

/**
 * Split a 32-byte master key into an independent subkey using HKDF-SHA256.
 *
 * The `info` label is what separates one subkey from another; two different labels on
 * the same master key produce keys from which neither reveals the other. The vault uses
 * this to derive its integrity key from the DEK.
 */
export function deriveSubkey(masterKey: Buffer, info: string, length: number = 32): Buffer {
  if (masterKey.length === 0) {
    throw new SecurityError('KEY_MATERIAL_INVALID', 'The key handed to the derivation was empty.')
  }
  return Buffer.from(
    hkdfSync('sha256', masterKey, Buffer.alloc(0), Buffer.from(info, 'utf8'), length),
  )
}

/**
 * Derive the pair of subkeys a slot needs: the key that wraps the DEK, and the verifier
 * that is written down beside it.
 *
 * The caller owns both buffers and must zero the KEK once it has been used.
 */
export async function deriveSlotKeys(
  secret: Buffer,
  salt: Buffer,
  params: Argon2Params,
): Promise<{ kek: Buffer; verifier: Buffer }> {
  const slotKey = await deriveKey(secret, salt, params, 32)
  try {
    return {
      kek: deriveSubkey(slotKey, KEK_INFO, DEK_BYTES),
      verifier: deriveSubkey(slotKey, VERIFIER_INFO, VERIFIER_BYTES),
    }
  } finally {
    zeroize(slotKey)
  }
}

/**
 * Encrypt the DEK under a key-encryption key.
 *
 * `aad` is authenticated but not encrypted. The vault passes the slot's own header
 * (its id, kind, KDF parameters and salt) so that editing any of them in the file makes
 * this ciphertext fail to open instead of quietly deriving a different key.
 *
 * @throws SecurityError `KEY_MATERIAL_INVALID`
 */
export function wrapDek(dek: Buffer, kek: Buffer, aad: Buffer): WrappedDek {
  assertValidDek(dek)
  if (kek.length !== DEK_BYTES) {
    throw new SecurityError('KEY_MATERIAL_INVALID', 'The key-encryption key is not the right size.')
  }
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', kek, nonce, { authTagLength: TAG_BYTES })
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()])
  return { nonce, ciphertext, tag: cipher.getAuthTag() }
}

/**
 * Decrypt a wrapped DEK. Returns null when authentication fails, for any reason —
 * wrong key, altered ciphertext, altered tag, altered AAD. GCM never returns unverified
 * plaintext, so a failure here is a failure, never garbage that looks like a key.
 */
export function unwrapDekWithKek(wrapped: WrappedDek, kek: Buffer, aad: Buffer): Buffer | null {
  if (
    kek.length !== DEK_BYTES ||
    wrapped.nonce.length !== NONCE_BYTES ||
    wrapped.tag.length !== TAG_BYTES ||
    wrapped.ciphertext.length !== DEK_BYTES
  ) {
    return null
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, wrapped.nonce, {
      authTagLength: TAG_BYTES,
    })
    decipher.setAAD(aad)
    decipher.setAuthTag(wrapped.tag)
    return Buffer.concat([decipher.update(wrapped.ciphertext), decipher.final()])
  } catch {
    return null
  }
}

/**
 * Wrap the DEK under a secret — a passphrase or a recovery code — producing everything
 * that has to be written down for that secret to open it again.
 *
 * A fresh random salt and nonce are generated on every call. Re-wrapping the same DEK
 * under the same passphrase therefore produces a completely different slot, which is
 * what makes a passphrase change indistinguishable from a first-time setup on disk.
 */
export async function wrapDekWithSecret(
  dek: Buffer,
  secret: Buffer,
  options: { readonly kdf: Argon2Params; readonly aad: (salt: Buffer) => Buffer },
): Promise<DekWrapping> {
  assertValidDek(dek)
  const salt = randomBytes(SALT_BYTES)
  const { kek, verifier } = await deriveSlotKeys(secret, salt, options.kdf)
  try {
    return { salt, verifier, wrapped: wrapDek(dek, kek, options.aad(salt)) }
  } finally {
    zeroize(kek)
  }
}

/**
 * Try to unwrap the DEK with a secret.
 *
 * The verifier decides which of the three outcomes applies, so a wrong passphrase and a
 * corrupted file are never confused for one another. On success the caller owns the
 * returned DEK and must zero it — `withSecret` does that for you.
 */
export async function unwrapDekWithSecret(
  secret: Buffer,
  wrapping: DekWrapping,
  options: { readonly kdf: Argon2Params; readonly aad: (salt: Buffer) => Buffer },
): Promise<UnwrapOutcome> {
  const { kek, verifier } = await deriveSlotKeys(secret, wrapping.salt, options.kdf)
  try {
    if (!constantTimeEqual(verifier, wrapping.verifier)) {
      return { status: 'wrong-secret' }
    }
    const dek = unwrapDekWithKek(wrapping.wrapped, kek, options.aad(wrapping.salt))
    if (dek === null) {
      // The secret was right, so the ciphertext, tag or AAD has been altered.
      return { status: 'tampered' }
    }
    return { status: 'unwrapped', dek }
  } finally {
    zeroize(kek, verifier)
  }
}

/**
 * Overwrite secret material with zeros.
 *
 * This is best effort and the limits are worth stating honestly. It reliably clears the
 * bytes of these buffers, which is what keeps a DEK out of a heap dump, a core file or a
 * swapped-out page after unlock. It cannot clear copies the runtime made on its own, and
 * it cannot touch a JavaScript string at all — strings are immutable and garbage
 * collected, which is why a passphrase is converted to a Buffer as early as possible and
 * why no key is ever handled as a string in this module.
 */
export function zeroize(...secrets: Array<Buffer | null | undefined>): void {
  for (const secret of secrets) {
    if (secret !== null && secret !== undefined && secret.length > 0) {
      secret.fill(0)
    }
  }
}

/**
 * Run `fn` with a secret and zero it afterwards, whether `fn` returned or threw.
 *
 * This is the shape the database layer should use for a DEK:
 *
 *     const dek = await unlockVaultFile(vaultPath, passphrase)
 *     const db = await withSecret(dek, (key) => openEncryptedDatabase(path, key))
 *
 * The secret is dead by the time the expression finishes.
 */
export async function withSecret<T>(
  secret: Buffer,
  fn: (secret: Buffer) => T | Promise<T>,
): Promise<T> {
  try {
    return await fn(secret)
  } finally {
    zeroize(secret)
  }
}

/**
 * The DEK as 64 lowercase hex characters.
 *
 * Prefer handing the raw Buffer to the driver — a string cannot be zeroed and will sit
 * in memory until it is collected. This exists for the SQLCipher `PRAGMA key` form,
 * which is text: `db.pragma(\`key="\${sqlcipherRawKey(dek)}"\`)`.
 */
export function dekToHex(dek: Buffer): string {
  assertValidDek(dek)
  return dek.toString('hex')
}

/**
 * The SQLCipher raw-key literal, `x'<64 hex>'`. Using the raw-key form rather than a
 * passphrase form is what stops SQLCipher applying its own KDF to our key.
 */
export function sqlcipherRawKey(dek: Buffer): string {
  return `x'${dekToHex(dek)}'`
}

/**
 * Parse 64 hex characters back into a DEK.
 *
 * @throws SecurityError `KEY_MATERIAL_INVALID`
 */
export function dekFromHex(hex: string): Buffer {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new SecurityError(
      'KEY_MATERIAL_INVALID',
      'The data encryption key is not 64 hexadecimal characters.',
    )
  }
  return Buffer.from(hex, 'hex')
}
