import { describe, expect, it, vi } from 'vitest'
import { API_SURFACE, apiChannels } from '../main/ipc/surface'
import { BRIDGE_FAILURE, createBridgeApi } from './bridge'

const SECRET = 'correct horse battery staple'

type LooseApi = Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>

function build(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): {
  api: LooseApi
  onFailure: ReturnType<typeof vi.fn>
} {
  const onFailure = vi.fn()
  return { api: createBridgeApi(invoke, onFailure) as unknown as LooseApi, onFailure }
}

describe('createBridgeApi — the shape contextBridge requires', () => {
  /*
   * The reason this module exists. `contextBridge.exposeInMainWorld` copies an exposed
   * object property by property; a Proxy over an empty target reports no own properties,
   * so Electron 43 rejects it with "An object could not be cloned" and the renderer sees
   * `window.coffer === undefined`. Every assertion below is about real own properties.
   */

  it('exposes every group as an own enumerable property', () => {
    const { api } = build(async () => ({ ok: true, data: null }))

    expect(Object.keys(api)).toEqual(Object.keys(API_SURFACE))
  })

  it('exposes every method of every group as an own enumerable property', () => {
    const { api } = build(async () => ({ ok: true, data: null }))

    for (const [group, methods] of Object.entries(API_SURFACE)) {
      const groupApi = api[group]
      expect(groupApi).toBeDefined()
      expect(Object.keys(groupApi ?? {})).toEqual(Object.keys(methods))
    }
  })

  it('exposes a callable for every channel in the contract', () => {
    const { api } = build(async () => ({ ok: true, data: null }))

    for (const channel of apiChannels()) {
      const [group, method] = channel.split(':')
      expect(typeof api[group ?? '']?.[method ?? '']).toBe('function')
    }
  })

  it('survives being enumerated the way Electron enumerates it', () => {
    const { api } = build(async () => ({ ok: true, data: null }))

    const copied: Record<string, unknown> = {}
    for (const key of Object.getOwnPropertyNames(api)) copied[key] = api[key]

    expect(Object.keys(copied)).toEqual(Object.keys(API_SURFACE))
  })
})

describe('createBridgeApi — dispatch', () => {
  it('sends a call to its group:method channel', async () => {
    const invoke = vi.fn(async () => ({ ok: true, data: [] }))
    const { api } = build(invoke)

    await api['companies']?.['list']?.()

    expect(invoke).toHaveBeenCalledExactlyOnceWith('companies:list')
  })

  it('forwards arguments unchanged', async () => {
    const invoke = vi.fn(async () => ({ ok: true, data: null }))
    const { api } = build(invoke)
    const input = { id: 'acme', passphrase: SECRET }

    await api['companies']?.['open']?.(input)

    expect(invoke).toHaveBeenCalledWith('companies:open', input)
  })

  it('returns the envelope main sent, untouched', async () => {
    const envelope = { ok: true, data: { name: 'Coffer' } }
    const { api } = build(async () => envelope)

    await expect(api['system']?.['getAppInfo']?.()).resolves.toBe(envelope)
  })

  it('returns a failure envelope main sent, untouched', async () => {
    const envelope = { ok: false, error: { code: 'DB_WRONG_KEY', message: 'Wrong passphrase.' } }
    const { api } = build(async () => envelope)

    await expect(api['companies']?.['open']?.({})).resolves.toBe(envelope)
  })
})

describe('createBridgeApi — a call that never reaches a handler', () => {
  it('resolves to a failure envelope instead of rejecting', async () => {
    const { api } = build(async () => {
      throw new Error("No handler registered for 'companies:list'")
    })

    await expect(api['companies']?.['list']?.()).resolves.toEqual({
      ok: false,
      error: BRIDGE_FAILURE,
    })
  })

  it('does not leak the underlying failure to the renderer', async () => {
    const { api } = build(async () => {
      throw new Error(`Error occurred in handler: ENOENT /home/ada/.coffer/${SECRET}`)
    })

    const result = await api['companies']?.['list']?.()

    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(JSON.stringify(result)).not.toContain('/home/ada')
  })

  it('reports the failure to the preload console, where a developer can see it', async () => {
    const cause = new Error('channel closed')
    const { api, onFailure } = build(async () => {
      throw cause
    })

    await api['companies']?.['list']?.()

    expect(onFailure).toHaveBeenCalledWith(expect.stringContaining('companies:list'), cause)
  })

  it('rejects an answer that is not a Result envelope', async () => {
    const { api, onFailure } = build(async () => ({ version: '1.0.0' }))

    await expect(api['system']?.['getAppInfo']?.()).resolves.toEqual({
      ok: false,
      error: BRIDGE_FAILURE,
    })
    expect(onFailure).toHaveBeenCalled()
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a bare string', 'ok'],
    ['a half-built failure', { ok: false }],
  ])('rejects %s as an answer', async (_label, value) => {
    const { api } = build(async () => value)

    await expect(api['system']?.['getAppInfo']?.()).resolves.toEqual({
      ok: false,
      error: BRIDGE_FAILURE,
    })
  })

  it('says what to do rather than apologising', () => {
    expect(BRIDGE_FAILURE.message).not.toMatch(/something went wrong|sorry/i)
    expect(BRIDGE_FAILURE.message).toMatch(/restart/i)
  })
})
