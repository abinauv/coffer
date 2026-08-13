/*
 * The vault — the on-disk key store that stands between a passphrase and the books.
 *
 * A vault holds one DEK wrapped several times over, once per independent secret:
 *
 *     slot "passphrase"   the user's passphrase          always present
 *     slot "recovery-1"   recovery code 1                single use
 *     ...                 ...
 *     slot "recovery-5"   recovery code 5                single use
 *
 * Every slot wraps THE SAME DEK under a different key. That is the whole trick, and
 * everything else follows from it:
 *
 *   - Changing the passphrase rewrites one slot. The database is not re-encrypted, not
 *     rewritten, not even opened. A passphrase change cannot corrupt a single ledger row.
 *   - Any one recovery code opens the books on its own, so a forgotten passphrase is an
 *     inconvenience rather than a bankruptcy.
 *   - Redeeming a recovery code destroys that slot's wrapped key material outright. The
 *     salt and verifier stay behind only so the code can still be *recognised* and
 *     reported as spent; there is nothing left in the slot to decrypt. A code is single
 *     use because the ciphertext is gone, not because a boolean says so.
 *
 * WHAT IS AUTHENTICATED. Two layers, and the second is what makes tampering fail loudly
 * rather than quietly.
 *
 *   Per slot: the AES-GCM wrap authenticates the slot's own header — id, kind, KDF
 *   parameters and salt — as associated data. Edit any of them in the file and the wrap
 *   fails to open. It cannot silently derive a different key.
 *
 *   Per document: a HMAC-SHA256 over the whole canonical vault, keyed by a subkey of the
 *   DEK, is checked immediately after any successful unlock. This covers the parts no
 *   individual slot can cover — the slot list itself, and each slot's spent marker. It
 *   is what stops the one attack the per-slot tag misses: editing `usedAt` back to null
 *   to resurrect a recovery code. Only someone who can already unlock the vault can
 *   compute this MAC, which is why every operation that changes a vault takes the DEK.
 *
 * WHAT IS NOT DEFENDED. An attacker who can write to the vault file can always replace
 * it wholesale with an older copy of itself, restoring a code that was spent since. That
 * is a rollback of a backup they must already possess, on a machine they already control
 * — SECURITY.md puts a compromised machine out of scope, and nothing short of trusted
 * external state could fix it.
 *
 * WHERE THE FILE LIVES is not decided here. This module reads and writes a path it is
 * given; the companies layer owns the question of where a company's vault sits relative
 * to its database.
 */

import { createHmac } from 'node:crypto'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  type Argon2Params,
  PASSPHRASE_KDF,
  RECOVERY_KDF,
  SALT_BYTES,
  assertPassphraseNotEmpty,
  assertValidKdfParams,
  constantTimeEqual,
  MAX_MEMORY_COST,
  MIN_MEMORY_COST,
} from './argon2'
import {
  DEK_BYTES,
  NONCE_BYTES,
  TAG_BYTES,
  VERIFIER_BYTES,
  type DekWrapping,
  type WrappedDek,
  deriveSlotKeys,
  deriveSubkey,
  generateDek,
  unwrapDekWithSecret,
  wrapDekWithSecret,
  zeroize,
} from './dek'
import { SecurityError } from './errors'
import { RECOVERY_CODE_COUNT, generateRecoveryCodes, recoveryCodeSecret } from './recovery-codes'

// ---------------------------------------------------------------------------
//  Format
// ---------------------------------------------------------------------------

/** Marker written into every vault. A file without it is not a vault. */
export const VAULT_FORMAT = 'coffer.vault'

/** The format version this build writes. */
export const VAULT_VERSION = 1

/**
 * Every version this build can read.
 *
 * TO ADD VERSION 2: write the new shape behind `VAULT_VERSION = 2`, keep 1 in this list,
 * teach `parseVault` to read the version-1 shape into the current in-memory `Vault`, and
 * let the next write emit version 2. The version lives in the file rather than being
 * inferred, and every slot carries its own KDF parameters rather than inheriting a
 * global default, so an old vault stays readable without guessing at anything.
 */
export const SUPPORTED_VAULT_VERSIONS: readonly number[] = [1]

/** Upper bound on slots in a file. Generous for the real shape (1 + 5), bounded against a hostile one. */
const MAX_SLOTS = 64

/** HKDF label for the document integrity key. Changing it invalidates every existing MAC. */
const VAULT_MAC_INFO = 'coffer/vault/integrity/v1'

