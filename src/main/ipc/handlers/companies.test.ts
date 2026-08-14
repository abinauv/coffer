import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BackupResult,
  CompanySummary,
  OpenCompanyResult,
  PassphraseStrength,
} from '../../../shared/dto'
import { IpcError } from '../errors'
import { type PathAllowlist, createPathAllowlist } from '../path-access'
import { type CompanyService, createCompaniesHandlers } from './companies'

const DIRECTORY = resolve('/coffer-data/acme')
const FILE = join(DIRECTORY, 'books.coffer')
const ARCHIVE = resolve('/coffer-data/acme-2026-08-14.zip')
const PASSPHRASE = 'correct horse battery staple'

const SUMMARY: CompanySummary = {
  id: 'acme',
  displayName: 'Acme Pvt Ltd',
  filePath: FILE,
  vaultPath: `${FILE}.vault`,
  lastOpenedAt: null,
  createdAt: '2026-08-14T09:30:00.000Z',
  availability: 'ok',
}

const OPENED: OpenCompanyResult = { company: SUMMARY, recoveryCodesRemaining: 5 }

const BACKUP: BackupResult = {
  archivePath: ARCHIVE,
  sizeBytes: 1024,
  createdAt: '2026-08-14T09:30:00.000Z',
}

const STRENGTH: PassphraseStrength = { score: 4, label: 'Strong', suggestion: null, isWeak: false }

async function call(spec: any, ...args: unknown[]): Promise<unknown> {
  return spec.handle(...spec.parseArgs(args))
}

function rejection(run: () => unknown): Promise<IpcError> {
  return Promise.resolve()
    .then(run)
    .then(
      () => {
        throw new Error('expected the handler to reject')
      },
      (cause: unknown) => {
        if (cause instanceof IpcError) return cause
        throw cause
      },
    )
}

let service: CompanyService
let allowlist: PathAllowlist
let handlers: ReturnType<typeof createCompaniesHandlers>

beforeEach(() => {
  service = {
    list: vi.fn(async () => [SUMMARY]),
    create: vi.fn(async () => OPENED),
    open: vi.fn(async () => OPENED),
    recover: vi.fn(async () => OPENED),
    close: vi.fn(async () => undefined),
    changePassphrase: vi.fn(async () => undefined),
    backup: vi.fn(async () => BACKUP),
    restore: vi.fn(async () => SUMMARY),
    addExisting: vi.fn(async () => SUMMARY),
    forget: vi.fn(async () => undefined),
    rename: vi.fn(async () => SUMMARY),
    checkPassphrase: vi.fn(async () => STRENGTH),
  }
  allowlist = createPathAllowlist()
  handlers = createCompaniesHandlers(service, allowlist)
})

describe('companies:list', () => {
  it('returns what the service returns', async () => {
    await expect(call(handlers.list)).resolves.toEqual({ ok: true, data: [SUMMARY] })
  })

  it('grants reveal access to each company file and its vault', async () => {
    await call(handlers.list)

    expect(allowlist.isAllowed(SUMMARY.filePath)).toBe(true)
    expect(allowlist.isAllowed(SUMMARY.vaultPath)).toBe(true)
  })
})

describe('companies:create', () => {
  const input = { displayName: 'Acme Pvt Ltd', directoryPath: DIRECTORY, passphrase: PASSPHRASE }

  it('passes the validated input to the service', async () => {
    await expect(call(handlers.create, input)).resolves.toEqual({ ok: true, data: OPENED })
    expect(service.create).toHaveBeenCalledWith(input)
  })

  it('grants reveal access to the company it just created', async () => {
    await call(handlers.create, input)

    expect(allowlist.isAllowed(SUMMARY.filePath)).toBe(true)
  })

  it('accepts an empty passphrase so the security layer can name the problem', async () => {
    await call(handlers.create, { ...input, passphrase: '' })

    expect(service.create).toHaveBeenCalledWith({ ...input, passphrase: '' })
  })

  it.each([
    ['no input at all', undefined],
    ['a string instead of an object', 'acme'],
    ['an array', []],
    ['a missing displayName', { directoryPath: DIRECTORY, passphrase: PASSPHRASE }],
    [
      'a blank displayName',
      { displayName: '  ', directoryPath: DIRECTORY, passphrase: PASSPHRASE },
    ],
    ['a relative directoryPath', { displayName: 'A', directoryPath: 'acme', passphrase: '' }],
    ['a numeric passphrase', { displayName: 'A', directoryPath: DIRECTORY, passphrase: 1234 }],
  ])('rejects %s', async (_label, value) => {
    const error = await rejection(() => call(handlers.create, value))

    expect(error.code).toBe('INVALID_ARGUMENT')
    expect(service.create).not.toHaveBeenCalled()
  })

  it('never echoes the passphrase back in a validation message', async () => {
    const error = await rejection(() =>
      call(handlers.create, { displayName: '', directoryPath: DIRECTORY, passphrase: PASSPHRASE }),
    )

    expect(error.message).not.toContain(PASSPHRASE)
    expect(JSON.stringify(error.details)).not.toContain(PASSPHRASE)
  })
})

