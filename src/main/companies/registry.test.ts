import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CompanyError } from './errors'
import {
  type CompanyRecord,
  CompanyRegistry,
  REGISTRY_FORMAT,
  availabilityOf,
  toSummary,
} from './registry'

const directories: string[] = []

async function tempRegistry(): Promise<{ registry: CompanyRegistry; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'coffer-registry-unit-'))
  directories.push(directory)
  return { registry: new CompanyRegistry(join(directory, 'companies.json')), directory }
}

function record(overrides: Partial<CompanyRecord> = {}): CompanyRecord {
  return {
    id: 'company-one',
    displayName: 'Acme Traders',
    filePath: join(tmpdir(), 'coffer-books', 'Acme-Traders.coffer'),
    vaultPath: join(tmpdir(), 'coffer-books', 'Acme-Traders.coffer.vault'),
    createdAt: '2026-08-14T09:30:00.000Z',
    lastOpenedAt: null,
    lastBackup: null,
    remindsAboutBackups: true,
    ...overrides,
  }
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return error instanceof CompanyError ? error.code : `unexpected error: ${String(error)}`
  }
  return 'did not throw'
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
  }
})

describe('CompanyRegistry', () => {
  it('reads an empty list on a machine that has never run Coffer', async () => {
    const { registry } = await tempRegistry()

    expect(await registry.read()).toEqual([])
    expect(registry.status().isHealthy).toBe(true)
    expect(registry.status().problem).toBeNull()
  })

  it('adds, patches and removes', async () => {
    const { registry } = await tempRegistry()
    await registry.add(record())

    expect((await registry.read()).map((entry) => entry.displayName)).toEqual(['Acme Traders'])

    const patched = await registry.patch('company-one', { displayName: 'Acme Trading' })
    expect(patched.displayName).toBe('Acme Trading')
    expect(patched.id).toBe('company-one')

    await registry.remove('company-one')
    expect(await registry.read()).toEqual([])
  })

  it('says which company it cannot find', async () => {
    const { registry } = await tempRegistry()

    expect(await codeOf(() => registry.patch('nobody', { displayName: 'x' }))).toBe(
      'COMPANY_NOT_FOUND',
    )
    expect(await codeOf(() => registry.remove('nobody'))).toBe('COMPANY_NOT_FOUND')
    expect(await codeOf(() => registry.add(record()))).toBe('did not throw')
    expect(await codeOf(() => registry.add(record()))).toBe('REGISTRY_IO_FAILED')
  })

  it('writes a file a person can read, with its format named', async () => {
    const { registry } = await tempRegistry()
    await registry.add(record())

    const document = JSON.parse(await readFile(registry.filePath, 'utf8')) as {
      format: string
      version: number
      companies: unknown[]
    }
    expect(document.format).toBe(REGISTRY_FORMAT)
    expect(document.version).toBe(1)
    expect(document.companies).toHaveLength(1)
  })

  it('degrades to an empty list when the file is not JSON', async () => {
    const { registry } = await tempRegistry()
    await writeFile(registry.filePath, 'not json at all', 'utf8')

    expect(await registry.read()).toEqual([])
    expect(registry.status().isHealthy).toBe(false)
    expect(registry.status().problem).toContain('Add your companies again')
  })

  it('degrades when the file is JSON but not a registry', async () => {
    const { registry } = await tempRegistry()
    await writeFile(registry.filePath, JSON.stringify({ companies: [] }), 'utf8')

    expect(await registry.read()).toEqual([])
    expect(registry.status().isHealthy).toBe(false)
  })

  it('sets a damaged file aside rather than overwriting it', async () => {
    const { registry, directory } = await tempRegistry()
    await writeFile(registry.filePath, 'nonsense', 'utf8')
    await registry.read()

    await registry.add(record())

    const names = await readdir(directory)
    expect(names.filter((name) => name.includes('.corrupt-'))).toHaveLength(1)
    expect(await registry.read()).toHaveLength(1)
    expect(registry.status().isHealthy).toBe(true)
  })

  /*
   * EVERY REGISTRY WRITTEN BEFORE THIS VERSION LACKS THE BACKUP FIELDS, and a file that
   * predates a field is not a damaged file. An entry keeps its company; the reminder
   * starts on, which is the answer somebody who has never been asked would want.
   */
  it('reads an entry written before backups were remembered', async () => {
    const { registry } = await tempRegistry()
    const old = record()
    const { lastBackup, remindsAboutBackups, ...withoutBackupFields } = old
    void lastBackup
    void remindsAboutBackups
    await writeFile(
      registry.filePath,
      JSON.stringify({ format: REGISTRY_FORMAT, version: 1, companies: [withoutBackupFields] }),
      'utf8',
    )

    const [entry] = await registry.read()
    expect(entry?.lastBackup).toBeNull()
    expect(entry?.remindsAboutBackups).toBe(true)
    expect(registry.status().isHealthy).toBe(true)
  })

  it('keeps a company whose backup record is unusable, and forgets only the record', async () => {
    const { registry } = await tempRegistry()
    await writeFile(
      registry.filePath,
      JSON.stringify({
        format: REGISTRY_FORMAT,
        version: 1,
        companies: [
          record({ id: 'half-written', lastBackup: { at: 'not a time', path: '', sizeBytes: -1 } }),
        ],
      }),
      'utf8',
    )

    const [entry] = await registry.read()
    /* The row's job is to say where the books are. A reminder is not worth losing it. */
    expect(entry?.id).toBe('half-written')
    expect(entry?.lastBackup).toBeNull()
  })

  it('round-trips a backup record through a write and a read', async () => {
    const { registry } = await tempRegistry()
    await registry.add(record())
    const backup = {
      at: '2026-09-16T10:00:00.000Z',
      path: join(tmpdir(), 'Acme-Traders.coffer-backup.zip'),
      sizeBytes: 2048,
    }

    await registry.patch('company-one', { lastBackup: backup, remindsAboutBackups: false })

    const [entry] = await new CompanyRegistry(registry.filePath).read()
    expect(entry?.lastBackup).toEqual(backup)
    expect(entry?.remindsAboutBackups).toBe(false)
  })

  it('keeps the entries it can read and drops the ones it cannot', async () => {
    const { registry } = await tempRegistry()
    await writeFile(
      registry.filePath,
      JSON.stringify({
        format: REGISTRY_FORMAT,
        version: 1,
        companies: [
          record(),
          { id: 'no-path' },
          { id: 'relative', filePath: 'books/Acme.coffer' },
          'not an object',
          record({ id: 'company-one', displayName: 'A duplicate id' }),
        ],
      }),
      'utf8',
    )

    const records = await registry.read()
    expect(records.map((entry) => entry.id)).toEqual(['company-one'])
    expect(records[0]?.displayName).toBe('Acme Traders')
    expect(registry.status().droppedEntries).toBe(4)
    expect(registry.status().isHealthy).toBe(false)
  })

  it('repairs the fields it can rather than dropping a company over them', async () => {
    const filePath = join(tmpdir(), 'coffer-books', 'Some-Books.coffer')
    const { registry } = await tempRegistry()
    await writeFile(
      registry.filePath,
      JSON.stringify({
        format: REGISTRY_FORMAT,
        version: 1,
        companies: [{ id: 'kept', filePath, createdAt: 'the day before yesterday' }],
      }),
      'utf8',
    )

    const [entry] = await registry.read()
    expect(entry?.displayName).toBe('Some Books')
    expect(entry?.vaultPath).toBe(`${filePath}.vault`)
    expect(entry?.lastOpenedAt).toBeNull()
    expect(isAbsolute(entry?.filePath ?? '')).toBe(true)
    expect(Number.isNaN(Date.parse(entry?.createdAt ?? ''))).toBe(false)
  })

  it('finds a company by the file it points at', async () => {
    const { registry } = await tempRegistry()
    const entry = record()
    await registry.add(entry)

    expect((await registry.findByFilePath(entry.filePath))?.id).toBe(entry.id)
    expect(await registry.findByFilePath(join(tmpdir(), 'elsewhere.coffer'))).toBeNull()
  })
})

describe('availability', () => {
  it('reports a missing database, a missing vault, or neither', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'coffer-availability-'))
    directories.push(directory)
    const filePath = join(directory, 'Books.coffer')
    const vaultPath = `${filePath}.vault`
    const entry = record({ filePath, vaultPath })

    expect(await availabilityOf(entry)).toBe('database-missing')

    await writeFile(filePath, 'pretend ciphertext')
    expect(await availabilityOf(entry)).toBe('vault-missing')

    await writeFile(vaultPath, '{}')
    expect(await availabilityOf(entry)).toBe('ok')
  })

  it('carries the record and the availability into the DTO the renderer sees', () => {
    const summary = toSummary(record(), 'vault-missing')

    expect(summary).toEqual({
      id: 'company-one',
      displayName: 'Acme Traders',
      filePath: record().filePath,
      vaultPath: record().vaultPath,
      createdAt: '2026-08-14T09:30:00.000Z',
      lastOpenedAt: null,
      availability: 'vault-missing',
      lastBackup: null,
      remindsAboutBackups: true,
    })
  })
})