/** Slot id of the passphrase slot. There is exactly one. */
export const PASSPHRASE_SLOT_ID = 'passphrase'

export type KeySlotKind = 'passphrase' | 'recovery'

/**
 * One wrapped copy of the DEK.
 *
 * `wrapped` is null exactly when the slot has been spent; `usedAt` records when. The
 * salt and verifier outlive the ciphertext so a spent recovery code can still be told
 * apart from a code that never belonged to this vault.
 */
export interface KeySlot {
  readonly id: string
  readonly kind: KeySlotKind
  readonly kdf: Argon2Params
  readonly salt: Buffer
  readonly verifier: Buffer
  readonly wrapped: WrappedDek | null
  readonly createdAt: string
  readonly usedAt: string | null
}

/**
 * A vault, in memory. Treat it as immutable — every operation here returns a new one
 * rather than editing this in place, so a half-applied change can never be persisted.
 */
export interface Vault {
  readonly format: typeof VAULT_FORMAT
  readonly version: number
  readonly createdAt: string
  readonly slots: readonly KeySlot[]
  /** HMAC-SHA256 over the canonical vault, keyed from the DEK. */
  readonly mac: Buffer
}

/** What `createVault` hands back. The recovery codes are visible here and nowhere else, ever. */
export interface CreatedVault {
  readonly vault: Vault
  readonly dek: Buffer
  readonly recoveryCodes: readonly string[]
}

/** What unlocking with a recovery code hands back. The vault has changed — persist it. */
export interface RecoveryUnlock {
  readonly dek: Buffer
  /** The vault with that code spent. Save this before acting on the DEK. */
  readonly vault: Vault
  readonly slotId: string
}

/** A non-secret summary, safe to show in the UI or attach to a support request. */
export interface VaultSummary {
  readonly format: string
  readonly version: number
  readonly createdAt: string
  readonly recoveryCodesRemaining: number
  readonly recoveryCodesIssued: number
  readonly needsKdfUpgrade: boolean
  readonly slots: ReadonlyArray<{
    readonly id: string
    readonly kind: KeySlotKind
    readonly isSpent: boolean
    readonly kdf: Argon2Params
  }>
}

export interface CreateVaultOptions {
  /** How many recovery codes to issue. Defaults to five. */
  readonly recoveryCodeCount?: number
  /**
   * Override the KDF profiles. For tests, which cannot afford a real derivation per
   * slot, and for a future migration that raises them. Production never passes this.
   */
  readonly kdf?: {
    readonly passphrase?: Argon2Params
    readonly recovery?: Argon2Params
  }
}

// ---------------------------------------------------------------------------
//  Creating
// ---------------------------------------------------------------------------

/**
 * Create a vault around a brand-new DEK, wrapped once per secret.
 *
 * The returned DEK is what opens the database; the returned recovery codes are the only
 * copy that will ever exist. Show them, let the user write them down, and drop them.
 *
 * @throws SecurityError `PASSPHRASE_EMPTY` | `KDF_PARAMS_INVALID`
 */
export async function createVault(
  passphrase: string,
  options: CreateVaultOptions = {},
): Promise<CreatedVault> {
  assertPassphraseNotEmpty(passphrase)
  const passphraseKdf = options.kdf?.passphrase ?? PASSPHRASE_KDF
  const recoveryKdf = options.kdf?.recovery ?? RECOVERY_KDF
  assertValidKdfParams(passphraseKdf)
  assertValidKdfParams(recoveryKdf)

  const codeCount = options.recoveryCodeCount ?? RECOVERY_CODE_COUNT
  const dek = generateDek()
  const createdAt = nowIso()

  try {
    const slots: KeySlot[] = [
      await buildSlot({
        version: VAULT_VERSION,
        id: PASSPHRASE_SLOT_ID,
        kind: 'passphrase',
        kdf: passphraseKdf,
        secretOf: () => Buffer.from(passphrase, 'utf8'),
        dek,
        createdAt,
      }),
    ]

    const recoveryCodes = generateRecoveryCodes(codeCount)
    for (const [index, code] of recoveryCodes.entries()) {
      slots.push(
        await buildSlot({
          version: VAULT_VERSION,
          id: recoverySlotId(index),
          kind: 'recovery',
          kdf: recoveryKdf,
          secretOf: () => recoveryCodeSecret(code),
          dek,
          createdAt,
        }),
      )
    }

    return { vault: seal({ version: VAULT_VERSION, createdAt, slots }, dek), dek, recoveryCodes }
  } catch (error) {
    zeroize(dek)
    throw error
  }
}

