import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type Argon2Params, MIN_MEMORY_COST, PASSPHRASE_KDF, RECOVERY_KDF } from './argon2'
import { dekToHex, zeroize } from './dek'
import { SecurityError } from './errors'
import { generateRecoveryCode } from './recovery-codes'
import {
  type CreateVaultOptions,
  type Vault,
  type VaultDocument,
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
  unlockVaultFile,
  unlockVaultFileWithRecoveryCode,
  unlockWithPassphrase,
  unlockWithRecoveryCode,
  writeVaultFile,
} from './vault'

/*
 * Real Argon2id, at the cheapest parameters the module will accept. Every property
 * under test is about the construction, not about how long a derivation takes, and the
 * production profile is exercised once at the bottom of this file.
 */
const FAST: Argon2Params = {
  algorithm: 'argon2id',
  memoryCost: MIN_MEMORY_COST,
  timeCost: 1,
  parallelism: 1,
}
const FAST_OPTIONS: CreateVaultOptions = { kdf: { passphrase: FAST, recovery: FAST } }

const PASSPHRASE = 'a quiet ledger keeps its own counsel'
const NEW_PASSPHRASE = 'nine invoices and a cup of tea'

describe('createVault', () => {
  it('issues five distinct, well-formed recovery codes', async () => {
    const { recoveryCodes } = await createVault(PASSPHRASE, FAST_OPTIONS)
    expect(recoveryCodes).toHaveLength(5)
    expect(new Set(recoveryCodes).size).toBe(5)
    for (const code of recoveryCodes) {
      expect(code).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/)
    }
  })

  it('builds one passphrase slot and one slot per recovery code', async () => {
    const { vault } = await createVault(PASSPHRASE, FAST_OPTIONS)
    expect(vault.format).toBe(VAULT_FORMAT)
    expect(vault.version).toBe(VAULT_VERSION)
    expect(vault.slots.filter((slot) => slot.kind === 'passphrase')).toHaveLength(1)
    expect(vault.slots.filter((slot) => slot.kind === 'recovery')).toHaveLength(5)
    expect(remainingRecoveryCodes(vault)).toBe(5)
  })

  /* The load-bearing property of the whole design: every secret opens the SAME key.
   * If this ever stopped being true, a recovery code would decrypt nothing. */
  it('wraps one single DEK in every slot', async () => {
    const { vault, dek, recoveryCodes } = await createVault(PASSPHRASE, FAST_OPTIONS)

    const viaPassphrase = await unlockWithPassphrase(vault, PASSPHRASE)
    expect(viaPassphrase.equals(dek)).toBe(true)

    for (const code of recoveryCodes) {
      const unlocked = await unlockWithRecoveryCode(vault, code)
      expect(unlocked.dek.equals(dek)).toBe(true)
    }
  })

  it('generates a different DEK for every company', async () => {
    const first = await createVault(PASSPHRASE, FAST_OPTIONS)
    const second = await createVault(PASSPHRASE, FAST_OPTIONS)
    expect(first.dek.equals(second.dek)).toBe(false)
  })

  it('refuses an empty passphrase', async () => {
    await expect(createVault('', FAST_OPTIONS)).rejects.toThrow(
      expect.objectContaining({ code: 'PASSPHRASE_EMPTY' }),
    )
  })

  it('refuses KDF parameters outside the accepted range', async () => {
    await expect(
      createVault(PASSPHRASE, { kdf: { passphrase: { ...FAST, memoryCost: 4 } } }),
    ).rejects.toThrow(expect.objectContaining({ code: 'KDF_PARAMS_INVALID' }))
  })
})

describe('unlockWithPassphrase', () => {
  it('returns the DEK for the right passphrase', async () => {
    const { vault, dek } = await createVault(PASSPHRASE, FAST_OPTIONS)
    expect((await unlockWithPassphrase(vault, PASSPHRASE)).equals(dek)).toBe(true)
  })

  it('rejects a wrong passphrase', async () => {
    const { vault } = await createVault(PASSPHRASE, FAST_OPTIONS)
    await expect(unlockWithPassphrase(vault, `${PASSPHRASE}!`)).rejects.toThrow(
      expect.objectContaining({ code: 'PASSPHRASE_INVALID' }),
    )
  })

  it('rejects a passphrase that belongs to a different company', async () => {
    const first = await createVault(PASSPHRASE, FAST_OPTIONS)
    await expect(unlockWithPassphrase(first.vault, NEW_PASSPHRASE)).rejects.toThrow(
      expect.objectContaining({ code: 'PASSPHRASE_INVALID' }),
    )
  })

  it('rejects an empty passphrase without doing any work', async () => {
    const { vault } = await createVault(PASSPHRASE, FAST_OPTIONS)
    await expect(unlockWithPassphrase(vault, '')).rejects.toThrow(
      expect.objectContaining({ code: 'PASSPHRASE_EMPTY' }),
    )
  })

  it('is case sensitive and whitespace sensitive', async () => {
    const { vault } = await createVault(PASSPHRASE, FAST_OPTIONS)
    await expect(unlockWithPassphrase(vault, PASSPHRASE.toUpperCase())).rejects.toThrow(
      SecurityError,
    )
    await expect(unlockWithPassphrase(vault, ` ${PASSPHRASE}`)).rejects.toThrow(SecurityError)
  })
})

