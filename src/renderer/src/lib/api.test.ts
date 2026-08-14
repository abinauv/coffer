import { describe, expect, it } from 'vitest'
import type { CofferApi } from '@shared/ipc'
import { BRIDGE_UNAVAILABLE, callApi } from './api'

/** Only the methods a given test touches need to exist. */
function fakeBridge(overrides: Partial<CofferApi>): CofferApi {
  return overrides as unknown as CofferApi
}

describe('callApi', () => {
  it('passes a successful result straight through', async () => {
    const bridge = fakeBridge({
      companies: {
        list: async () => ({ ok: true, data: [] }),
      } as unknown as CofferApi['companies'],
    })
    await expect(callApi((api) => api.companies.list(), bridge)).resolves.toEqual({
      ok: true,
      data: [],
    })
  })

  it('passes an expected failure straight through, code intact', async () => {
    const error = { code: 'VAULT_MISSING', message: 'The key file is not beside the database.' }
    const bridge = fakeBridge({
      companies: { list: async () => ({ ok: false, error }) } as unknown as CofferApi['companies'],
    })
    const result = await callApi((api) => api.companies.list(), bridge)
    expect(result).toEqual({ ok: false, error })
  })

  it('reports a missing bridge rather than throwing on undefined', async () => {
    const result = await callApi((api) => api.companies.list(), null)
    expect(result).toEqual({ ok: false, error: BRIDGE_UNAVAILABLE })
  })

  /* A handler that throws crosses IPC as a rejection. Every caller converting
   * that by hand is how one of them ends up not converting it. */
  it('turns a rejected invoke into a Result', async () => {
    const bridge = fakeBridge({
      companies: {
        list: async () => {
          throw new Error('Error invoking remote method')
        },
      } as unknown as CofferApi['companies'],
    })
    const result = await callApi((api) => api.companies.list(), bridge)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('IPC_FAILED')
      expect(result.error.details?.['cause']).toBe('Error invoking remote method')
    }
  })

  it('turns a synchronous throw into a Result too', async () => {
    const result = await callApi(() => {
      throw new Error('selector blew up')
    }, fakeBridge({}))
    expect(result.ok).toBe(false)
  })

  it('describes a non-Error rejection without crashing', async () => {
    const result = await callApi(() => Promise.reject('plain string'), fakeBridge({}))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.details?.['cause']).toBe('plain string')
  })

  it('never puts a stack trace in a user-facing message', async () => {
    const result = await callApi(() => {
      throw new Error('at Object.<anonymous> (/src/main/index.ts:1:1)')
    }, fakeBridge({}))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).not.toContain('at Object')
  })
})