// ---------------------------------------------------------------------------
//  Unlocking
// ---------------------------------------------------------------------------

/**
 * Recover the DEK with the passphrase.
 *
 * The caller owns the returned buffer and must zero it — see `withSecret` in dek.ts.
 *
 * @throws SecurityError `PASSPHRASE_EMPTY` | `PASSPHRASE_INVALID` | `VAULT_TAMPERED` | `VAULT_MALFORMED`
 */
export async function unlockWithPassphrase(vault: Vault, passphrase: string): Promise<Buffer> {
  assertPassphraseNotEmpty(passphrase)
  const slot = passphraseSlot(vault)
  const secret = Buffer.from(passphrase, 'utf8')
  try {
    const outcome = await unwrapDekWithSecret(secret, wrappingOf(slot), {
      kdf: slot.kdf,
      aad: (salt) => slotAad(vault.version, slot, salt),
    })
    if (outcome.status === 'wrong-secret') {
      throw new SecurityError(
        'PASSPHRASE_INVALID',
        'That passphrase did not unlock this company. Check it and try again.',
      )
    }
    if (outcome.status === 'tampered') {
      throw tampered()
    }
    return checkIntegrity(vault, outcome.dek)
  } finally {
    zeroize(secret)
  }
}

/**
 * Recover the DEK with a recovery code, spending it in the process.
 *
 * The returned vault has that slot's wrapped key destroyed. PERSIST IT BEFORE YOU USE
 * THE DEK — if the process dies in between, the code must already be spent, not still
 * live. `unlockVaultFileWithRecoveryCode` does that ordering for you.
 *
 * @throws SecurityError `RECOVERY_CODE_MALFORMED` | `RECOVERY_CODE_INVALID`
 *         | `RECOVERY_CODE_ALREADY_USED` | `VAULT_TAMPERED` | `VAULT_MALFORMED`
 */
export async function unlockWithRecoveryCode(vault: Vault, code: string): Promise<RecoveryUnlock> {
  const secret = recoveryCodeSecret(code)
  try {
    const recoverySlots = vault.slots.filter((slot) => slot.kind === 'recovery')
    if (recoverySlots.length === 0) {
      throw new SecurityError('VAULT_MALFORMED', 'This company has no recovery codes on file.')
    }

    for (const slot of recoverySlots) {
      if (slot.wrapped === null) {
        continue
      }
      const outcome = await unwrapDekWithSecret(secret, wrappingOf(slot), {
        kdf: slot.kdf,
        aad: (salt) => slotAad(vault.version, slot, salt),
      })
      if (outcome.status === 'wrong-secret') {
        continue
      }
      if (outcome.status === 'tampered') {
        throw tampered()
      }
      const dek = checkIntegrity(vault, outcome.dek)
      try {
        return { dek, vault: spendSlot(vault, slot.id, dek), slotId: slot.id }
      } catch (error) {
        zeroize(dek)
        throw error
      }
    }

    // No live slot matched. If a spent one does, say so — it is a different mistake.
    for (const slot of recoverySlots) {
      if (slot.wrapped !== null) {
        continue
      }
      if (await matchesSlot(secret, slot)) {
        throw new SecurityError(
          'RECOVERY_CODE_ALREADY_USED',
          'That recovery code has already been used. Each code works once.',
        )
      }
    }

    throw new SecurityError(
      'RECOVERY_CODE_INVALID',
      'That recovery code does not belong to this company.',
    )
  } finally {
    zeroize(secret)
  }
}

// ---------------------------------------------------------------------------
//  Changing
// ---------------------------------------------------------------------------

/**
 * Re-wrap the passphrase slot under a new passphrase.
 *
 * The DEK is unchanged, so the database is untouched and every recovery code still
 * works. That is the point of the whole design.
 *
 * @throws SecurityError `PASSPHRASE_EMPTY` | `PASSPHRASE_INVALID` | `VAULT_TAMPERED`
 */
export async function changePassphrase(
  vault: Vault,
  currentPassphrase: string,
  newPassphrase: string,
): Promise<Vault> {
  assertPassphraseNotEmpty(newPassphrase)
  const dek = await unlockWithPassphrase(vault, currentPassphrase)
  try {
    return await setPassphrase(vault, dek, newPassphrase)
  } finally {
    zeroize(dek)
  }
}

