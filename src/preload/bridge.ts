/*
 * Building the object that crosses the context bridge.
 *
 * `createApiProxy` cannot be handed to `contextBridge.exposeInMainWorld` directly.
 * Electron copies an exposed object property by property, reading its own keys through
 * V8 — and a Proxy over an empty target has none, so the call fails with
 * "An object could not be cloned" and the renderer gets `window.coffer === undefined`.
 * Verified against Electron 43, not assumed.
 *
 * So the proxy is still what dispatches every call — channel names are derived in
 * exactly one place, in the contract — and this module walks `API_SURFACE` once to pull
 * those dispatch functions onto a plain object with real own properties, which
 * `contextBridge` is happy to copy.
 *
 * The other job here is the envelope. The renderer's entire error story is "every call
 * resolves to a Result", so a call that never reaches a handler must not reject and must
 * not leak why. Electron's own IPC failures — no handler on that channel, an argument
 * that would not structured-clone — carry main-process detail in their message; that
 * detail goes to the preload console, and the renderer gets a fixed sentence.
 */

import type { AppError, Result } from '../shared/dto'
import type { ChannelName, CofferApi } from '../shared/ipc'
import { createApiProxy } from '../shared/ipc'
/* Pure data with no main-process dependencies: the runtime enumeration of a contract
 * that is otherwise a compile-time-only interface. It belongs in src/shared/ipc.ts,
 * which is frozen for this batch — see the batch report. */
import { API_SURFACE, isResultEnvelope } from '../main/ipc/surface'

export type Invoke = (channel: ChannelName, ...args: unknown[]) => Promise<unknown>

/** Where the bridge reports a failure that never reached a handler. */
export type BridgeFailureLogger = (message: string, cause: unknown) => void

/**
 * What the renderer is told when the call did not reach the main process at all. This is
 * always a wiring bug rather than something the user did, so the advice is the only
 * advice that ever helps with one.
 */
export const BRIDGE_FAILURE: AppError = {
  code: 'IPC_UNAVAILABLE',
  message:
    'Coffer could not reach the part of the app that does the work. Restart Coffer, and ' +
    'report this if it happens again.',
}

type BridgeCall = (...args: unknown[]) => Promise<Result<unknown>>
type LooseApi = Record<string, Record<string, BridgeCall>>

function guard(invoke: Invoke, onFailure: BridgeFailureLogger): Invoke {
  return async (channel, ...args) => {
    let value: unknown
    try {
      value = await invoke(channel, ...args)
    } catch (cause) {
      onFailure(`IPC ${channel} failed before it reached a handler.`, cause)
      return { ok: false, error: BRIDGE_FAILURE }
    }

    if (!isResultEnvelope(value)) {
      onFailure(`IPC ${channel} answered with something that is not a Result envelope.`, value)
      return { ok: false, error: BRIDGE_FAILURE }
    }
    return value
  }
}

/**
 * The API object to expose on `window.coffer`: real own properties all the way down, so
 * `contextBridge` can copy it into the renderer's world.
 */
export function createBridgeApi(invoke: Invoke, onFailure: BridgeFailureLogger): CofferApi {
  const dispatch = createApiProxy(guard(invoke, onFailure)) as unknown as LooseApi
  const bridged: LooseApi = {}

  for (const [group, methods] of Object.entries(API_SURFACE)) {
    const groupApi: Record<string, BridgeCall> = {}

    for (const method of Object.keys(methods)) {
      const call = dispatch[group]?.[method]
      if (typeof call !== 'function') {
        throw new Error(`The API proxy produced no callable for '${group}:${method}'.`)
      }
      groupApi[method] = call
    }

    bridged[group] = groupApi
  }

  return bridged as unknown as CofferApi
}
