/*
 * The runtime shadow of the frozen contract in src/shared/ipc.ts.
 *
 * `CofferApi` is an interface — it does not exist at runtime. So neither the startup
 * completeness check (src/main/ipc/index.ts) nor the preload bridge (src/preload) can
 * enumerate it, and both need to. `API_SURFACE` is that enumeration.
 *
 * Its type makes it impossible to get wrong: the mapped type admits exactly the groups
 * and methods the contract declares, no more and no less. Adding a method to `CofferApi`
 * therefore fails to compile until it is listed here, and fails at startup until a
 * handler exists for it. Neither failure can reach a user.
 *
 * It lives under main/ipc rather than in src/shared/ because shared/ is frozen for this
 * batch. It belongs in src/shared/ipc.ts beside `toChannelName` and `createApiProxy` —
 * see the batch report.
 */

import type { Result } from '../../shared/dto'
import type { ApiGroup, ChannelName, CofferApi } from '../../shared/ipc'
import { toChannelName } from '../../shared/ipc'

/** The method names of one group, as string literals. */
export type ApiMethod<G extends ApiGroup> = Extract<keyof CofferApi[G], string>

/**
 * Exhaustive by construction. `true` carries no information; the keys are the point.
 */
export type ApiSurface = {
  readonly [G in ApiGroup]: { readonly [M in keyof CofferApi[G]]: true }
}

export const API_SURFACE: ApiSurface = {
  system: {
    getAppInfo: true,
    chooseDirectory: true,
    chooseBackupArchive: true,
    chooseCompanyFile: true,
    revealInFileManager: true,
    setTitleBarOverlay: true,
  },
  companies: {
    list: true,
    create: true,
    open: true,
    recover: true,
    close: true,
    changePassphrase: true,
    backup: true,
    restore: true,
    addExisting: true,
    forget: true,
    rename: true,
    checkPassphrase: true,
  },
}

export const API_GROUPS: readonly ApiGroup[] = Object.keys(API_SURFACE) as ApiGroup[]

/** The methods declared for one group, in declaration order. */
export function apiMethods<G extends ApiGroup>(group: G): readonly ApiMethod<G>[] {
  return Object.keys(API_SURFACE[group]) as ApiMethod<G>[]
}

/** Every channel the contract declares, derived exactly as the renderer derives them. */
export function apiChannels(): readonly ChannelName[] {
  return API_GROUPS.flatMap((group) =>
    apiMethods(group).map((method) => toChannelName(group, method)),
  )
}

/** True when `channel` names a method the contract actually declares. */
export function isApiChannel(channel: string): boolean {
  return apiChannels().includes(channel)
}

// ---- The result envelope --------------------------------------------------

/** Wrap a value in a success envelope. */
export function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

/**
 * True when `value` is a well-formed `Result`.
 *
 * Used on both sides of the bridge: main refuses to send anything else, and preload
 * refuses to hand anything else to the renderer. The renderer's whole error-handling
 * story rests on the envelope always being there.
 */
export function isResultEnvelope(value: unknown): value is Result<unknown> {
  if (typeof value !== 'object' || value === null) return false

  const candidate = value as { ok?: unknown; error?: unknown }
  if (candidate.ok === true) return 'data' in candidate
  if (candidate.ok !== false) return false

  const error = candidate.error
  if (typeof error !== 'object' || error === null) return false

  const { code, message } = error as { code?: unknown; message?: unknown }
  return typeof code === 'string' && typeof message === 'string'
}