/**
 * Re-wrap the passphrase slot when the old passphrase is not available — the state a
 * user is in immediately after redeeming a recovery code.
 *
 * @throws SecurityError `PASSPHRASE_EMPTY` | `KEY_MATERIAL_INVALID` | `VAULT_MALFORMED`
 */
export async function setPassphrase(
  vault: Vault,
  dek: Buffer,
  newPassphrase: string,
): Promise<Vault> {
  assertPassphraseNotEmpty(newPassphrase)
  const existing = passphraseSlot(vault)
  const replacement = await buildSlot({
    version: vault.version,
    id: existing.id,
    kind: 'passphrase',
    kdf: existing.kdf.memoryCost >= PASSPHRASE_KDF.memoryCost ? existing.kdf : PASSPHRASE_KDF,
    secretOf: () => Buffer.from(newPassphrase, 'utf8'),
    dek,
    createdAt: nowIso(),
  })
  const slots = vault.slots.map((slot) => (slot.id === existing.id ? replacement : slot))
  return seal({ version: vault.version, createdAt: vault.createdAt, slots }, dek)
}

/**
 * Issue a fresh set of recovery codes, invalidating every existing one.
 *
 * Requires the DEK, so it can only be done from an unlocked session — a stolen vault
 * file cannot mint itself new codes. The natural moment to offer this is straight after
 * a code has been redeemed, when the user is down to four.
 */
export async function replaceRecoveryCodes(
  vault: Vault,
  dek: Buffer,
  count: number = RECOVERY_CODE_COUNT,
): Promise<{ vault: Vault; recoveryCodes: readonly string[] }> {
  const template = vault.slots.find((slot) => slot.kind === 'recovery')
  const kdf = template?.kdf ?? RECOVERY_KDF
  const createdAt = nowIso()
  const recoveryCodes = generateRecoveryCodes(count)
  const slots: KeySlot[] = vault.slots.filter((slot) => slot.kind !== 'recovery')
  for (const [index, code] of recoveryCodes.entries()) {
    slots.push(
      await buildSlot({
        version: vault.version,
        id: recoverySlotId(index),
        kind: 'recovery',
        kdf,
        secretOf: () => recoveryCodeSecret(code),
        dek,
        createdAt,
      }),
    )
  }
  return {
    vault: seal({ version: vault.version, createdAt: vault.createdAt, slots }, dek),
    recoveryCodes,
  }
}

// ---------------------------------------------------------------------------
//  Inspecting
// ---------------------------------------------------------------------------

/** How many recovery codes are still live. */
export function remainingRecoveryCodes(vault: Vault): number {
  return vault.slots.filter((slot) => slot.kind === 'recovery' && slot.wrapped !== null).length
}

/**
 * True when any slot was written with parameters weaker than this build's profile —
 * an older vault, or one created by a test. The unlock path can use it to re-wrap
 * transparently while it has the DEK in hand.
 */
export function needsKdfUpgrade(vault: Vault): boolean {
  return vault.slots.some((slot) => {
    const target = slot.kind === 'passphrase' ? PASSPHRASE_KDF : RECOVERY_KDF
    return (
      slot.kdf.memoryCost < target.memoryCost ||
      slot.kdf.timeCost < target.timeCost ||
      slot.kdf.parallelism < target.parallelism
    )
  })
}

/** A summary with no key material in it. Safe for the UI and for a support request. */
export function describeVault(vault: Vault): VaultSummary {
  const recoverySlots = vault.slots.filter((slot) => slot.kind === 'recovery')
  return {
    format: vault.format,
    version: vault.version,
    createdAt: vault.createdAt,
    recoveryCodesIssued: recoverySlots.length,
    recoveryCodesRemaining: remainingRecoveryCodes(vault),
    needsKdfUpgrade: needsKdfUpgrade(vault),
    slots: vault.slots.map((slot) => ({
      id: slot.id,
      kind: slot.kind,
      isSpent: slot.wrapped === null,
      kdf: slot.kdf,
    })),
  }
}

// ---------------------------------------------------------------------------
//  Serialising
// ---------------------------------------------------------------------------

/** The JSON shape written to disk. Binary fields are base64; nothing here is a secret. */
export interface VaultDocument {
  format: string
  version: number
  createdAt: string
  mac: string
  slots: Array<{
    id: string
    kind: string
    kdf: { algorithm: string; memoryCost: number; timeCost: number; parallelism: number }
    salt: string
    verifier: string
    wrapped: { nonce: string; ciphertext: string; tag: string } | null
    createdAt: string
    usedAt: string | null
  }>
}