describe('changePassphrase', () => {
  it('keeps the very same DEK, so the database is never re-encrypted', async () => {
    const { vault, dek } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const changed = await changePassphrase(vault, PASSPHRASE, NEW_PASSPHRASE)
    expect((await unlockWithPassphrase(changed, NEW_PASSPHRASE)).equals(dek)).toBe(true)
  })

  it('retires the old passphrase', async () => {
    const { vault } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const changed = await changePassphrase(vault, PASSPHRASE, NEW_PASSPHRASE)
    await expect(unlockWithPassphrase(changed, PASSPHRASE)).rejects.toThrow(
      expect.objectContaining({ code: 'PASSPHRASE_INVALID' }),
    )
  })

  it('leaves every recovery code working', async () => {
    const { vault, dek, recoveryCodes } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const changed = await changePassphrase(vault, PASSPHRASE, NEW_PASSPHRASE)
    for (const code of recoveryCodes) {
      expect((await unlockWithRecoveryCode(changed, code)).dek.equals(dek)).toBe(true)
    }
  })

  it('rewrites only the passphrase slot', async () => {
    const { vault } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const changed = await changePassphrase(vault, PASSPHRASE, NEW_PASSPHRASE)
    const before = slotOf(vault, 'passphrase')
    const after = slotOf(changed, 'passphrase')
    expect(after.salt.equals(before.salt)).toBe(false)
    for (const slot of vault.slots.filter((candidate) => candidate.kind === 'recovery')) {
      expect(slotOf(changed, slot.id).salt.equals(slot.salt)).toBe(true)
    }
  })

  it('refuses a wrong current passphrase and changes nothing', async () => {
    const { vault } = await createVault(PASSPHRASE, FAST_OPTIONS)
    await expect(changePassphrase(vault, 'not it', NEW_PASSPHRASE)).rejects.toThrow(
      expect.objectContaining({ code: 'PASSPHRASE_INVALID' }),
    )
    await expect(unlockWithPassphrase(vault, PASSPHRASE)).resolves.toBeDefined()
  })

  it('refuses an empty new passphrase', async () => {
    const { vault } = await createVault(PASSPHRASE, FAST_OPTIONS)
    await expect(changePassphrase(vault, PASSPHRASE, '  ')).rejects.toThrow(
      expect.objectContaining({ code: 'PASSPHRASE_EMPTY' }),
    )
  })

  it('can be done twice in a row', async () => {
    const { vault, dek } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const once = await changePassphrase(vault, PASSPHRASE, NEW_PASSPHRASE)
    const twice = await changePassphrase(once, NEW_PASSPHRASE, 'a third one entirely')
    expect((await unlockWithPassphrase(twice, 'a third one entirely')).equals(dek)).toBe(true)
  })
})

