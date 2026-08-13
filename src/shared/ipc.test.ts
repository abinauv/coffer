import { describe, expect, it, vi } from 'vitest'
import { createApiProxy, toChannelName } from './ipc'

describe('toChannelName', () => {
  it('joins group and method with a colon', () => {
    expect(toChannelName('companies', 'open')).toBe('companies:open')
  })
})

describe('createApiProxy', () => {
  it('dispatches a call to the group:method channel', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, data: [] })
    const api = createApiProxy(invoke)

    await api.companies.list()

    expect(invoke).toHaveBeenCalledExactlyOnceWith('companies:list')
  })

  it('forwards arguments unchanged', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, data: null })
    const api = createApiProxy(invoke)
    const input = { id: 'acme', passphrase: 'correct horse battery staple' }

    await api.companies.open(input)

    expect(invoke).toHaveBeenCalledWith('companies:open', input)
  })

  it('returns whatever invoke resolves to', async () => {
    const expected = { ok: true as const, data: [] }
    const api = createApiProxy(vi.fn().mockResolvedValue(expected))

    await expect(api.companies.list()).resolves.toBe(expected)
  })

  it('propagates a rejection rather than swallowing it', async () => {
    const api = createApiProxy(vi.fn().mockRejectedValue(new Error('channel closed')))

    await expect(api.companies.list()).rejects.toThrow('channel closed')
  })

  it('resolves methods that were never enumerated ahead of time', async () => {
    /* The point of the proxy: adding a method to CofferApi requires no wiring here.
     * A group and method that exist only in the type system still dispatch. */
    const invoke = vi.fn().mockResolvedValue({ ok: true, data: null })
    const api = createApiProxy(invoke) as unknown as Record<
      string,
      Record<string, (...a: unknown[]) => Promise<unknown>>
    >

    await api['ledger']!['postEntry']!({ amount: '100.00' })

    expect(invoke).toHaveBeenCalledWith('ledger:postEntry', { amount: '100.00' })
  })
})