/** The vault as a JSON document object. */
export function toVaultDocument(vault: Vault): VaultDocument {
  return {
    format: vault.format,
    version: vault.version,
    createdAt: vault.createdAt,
    mac: vault.mac.toString('base64'),
    slots: vault.slots.map((slot) => ({
      id: slot.id,
      kind: slot.kind,
      kdf: {
        algorithm: slot.kdf.algorithm,
        memoryCost: slot.kdf.memoryCost,
        timeCost: slot.kdf.timeCost,
        parallelism: slot.kdf.parallelism,
      },
      salt: slot.salt.toString('base64'),
      verifier: slot.verifier.toString('base64'),
      wrapped:
        slot.wrapped === null
          ? null
          : {
              nonce: slot.wrapped.nonce.toString('base64'),
              ciphertext: slot.wrapped.ciphertext.toString('base64'),
              tag: slot.wrapped.tag.toString('base64'),
            },
      createdAt: slot.createdAt,
      usedAt: slot.usedAt,
    })),
  }
}

/** The vault as the exact text written to disk. Indented, because a human may need to look at it. */
export function serializeVault(vault: Vault): string {
  return `${JSON.stringify(toVaultDocument(vault), null, 2)}\n`
}

/**
 * Parse a vault from JSON text or an already-parsed object.
 *
 * Strict on purpose. Everything is checked: the format marker, the version, every field's
 * type, every binary field's exact byte length and that its base64 is canonical, slot id
 * shape and uniqueness, KDF parameters within the accepted range, and the invariant that
 * a slot is spent if and only if it has a `usedAt`. A file that fails any of these is
 * rejected here rather than turning into a confusing failure three layers down.
 *
 * Note what this does NOT do: it does not verify the document MAC, because that needs
 * the DEK. Integrity is checked on the unlock path, immediately after the DEK appears.
 *
 * @throws SecurityError `VAULT_MALFORMED` | `VAULT_UNSUPPORTED_VERSION` | `KDF_PARAMS_INVALID`
 */
export function parseVault(input: unknown): Vault {
  const raw = typeof input === 'string' ? parseJson(input) : input
  const document = asRecord(raw)

  if (document['format'] !== VAULT_FORMAT) {
    throw malformed('This file is not a Coffer vault.')
  }

  const version = asInteger(document['version'])
  if (version === null || version < 1) {
    throw malformed('The vault file does not say which format version it uses.')
  }
  if (!SUPPORTED_VAULT_VERSIONS.includes(version)) {
    throw new SecurityError(
      'VAULT_UNSUPPORTED_VERSION',
      version > VAULT_VERSION
        ? 'This vault was written by a newer version of Coffer. Update Coffer to open it.'
        : 'This vault uses a format this version of Coffer can no longer read.',
    )
  }

  const createdAt = asTimestamp(document['createdAt'])
  const mac = asBase64(document['mac'], 32, 'the integrity check')

  const rawSlots = document['slots']
  if (!Array.isArray(rawSlots) || rawSlots.length === 0 || rawSlots.length > MAX_SLOTS) {
    throw malformed('The vault file has no usable key slots.')
  }

  const seen = new Set<string>()
  const slots: KeySlot[] = rawSlots.map((rawSlot) => {
    const slot = asRecord(rawSlot)
    const id = asSlotId(slot['id'])
    if (seen.has(id)) {
      throw malformed('The vault file has two key slots with the same name.')
    }
    seen.add(id)

    const kind = slot['kind']
    if (kind !== 'passphrase' && kind !== 'recovery') {
      throw malformed('The vault file has a key slot of an unknown kind.')
    }

    const wrapped = asWrapped(slot['wrapped'])
    const usedAt = slot['usedAt'] === null ? null : asTimestamp(slot['usedAt'])
    if ((wrapped === null) !== (usedAt !== null)) {
      throw malformed('A key slot in the vault file contradicts itself.')
    }
    if (kind === 'passphrase' && wrapped === null) {
      throw malformed('The passphrase key slot in the vault file is empty.')
    }

    return {
      id,
      kind,
      kdf: asKdfParams(slot['kdf']),
      salt: asBase64(slot['salt'], SALT_BYTES, 'a key slot salt'),
      verifier: asBase64(slot['verifier'], VERIFIER_BYTES, 'a key slot check value'),
      wrapped,
      createdAt: asTimestamp(slot['createdAt']),
      usedAt,
    }
  })

  if (slots.filter((slot) => slot.kind === 'passphrase').length !== 1) {
    throw malformed('The vault file does not have exactly one passphrase slot.')
  }

  return { format: VAULT_FORMAT, version, createdAt, slots, mac }
}

