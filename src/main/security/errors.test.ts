import { describe, expect, it } from 'vitest'

import { type Argon2Params, MIN_MEMORY_COST, hashPassphrase, verifyPassphrase } from './argon2'
import { dekFromHex, dekToHex } from './dek'
import { SecurityError, isSecurityError } from './errors'
import { normalizeRecoveryCode } from './recovery-codes'
import { generateKeyPair, openSealed, seal } from './sealed-box'
import {
  type CreateVaultOptions,
  changePassphrase,
  createVault,
  unlockWithPassphrase,
  unlockWithRecoveryCode,
} from './vault'

const FAST: Argon2Params = {
  algorithm: 'argon2id',
  memoryCost: MIN_MEMORY_COST,
  timeCost: 1,
  parallelism: 1,
}
const FAST_OPTIONS: CreateVaultOptions = { kdf: { passphrase: FAST, recovery: FAST } }

/* Values a careless error message would quote back. Every one is unmistakable in a
 * string, so if any of them leaks into a message this test says so. */
const PASSPHRASE = 'zzsecretpassphrasezz'
const WRONG_PASSPHRASE = 'zzwrongpassphrasezz'
const NOT_A_CODE = 'zzNOTACODEzz'

describe('SecurityError', () => {
  it('carries a stable code and a name a handler can branch on', () => {
    const error = new SecurityError('VAULT_TAMPERED', 'The vault file has been altered.')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('SecurityError')
    expect(error.code).toBe('VAULT_TAMPERED')
  })

  it('is recognisable through isSecurityError', () => {
    expect(isSecurityError(new SecurityError('PASSPHRASE_INVALID', 'no'))).toBe(true)
    expect(isSecurityError(new Error('no'))).toBe(false)
    expect(isSecurityError('no')).toBe(false)
    expect(isSecurityError(null)).toBe(false)
  })
})

/*
 * The rule from the top of errors.ts, enforced. An error message is the most likely
 * place for a secret to escape: it reaches logs, crash reports and screenshots, and
 * SECURITY.md lists "secrets written anywhere they should not be" as in scope.
 */
describe('no error ever repeats a secret back', () => {
  it('holds for a wrong passphrase', async () => {
    const { vault } = await createVault(PASSPHRASE, FAST_OPTIONS)
    await expectCleanFailure(
      () => unlockWithPassphrase(vault, WRONG_PASSPHRASE),
      [PASSPHRASE, WRONG_PASSPHRASE],
    )
  })

  it('holds for a wrong passphrase on a passphrase change', async () => {
    const { vault } = await createVault(PASSPHRASE, FAST_OPTIONS)
    await expectCleanFailure(
      () => changePassphrase(vault, WRONG_PASSPHRASE, 'a new one'),
      [PASSPHRASE, WRONG_PASSPHRASE, 'a new one'],
    )
  })

  it('holds for a malformed recovery code', async () => {
    const { vault } = await createVault(PASSPHRASE, FAST_OPTIONS)
    await expectCleanFailure(() => unlockWithRecoveryCode(vault, NOT_A_CODE), [NOT_A_CODE])
  })

  it('holds for a valid-looking code from another company', async () => {
    const { vault } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const stranger = await createVault(PASSPHRASE, FAST_OPTIONS)
    const code = stranger.recoveryCodes[0] ?? ''
    await expectCleanFailure(
      () => unlockWithRecoveryCode(vault, code),
      [code, code.replace(/-/g, '')],
    )
  })

  it('holds for a spent recovery code', async () => {
    const { vault, recoveryCodes } = await createVault(PASSPHRASE, FAST_OPTIONS)
    const code = recoveryCodes[0] ?? ''
    const spent = await unlockWithRecoveryCode(vault, code)
    await expectCleanFailure(
      () => unlockWithRecoveryCode(spent.vault, code),
      [code, code.replace(/-/g, '')],
    )
  })

  it('holds for code normalisation', () => {
    expect(() => normalizeRecoveryCode(NOT_A_CODE)).toThrow(SecurityError)
    try {
      normalizeRecoveryCode(NOT_A_CODE)
    } catch (error) {
      expect(messageOf(error)).not.toContain('NOTACODE')
    }
  })

  it('holds for a bad key handed to the hex helpers', () => {
    const key = 'zz'.repeat(32)
    try {
      dekFromHex(key)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(messageOf(error)).not.toContain(key)
    }
  })

  it('holds for an unreadable stored hash', async () => {
    const stored = await hashPassphrase(PASSPHRASE)
    await expectCleanFailure(
      () => verifyPassphrase('$argon2id$broken', PASSPHRASE),
      [PASSPHRASE, stored],
    )
  })

  it('holds for a sealed box that will not open', async () => {
    const maintainer = await generateKeyPair()
    const impostor = await generateKeyPair()
    const sealed = await seal(Buffer.from(PASSPHRASE), maintainer.publicKey)
    await expectCleanFailure(
      () => openSealed(sealed, impostor),
      [PASSPHRASE, maintainer.privateKey.toString('hex'), sealed.toString('base64')],
    )
  })

  it('holds for a DEK that never appears in any message it could reach', async () => {
    const { vault, dek } = await createVault(PASSPHRASE, FAST_OPTIONS)
    await expectCleanFailure(
      () => unlockWithPassphrase(vault, WRONG_PASSPHRASE),
      [dekToHex(dek), dek.toString('base64')],
    )
  })
})

async function expectCleanFailure(
  operation: () => Promise<unknown>,
  forbidden: string[],
): Promise<void> {
  let thrown: unknown
  try {
    await operation()
    expect.unreachable('the operation should have failed')
  } catch (error) {
    thrown = error
  }

  expect(isSecurityError(thrown)).toBe(true)
  const surface = `${messageOf(thrown)}\n${String(thrown)}`
  for (const secret of forbidden) {
    expect(surface).not.toContain(secret)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
