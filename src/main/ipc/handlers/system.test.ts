import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppInfo } from '../../../shared/dto'
import { IpcError } from '../errors'
import { type PathAllowlist, createPathAllowlist } from '../path-access'
import { type SystemEnvironment, createSystemHandlers } from './system'

const DATA = resolve('/coffer-data')
const ARCHIVE = join(DATA, 'acme-2026-08-14.zip')
const PRIVATE = resolve('/home/ada/.ssh/id_ed25519')

const APP_INFO: AppInfo = {
  name: 'Coffer',
  version: '0.0.0',
  platform: 'linux',
  isDevelopment: true,
}

/** Handlers are exercised the way the boundary exercises them: parse, then handle. */
async function call(spec: any, ...args: unknown[]): Promise<unknown> {
  return spec.handle(...spec.parseArgs(args))
}

function rejection(promise: Promise<unknown>): Promise<IpcError> {
  return promise.then(
    () => {
      throw new Error('expected the handler to reject')
    },
    (cause: unknown) => {
      if (cause instanceof IpcError) return cause
      throw cause
    },
  )
}

let environment: SystemEnvironment
let allowlist: PathAllowlist
let handlers: ReturnType<typeof createSystemHandlers>

beforeEach(() => {
  environment = {
    appInfo: vi.fn(() => APP_INFO),
    chooseDirectory: vi.fn(async () => null),
    chooseBackupArchive: vi.fn(async () => null),
    revealPath: vi.fn(async () => undefined),
    pathExists: vi.fn(async () => true),
  }
  allowlist = createPathAllowlist()
  handlers = createSystemHandlers(environment, allowlist)
})

describe('system:getAppInfo', () => {
  it('returns what the environment reports', async () => {
    await expect(call(handlers.getAppInfo)).resolves.toEqual({ ok: true, data: APP_INFO })
  })
})

describe('system:chooseDirectory', () => {
  it('returns null when the user cancels', async () => {
    await expect(call(handlers.chooseDirectory)).resolves.toEqual({ ok: true, data: null })
  })

  it('returns the chosen directory', async () => {
    environment.chooseDirectory = vi.fn(async () => DATA)

    await expect(call(handlers.chooseDirectory)).resolves.toEqual({ ok: true, data: DATA })
  })

  it('grants reveal access to what the user picked themselves', async () => {
    environment.chooseDirectory = vi.fn(async () => DATA)
    expect(allowlist.isAllowed(DATA)).toBe(false)

    await call(handlers.chooseDirectory)

    expect(allowlist.isAllowed(DATA)).toBe(true)
  })

  it('grants nothing when the user cancels', async () => {
    await call(handlers.chooseDirectory)

    expect(allowlist.isAllowed(DATA)).toBe(false)
  })
})

describe('system:chooseBackupArchive', () => {
  it('returns null when the user cancels', async () => {
    await expect(call(handlers.chooseBackupArchive)).resolves.toEqual({ ok: true, data: null })
  })

  it('returns the chosen archive and grants reveal access to it', async () => {
    environment.chooseBackupArchive = vi.fn(async () => ARCHIVE)

    await expect(call(handlers.chooseBackupArchive)).resolves.toEqual({ ok: true, data: ARCHIVE })
    expect(allowlist.isAllowed(ARCHIVE)).toBe(true)
  })
})

describe('system:revealInFileManager', () => {
  it('reveals a path the user is entitled to', async () => {
    allowlist.allow(ARCHIVE)

    await expect(call(handlers.revealInFileManager, ARCHIVE)).resolves.toEqual({
      ok: true,
      data: undefined,
    })
    expect(environment.revealPath).toHaveBeenCalledWith(ARCHIVE)
  })

  it('refuses a path Coffer never put in front of the user', async () => {
    const error = await rejection(call(handlers.revealInFileManager, PRIVATE))

    expect(error.code).toBe('PATH_NOT_ALLOWED')
    expect(environment.revealPath).not.toHaveBeenCalled()
  })

  it('refuses a traversal out of a granted directory', async () => {
    allowlist.allow(DATA)
    const escape = join(DATA, '..', '..', 'home', 'ada', '.ssh', 'id_ed25519')

    const error = await rejection(call(handlers.revealInFileManager, escape))

    expect(error.code).toBe('PATH_NOT_ALLOWED')
    expect(environment.revealPath).not.toHaveBeenCalled()
  })

  it.each([
    ['a relative path', 'books.coffer'],
    ['a number', 7],
    ['nothing at all', undefined],
    ['an interior NUL', '/coffer-data/books.coffer\0.txt'],
  ])('rejects %s before it reaches the allowlist', async (_label, value) => {
    const error = await rejection(call(handlers.revealInFileManager, value))

    expect(error.code).toBe('INVALID_ARGUMENT')
    expect(environment.revealPath).not.toHaveBeenCalled()
  })

  it('reports a granted path that is no longer there', async () => {
    allowlist.allow(ARCHIVE)
    environment.pathExists = vi.fn(async () => false)

    const error = await rejection(call(handlers.revealInFileManager, ARCHIVE))

    expect(error.code).toBe('PATH_NOT_FOUND')
    expect(environment.revealPath).not.toHaveBeenCalled()
  })

  it('checks the allowlist before it checks the filesystem', async () => {
    /* Otherwise the answer tells a caller whether an arbitrary path exists. */
    await rejection(call(handlers.revealInFileManager, PRIVATE))

    expect(environment.pathExists).not.toHaveBeenCalled()
  })
})
