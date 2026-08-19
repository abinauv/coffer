import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppInfo, CompanySummary, Result } from '../../shared/dto'
import type { CompanyService } from './handlers/companies'
import type { LedgerService } from './handlers/ledger'
import type { PartiesService } from './handlers/parties'
import type { ReportService } from './handlers/reports'
import type { SystemEnvironment } from './handlers/system'
import {
  HandlerRegistrationError,
  HandlerRegistry,
  type IpcDependencies,
  assertApiSurfaceComplete,
  registerIpcHandlers,
} from './index'
import type { ChannelListener, IpcLogger, IpcTransport } from './registry'
import { apiChannels } from './surface'

const DATA = resolve('/coffer-data')
const FILE = join(DATA, 'acme', 'books.coffer')

const APP_INFO: AppInfo = {
  name: 'Coffer',
  version: '0.0.0',
  platform: 'linux',
  isDevelopment: true,
}

const SUMMARY: CompanySummary = {
  id: 'acme',
  displayName: 'Acme Pvt Ltd',
  filePath: FILE,
  vaultPath: `${FILE}.vault`,
  lastOpenedAt: null,
  createdAt: '2026-08-14T09:30:00.000Z',
  availability: 'ok',
}

let channels: Map<string, ChannelListener>
let logger: IpcLogger
let system: SystemEnvironment
let companies: CompanyService
let ledger: LedgerService
let parties: PartiesService
let reports: ReportService

function dependencies(overrides: Partial<IpcDependencies> = {}): IpcDependencies {
  const transport: IpcTransport = {
    handle(channel, listener) {
      channels.set(channel, listener)
    },
  }
  return { transport, logger, system, companies, ledger, parties, reports, ...overrides }
}

function invoke(channel: string, ...args: unknown[]): Promise<Result<unknown>> {
  const listener = channels.get(channel)
  if (listener === undefined) throw new Error(`nothing is registered on '${channel}'`)
  return listener(args)
}

beforeEach(() => {
  channels = new Map()
  logger = { warn: vi.fn(), error: vi.fn() }
  system = {
    appInfo: vi.fn(() => APP_INFO),
    chooseDirectory: vi.fn(async () => null),
    chooseBackupArchive: vi.fn(async () => null),
    chooseCompanyFile: vi.fn(async () => null),
    revealPath: vi.fn(async () => undefined),
    pathExists: vi.fn(async () => true),
    setTitleBarOverlay: vi.fn(() => undefined),
  }
  companies = {
    list: vi.fn(async () => [SUMMARY]),
    create: vi.fn(),
    open: vi.fn(),
    recover: vi.fn(),
    close: vi.fn(async () => undefined),
    changePassphrase: vi.fn(),
    backup: vi.fn(),
    restore: vi.fn(),
    addExisting: vi.fn(),
    forget: vi.fn(),
    rename: vi.fn(),
    checkPassphrase: vi.fn(),
  } as unknown as CompanyService
  ledger = {
    listAccounts: vi.fn(async () => []),
    createAccount: vi.fn(),
    updateAccount: vi.fn(),
    setAccountRole: vi.fn(async () => undefined),
    listPeriods: vi.fn(async () => []),
    closePeriod: vi.fn(),
    reopenPeriod: vi.fn(),
    lockPeriod: vi.fn(),
    postEntry: vi.fn(),
    reverseEntry: vi.fn(),
    listEntries: vi.fn(async () => []),
    getEntry: vi.fn(async () => null),
    trialBalance: vi.fn(),
    postOpeningBalances: vi.fn(),
    closeFiscalYear: vi.fn(),
  } as unknown as LedgerService

  parties = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    delete: vi.fn(async () => undefined),
  } as unknown as PartiesService

  reports = {
    balanceSheet: vi.fn(),
    profitAndLoss: vi.fn(),
    accountLedger: vi.fn(),
    dayBook: vi.fn(),
  } as unknown as ReportService
})

