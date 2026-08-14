/*
 * The lifecycle, against real files in real temporary directories.
 *
 * Nothing here is mocked: real Argon2id, real SQLCipher, real vaults on disk. The whole
 * value of this module is what happens to files, and a test that stubs the filesystem
 * would assert that the code calls the functions it calls.
 *
 * Argon2 runs at the cheapest parameters the security module accepts. Two paths still
 * pay the production profile whatever the tests ask for — `setPassphrase` upgrades a weak
 * slot on purpose — so the tests that change a passphrase or redeem a recovery code carry
 * a longer timeout.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { DbError } from '../db/errors'
import { type Argon2Params, MIN_MEMORY_COST, SecurityError } from '../security'
import { readBackup } from './backup'
import { CompanyError } from './errors'
import { METADATA_KEYS, readMetadata, writeMetadata } from './metadata'
import { CompanyService } from './service'

/** Real Argon2id at the floor. What is under test is the ordering, not the derivation. */
const FAST: Argon2Params = {
  algorithm: 'argon2id',
  memoryCost: MIN_MEMORY_COST,
  timeCost: 1,
  parallelism: 1,
}

const PASSPHRASE = 'a quiet ledger keeps its own counsel'
const NEW_PASSPHRASE = 'nine invoices and a cup of tea'
const DISPLAY_NAME = 'Acme Traders'

/** Long enough for the two paths that pay the production KDF on purpose. */
const SLOW_TEST_MS = 120_000

const MARKER_KEY = 'test.marker'

const directories: string[] = []
const services: CompanyService[] = []

interface Fixture {
  service: CompanyService
  dataDirectory: string
  companyDirectory: string
}

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `coffer-${prefix}-`))
  directories.push(directory)
  return directory
}

async function fixture(): Promise<Fixture> {
  const dataDirectory = await tempDirectory('registry')
  const companyDirectory = await tempDirectory('books')
  const service = new CompanyService({
    dataDirectory,
    kdf: { passphrase: FAST, recovery: FAST },
  })
  services.push(service)
  return { service, dataDirectory, companyDirectory }
}

async function createCompany(
  now: Fixture,
  displayName = DISPLAY_NAME,
  passphrase = PASSPHRASE,
): ReturnType<CompanyService['create']> {
  return now.service.create({
    displayName,
    directoryPath: now.companyDirectory,
    passphrase,
  })
}

/** The stable code of whatever was thrown, or a description of why that question failed. */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (
      error instanceof CompanyError ||
      error instanceof SecurityError ||
      error instanceof DbError
    ) {
      return error.code
    }
    return `unexpected error: ${String(error)}`
  }
  return 'did not throw'
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath)
    return true
  } catch {
    return false
  }
}

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex')
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.close().catch(() => undefined)
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
  }
})

describe('create', () => {
  it('writes the database and its vault side by side, and leaves the company open', async () => {
    const now = await fixture()
    const result = await createCompany(now)

    expect(result.company.displayName).toBe(DISPLAY_NAME)
    expect(result.company.filePath).toBe(join(now.companyDirectory, 'Acme-Traders.coffer'))
    expect(result.company.vaultPath).toBe(`${result.company.filePath}.vault`)
    expect(result.company.availability).toBe('ok')
    expect(await exists(result.company.filePath)).toBe(true)
    expect(await exists(result.company.vaultPath)).toBe(true)
    expect(now.service.currentCompany()?.id).toBe(result.company.id)
  })

  it('returns five recovery codes, and never returns them again', async () => {
    const now = await fixture()
    const created = await createCompany(now)

    expect(created.recoveryCodes).toHaveLength(5)
    expect(new Set(created.recoveryCodes).size).toBe(5)
    expect(created.recoveryCodesRemaining).toBe(5)

    await now.service.close()
    const reopened = await now.service.open({ id: created.company.id, passphrase: PASSPHRASE })
    expect(reopened.recoveryCodes).toBeUndefined()
    expect(reopened.recoveryCodesRemaining).toBe(5)
  })

  it('brings the database up to the head of the migration list', async () => {
    const now = await fixture()
    await createCompany(now)
    const database = now.service.requireDatabase()

    const tables = database
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all()
      .map((row) => row.name)

    expect(tables).toContain('schema_migrations')
    expect(tables).toContain('app_metadata')
    expect(readMetadata(database, METADATA_KEYS.format)).toBe('coffer.company')
    expect(readMetadata(database, METADATA_KEYS.displayName)).toBe(DISPLAY_NAME)
  })

  it('accepts a passphrase the strength meter hates — nothing here may block', async () => {
    const now = await fixture()
    const weak = '1234'

    expect(now.service.checkPassphrase(weak).isWeak).toBe(true)
    const created = await createCompany(now, 'Weak Passphrase Co', weak)
    expect(created.company.availability).toBe('ok')
  })

  it('refuses an empty passphrase and an empty name', async () => {
    const now = await fixture()

    expect(await codeOf(() => createCompany(now, DISPLAY_NAME, '   '))).toBe('PASSPHRASE_REQUIRED')
    expect(await codeOf(() => createCompany(now, '  ', PASSPHRASE))).toBe('COMPANY_NAME_REQUIRED')
    expect(await now.service.list()).toEqual([])
  })

  it('refuses to write over an existing company', async () => {
    const now = await fixture()
    await createCompany(now)

    expect(await codeOf(() => createCompany(now))).toBe('COMPANY_FILE_EXISTS')
    expect(await now.service.list()).toHaveLength(1)
  })

  it('leaves nothing half-made when a step fails', async () => {
    const now = await fixture()
    /* A directory where the database file has to go: the vault is written, the database
     * cannot be, and the vault must not survive that. */
    const filePath = join(now.companyDirectory, 'Acme-Traders.coffer')
    await mkdir(filePath)

    const code = await codeOf(() => createCompany(now))

    expect(code).toBe('DB_OPEN_FAILED')
    expect(await exists(`${filePath}.vault`)).toBe(false)
    expect(await now.service.list()).toEqual([])
    expect(now.service.currentCompany()).toBeNull()
  })
})

