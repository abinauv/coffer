import { describe, expect, it, vi } from 'vitest'
import type { Result } from '../../shared/dto'
import { DbError } from '../db/errors'
import { SecurityError } from '../security/errors'
import { type ErrorMapper, INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE, IpcError } from './errors'
import {
  type ChannelListener,
  HandlerRegistrationError,
  HandlerRegistry,
  type IpcLogger,
  type IpcTransport,
} from './registry'
import { ok } from './surface'
import { expectNonEmptyString, noArgs } from './validate'

const SECRET = 'correct horse battery staple'

function harness(errorMappers: readonly ErrorMapper[] = []): {
  registry: HandlerRegistry
  logger: IpcLogger
  invoke: (channel: string, ...args: unknown[]) => Promise<Result<unknown>>
  channels: Map<string, ChannelListener>
} {
  const channels = new Map<string, ChannelListener>()
  const transport: IpcTransport = {
    handle(channel, listener) {
      channels.set(channel, listener)
    },
  }
  const logger: IpcLogger = { warn: vi.fn(), error: vi.fn() }

  return {
    registry: new HandlerRegistry(transport, logger, errorMappers),
    logger,
    channels,
    invoke: (channel, ...args) => {
      const listener = channels.get(channel)
      if (listener === undefined) throw new Error(`nothing is registered on '${channel}'`)
      return listener(args)
    },
  }
}

/** A minimal, always-succeeding spec for a zero-argument method. */
function stub(data: unknown = null): any {
  return { parseArgs: noArgs, handle: () => ok(data) }
}