describe('registerIpcHandlers', () => {
  it('registers a handler for every method in the contract', () => {
    const registry = registerIpcHandlers(dependencies())

    expect([...channels.keys()].sort()).toEqual([...apiChannels()].sort())
    for (const channel of apiChannels()) {
      expect(registry.has(channel)).toBe(true)
    }
  })

  it('registers nothing the contract does not declare', () => {
    registerIpcHandlers(dependencies())

    for (const channel of channels.keys()) {
      expect(apiChannels()).toContain(channel)
    }
  })

  it('answers a real call with a Result envelope', async () => {
    registerIpcHandlers(dependencies())

    await expect(invoke('system:getAppInfo')).resolves.toEqual({ ok: true, data: APP_INFO })
  })

  it('answers a malformed call with a typed failure rather than throwing', async () => {
    registerIpcHandlers(dependencies())

    const result = (await invoke('companies:open', 'not an object')) as {
      ok: false
      error: { code: string }
    }

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('INVALID_ARGUMENT')
  })

  it('shares one path allowlist between the two groups', async () => {
    registerIpcHandlers(dependencies())

    /* Listing companies is what makes their files revealable. Nothing else granted it. */
    await expect(invoke('system:revealInFileManager', FILE)).resolves.toMatchObject({
      ok: false,
      error: { code: 'PATH_NOT_ALLOWED' },
    })

    await invoke('companies:list')

    await expect(invoke('system:revealInFileManager', FILE)).resolves.toEqual({
      ok: true,
      data: undefined,
    })
  })

  it('seeds the allowlist with the roots it was given', async () => {
    registerIpcHandlers(dependencies({ revealRoots: [DATA] }))

    await expect(invoke('system:revealInFileManager', FILE)).resolves.toEqual({
      ok: true,
      data: undefined,
    })
  })

  it('gives the boundary the error mappers it was handed', async () => {
    class CompanyError extends Error {
      readonly code = 'COMPANY_NOT_FOUND'
    }
    companies.list = vi.fn(async () => {
      throw new CompanyError()
    })

    registerIpcHandlers(
      dependencies({
        errorMappers: [
          (cause) =>
            cause instanceof CompanyError
              ? { code: cause.code, message: 'No company with that id.' }
              : null,
        ],
      }),
    )

    await expect(invoke('companies:list')).resolves.toEqual({
      ok: false,
      error: { code: 'COMPANY_NOT_FOUND', message: 'No company with that id.' },
    })
  })

  it('grants nothing when no roots are seeded', async () => {
    registerIpcHandlers(dependencies())

    await expect(invoke('system:revealInFileManager', FILE)).resolves.toMatchObject({
      ok: false,
      error: { code: 'PATH_NOT_ALLOWED' },
    })
  })
})

describe('assertApiSurfaceComplete', () => {
  it('passes once every group is registered', () => {
    const registry = registerIpcHandlers(dependencies())

    expect(() => assertApiSurfaceComplete(registry)).not.toThrow()
  })

  it('fails at startup when a whole group is missing', () => {
    /* What happens if a feature agent adds `companies` to the contract and nobody
     * writes the handlers: the app refuses to start, naming every gap. */
    const registry = new HandlerRegistry(
      { handle: (channel, listener) => channels.set(channel, listener) },
      logger,
    )
    registry.registerGroup('system', {
      getAppInfo: { parseArgs: () => [], handle: () => ({ ok: true, data: APP_INFO }) },
      chooseDirectory: { parseArgs: () => [], handle: () => ({ ok: true, data: null }) },
      chooseBackupArchive: { parseArgs: () => [], handle: () => ({ ok: true, data: null }) },
      chooseCompanyFile: { parseArgs: () => [], handle: () => ({ ok: true, data: null }) },
      revealInFileManager: {
        parseArgs: (raw: readonly unknown[]) => [String(raw[0])],
        handle: () => ({ ok: true, data: undefined }),
      },
      setTitleBarOverlay: { parseArgs: () => [], handle: () => ({ ok: true, data: undefined }) },
    } as any)

    expect(() => assertApiSurfaceComplete(registry)).toThrow(HandlerRegistrationError)
    expect(() => assertApiSurfaceComplete(registry)).toThrow(/companies:list/)
    expect(() => assertApiSurfaceComplete(registry)).toThrow(/companies:checkPassphrase/)
  })

  it('fails when a single method is missing, and names it', () => {
    const covered = new Set(apiChannels())
    covered.delete('companies:backup')

    expect(() => assertApiSurfaceComplete({ has: (channel) => covered.has(channel) })).toThrow(
      /companies:backup/,
    )
  })

  it('points at where the handler belongs', () => {
    expect(() => assertApiSurfaceComplete({ has: () => false })).toThrow(/src\/main\/ipc\/handlers/)
  })

  it('passes when everything is covered', () => {
    expect(() => assertApiSurfaceComplete({ has: () => true })).not.toThrow()
  })
})