describe('unlockWithRecoveryCode', () => {
  it('opens the books and returns the same DEK', async () => {
    const { vault, dek, recoveryCodes } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const unlocked = await unlockWithRecoveryCode(vault, firstCode(recoveryCodes))
    expect(unlocked.dek.equals(dek)).toBe(true)
    expect(unlocked.slotId).toMatch(/^recovery-\d$/)
  })

  it('accepts a code typed carelessly', async () => {
    const { vault, dek, recoveryCodes } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const typed = ` ${firstCode(recoveryCodes).toLowerCase().replace(/-/g, ' ')}\n`
    expect((await unlockWithRecoveryCode(vault, typed)).dek.equals(dek)).toBe(true)
  })

  /* Single use, proven: the code works, then the very same code does not. */
  it('works exactly once', async () => {
    const { vault, recoveryCodes } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const code = firstCode(recoveryCodes)

    const spent = await unlockWithRecoveryCode(vault, code)

    await expect(unlockWithRecoveryCode(spent.vault, code)).rejects.toThrow(
      expect.objectContaining({ code: 'RECOVERY_CODE_ALREADY_USED' }),
    )
  })

  it('destroys the wrapped key rather than only marking the slot', async () => {
    const { vault, recoveryCodes } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const spent = await unlockWithRecoveryCode(vault, firstCode(recoveryCodes))
    const slot = slotOf(spent.vault, spent.slotId)

    expect(slot.wrapped).toBeNull()
    expect(slot.usedAt).not.toBeNull()
    expect(documentSlot(spent.vault, spent.slotId).wrapped).toBeNull()
  })

  it('leaves the other four codes working', async () => {
    const { vault, dek, recoveryCodes } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const spent = await unlockWithRecoveryCode(vault, firstCode(recoveryCodes))

    expect(remainingRecoveryCodes(spent.vault)).toBe(4)
    for (const code of recoveryCodes.slice(1)) {
      expect((await unlockWithRecoveryCode(spent.vault, code)).dek.equals(dek)).toBe(true)
    }
  })

  it('leaves the passphrase working', async () => {
    const { vault, dek, recoveryCodes } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const spent = await unlockWithRecoveryCode(vault, firstCode(recoveryCodes))
    expect((await unlockWithPassphrase(spent.vault, PASSPHRASE)).equals(dek)).toBe(true)
  })

  it('spends codes one at a time until none are left', async () => {
    const created = await createVault(PASSPHRASE, FAST_OPTIONS)
    let vault = created.vault
    for (const code of created.recoveryCodes) {
      const unlocked = await unlockWithRecoveryCode(vault, code)
      vault = unlocked.vault
    }
    expect(remainingRecoveryCodes(vault)).toBe(0)
    await expect(unlockWithRecoveryCode(vault, firstCode(created.recoveryCodes))).rejects.toThrow(
      expect.objectContaining({ code: 'RECOVERY_CODE_ALREADY_USED' }),
    )
    // The passphrase is untouched by any of it.
    expect((await unlockWithPassphrase(vault, PASSPHRASE)).equals(created.dek)).toBe(true)
  })

  it('rejects a well-formed code from a different company', async () => {
    const { vault } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const stranger = await createVault(PASSPHRASE, FAST_OPTIONS)
    await expect(unlockWithRecoveryCode(vault, firstCode(stranger.recoveryCodes))).rejects.toThrow(
      expect.objectContaining({ code: 'RECOVERY_CODE_INVALID' }),
    )
  })

  it('rejects a code that never was one', async () => {
    const { vault } = await createVault(PASSPHRASE, FAST_OPTIONS)
    await expect(unlockWithRecoveryCode(vault, 'hello')).rejects.toThrow(
      expect.objectContaining({ code: 'RECOVERY_CODE_MALFORMED' }),
    )
  })

  it('tells a spent code apart from a code that was never issued', async () => {
    const { vault, recoveryCodes } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const spent = await unlockWithRecoveryCode(vault, firstCode(recoveryCodes))

    await expect(unlockWithRecoveryCode(spent.vault, firstCode(recoveryCodes))).rejects.toThrow(
      expect.objectContaining({ code: 'RECOVERY_CODE_ALREADY_USED' }),
    )
    await expect(unlockWithRecoveryCode(spent.vault, generateRecoveryCode())).rejects.toThrow(
      expect.objectContaining({ code: 'RECOVERY_CODE_INVALID' }),
    )
  })
})

describe('setPassphrase', () => {
  /* The flow after a recovery: the user has the DEK and no passphrase they remember. */
  it('sets a new passphrase from a DEK recovered with a code', async () => {
    const { vault, dek, recoveryCodes } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const recovered = await unlockWithRecoveryCode(vault, firstCode(recoveryCodes))

    const reset = await setPassphrase(recovered.vault, recovered.dek, NEW_PASSPHRASE)

    expect((await unlockWithPassphrase(reset, NEW_PASSPHRASE)).equals(dek)).toBe(true)
    await expect(unlockWithPassphrase(reset, PASSPHRASE)).rejects.toThrow(SecurityError)
    expect(remainingRecoveryCodes(reset)).toBe(4)
  })

  it('refuses an empty passphrase', async () => {
    const { vault, dek } = await createVault(PASSPHRASE, FAST_OPTIONS)
    await expect(setPassphrase(vault, dek, '')).rejects.toThrow(
      expect.objectContaining({ code: 'PASSPHRASE_EMPTY' }),
    )
  })

  /* A vault created with weak parameters is brought up to the production profile the
   * next time its passphrase is written. */
  it('upgrades weak KDF parameters when it rewraps', async () => {
    const { vault, dek } = await createVault(PASSPHRASE, FAST_OPTIONS)
    expect(needsKdfUpgrade(vault)).toBe(true)
    const upgraded = await setPassphrase(vault, dek, NEW_PASSPHRASE)
    expect(slotOf(upgraded, 'passphrase').kdf).toEqual(PASSPHRASE_KDF)
    expect((await unlockWithPassphrase(upgraded, NEW_PASSPHRASE)).equals(dek)).toBe(true)
  })
})

