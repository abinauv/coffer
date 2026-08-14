/*
 * The renderer's side of the IPC bridge.
 *
 * `window.coffer` is the whole surface (src/preload/index.ts). This module adds
 * two things around it and nothing else:
 *
 *   - a null check, because the bridge is absent in a plain browser tab and would
 *     otherwise fail as `Cannot read properties of undefined`;
 *   - a catch, because a handler that throws crosses IPC as a rejected promise,
 *     and every caller turning that into a Result themselves is how one of them
 *     ends up not doing it.
 *
 * Both failures come back as a `Result` with an actionable message, so screens
 * have exactly one shape to branch on (docs/CONVENTIONS.md §5).
 */

import type { AppError, Result } from '@shared/dto'
import type { CofferApi } from '@shared/ipc'

export function getBridge(): CofferApi | null {
  if (typeof globalThis === 'undefined') return null
  const host = globalThis as { coffer?: CofferApi }
  return host.coffer ?? null
}

export const BRIDGE_UNAVAILABLE: AppError = {
  code: 'BRIDGE_UNAVAILABLE',
  message: 'Coffer cannot reach the application core. Restart the application.',
}

/**
 * Runs one call against the bridge.
 *
 *   const result = await callApi((api) => api.companies.list())
 *
 * `bridge` is a parameter so tests can pass a stand-in; production callers omit it.
 */
export async function callApi<T>(
  select: (api: CofferApi) => Promise<Result<T>>,
  bridge: CofferApi | null = getBridge(),
): Promise<Result<T>> {
  if (!bridge) return { ok: false, error: BRIDGE_UNAVAILABLE }
  try {
    return await select(bridge)
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'IPC_FAILED',
        message: 'That action could not be completed. Try again.',
        details: { cause: describeCause(cause) },
      },
    }
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return typeof cause === 'string' ? cause : 'Unknown error'
}