describe('open', () => {
  it('reopens a company and finds what was written to it', async () => {
    const now = await fixture()
    const created = await createCompany(now)
    writeMetadata(now.service.requireDatabase(), MARKER_KEY, 'seventeen invoices')
    await now.service.close()

    expect(now.service.currentDatabase()).toBeNull()

    const reopened = await now.service.open({ id: created.company.id, passphrase: PASSPHRASE })
    expect(reopened.company.id).toBe(created.company.id)
    expect(readMetadata(now.service.requireDatabase(), MARKER_KEY)).toBe('seventeen invoices')
    expect(reopened.company.lastOpenedAt).not.toBeNull()
  })

  it('rejects the wrong passphrase', async () => {
    const now = await fixture()
    const created = await createCompany(now)
    await now.service.close()

    expect(
      await codeOf(() => now.service.open({ id: created.company.id, passphrase: 'not it' })),
    ).toBe('PASSPHRASE_INVALID')
    expect(now.service.currentCompany()).toBeNull()
  })

  it('reports a missing vault as missing keys, never as a decryption failure', async () => {
    const now = await fixture()
    const created = await createCompany(now)
    await now.service.close()
    await rm(created.company.vaultPath)

    const [listed] = await now.service.list()
    expect(listed?.availability).toBe('vault-missing')

    const code = await codeOf(() =>
      now.service.open({ id: created.company.id, passphrase: PASSPHRASE }),
    )
    expect(code).toBe('COMPANY_VAULT_MISSING')

    /* The message has to send the user to a backup, because nothing else can help. */
    await expect(
      now.service.open({ id: created.company.id, passphrase: PASSPHRASE }),
    ).rejects.toThrow(/backup/i)
  })

  it('reports a missing database as a missing file', async () => {
    const now = await fixture()
    const created = await createCompany(now)
    await now.service.close()
    await rm(created.company.filePath)

    const [listed] = await now.service.list()
    expect(listed?.availability).toBe('database-missing')
    expect(
      await codeOf(() => now.service.open({ id: created.company.id, passphrase: PASSPHRASE })),
    ).toBe('COMPANY_DATABASE_MISSING')
  })

  it('reports an unknown company rather than throwing something anonymous', async () => {
    const now = await fixture()
    expect(await codeOf(() => now.service.open({ id: 'nobody', passphrase: PASSPHRASE }))).toBe(
      'COMPANY_NOT_FOUND',
    )
  })

  it('says so when the vault beside a database belongs to another company', async () => {
    const now = await fixture()
    const first = await createCompany(now, 'First Company')
    await now.service.close()
    const second = await createCompany(now, 'Second Company')
    await now.service.close()

    /* The classic way to lose books: copy one company's vault next to another's file. */
    await writeFile(first.company.vaultPath, await readFile(second.company.vaultPath))

    expect(
      await codeOf(() => now.service.open({ id: first.company.id, passphrase: PASSPHRASE })),
    ).toBe('COMPANY_KEYS_MISMATCHED')
  })
})