describe('replaceRecoveryCodes', () => {
  it('issues a new set and invalidates the old one', async () => {
    const { vault, dek, recoveryCodes } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const replaced = await replaceRecoveryCodes(vault, dek)

    expect(replaced.recoveryCodes).toHaveLength(5)
    expect(remainingRecoveryCodes(replaced.vault)).toBe(5)

    for (const code of replaced.recoveryCodes) {
      expect((await unlockWithRecoveryCode(replaced.vault, code)).dek.equals(dek)).toBe(true)
    }
    for (const old of recoveryCodes) {
      await expect(unlockWithRecoveryCode(replaced.vault, old)).rejects.toThrow(
        expect.objectContaining({ code: 'RECOVERY_CODE_INVALID' }),
      )
    }
  })

  it('keeps the DEK and the passphrase', async () => {
    const { vault, dek } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const replaced = await replaceRecoveryCodes(vault, dek)
    expect((await unlockWithPassphrase(replaced.vault, PASSPHRASE)).equals(dek)).toBe(true)
  })

  it('clears spent slots as well', async () => {
    const { vault, dek, recoveryCodes } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const spent = await unlockWithRecoveryCode(vault, firstCode(recoveryCodes))
    const replaced = await replaceRecoveryCodes(spent.vault, dek)
    expect(remainingRecoveryCodes(replaced.vault)).toBe(5)
  })
})

describe('serializeVault and parseVault', () => {
  it('round-trips a vault that still unlocks', async () => {
    const { vault, dek, recoveryCodes } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const restored = parseVault(serializeVault(vault))

    expect((await unlockWithPassphrase(restored, PASSPHRASE)).equals(dek)).toBe(true)
    expect((await unlockWithRecoveryCode(restored, firstCode(recoveryCodes))).dek.equals(dek)).toBe(
      true,
    )
  })

  it('round-trips a vault with a spent code, and it stays spent', async () => {
    const { vault, recoveryCodes } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const spent = await unlockWithRecoveryCode(vault, firstCode(recoveryCodes))
    const restored = parseVault(serializeVault(spent.vault))

    expect(remainingRecoveryCodes(restored)).toBe(4)
    await expect(unlockWithRecoveryCode(restored, firstCode(recoveryCodes))).rejects.toThrow(
      expect.objectContaining({ code: 'RECOVERY_CODE_ALREADY_USED' }),
    )
  })

  /* Nothing that could open the books, and nothing the user typed, may appear on disk. */
  it('writes no secret into the file', async () => {
    const { vault, dek, recoveryCodes } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const text = serializeVault(vault)

    expect(text).not.toContain(PASSPHRASE)
    expect(text).not.toContain(dekToHex(dek))
    expect(text).not.toContain(dek.toString('base64'))
    for (const code of recoveryCodes) {
      expect(text).not.toContain(code)
      expect(text).not.toContain(code.replace(/-/g, ''))
    }
  })

  it('records the KDF parameters per slot so they never have to be guessed', async () => {
    const { vault } = await createVault(PASSPHRASE, {
      kdf: { passphrase: FAST, recovery: { ...FAST, timeCost: 2 } },
    })
    const document = toDocument(vault)
    expect(documentSlot(vault, 'passphrase').kdf).toEqual({
      algorithm: 'argon2id',
      memoryCost: FAST.memoryCost,
      timeCost: 1,
      parallelism: 1,
    })
    expect(documentSlot(vault, 'recovery-1').kdf.timeCost).toBe(2)
    expect(document.version).toBe(VAULT_VERSION)
  })

  it.each([
    ['text that is not JSON', 'not json at all'],
    ['a JSON array', '[]'],
    ['a JSON number', '7'],
    ['null', 'null'],
  ])('rejects %s', (_label, input) => {
    expect(() => parseVault(input)).toThrow(expect.objectContaining({ code: 'VAULT_MALFORMED' }))
  })

  it('rejects a file that is not a vault', async () => {
    const document = toDocument((await createVault(PASSPHRASE, FAST_OPTIONS)).vault)
    document.format = 'something.else'
    expect(() => parseVault(document)).toThrow(expect.objectContaining({ code: 'VAULT_MALFORMED' }))
  })

  it('rejects a vault from a newer version of Coffer, by name', async () => {
    const document = toDocument((await createVault(PASSPHRASE, FAST_OPTIONS)).vault)
    document.version = VAULT_VERSION + 1
    expect(() => parseVault(document)).toThrow(
      expect.objectContaining({ code: 'VAULT_UNSUPPORTED_VERSION' }),
    )
  })

  it.each<[string, (document: VaultDocument) => void]>([
    ['no slots', (document) => (document.slots = [])],
    [
      'no passphrase slot',
      (document) => (document.slots = document.slots.filter((slot) => slot.kind !== 'passphrase')),
    ],
    [
      'two passphrase slots',
      (document) => {
        const passphrase = document.slots.filter((slot) => slot.kind === 'passphrase')
        document.slots.push({ ...requireFirst(passphrase), id: 'passphrase-2' })
      },
    ],
    [
      'two slots with the same name',
      (document) => document.slots.push({ ...requireFirst(document.slots) }),
    ],
    [
      'a slot of an unknown kind',
      (document) => (requireFirst(document.slots).kind = 'maintainer-escrow'),
    ],
    ['a slot with an unusable name', (document) => (requireFirst(document.slots).id = '../../etc')],
    [
      'a salt of the wrong length',
      (document) => (requireFirst(document.slots).salt = Buffer.alloc(8).toString('base64')),
    ],
    [
      'a verifier of the wrong length',
      (document) => (requireFirst(document.slots).verifier = Buffer.alloc(16).toString('base64')),
    ],
    [
      'a wrapped key of the wrong length',
      (document) => {
        const slot = requireFirst(document.slots)
        if (slot.wrapped !== null) {
          slot.wrapped.ciphertext = Buffer.alloc(48).toString('base64')
        }
      },
    ],
    [
      'base64 that is not base64',
      (document) => (requireFirst(document.slots).salt = 'not base64 at all!!!'),
    ],
    ['a missing integrity value', (document) => (document.mac = '')],
    ['an unreadable timestamp', (document) => (document.createdAt = 'last Tuesday')],
    [
      'a spent slot that still claims to hold a key',
      (document) => (requireFirst(document.slots).usedAt = new Date().toISOString()),
    ],
    [
      'a passphrase slot with no key in it',
      (document) => {
        const slot = requireFirst(document.slots)
        slot.wrapped = null
        slot.usedAt = new Date().toISOString()
      },
    ],
  ])('rejects a vault with %s', async (_label, damage) => {
    const document = toDocument((await createVault(PASSPHRASE, FAST_OPTIONS)).vault)
    damage(document)
    expect(() => parseVault(document)).toThrow(SecurityError)
  })

  /* A hostile file must not be able to make the app allocate its way to death. */
  it('rejects KDF parameters that would exhaust memory', async () => {
    const document = toDocument((await createVault(PASSPHRASE, FAST_OPTIONS)).vault)
    requireFirst(document.slots).kdf.memoryCost = 64 * 1024 * 1024
    expect(() => parseVault(document)).toThrow(
      expect.objectContaining({ code: 'KDF_PARAMS_INVALID' }),
    )
  })

  it('rejects KDF parameters too weak to be a KDF', async () => {
    const document = toDocument((await createVault(PASSPHRASE, FAST_OPTIONS)).vault)
    requireFirst(document.slots).kdf.memoryCost = 8
    expect(() => parseVault(document)).toThrow(
      expect.objectContaining({ code: 'KDF_PARAMS_INVALID' }),
    )
  })
})