// ---------------------------------------------------------------------------
//  Files
// ---------------------------------------------------------------------------

/**
 * Read and parse a vault file.
 *
 * @throws SecurityError `VAULT_IO_FAILED` | `VAULT_MALFORMED` | `VAULT_UNSUPPORTED_VERSION`
 */
export async function readVaultFile(filePath: string): Promise<Vault> {
  let text: string
  try {
    const handle = await open(filePath, 'r')
    try {
      text = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    throw new SecurityError('VAULT_IO_FAILED', 'The vault file could not be read.')
  }
  return parseVault(text)
}

/**
 * Write a vault, atomically.
 *
 * Write to a temporary file, flush it to the platter, then rename over the target. A
 * rename within a directory is atomic, so an interrupted write leaves either the old
 * vault or the new one and never a half-written file. Losing this file loses the books,
 * which is why it is worth the extra syscalls.
 *
 * The directory entry itself is not fsynced — that is not portable to Windows, and the
 * failure it would protect against (power loss between rename and the OS flushing the
 * directory) leaves the previous vault intact.
 *
 * @throws SecurityError `VAULT_IO_FAILED`
 */
export async function writeVaultFile(filePath: string, vault: Vault): Promise<void> {
  const payload = serializeVault(vault)
  const temporaryPath = `${filePath}.tmp`
  try {
    await mkdir(dirname(filePath), { recursive: true })
    const handle = await open(temporaryPath, 'w', 0o600)
    try {
      await handle.writeFile(payload, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, filePath)
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw new SecurityError('VAULT_IO_FAILED', 'The vault file could not be saved.')
  }
}

/**
 * Create a vault and write it, refusing to overwrite one that already exists.
 *
 * That refusal is not a nicety: overwriting a vault destroys every key that opens the
 * database beside it, and no passphrase or recovery code would ever open those books
 * again.
 *
 * @throws SecurityError `VAULT_IO_FAILED` | `PASSPHRASE_EMPTY`
 */
export async function createVaultFile(
  filePath: string,
  passphrase: string,
  options: CreateVaultOptions = {},
): Promise<{ dek: Buffer; recoveryCodes: readonly string[] }> {
  if (await exists(filePath)) {
    throw new SecurityError('VAULT_IO_FAILED', 'A vault already exists at that location.')
  }
  const { vault, dek, recoveryCodes } = await createVault(passphrase, options)
  try {
    await writeVaultFile(filePath, vault)
  } catch (error) {
    zeroize(dek)
    throw error
  }
  return { dek, recoveryCodes }
}

/** Read a vault file and unlock it with the passphrase. The caller must zero the DEK. */
export async function unlockVaultFile(filePath: string, passphrase: string): Promise<Buffer> {
  return unlockWithPassphrase(await readVaultFile(filePath), passphrase)
}

/**
 * Read a vault file, unlock it with a recovery code, and burn that code on disk before
 * returning.
 *
 * The write happens first and a failure to write is a failure to unlock. A code that was
 * accepted but not recorded as spent would be a code that works twice.
 */
export async function unlockVaultFileWithRecoveryCode(
  filePath: string,
  code: string,
): Promise<Buffer> {
  const unlock = await unlockWithRecoveryCode(await readVaultFile(filePath), code)
  try {
    await writeVaultFile(filePath, unlock.vault)
  } catch (error) {
    zeroize(unlock.dek)
    throw error
  }
  return unlock.dek
}

/** Change the passphrase on a vault file. The DEK, and so the database, is untouched. */
export async function changeVaultFilePassphrase(
  filePath: string,
  currentPassphrase: string,
  newPassphrase: string,
): Promise<void> {
  const vault = await readVaultFile(filePath)
  await writeVaultFile(filePath, await changePassphrase(vault, currentPassphrase, newPassphrase))
}

/**
 * Issue a fresh set of recovery codes for a vault file, invalidating the old set.
 * Requires the passphrase.
 */
export async function replaceVaultFileRecoveryCodes(
  filePath: string,
  passphrase: string,
): Promise<readonly string[]> {
  const vault = await readVaultFile(filePath)
  const dek = await unlockWithPassphrase(vault, passphrase)
  try {
    const replaced = await replaceRecoveryCodes(vault, dek)
    await writeVaultFile(filePath, replaced.vault)
    return replaced.recoveryCodes
  } finally {
    zeroize(dek)
  }
}

// ---------------------------------------------------------------------------
//  Internals
// ---------------------------------------------------------------------------

interface VaultCore {
  readonly version: number
  readonly createdAt: string
  readonly slots: readonly KeySlot[]
}

/** Compute the document MAC and produce the finished vault. */
function seal(core: VaultCore, dek: Buffer): Vault {
  return {
    format: VAULT_FORMAT,
    version: core.version,
    createdAt: core.createdAt,
    slots: core.slots,
    mac: computeMac(core, dek),
  }
}

/**
 * Check the document MAC against a DEK that has just been unwrapped.
 *
 * On failure the DEK is zeroed before throwing: a vault that fails this check is a
 * vault whose slot list has been edited, and the caller gets nothing.
 */
function checkIntegrity(vault: Vault, dek: Buffer): Buffer {
  const expected = computeMac(vault, dek)
  try {
    if (!constantTimeEqual(expected, vault.mac)) {
      zeroize(dek)
      throw tampered()
    }
  } finally {
    zeroize(expected)
  }
  return dek
}

function computeMac(core: VaultCore, dek: Buffer): Buffer {
  const macKey = deriveSubkey(dek, VAULT_MAC_INFO, 32)
  try {
    return createHmac('sha256', macKey).update(canonicalBytes(core)).digest()
  } finally {
    zeroize(macKey)
  }
}

/**
 * The exact bytes the MAC covers.
 *
 * Built field by field in a fixed order rather than by serialising an object, so the
 * result cannot drift with a JSON formatting change, a key reordering, or a future
 * field arriving with an undefined value. Every field that a tamperer might want to
 * edit is in here — including each slot's spent marker.
 */
function canonicalBytes(core: VaultCore): Buffer {
  const lines: string[] = [
    `${VAULT_FORMAT}/v${core.version}`,
    `createdAt=${core.createdAt}`,
    `slots=${core.slots.length}`,
  ]
  for (const slot of core.slots) {
    const wrapped =
      slot.wrapped === null
        ? 'spent'
        : [
            slot.wrapped.nonce.toString('base64'),
            slot.wrapped.ciphertext.toString('base64'),
            slot.wrapped.tag.toString('base64'),
          ].join('.')
    lines.push(
      [
        `id=${slot.id}`,
        `kind=${slot.kind}`,
        `kdf=${kdfToken(slot.kdf)}`,
        `salt=${slot.salt.toString('base64')}`,
        `verifier=${slot.verifier.toString('base64')}`,
        `wrapped=${wrapped}`,
        `createdAt=${slot.createdAt}`,
        `usedAt=${slot.usedAt ?? '-'}`,
      ].join('|'),
    )
  }
  return Buffer.from(lines.join('\n'), 'utf8')
}

/**
 * The associated data bound into a slot's AES-GCM wrap: everything about the slot that
 * the file states in the clear. Editing any of it makes the wrap fail to open.
 */
function slotAad(
  version: number,
  slot: Pick<KeySlot, 'id' | 'kind' | 'kdf'>,
  salt: Buffer,
): Buffer {
  return Buffer.from(
    [
      `${VAULT_FORMAT}/v${version}`,
      `id=${slot.id}`,
      `kind=${slot.kind}`,
      `kdf=${kdfToken(slot.kdf)}`,
      `salt=${salt.toString('base64')}`,
    ].join('|'),
    'utf8',
  )
}

function kdfToken(kdf: Argon2Params): string {
  return `${kdf.algorithm},m=${kdf.memoryCost},t=${kdf.timeCost},p=${kdf.parallelism}`
}

async function buildSlot(input: {
  version: number
  id: string
  kind: KeySlotKind
  kdf: Argon2Params
  secretOf: () => Buffer
  dek: Buffer
  createdAt: string
}): Promise<KeySlot> {
  const header = { id: input.id, kind: input.kind, kdf: input.kdf }
  const secret = input.secretOf()
  try {
    const wrapping = await wrapDekWithSecret(input.dek, secret, {
      kdf: input.kdf,
      aad: (salt) => slotAad(input.version, header, salt),
    })
    return {
      ...header,
      salt: wrapping.salt,
      verifier: wrapping.verifier,
      wrapped: wrapping.wrapped,
      createdAt: input.createdAt,
      usedAt: null,
    }
  } finally {
    zeroize(secret)
  }
}

/** Destroy a slot's wrapped key and re-seal the vault. */
function spendSlot(vault: Vault, slotId: string, dek: Buffer): Vault {
  const spentAt = nowIso()
  const slots = vault.slots.map((slot) =>
    slot.id === slotId ? { ...slot, wrapped: null, usedAt: spentAt } : slot,
  )
  return seal({ version: vault.version, createdAt: vault.createdAt, slots }, dek)
}

/** Does `secret` belong to this slot? Used to recognise a spent code. */
async function matchesSlot(secret: Buffer, slot: KeySlot): Promise<boolean> {
  const { kek, verifier } = await deriveSlotKeys(secret, slot.salt, slot.kdf)
  try {
    return constantTimeEqual(verifier, slot.verifier)
  } finally {
    zeroize(kek, verifier)
  }
}

function wrappingOf(slot: KeySlot): DekWrapping {
  if (slot.wrapped === null) {
    throw new SecurityError('VAULT_MALFORMED', 'That key slot has already been used.')
  }
  return { salt: slot.salt, verifier: slot.verifier, wrapped: slot.wrapped }
}

function passphraseSlot(vault: Vault): KeySlot {
  const slot = vault.slots.find((candidate) => candidate.kind === 'passphrase')
  if (slot === undefined || slot.wrapped === null) {
    throw new SecurityError('VAULT_MALFORMED', 'This vault has no passphrase on file.')
  }
  return slot
}

function recoverySlotId(index: number): string {
  return `recovery-${index + 1}`
}

function nowIso(): string {
  return new Date().toISOString()
}

function tampered(): SecurityError {
  return new SecurityError(
    'VAULT_TAMPERED',
    'The vault file has been altered and can no longer be trusted. Restore it from a backup.',
  )
}

function malformed(message: string): SecurityError {
  return new SecurityError('VAULT_MALFORMED', message)
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

// ---- Parsing helpers. Every one of these rejects rather than coerces. ----

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw malformed('The vault file is not readable.')
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw malformed('The vault file is not in the expected shape.')
  }
  return value as Record<string, unknown>
}

function asInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function asTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)) {
    throw malformed('The vault file has a timestamp it cannot read.')
  }
  if (Number.isNaN(Date.parse(value))) {
    throw malformed('The vault file has a timestamp it cannot read.')
  }
  return value
}