/** Everything the logger was handed, flattened to text. */
function loggedText(logger: IpcLogger): string {
  const calls = [
    ...(logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls,
    ...(logger.error as unknown as { mock: { calls: unknown[][] } }).mock.calls,
  ]
  return calls
    .flat()
    .map((entry) => `${String(entry)} ${JSON.stringify(entry) ?? ''}`)
    .join('\n')
}

describe('HandlerRegistry — registration', () => {
  it('registers under the group:method channel the renderer will call', () => {
    const { registry, channels } = harness()

    registry.register('system', 'getAppInfo', stub())

    expect([...channels.keys()]).toEqual(['system:getAppInfo'])
    expect(registry.has('system:getAppInfo')).toBe(true)
    expect(registry.channels).toEqual(['system:getAppInfo'])
  })

  it('refuses a channel the contract does not declare', () => {
    const { registry } = harness()

    expect(() => (registry as any).register('system', 'selfDestruct', stub())).toThrow(
      HandlerRegistrationError,
    )
    expect(() => (registry as any).register('ledger', 'postEntry', stub())).toThrow(
      /declares no such method/,
    )
  })

  it('refuses to register the same channel twice', () => {
    const { registry } = harness()
    registry.register('system', 'getAppInfo', stub())

    expect(() => registry.register('system', 'getAppInfo', stub())).toThrow(
      HandlerRegistrationError,
    )
  })

  it('leaves the first handler in place when a duplicate is refused', async () => {
    const { registry, invoke } = harness()
    registry.register('system', 'getAppInfo', stub('first'))

    expect(() => registry.register('system', 'getAppInfo', stub('second'))).toThrow()

    await expect(invoke('system:getAppInfo')).resolves.toEqual({ ok: true, data: 'first' })
  })
})

describe('HandlerRegistry — registerGroup', () => {
  it('registers every method of the group', () => {
    const { registry } = harness()

    registry.registerGroup('system', {
      getAppInfo: stub(),
      chooseDirectory: stub(),
      chooseBackupArchive: stub(),
      chooseCompanyFile: stub(),
      revealInFileManager: stub(),
      setTitleBarOverlay: stub(),
    } as any)

    expect(registry.channels).toEqual([
      'system:getAppInfo',
      'system:chooseDirectory',
      'system:chooseBackupArchive',
      'system:chooseCompanyFile',
      'system:revealInFileManager',
      'system:setTitleBarOverlay',
    ])
  })

  it('refuses a group that is missing a method', () => {
    const { registry } = harness()

    expect(() =>
      registry.registerGroup('system', { getAppInfo: stub(), chooseDirectory: stub() } as any),
    ).toThrow(/no handler was supplied for 'chooseBackupArchive'/)
  })

  it('refuses a group carrying a method the contract does not declare', () => {
    const { registry } = harness()

    expect(() =>
      registry.registerGroup('system', {
        getAppInfo: stub(),
        chooseDirectory: stub(),
        chooseBackupArchive: stub(),
        chooseCompanyFile: stub(),
        revealInFileManager: stub(),
        setTitleBarOverlay: stub(),
        runShellCommand: stub(),
      } as any),
    ).toThrow(/declares no such method on 'system'/)
  })
})

describe('the error boundary — a Result passes through', () => {
  it('returns a success envelope unchanged', async () => {
    const { registry, invoke } = harness()
    const data = { name: 'Coffer', version: '1.0.0' }
    registry.register('system', 'getAppInfo', stub(data))

    await expect(invoke('system:getAppInfo')).resolves.toEqual({ ok: true, data })
  })

  it('returns a failure envelope the handler chose to return, untouched', async () => {
    const { registry, invoke } = harness()
    const failure = { ok: false as const, error: { code: 'PERIOD_CLOSED', message: 'Closed.' } }
    registry.register('companies', 'close', { parseArgs: noArgs, handle: () => failure } as any)

    await expect(invoke('companies:close')).resolves.toBe(failure)
  })

  it('awaits a handler that returns a promise', async () => {
    const { registry, invoke } = harness()
    registry.register('companies', 'close', {
      parseArgs: noArgs,
      handle: async () => ok(undefined),
    } as any)

    await expect(invoke('companies:close')).resolves.toEqual({ ok: true, data: undefined })
  })
})

describe('the error boundary — mapping a coded error', () => {
  it('maps a SecurityError onto its code and message', async () => {
    const { registry, invoke, logger } = harness()
    registry.register('companies', 'close', {
      parseArgs: noArgs,
      handle: () => {
        throw new SecurityError('PASSPHRASE_INVALID', 'That passphrase did not unlock the vault.')
      },
    } as any)

    await expect(invoke('companies:close')).resolves.toEqual({
      ok: false,
      error: {
        code: 'PASSPHRASE_INVALID',
        message: 'That passphrase did not unlock the vault.',
      },
    })
    expect(logger.warn).toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('maps a DbError onto its code, with a message written for a user', async () => {
    const { registry, invoke } = harness()
    registry.register('companies', 'close', {
      parseArgs: noArgs,
      handle: () => {
        throw new DbError('DB_SCHEMA_TOO_NEW', 'migration 0099 > head 0007 at /home/ada/books')
      },
    } as any)

    const result = (await invoke('companies:close')) as {
      ok: false
      error: { code: string; message: string }
    }

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('DB_SCHEMA_TOO_NEW')
    expect(result.error.message).not.toContain('/home/ada')
    expect(result.error.message).toContain('newer version')
  })

  it('maps an IpcError onto its code', async () => {
    const { registry, invoke } = harness()
    registry.register('companies', 'close', {
      parseArgs: noArgs,
      handle: () => {
        throw new IpcError('PATH_NOT_ALLOWED', 'Coffer can only show files it manages.')
      },
    } as any)

    await expect(invoke('companies:close')).resolves.toEqual({
      ok: false,
      error: { code: 'PATH_NOT_ALLOWED', message: 'Coffer can only show files it manages.' },
    })
  })
})

describe('the error boundary — a supplied error mapper', () => {
  class CompanyError extends Error {
    readonly code = 'COMPANY_VAULT_MISSING'
  }

  const companyMapper: ErrorMapper = (cause) =>
    cause instanceof CompanyError
      ? { code: cause.code, message: 'The vault beside this company is missing.' }
      : null

  it('maps an error type the IPC layer cannot import', async () => {
    const { registry, invoke } = harness([companyMapper])
    registry.register('companies', 'close', {
      parseArgs: noArgs,
      handle: () => {
        throw new CompanyError()
      },
    } as any)

    await expect(invoke('companies:close')).resolves.toEqual({
      ok: false,
      error: {
        code: 'COMPANY_VAULT_MISSING',
        message: 'The vault beside this company is missing.',
      },
    })
  })

  it('treats a mapped error as expected, not as a crash', async () => {
    const { registry, invoke, logger } = harness([companyMapper])
    registry.register('companies', 'close', {
      parseArgs: noArgs,
      handle: () => {
        throw new CompanyError()
      },
    } as any)

    await invoke('companies:close')

    expect(logger.warn).toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('still collapses what no mapper claims', async () => {
    const { registry, invoke } = harness([companyMapper])
    registry.register('companies', 'close', {
      parseArgs: noArgs,
      handle: () => {
        throw new Error(SECRET)
      },
    } as any)

    const result = await invoke('companies:close')

    expect(result).toEqual({
      ok: false,
      error: { code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE },
    })
  })
})

describe('the error boundary — an unexpected throw', () => {
  it('does not leak the message, the path, or anything else in it', async () => {
    const { registry, invoke } = harness()
    registry.register('companies', 'close', {
      parseArgs: noArgs,
      handle: () => {
        throw new Error(`sqlite: no such column "dek" while reading /home/ada/.coffer/${SECRET}`)
      },
    } as any)

    const result = await invoke('companies:close')

    expect(result).toEqual({
      ok: false,
      error: { code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE },
    })
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(JSON.stringify(result)).not.toContain('/home/ada')
    expect(JSON.stringify(result)).not.toContain('sqlite')
  })

  it('logs it in full, at error level, with the channel named', async () => {
    const { registry, invoke, logger } = harness()
    const cause = new Error('the whole ugly truth')
    registry.register('companies', 'close', {
      parseArgs: noArgs,
      handle: () => {
        throw cause
      },
    } as any)

    await invoke('companies:close')

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('companies:close'), cause)
  })

  it('survives a handler that throws something that is not an Error', async () => {
    const { registry, invoke } = harness()
    registry.register('companies', 'close', {
      parseArgs: noArgs,
      handle: () => {
        throw SECRET
      },
    } as any)

    const result = await invoke('companies:close')

    expect(result).toEqual({
      ok: false,
      error: { code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE },
    })
  })

  it('treats a handler that returns something other than a Result as a bug', async () => {
    const { registry, invoke, logger } = harness()
    registry.register('companies', 'close', { parseArgs: noArgs, handle: () => 'fine' } as any)

    await expect(invoke('companies:close')).resolves.toEqual({
      ok: false,
      error: { code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE },
    })
    expect(logger.error).toHaveBeenCalled()
  })

  it('never writes the arguments to the log — they carry passphrases', async () => {
    const { registry, invoke, logger } = harness()
    registry.register('companies', 'open', {
      parseArgs: (raw: readonly unknown[]) => [raw[0]],
      handle: () => {
        throw new Error('boom')
      },
    } as any)

    await invoke('companies:open', { id: 'acme', passphrase: SECRET })

    expect(loggedText(logger)).not.toContain(SECRET)
  })
})

describe('the error boundary — validation runs first', () => {
  it('rejects a malformed argument with INVALID_ARGUMENT', async () => {
    const { registry, invoke } = harness()
    registry.register('companies', 'forget', {
      parseArgs: (raw: readonly unknown[]) => [expectNonEmptyString(raw[0], 'id')],
      handle: () => ok(undefined),
    } as any)

    const result = (await invoke('companies:forget', 42)) as { ok: false; error: { code: string } }

    expect(result.error.code).toBe('INVALID_ARGUMENT')
  })

  it('does not run the handler when validation fails', async () => {
    const { registry, invoke } = harness()
    const handle = vi.fn(() => ok(undefined))
    registry.register('companies', 'forget', {
      parseArgs: (raw: readonly unknown[]) => [expectNonEmptyString(raw[0], 'id')],
      handle,
    } as any)

    await invoke('companies:forget', null)

    expect(handle).not.toHaveBeenCalled()
  })

  it('rejects a call that arrives with no arguments at all', async () => {
    const { registry, invoke } = harness()
    registry.register('companies', 'forget', {
      parseArgs: (raw: readonly unknown[]) => [expectNonEmptyString(raw[0], 'id')],
      handle: () => ok(undefined),
    } as any)

    const result = (await invoke('companies:forget')) as { ok: false; error: { code: string } }

    expect(result.error.code).toBe('INVALID_ARGUMENT')
  })

  it('passes validated arguments to the handler', async () => {
    const { registry, invoke } = harness()
    const handle = vi.fn(() => ok(undefined))
    registry.register('companies', 'rename', {
      parseArgs: (raw: readonly unknown[]) => [
        expectNonEmptyString(raw[0], 'id'),
        expectNonEmptyString(raw[1], 'displayName'),
      ],
      handle,
    } as any)

    await invoke('companies:rename', 'acme', 'Acme Pvt Ltd')

    expect(handle).toHaveBeenCalledWith('acme', 'Acme Pvt Ltd')
  })
})