describe('recover', () => {
  it(
    'spends exactly one code, sets the new passphrase, and refuses the code afterwards',
    async () => {
      const now = await fixture()
      const created = await createCompany(now)
      writeMetadata(now.service.requireDatabase(), MARKER_KEY, 'still here')
      await now.service.close()

      const codes = created.recoveryCodes ?? []
      const [firstCode, secondCode] = codes
      expect(firstCode).toBeDefined()
      expect(secondCode).toBeDefined()

      const recovered = await now.service.recover({
        id: created.company.id,
        recoveryCode: firstCode ?? '',
        newPassphrase: NEW_PASSPHRASE,
      })

      expect(recovered.recoveryCodesRemaining).toBe(4)
      expect(recovered.recoveryCodes).toBeUndefined()
      expect(readMetadata(now.service.requireDatabase(), MARKER_KEY)).toBe('still here')

      /* The spend is on disk, not merely in memory: exactly one slot is burnt. */
      const vault = JSON.parse(await readFile(created.company.vaultPath, 'utf8')) as {
        slots: Array<{ kind: string; wrapped: unknown; usedAt: string | null }>
      }
      const recoverySlots = vault.slots.filter((slot) => slot.kind === 'recovery')
      expect(recoverySlots.filter((slot) => slot.wrapped === null)).toHaveLength(1)
      expect(recoverySlots.filter((slot) => slot.usedAt !== null)).toHaveLength(1)

      await now.service.close()
      expect(
        await codeOf(() =>
          now.service.recover({
            id: created.company.id,
            recoveryCode: firstCode ?? '',
            newPassphrase: 'another one entirely',
          }),
        ),
      ).toBe('RECOVERY_CODE_ALREADY_USED')

      /* The old passphrase is gone and the new one works. */
      expect(
        await codeOf(() => now.service.open({ id: created.company.id, passphrase: PASSPHRASE })),
      ).toBe('PASSPHRASE_INVALID')
      const reopened = await now.service.open({
        id: created.company.id,
        passphrase: NEW_PASSPHRASE,
      })
      expect(reopened.recoveryCodesRemaining).toBe(4)
    },
    SLOW_TEST_MS,
  )

  it(
    'leaves the other four codes working',
    async () => {
      const now = await fixture()
      const created = await createCompany(now)
      await now.service.close()
      const codes = created.recoveryCodes ?? []

      await now.service.recover({
        id: created.company.id,
        recoveryCode: codes[0] ?? '',
        newPassphrase: NEW_PASSPHRASE,
      })
      await now.service.close()

      const second = await now.service.recover({
        id: created.company.id,
        recoveryCode: codes[4] ?? '',
        newPassphrase: 'a third passphrase for the books',
      })
      expect(second.recoveryCodesRemaining).toBe(3)
    },
    SLOW_TEST_MS,
  )

  it('rejects a code that is not a code, and one from another company', async () => {
    const now = await fixture()
    const created = await createCompany(now)
    const other = await now.service.create({
      displayName: 'Other Company',
      directoryPath: now.companyDirectory,
      passphrase: PASSPHRASE,
    })
    await now.service.close()

    expect(
      await codeOf(() =>
        now.service.recover({
          id: created.company.id,
          recoveryCode: 'not-a-code',
          newPassphrase: NEW_PASSPHRASE,
        }),
      ),
    ).toBe('RECOVERY_CODE_MALFORMED')

    expect(
      await codeOf(() =>
        now.service.recover({
          id: created.company.id,
          recoveryCode: other.recoveryCodes?.[0] ?? '',
          newPassphrase: NEW_PASSPHRASE,
        }),
      ),
    ).toBe('RECOVERY_CODE_INVALID')
  })
})