function asSlotId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw malformed('The vault file has a key slot with an unusable name.')
  }
  return value
}

/**
 * Decode a base64 field of an exactly known length.
 *
 * `Buffer.from(value, 'base64')` is famously forgiving — it skips characters it does not
 * recognise and silently truncates, so garbage decodes to something. Re-encoding and
 * comparing is what turns that into a rejection.
 */
function asBase64(value: unknown, expectedBytes: number, field: string): Buffer {
  if (typeof value !== 'string') {
    throw malformed(`The vault file is missing ${field}.`)
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length !== expectedBytes || decoded.toString('base64') !== value) {
    throw malformed(`The vault file has an unreadable value for ${field}.`)
  }
  return decoded
}

function asWrapped(value: unknown): WrappedDek | null {
  if (value === null) {
    return null
  }
  const record = asRecord(value)
  return {
    nonce: asBase64(record['nonce'], NONCE_BYTES, 'a wrapped key nonce'),
    ciphertext: asBase64(record['ciphertext'], DEK_BYTES, 'a wrapped key'),
    tag: asBase64(record['tag'], TAG_BYTES, 'a wrapped key tag'),
  }
}

function asKdfParams(value: unknown): Argon2Params {
  const record = asRecord(value)
  const memoryCost = asInteger(record['memoryCost'])
  const timeCost = asInteger(record['timeCost'])
  const parallelism = asInteger(record['parallelism'])
  if (
    record['algorithm'] !== 'argon2id' ||
    memoryCost === null ||
    timeCost === null ||
    parallelism === null
  ) {
    throw malformed('The vault file has key derivation settings it cannot read.')
  }
  /* Bounds first, then the shared validator. A file claiming 64 TiB of memory must be
   * rejected as a bad file, never handed to Argon2 to find out. */
  if (memoryCost < MIN_MEMORY_COST || memoryCost > MAX_MEMORY_COST) {
    throw new SecurityError(
      'KDF_PARAMS_INVALID',
      'The vault file asks for key derivation settings outside the range this version accepts.',
    )
  }
  const params: Argon2Params = { algorithm: 'argon2id', memoryCost, timeCost, parallelism }
  assertValidKdfParams(params)
  return params
}