describe('tampering', () => {
  /* Every one of these asserts the same thing in a different place: an altered vault
   * fails, loudly, and never hands back a key that would decrypt into nonsense. */

  it.each(['ciphertext', 'tag', 'nonce'] as const)(
    'fails authentication when a wrapped key %s is altered',
    async (field) => {
      const { vault } = await createVault(PASSPHRASE, FAST_OPTIONS)
      const damaged = damage(vault, (document) => {
        const slot = documentSlotOf(document, 'passphrase')
        if (slot.wrapped !== null) {
          slot.wrapped[field] = flipBase64(slot.wrapped[field])
        }
      })
      await expect(unlockWithPassphrase(damaged, PASSPHRASE)).rejects.toThrow(
        expect.objectContaining({ code: 'VAULT_TAMPERED' }),
      )
    },
  )

  /* The slot's name is bound into its own AES-GCM wrap as associated data, and into the
   * document MAC. Renaming it therefore fails from either direction. */
  it('fails when a slot is renamed', async () => {
    const { vault, recoveryCodes } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const damaged = damage(vault, (document) => {
      documentSlotOf(document, 'recovery-1').id = 'recovery-9'
    })

    // Caught by the document MAC.
    await expect(unlockWithPassphrase(damaged, PASSPHRASE)).rejects.toThrow(
      expect.objectContaining({ code: 'VAULT_TAMPERED' }),
    )
    // Caught by the renamed slot's own associated data, before the MAC is ever reached.
    await expect(unlockWithRecoveryCode(damaged, firstCode(recoveryCodes))).rejects.toThrow(
      expect.objectContaining({ code: 'VAULT_TAMPERED' }),
    )
  })

  /* The attack the per-slot tag cannot see and the document MAC can: putting a spent
   * recovery code back into service by editing the file. */
  it('fails when a spent recovery slot is resurrected', async () => {
    const { vault, recoveryCodes } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const original = toDocument(vault)
    const spent = await unlockWithRecoveryCode(vault, firstCode(recoveryCodes))

    const resurrected = damage(spent.vault, (document) => {
      const slot = documentSlotOf(document, spent.slotId)
      slot.wrapped = documentSlotOf(original, spent.slotId).wrapped
      slot.usedAt = null
    })

    await expect(unlockWithPassphrase(resurrected, PASSPHRASE)).rejects.toThrow(
      expect.objectContaining({ code: 'VAULT_TAMPERED' }),
    )
    await expect(unlockWithRecoveryCode(resurrected, firstCode(recoveryCodes))).rejects.toThrow(
      expect.objectContaining({ code: 'VAULT_TAMPERED' }),
    )
  })

  it('fails when a slot is removed', async () => {
    const { vault } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const damaged = damage(vault, (document) => {
      document.slots = document.slots.filter((slot) => slot.id !== 'recovery-5')
    })
    await expect(unlockWithPassphrase(damaged, PASSPHRASE)).rejects.toThrow(
      expect.objectContaining({ code: 'VAULT_TAMPERED' }),
    )
  })

  it('fails when a slot is added', async () => {
    const { vault } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const damaged = damage(vault, (document) => {
      document.slots.push({ ...documentSlotOf(document, 'recovery-1'), id: 'recovery-6' })
    })
    await expect(unlockWithPassphrase(damaged, PASSPHRASE)).rejects.toThrow(
      expect.objectContaining({ code: 'VAULT_TAMPERED' }),
    )
  })

  it('fails when the integrity value itself is replaced', async () => {
    const { vault } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const damaged = damage(vault, (document) => {
      document.mac = Buffer.alloc(32, 1).toString('base64')
    })
    await expect(unlockWithPassphrase(damaged, PASSPHRASE)).rejects.toThrow(
      expect.objectContaining({ code: 'VAULT_TAMPERED' }),
    )
  })

  it('fails when the creation date is edited', async () => {
    const { vault } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const damaged = damage(vault, (document) => {
      document.createdAt = '2001-01-01T00:00:00.000Z'
    })
    await expect(unlockWithPassphrase(damaged, PASSPHRASE)).rejects.toThrow(
      expect.objectContaining({ code: 'VAULT_TAMPERED' }),
    )
  })

  /* Editing the salt or the KDF parameters changes the key that gets derived, so it is
   * indistinguishable from a wrong passphrase. It still fails closed, which is the
   * property that matters — no key comes back either way. */
  it.each<[string, (document: VaultDocument) => void]>([
    [
      'the salt',
      (document) =>
        (documentSlotOf(document, 'passphrase').salt = flipBase64(
          documentSlotOf(document, 'passphrase').salt,
        )),
    ],
    ['the KDF parameters', (document) => (documentSlotOf(document, 'passphrase').kdf.timeCost = 2)],
  ])('fails closed when %s is altered', async (_label, edit) => {
    const { vault } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const damaged = damage(vault, edit)
    await expect(unlockWithPassphrase(damaged, PASSPHRASE)).rejects.toThrow(SecurityError)
  })

  it('does not let a stranger swap in a vault of their own making', async () => {
    const stranger = await createVault('the attacker knows this one', FAST_OPTIONS)
    // A wholesale replacement is internally consistent and will unlock for the attacker.
    // What it cannot do is produce the original DEK, so the database stays shut.
    const opened = await unlockWithPassphrase(stranger.vault, 'the attacker knows this one')
    const original = await createVault(PASSPHRASE, FAST_OPTIONS)
    expect(opened.equals(original.dek)).toBe(false)
  })
})