describe('changePassphrase', () => {
  it(
    're-wraps the key without rewriting a single database page',
    async () => {
      const now = await fixture()
      const created = await createCompany(now)
      writeMetadata(now.service.requireDatabase(), MARKER_KEY, 'untouched')
      /* Fold the write-ahead log in, so the comparison is against a settled file. */
      await now.service.backup({ directoryPath: await tempDirectory('backups') })

      const before = await sha256(created.company.filePath)
      await now.service.changePassphrase({
        currentPassphrase: PASSPHRASE,
        newPassphrase: NEW_PASSPHRASE,
      })
      expect(await sha256(created.company.filePath)).toBe(before)

      /* The session survives: the DEK never changed. */
      expect(readMetadata(now.service.requireDatabase(), MARKER_KEY)).toBe('untouched')

      await now.service.close()
      expect(
        await codeOf(() => now.service.open({ id: created.company.id, passphrase: PASSPHRASE })),
      ).toBe('PASSPHRASE_INVALID')

      await now.service.open({ id: created.company.id, passphrase: NEW_PASSPHRASE })
      expect(readMetadata(now.service.requireDatabase(), MARKER_KEY)).toBe('untouched')
    },
    SLOW_TEST_MS,
  )

  it('needs an open company, and the current passphrase', async () => {
    const now = await fixture()
    expect(
      await codeOf(() =>
        now.service.changePassphrase({
          currentPassphrase: PASSPHRASE,
          newPassphrase: NEW_PASSPHRASE,
        }),
      ),
    ).toBe('NO_COMPANY_OPEN')

    await createCompany(now)
    expect(
      await codeOf(() =>
        now.service.changePassphrase({
          currentPassphrase: 'wrong',
          newPassphrase: NEW_PASSPHRASE,
        }),
      ),
    ).toBe('PASSPHRASE_INVALID')
  })
})

describe('backup and restore', () => {
  it('writes one archive holding both files, and restores it to a working company', async () => {
    const now = await fixture()
    const created = await createCompany(now)
    writeMetadata(now.service.requireDatabase(), MARKER_KEY, 'the books survived')

    const backupDirectory = await tempDirectory('backups')
    const result = await now.service.backup({ directoryPath: backupDirectory })

    expect(result.archivePath.endsWith('.coffer-backup.zip')).toBe(true)
    expect(result.sizeBytes).toBeGreaterThan(0)
    expect(await readdir(backupDirectory)).toHaveLength(1)

    const archive = await readBackup(result.archivePath)
    expect(archive.manifest.displayName).toBe(DISPLAY_NAME)
    expect(archive.manifest.database.fileName).toBe('Acme-Traders.coffer')
    expect(archive.manifest.vault.fileName).toBe('Acme-Traders.coffer.vault')

    await now.service.close()
    const restoreDirectory = await tempDirectory('restored')
    const restored = await now.service.restore({
      archivePath: result.archivePath,
      directoryPath: restoreDirectory,
    })

    expect(restored.availability).toBe('ok')
    expect(restored.filePath).toBe(join(restoreDirectory, 'Acme-Traders.coffer'))
    expect(restored.id).not.toBe(created.company.id)

    await now.service.open({ id: restored.id, passphrase: PASSPHRASE })
    expect(readMetadata(now.service.requireDatabase(), MARKER_KEY)).toBe('the books survived')
  })

  it('never overwrites a company that is already there', async () => {
    const now = await fixture()
    await createCompany(now)
    const backupDirectory = await tempDirectory('backups')
    const result = await now.service.backup({ directoryPath: backupDirectory })

    expect(
      await codeOf(() =>
        now.service.restore({
          archivePath: result.archivePath,
          directoryPath: now.companyDirectory,
        }),
      ),
    ).toBe('COMPANY_FILE_EXISTS')
  })

  it('never writes two backups to the same name', async () => {
    const now = await fixture()
    await createCompany(now)
    const backupDirectory = await tempDirectory('backups')

    const first = await now.service.backup({ directoryPath: backupDirectory })
    const second = await now.service.backup({ directoryPath: backupDirectory })

    expect(second.archivePath).not.toBe(first.archivePath)
    expect(await readdir(backupDirectory)).toHaveLength(2)
  })

  it('refuses a damaged archive before writing anything', async () => {
    const now = await fixture()
    await createCompany(now)
    const backupDirectory = await tempDirectory('backups')
    const result = await now.service.backup({ directoryPath: backupDirectory })

    /* Flip a byte in the middle of the archive: the manifest hashes catch it. */
    const bytes = await readFile(result.archivePath)
    const middle = Math.floor(bytes.length / 2)
    bytes[middle] = (bytes[middle] ?? 0) ^ 0xff
    await writeFile(result.archivePath, bytes)

    const restoreDirectory = await tempDirectory('restored')
    expect(
      await codeOf(() =>
        now.service.restore({
          archivePath: result.archivePath,
          directoryPath: restoreDirectory,
        }),
      ),
    ).toBe('BACKUP_ARCHIVE_INVALID')
    expect(await readdir(restoreDirectory)).toEqual([])
  })

  it('needs an open company to back one up', async () => {
    const now = await fixture()
    expect(await codeOf(() => now.service.backup({ directoryPath: now.companyDirectory }))).toBe(
      'NO_COMPANY_OPEN',
    )
  })
})

