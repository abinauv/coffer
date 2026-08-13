import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/*
 * The public surface, used exactly as the header of index.ts documents it.
 *
 * This is the contract the companies and database layers build against, so it is worth
 * a test of its own: if a rename or a re-export breaks the flow below, it breaks here
 * rather than in someone else's module.
 */
import {
  type Argon2Params,
  MIN_MEMORY_COST,
  createVaultFile,
  changeVaultFilePassphrase,
  isSecurityError,
  sqlcipherRawKey,
  unlockVaultFile,
  unlockVaultFileWithRecoveryCode,
  withSecret,
} from './index'

const FAST: Argon2Params = {
  algorithm: 'argon2id',
  memoryCost: MIN_MEMORY_COST,
  timeCost: 1,
  parallelism: 1,
}
const FAST_OPTIONS = { kdf: { passphrase: FAST, recovery: FAST } }

describe('the flow the database layer will use', () => {
  let directory: string
  let vaultPath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'coffer-security-'))
    vaultPath = join(directory, 'books.vault')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('creates a company, opens it, changes the passphrase and recovers', async () => {
    // Create.
    const created = await createVaultFile(vaultPath, 'a passphrase worth having', FAST_OPTIONS)
    expect(created.recoveryCodes).toHaveLength(5)

    const keyAtCreation = await withSecret(created.dek, (dek) => sqlcipherRawKey(dek))
    expect(keyAtCreation).toMatch(/^x'[0-9a-f]{64}'$/)
    expect(created.dek.every((byte) => byte === 0)).toBe(true) // withSecret zeroed it

    // Open.
    const opened = await unlockVaultFile(vaultPath, 'a passphrase worth having')
    const keyAtOpen = await withSecret(opened, (dek) => sqlcipherRawKey(dek))
    expect(keyAtOpen).toBe(keyAtCreation)

    // Change the passphrase. The key that opens the database does not move.
    await changeVaultFilePassphrase(vaultPath, 'a passphrase worth having', 'a better one')
    const afterChange = await unlockVaultFile(vaultPath, 'a better one')
    expect(await withSecret(afterChange, (dek) => sqlcipherRawKey(dek))).toBe(keyAtCreation)

    // Recover with a code, which spends it on disk.
    const code = created.recoveryCodes[0] ?? ''
    const recovered = await unlockVaultFileWithRecoveryCode(vaultPath, code)
    expect(await withSecret(recovered, (dek) => sqlcipherRawKey(dek))).toBe(keyAtCreation)
  })

  it('reports a wrong passphrase as a SecurityError with a code to branch on', async () => {
    await createVaultFile(vaultPath, 'the right one', FAST_OPTIONS)
    try {
      await unlockVaultFile(vaultPath, 'the wrong one')
      expect.unreachable('should have failed')
    } catch (error) {
      expect(isSecurityError(error)).toBe(true)
      if (isSecurityError(error)) {
        expect(error.code).toBe('PASSPHRASE_INVALID')
      }
    }
  })
})