describe('describeVault', () => {
  it('summarises without exposing anything', async () => {
    const { vault, dek, recoveryCodes } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const spent = await unlockWithRecoveryCode(vault, firstCode(recoveryCodes))
    const summary = describeVault(spent.vault)

    expect(summary.recoveryCodesIssued).toBe(5)
    expect(summary.recoveryCodesRemaining).toBe(4)
    expect(summary.slots.filter((slot) => slot.isSpent)).toHaveLength(1)

    const asText = JSON.stringify(summary)
    expect(asText).not.toContain(PASSPHRASE)
    expect(asText).not.toContain(dekToHex(dek))
    for (const code of recoveryCodes) {
      expect(asText).not.toContain(code.replace(/-/g, ''))
    }
  })
})

describe('needsKdfUpgrade', () => {
  it('is true for a vault written with weaker parameters', async () => {
    const { vault } = await createVault(PASSPHRASE, FAST_OPTIONS)
    expect(needsKdfUpgrade(vault)).toBe(true)
  })

  it('is false for a vault written at the current profile', async () => {
    const { vault } = await createVault(PASSPHRASE, {
      recoveryCodeCount: 1,
      kdf: { passphrase: PASSPHRASE_KDF, recovery: RECOVERY_KDF },
    })
    expect(needsKdfUpgrade(vault)).toBe(false)
  })
})

