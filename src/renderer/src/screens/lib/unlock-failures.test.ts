import { describe, expect, it } from 'vitest'
import type { CompanySummary } from '@shared/dto'
import {
  describeUnlockFailure,
  UNLOCK_ACTION_LABELS,
  unlockFailureKind,
  type UnlockFailureKind,
} from './unlock-failures'

const ACME: CompanySummary = {
  id: 'acme',
  displayName: 'Acme Pvt Ltd',
  filePath: '/books/acme.coffer',
  vaultPath: '/books/acme.coffer.vault',
  lastOpenedAt: null,
  createdAt: '2026-08-14T09:30:00.000Z',
  lastBackup: null,
  remindsAboutBackups: true,
  availability: 'ok',
}

const EVERY_KIND: readonly UnlockFailureKind[] = [
  'passphrase',
  'file-missing',
  'vault-missing',
  'keys-mismatched',
]

describe('which failure it is', () => {
  it('reads the attempt’s error code for all four', () => {
    expect(unlockFailureKind(ACME, { code: 'PASSPHRASE_INVALID' })).toBe('passphrase')
    expect(unlockFailureKind(ACME, { code: 'COMPANY_DATABASE_MISSING' })).toBe('file-missing')
    expect(unlockFailureKind(ACME, { code: 'COMPANY_VAULT_MISSING' })).toBe('vault-missing')
    expect(unlockFailureKind(ACME, { code: 'COMPANY_KEYS_MISMATCHED' })).toBe('keys-mismatched')
  })

  it('knows two of them before anyone types, from the list’s own check', () => {
    expect(unlockFailureKind({ availability: 'database-missing' }, null)).toBe('file-missing')
    expect(unlockFailureKind({ availability: 'vault-missing' }, null)).toBe('vault-missing')
    expect(unlockFailureKind({ availability: 'ok' }, null)).toBeNull()
  })

  /* The file was there when the list was read and gone when Unlock was pressed. */
  it('takes the attempt’s answer over the list’s', () => {
    expect(unlockFailureKind({ availability: 'ok' }, { code: 'COMPANY_DATABASE_MISSING' })).toBe(
      'file-missing',
    )
  })

  it('is none of the four for any other failure', () => {
    expect(unlockFailureKind(ACME, { code: 'IPC_FAILED' })).toBeNull()
  })
})

describe('what each failure says', () => {
  it.each(EVERY_KIND)('gives %s a cause, a fix and at least one action', (kind) => {
    const failure = describeUnlockFailure(kind, ACME)
    expect(failure.title).not.toBe('')
    expect(failure.cause).not.toBe('')
    expect(failure.fix).not.toBe('')
    expect(failure.actions.length).toBeGreaterThan(0)
    for (const action of failure.actions) expect(UNLOCK_ACTION_LABELS[action]).not.toBe('')
  })

  /* Four different screens, not one message: no two may share a title. */
  it('never lets two failures share a title', () => {
    const titles = EVERY_KIND.map((kind) => describeUnlockFailure(kind, ACME).title)
    expect(new Set(titles).size).toBe(titles.length)
  })

  it('only offers the passphrase field again when the passphrase was the problem', () => {
    expect(EVERY_KIND.filter((kind) => describeUnlockFailure(kind, ACME).canRetry)).toEqual([
      'passphrase',
    ])
  })

  it('names the file, never counting the failed attempts', () => {
    const passphrase = describeUnlockFailure('passphrase', ACME)
    expect(passphrase.cause).toContain('Acme Pvt Ltd')
    expect(passphrase.cause).not.toMatch(/attempt|tries|\d+ times/)
    expect(passphrase.actions).toEqual(['recover'])
  })

  it('says the books are not lost when only the path is', () => {
    const missing = describeUnlockFailure('file-missing', ACME)
    expect(missing.cause).toContain('/books/acme.coffer')
    expect(missing.cause).toContain('The books are not lost')
    expect(missing.actions).toEqual(['refresh', 'find-file', 'forget'])
  })

  it('names both halves when the vault is missing, and offers a backup', () => {
    const vault = describeUnlockFailure('vault-missing', ACME)
    expect(vault.cause).toContain('/books/acme.coffer.vault')
    expect(vault.actions).toContain('restore')
  })

  it('never offers a recovery code for keys that belong to another file', () => {
    expect(describeUnlockFailure('keys-mismatched', ACME).actions).not.toContain('recover')
  })
})
