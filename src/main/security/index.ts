/*
 * The security module's public surface.
 *
 * This module hands out keys. It does not open databases, does not know what a company
 * is, and imports nothing from `db`, `ipc` or `services` — it is a leaf, and it stays a
 * leaf. Everything it needs arrives as an argument.
 *
 * ---------------------------------------------------------------------------
 *  HOW THE REST OF THE APP USES THIS
 * ---------------------------------------------------------------------------
 *
 * Creating a company:
 *
 *     const { dek, recoveryCodes } = await createVaultFile(vaultPath, passphrase)
 *     await withSecret(dek, (key) => createEncryptedDatabase(databasePath, key))
 *     // show recoveryCodes to the user, once. There is no second chance to read them.
 *
 * Opening one:
 *
 *     const dek = await unlockVaultFile(vaultPath, passphrase)
 *     const db = await withSecret(dek, (key) => openEncryptedDatabase(databasePath, key))
 *
 * Opening one with a recovery code, which spends the code:
 *
 *     const dek = await unlockVaultFileWithRecoveryCode(vaultPath, code)
 *     // the user has no passphrase at this point — prompt for a new one:
 *     await writeVaultFile(vaultPath, await setPassphrase(vault, dek, newPassphrase))
 *
 * Changing the passphrase — the database is not touched, opened, or re-encrypted:
 *
 *     await changeVaultFilePassphrase(vaultPath, currentPassphrase, newPassphrase)
 *
 * The DEK is a Buffer of 32 raw bytes. Hand it to the SQLCipher driver's `key()`
 * directly, or use `sqlcipherRawKey(dek)` for the `PRAGMA key = "x'…'"` text form.
 * Either way, zero it as soon as the database is open: `withSecret` does that for you
 * even if the callback throws.
 *
 * Every failure here is a `SecurityError` with a stable `code`, ready to be mapped onto
 * the `AppError` envelope in src/shared/dto.ts. No error, log line or message from this
 * module ever contains key material.
 */

// ---- Errors ----
export { SecurityError, isSecurityError } from './errors'
export type { SecurityErrorCode } from './errors'

// ---- Argon2id: passphrase hashing and key derivation ----
export {
  KDF_OUTPUT_BYTES,
  MAX_MEMORY_COST,
  MAX_PARALLELISM,
  MAX_TIME_COST,
  MIN_MEMORY_COST,
  MIN_PARALLELISM,
  MIN_SALT_BYTES,
  MIN_TIME_COST,
  PASSPHRASE_KDF,
  RECOVERY_KDF,
  SALT_BYTES,
  assertPassphraseNotEmpty,
  assertValidKdfParams,
  constantTimeEqual,
  deriveKey,
  hashPassphrase,
  needsRehash,
  parsePhcParams,
  verifyPassphrase,
} from './argon2'
export type { Argon2Params, PhcParams } from './argon2'

// ---- The data encryption key ----
export {
  DEK_BYTES,
  NONCE_BYTES,
  TAG_BYTES,
  VERIFIER_BYTES,
  assertValidDek,
  dekFromHex,
  dekToHex,
  deriveSlotKeys,
  deriveSubkey,
  generateDek,
  isValidDek,
  sqlcipherRawKey,
  unwrapDekWithKek,
  unwrapDekWithSecret,
  withSecret,
  wrapDek,
  wrapDekWithSecret,
  zeroize,
} from './dek'
export type { DekWrapping, UnwrapOutcome, WrappedDek } from './dek'

// ---- Recovery codes ----
export {
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_ENTROPY_BITS,
  RECOVERY_CODE_GROUP_SIZE,
  RECOVERY_CODE_LENGTH,
  formatRecoveryCode,
  generateRecoveryCode,
  generateRecoveryCodes,
  isRecoveryCodeWellFormed,
  normalizeRecoveryCode,
  recoveryCodeSecret,
} from './recovery-codes'

// ---- The vault ----
export {
  PASSPHRASE_SLOT_ID,
  SUPPORTED_VAULT_VERSIONS,
  VAULT_FORMAT,
  VAULT_VERSION,
  changePassphrase,
  changeVaultFilePassphrase,
  createVault,
  createVaultFile,
  describeVault,
  needsKdfUpgrade,
  parseVault,
  readVaultFile,
  remainingRecoveryCodes,
  replaceRecoveryCodes,
  replaceVaultFileRecoveryCodes,
  serializeVault,
  setPassphrase,
  toVaultDocument,
  unlockVaultFile,
  unlockVaultFileWithRecoveryCode,
  unlockWithPassphrase,
  unlockWithRecoveryCode,
  writeVaultFile,
} from './vault'
export type {
  CreateVaultOptions,
  CreatedVault,
  KeySlot,
  KeySlotKind,
  RecoveryUnlock,
  Vault,
  VaultDocument,
  VaultSummary,
} from './vault'

// ---- Sealed boxes ----
export {
  PRIVATE_KEY_BYTES,
  PUBLIC_KEY_BYTES,
  SEALED_BOX_OVERHEAD_BYTES,
  SEALED_REQUEST_FORMAT,
  SEALED_REQUEST_VERSION,
  generateKeyPair,
  initSealedBox,
  openRequest,
  openSealed,
  parseSealedRequest,
  publicKeyFingerprint,
  seal,
  sealRequest,
  serializeSealedRequest,
} from './sealed-box'
export type { JsonValue, KeyPair, SealedRequestEnvelope } from './sealed-box'