describe('vault files', () => {
  let directory: string
  let vaultPath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'coffer-vault-'))
    vaultPath = join(directory, 'company.vault')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('creates, writes and unlocks', async () => {
    const created = await createVaultFile(vaultPath, PASSPHRASE, FAST_OPTIONS)
    const dek = await unlockVaultFile(vaultPath, PASSPHRASE)
    expect(dek.equals(created.dek)).toBe(true)
    expect(created.recoveryCodes).toHaveLength(5)
  })

  it('writes a file that is valid JSON and holds no secret', async () => {
    const created = await createVaultFile(vaultPath, PASSPHRASE, FAST_OPTIONS)
    const text = await readFile(vaultPath, 'utf8')

    expect(() => JSON.parse(text) as unknown).not.toThrow()
    expect(text).not.toContain(PASSPHRASE)
    expect(text).not.toContain(dekToHex(created.dek))
    for (const code of created.recoveryCodes) {
      expect(text).not.toContain(code.replace(/-/g, ''))
    }
  })

  /* Overwriting a vault destroys every key to the database beside it. */
  it('refuses to overwrite an existing vault', async () => {
    await createVaultFile(vaultPath, PASSPHRASE, FAST_OPTIONS)
    await expect(createVaultFile(vaultPath, NEW_PASSPHRASE, FAST_OPTIONS)).rejects.toThrow(
      expect.objectContaining({ code: 'VAULT_IO_FAILED' }),
    )
    await expect(unlockVaultFile(vaultPath, PASSPHRASE)).resolves.toBeDefined()
  })

  it('leaves no temporary file behind', async () => {
    await createVaultFile(vaultPath, PASSPHRASE, FAST_OPTIONS)
    expect(await readdir(directory)).toEqual(['company.vault'])
  })

  it('creates missing directories on the way', async () => {
    const nested = join(directory, 'a', 'b', 'company.vault')
    await createVaultFile(nested, PASSPHRASE, FAST_OPTIONS)
    await expect(unlockVaultFile(nested, PASSPHRASE)).resolves.toBeDefined()
  })

  /* The burn must survive the process dying immediately after the unlock returns. */
  it('burns a recovery code on disk, not just in memory', async () => {
    const created = await createVaultFile(vaultPath, PASSPHRASE, FAST_OPTIONS)
    const code = firstCode(created.recoveryCodes)

    const dek = await unlockVaultFileWithRecoveryCode(vaultPath, code)
    expect(dek.equals(created.dek)).toBe(true)

    // Re-read from disk, as a fresh process would.
    await expect(unlockVaultFileWithRecoveryCode(vaultPath, code)).rejects.toThrow(
      expect.objectContaining({ code: 'RECOVERY_CODE_ALREADY_USED' }),
    )
    expect(remainingRecoveryCodes(await readVaultFile(vaultPath))).toBe(4)
  })

  it('changes the passphrase on disk without touching the DEK', async () => {
    const created = await createVaultFile(vaultPath, PASSPHRASE, FAST_OPTIONS)
    await changeVaultFilePassphrase(vaultPath, PASSPHRASE, NEW_PASSPHRASE)

    expect((await unlockVaultFile(vaultPath, NEW_PASSPHRASE)).equals(created.dek)).toBe(true)
    await expect(unlockVaultFile(vaultPath, PASSPHRASE)).rejects.toThrow(
      expect.objectContaining({ code: 'PASSPHRASE_INVALID' }),
    )
  })

  it('does not rewrite the file when the current passphrase is wrong', async () => {
    await createVaultFile(vaultPath, PASSPHRASE, FAST_OPTIONS)
    const before = await readFile(vaultPath, 'utf8')
    await expect(changeVaultFilePassphrase(vaultPath, 'wrong', NEW_PASSPHRASE)).rejects.toThrow(
      SecurityError,
    )
    expect(await readFile(vaultPath, 'utf8')).toBe(before)
  })

  it('replaces the recovery codes on disk', async () => {
    const created = await createVaultFile(vaultPath, PASSPHRASE, FAST_OPTIONS)
    const replaced = await replaceVaultFileRecoveryCodes(vaultPath, PASSPHRASE)

    expect(replaced).toHaveLength(5)
    await expect(
      unlockVaultFileWithRecoveryCode(vaultPath, firstCode(created.recoveryCodes)),
    ).rejects.toThrow(expect.objectContaining({ code: 'RECOVERY_CODE_INVALID' }))
    await expect(
      unlockVaultFileWithRecoveryCode(vaultPath, firstCode(replaced)),
    ).resolves.toBeDefined()
  })

  it('reports a missing file rather than throwing something raw', async () => {
    await expect(readVaultFile(join(directory, 'nothing.vault'))).rejects.toThrow(
      expect.objectContaining({ code: 'VAULT_IO_FAILED' }),
    )
  })

  it('reports a file full of rubbish as a malformed vault', async () => {
    await writeFile(vaultPath, 'this used to be a vault', 'utf8')
    await expect(readVaultFile(vaultPath)).rejects.toThrow(
      expect.objectContaining({ code: 'VAULT_MALFORMED' }),
    )
  })

  it('detects a vault file edited on disk', async () => {
    const created = await createVaultFile(vaultPath, PASSPHRASE, FAST_OPTIONS)
    zeroize(created.dek)

    const document = JSON.parse(await readFile(vaultPath, 'utf8')) as VaultDocument
    const slot = documentSlotOf(document, 'passphrase')
    if (slot.wrapped !== null) {
      slot.wrapped.ciphertext = flipBase64(slot.wrapped.ciphertext)
    }
    await writeFile(vaultPath, JSON.stringify(document), 'utf8')

    await expect(unlockVaultFile(vaultPath, PASSPHRASE)).rejects.toThrow(
      expect.objectContaining({ code: 'VAULT_TAMPERED' }),
    )
  })

  it('replaces a vault atomically when it rewrites one', async () => {
    const created = await createVaultFile(vaultPath, PASSPHRASE, FAST_OPTIONS)
    const vault = await readVaultFile(vaultPath)
    await writeVaultFile(vaultPath, await changePassphrase(vault, PASSPHRASE, NEW_PASSPHRASE))

    expect(await readdir(directory)).toEqual(['company.vault'])
    expect((await unlockVaultFile(vaultPath, NEW_PASSPHRASE)).equals(created.dek)).toBe(true)
  })
})

