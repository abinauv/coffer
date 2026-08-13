/*
 * The typed IPC contract. Single source of truth for every method the renderer may call.
 *
 * HOW TO ADD AN ENDPOINT (docs/CONVENTIONS.md §4):
 *   1. Add the method to its group in `CofferApi` below.
 *   2. Add any DTOs to ./dto.ts.
 *   3. Register a handler in src/main/ipc/handlers/<group>.ts under 'group:method'.
 *
 * That is the whole procedure. The renderer proxy is generated from this interface, so
 * `api.companies.list()` becomes callable and fully typed with no further wiring, and
 * no `ipcRenderer.invoke` call belongs anywhere else in the codebase.
 *
 * Channel names are `${group}:${method}`, derived automatically.
 */

import type {
  AppInfo,
  CompanySummary,
  CreateCompanyInput,
  OpenCompanyInput,
  OpenCompanyResult,
  Result,
} from './dto'

export interface CofferApi {
  system: {
    getAppInfo(): Promise<Result<AppInfo>>
  }

  companies: {
    list(): Promise<Result<CompanySummary[]>>
    create(input: CreateCompanyInput): Promise<Result<OpenCompanyResult>>
    open(input: OpenCompanyInput): Promise<Result<OpenCompanyResult>>
    close(): Promise<Result<void>>
  }
}

/** Every group name in the API. Used by the main-process handler registry. */
export type ApiGroup = keyof CofferApi

/** A channel name, e.g. 'companies:open'. */
export type ChannelName = string

export function toChannelName(group: string, method: string): ChannelName {
  return `${group}:${method}`
}

/**
 * Build a renderer-side proxy over `invoke`, so that a call to `api.companies.list()`
 * is dispatched to the channel 'companies:list'.
 *
 * Two levels of Proxy: the outer resolves the group, the inner resolves the method and
 * returns the calling function. Nothing is enumerated ahead of time, so adding a method
 * to `CofferApi` is genuinely the only change required.
 */
export function createApiProxy(
  invoke: (channel: ChannelName, ...args: unknown[]) => Promise<unknown>,
): CofferApi {
  return new Proxy({} as CofferApi, {
    get(_target, group: string) {
      return new Proxy(
        {},
        {
          get(_inner, method: string) {
            return (...args: unknown[]) => invoke(toChannelName(group, method), ...args)
          },
        },
      )
    },
  })
}