describe('companies:open', () => {
  it('passes the validated input to the service', async () => {
    const input = { id: 'acme', passphrase: PASSPHRASE }

    await expect(call(handlers.open, input)).resolves.toEqual({ ok: true, data: OPENED })
    expect(service.open).toHaveBeenCalledWith(input)
  })

  it('drops fields the contract does not declare', async () => {
    await call(handlers.open, { id: 'acme', passphrase: PASSPHRASE, isAdmin: true })

    expect(service.open).toHaveBeenCalledWith({ id: 'acme', passphrase: PASSPHRASE })
  })

  it.each([
    ['a missing id', { passphrase: PASSPHRASE }],
    ['a blank id', { id: '', passphrase: PASSPHRASE }],
    ['a missing passphrase', { id: 'acme' }],
  ])('rejects %s', async (_label, value) => {
    expect((await rejection(() => call(handlers.open, value))).code).toBe('INVALID_ARGUMENT')
  })
})

describe('companies:recover', () => {
  const input = { id: 'acme', recoveryCode: 'ABCD-EFGH-JKLM', newPassphrase: PASSPHRASE }

  it('passes the validated input to the service', async () => {
    await call(handlers.recover, input)

    expect(service.recover).toHaveBeenCalledWith(input)
  })

  it('rejects a blank recovery code', async () => {
    const error = await rejection(() => call(handlers.recover, { ...input, recoveryCode: '' }))

    expect(error.code).toBe('INVALID_ARGUMENT')
  })

  it('never echoes the recovery code back', async () => {
    const error = await rejection(() => call(handlers.recover, { ...input, id: 7 }))

    expect(error.message).not.toContain('ABCD-EFGH-JKLM')
  })
})

describe('companies:close', () => {
  it('closes and returns an empty success', async () => {
    await expect(call(handlers.close)).resolves.toEqual({ ok: true, data: undefined })
    expect(service.close).toHaveBeenCalledOnce()
  })
})

describe('companies:changePassphrase', () => {
  it('passes both passphrases to the service', async () => {
    const input = { currentPassphrase: 'old one', newPassphrase: PASSPHRASE }

    await expect(call(handlers.changePassphrase, input)).resolves.toEqual({
      ok: true,
      data: undefined,
    })
    expect(service.changePassphrase).toHaveBeenCalledWith(input)
  })

  it('rejects a missing newPassphrase', async () => {
    const error = await rejection(() =>
      call(handlers.changePassphrase, { currentPassphrase: 'old one' }),
    )

    expect(error.code).toBe('INVALID_ARGUMENT')
  })
})

describe('companies:backup', () => {
  it('writes the archive and grants reveal access to it', async () => {
    await expect(call(handlers.backup, { directoryPath: DIRECTORY })).resolves.toEqual({
      ok: true,
      data: BACKUP,
    })
    expect(allowlist.isAllowed(ARCHIVE)).toBe(true)
  })

  it('rejects a relative directory', async () => {
    const error = await rejection(() => call(handlers.backup, { directoryPath: './backups' }))

    expect(error.code).toBe('INVALID_ARGUMENT')
    expect(service.backup).not.toHaveBeenCalled()
  })
})

describe('companies:restore', () => {
  it('passes both paths to the service and grants reveal access to the result', async () => {
    const input = { archivePath: ARCHIVE, directoryPath: DIRECTORY }

    await expect(call(handlers.restore, input)).resolves.toEqual({ ok: true, data: SUMMARY })
    expect(service.restore).toHaveBeenCalledWith(input)
    expect(allowlist.isAllowed(SUMMARY.filePath)).toBe(true)
  })

  it('rejects a relative archive path', async () => {
    const error = await rejection(() =>
      call(handlers.restore, { archivePath: 'backup.zip', directoryPath: DIRECTORY }),
    )

    expect(error.code).toBe('INVALID_ARGUMENT')
  })
})

describe('companies:addExisting', () => {
  it('registers an absolute file path', async () => {
    await expect(call(handlers.addExisting, FILE)).resolves.toEqual({ ok: true, data: SUMMARY })
    expect(service.addExisting).toHaveBeenCalledWith(FILE)
  })

  it('rejects a relative path', async () => {
    expect((await rejection(() => call(handlers.addExisting, 'books.coffer'))).code).toBe(
      'INVALID_ARGUMENT',
    )
  })
})

describe('companies:forget', () => {
  it('forgets by id', async () => {
    await expect(call(handlers.forget, 'acme')).resolves.toEqual({ ok: true, data: undefined })
    expect(service.forget).toHaveBeenCalledWith('acme')
  })

  it('rejects a blank id', async () => {
    expect((await rejection(() => call(handlers.forget, '   '))).code).toBe('INVALID_ARGUMENT')
  })
})

describe('companies:rename', () => {
  it('passes both positional arguments through', async () => {
    await expect(call(handlers.rename, 'acme', 'Acme Pvt Ltd')).resolves.toEqual({
      ok: true,
      data: SUMMARY,
    })
    expect(service.rename).toHaveBeenCalledWith('acme', 'Acme Pvt Ltd')
  })

  it('rejects a blank display name', async () => {
    const error = await rejection(() => call(handlers.rename, 'acme', ''))

    expect(error.code).toBe('INVALID_ARGUMENT')
    expect(service.rename).not.toHaveBeenCalled()
  })
})

describe('companies:checkPassphrase', () => {
  it('returns the advisory strength', async () => {
    await expect(call(handlers.checkPassphrase, PASSPHRASE)).resolves.toEqual({
      ok: true,
      data: STRENGTH,
    })
  })

  it('accepts an empty passphrase — the meter has to say something about one', async () => {
    await call(handlers.checkPassphrase, '')

    expect(service.checkPassphrase).toHaveBeenCalledWith('')
  })

  it('rejects a non-string', async () => {
    expect((await rejection(() => call(handlers.checkPassphrase, 12345))).code).toBe(
      'INVALID_ARGUMENT',
    )
  })
})