describe('with the parameters Coffer actually ships', () => {
  /* Everything above runs at the cheapest accepted parameters. This one pays the real
   * cost once, so the profile in argon2.ts is known to work end to end. */
  it('creates, unlocks, changes the passphrase and recovers', async () => {
    const { vault, dek, recoveryCodes } = await createVault(PASSPHRASE, { recoveryCodeCount: 2 })

    expect(slotOf(vault, 'passphrase').kdf).toEqual(PASSPHRASE_KDF)
    expect(slotOf(vault, 'recovery-1').kdf).toEqual(RECOVERY_KDF)
    expect(needsKdfUpgrade(vault)).toBe(false)

    expect((await unlockWithPassphrase(vault, PASSPHRASE)).equals(dek)).toBe(true)

    const changed = await changePassphrase(vault, PASSPHRASE, NEW_PASSPHRASE)
    expect((await unlockWithPassphrase(changed, NEW_PASSPHRASE)).equals(dek)).toBe(true)

    const recovered = await unlockWithRecoveryCode(changed, firstCode(recoveryCodes))
    expect(recovered.dek.equals(dek)).toBe(true)
    await expect(unlockWithRecoveryCode(recovered.vault, firstCode(recoveryCodes))).rejects.toThrow(
      expect.objectContaining({ code: 'RECOVERY_CODE_ALREADY_USED' }),
    )
  })
})

// ---- helpers ----

function toDocument(vault: Vault): VaultDocument {
  return JSON.parse(serializeVault(vault)) as VaultDocument
}

/** Edit the on-disk shape and parse it back, the way an attacker with an editor would. */
function damage(vault: Vault, edit: (document: VaultDocument) => void): Vault {
  const document = toDocument(vault)
  edit(document)
  return parseVault(document)
}

function slotOf(vault: Vault, id: string): Vault['slots'][number] {
  const slot = vault.slots.find((candidate) => candidate.id === id)
  if (slot === undefined) {
    throw new Error(`the test expected a slot called ${id}`)
  }
  return slot
}

function documentSlot(vault: Vault, id: string): VaultDocument['slots'][number] {
  return documentSlotOf(toDocument(vault), id)
}

function documentSlotOf(document: VaultDocument, id: string): VaultDocument['slots'][number] {
  const slot = document.slots.find((candidate) => candidate.id === id)
  if (slot === undefined) {
    throw new Error(`the test expected a slot called ${id}`)
  }
  return slot
}

function requireFirst<T>(items: T[]): T {
  const first = items[0]
  if (first === undefined) {
    throw new Error('the test expected at least one item')
  }
  return first
}

function firstCode(codes: readonly string[]): string {
  return requireFirst([...codes])
}

/** Flip one bit inside a base64 field, keeping its length valid. */
function flipBase64(value: string): string {
  const bytes = Buffer.from(value, 'base64')
  bytes[0] = (bytes[0] ?? 0) ^ 0x01
  return bytes.toString('base64')
}