describe('the list', () => {
  it('forgets a company without deleting anything', async () => {
    const now = await fixture()
    const created = await createCompany(now)

    await now.service.forget(created.company.id)

    expect(await now.service.list()).toEqual([])
    expect(now.service.currentCompany()).toBeNull()
    expect(await exists(created.company.filePath)).toBe(true)
    expect(await exists(created.company.vaultPath)).toBe(true)
  })

  it('adds an existing file back, and does not add it twice', async () => {
    const now = await fixture()
    const created = await createCompany(now)
    await now.service.forget(created.company.id)

    const added = await now.service.addExisting(created.company.filePath)
    expect(added.filePath).toBe(created.company.filePath)
    expect(added.availability).toBe('ok')
    expect(added.displayName).toBe('Acme Traders')

    const again = await now.service.addExisting(created.company.filePath)
    expect(again.id).toBe(added.id)
    expect(await now.service.list()).toHaveLength(1)

    /* And it opens, which is the point of adding it. */
    await now.service.open({ id: added.id, passphrase: PASSPHRASE })
    expect(now.service.currentCompany()?.id).toBe(added.id)
  })

  it('adds a file whose vault is missing, so the list can say what is wrong', async () => {
    const now = await fixture()
    const created = await createCompany(now)
    await now.service.close()
    await now.service.forget(created.company.id)
    await rm(created.company.vaultPath)

    const added = await now.service.addExisting(created.company.filePath)
    expect(added.availability).toBe('vault-missing')
  })

  it('refuses to add a file that is not there', async () => {
    const now = await fixture()
    expect(
      await codeOf(() => now.service.addExisting(join(now.companyDirectory, 'nothing.coffer'))),
    ).toBe('COMPANY_DATABASE_MISSING')
  })

  it('renames in the list and in the file, but not on disk', async () => {
    const now = await fixture()
    const created = await createCompany(now)

    const renamed = await now.service.rename(created.company.id, '  Acme Trading Company  ')

    expect(renamed.displayName).toBe('Acme Trading Company')
    expect(renamed.filePath).toBe(created.company.filePath)
    expect(readMetadata(now.service.requireDatabase(), METADATA_KEYS.displayName)).toBe(
      'Acme Trading Company',
    )
    expect(await codeOf(() => now.service.rename('nobody', 'Something'))).toBe('COMPANY_NOT_FOUND')
  })

  it('closes cleanly, twice, and when nothing is open', async () => {
    const now = await fixture()
    await now.service.close()
    await createCompany(now)
    await now.service.close()
    await now.service.close()
    expect(now.service.currentDatabase()).toBeNull()
    expect(await codeOf(async () => now.service.requireDatabase())).toBe('NO_COMPANY_OPEN')
  })
})

describe('a damaged registry', () => {
  it('degrades to an empty list rather than failing to start', async () => {
    const now = await fixture()
    await createCompany(now)
    await now.service.close()

    const registryPath = await now.service.registryFilePath()
    await writeFile(registryPath, '{ this is not json', 'utf8')

    expect(await now.service.list()).toEqual([])
    const status = await now.service.registryStatus()
    expect(status.isHealthy).toBe(false)
    expect(status.problem).toMatch(/companies/i)
  })

  it('sets the damaged file aside instead of overwriting it', async () => {
    const now = await fixture()
    const registryPath = await now.service.registryFilePath()
    await mkdir(now.dataDirectory, { recursive: true })
    await writeFile(registryPath, 'nonsense', 'utf8')

    expect(await now.service.list()).toEqual([])
    await createCompany(now)

    const names = await readdir(now.dataDirectory)
    expect(names.some((name) => name.includes('.corrupt-'))).toBe(true)
    expect(await now.service.list()).toHaveLength(1)
  })

  it('keeps the entries it can read and drops the ones it cannot', async () => {
    const now = await fixture()
    const created = await createCompany(now)
    await now.service.close()

    const registryPath = await now.service.registryFilePath()
    const document = JSON.parse(await readFile(registryPath, 'utf8')) as {
      companies: unknown[]
    }
    document.companies.push({ id: '', filePath: 42 })
    await writeFile(registryPath, JSON.stringify(document), 'utf8')

    const listed = await now.service.list()
    expect(listed.map((company) => company.id)).toEqual([created.company.id])
    expect((await now.service.registryStatus()).droppedEntries).toBe(1)
  })
})
