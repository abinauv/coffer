/*
 * The handler registry and the error boundary.
 *
 * A handler is registered against the contract, not against a string: the group and
 * method are keys of `CofferApi`, so the channel name cannot be mistyped and the
 * handler's arguments and return type are the contract's. Registering a channel the
 * contract does not declare, or registering one twice, throws — at startup, where a
 * developer sees it, rather than at runtime where a user does.
 *
 * Every handler runs inside the boundary, which guarantees the renderer four things:
 *
 *   1. It always receives a `Result`. A handler that returns one is passed through
 *      untouched; a handler that throws produces `{ ok: false }`; a handler that returns
 *      anything else is itself a bug and is treated as one.
 *   2. Arguments were validated before the handler saw them (./validate.ts).
 *   3. An expected failure keeps its code, so the UI can branch (./errors.ts).
 *   4. An unexpected exception says nothing. It is logged in full on this side and
 *      arrives as one generic message.
 *
 * The boundary NEVER LOGS ARGUMENTS. `CreateCompanyInput` carries a passphrase and
 * `RecoverCompanyInput` carries a recovery code; a log line that helpfully dumped the
 * call would write both to disk in clear text. The channel and the error are enough.
 */

import type { Result } from '../../shared/dto'
import type { ApiGroup, ChannelName, CofferApi } from '../../shared/ipc'
import { toChannelName } from '../../shared/ipc'
import { type ErrorMapper, INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE, mapError } from './errors'
import { type ApiMethod, apiMethods, isApiChannel, isResultEnvelope } from './surface'

/** Just enough of a logger to record a boundary failure. `electron-log` satisfies it. */
export interface IpcLogger {
  warn(message: string, ...meta: unknown[]): void
  error(message: string, ...meta: unknown[]): void
}

/** What the registry needs from Electron. Injected so the registry itself is portable. */
export interface IpcTransport {
  handle(channel: ChannelName, listener: ChannelListener): void
}

export type ChannelListener = (args: readonly unknown[]) => Promise<Result<unknown>>

/**
 * One handler, derived from its contract method.
 *
 * `parseArgs` is not optional and not a formality: it is the only way to get from the
 * `unknown[]` the renderer sent to the typed arguments `handle` declares. The type
 * system will not let a handler skip validation and reach for `args[0]` directly.
 */
export type HandlerSpec<F> = F extends (...args: infer A) => Promise<infer R>
  ? {
      readonly parseArgs: (raw: readonly unknown[]) => A
      readonly handle: (...args: A) => Promise<R> | R
    }
  : never

/** Every method of one group. Missing one is a compile error, not a startup surprise. */
export type GroupHandlers<G extends ApiGroup> = {
  readonly [M in keyof CofferApi[G]]: HandlerSpec<CofferApi[G][M]>
}

/** Thrown when the wiring is wrong. Always at startup, never in response to a user. */
export class HandlerRegistrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HandlerRegistrationError'
  }
}

/* The generic HandlerSpec is a conditional type; inside the registry the specific method
 * is not known, so it is erased exactly once, here, rather than at every call site. */
interface ErasedSpec {
  parseArgs: (raw: readonly unknown[]) => unknown[]
  handle: (...args: unknown[]) => unknown
}

export class HandlerRegistry {
  readonly #transport: IpcTransport
  readonly #logger: IpcLogger
  readonly #errorMappers: readonly ErrorMapper[]
  readonly #registered = new Set<ChannelName>()

  constructor(
    transport: IpcTransport,
    logger: IpcLogger,
    errorMappers: readonly ErrorMapper[] = [],
  ) {
    this.#transport = transport
    this.#logger = logger
    this.#errorMappers = errorMappers
  }

  /** Channels registered so far, in registration order. */
  get channels(): readonly ChannelName[] {
    return [...this.#registered]
  }

  has(channel: ChannelName): boolean {
    return this.#registered.has(channel)
  }

  register<G extends ApiGroup, M extends ApiMethod<G>>(
    group: G,
    method: M,
    spec: HandlerSpec<CofferApi[G][M]>,
  ): void {
    const channel = toChannelName(group, method)

    if (!isApiChannel(channel)) {
      throw new HandlerRegistrationError(
        `Cannot register '${channel}': the contract in src/shared/ipc.ts declares no such ` +
          'method. Add it to CofferApi and to API_SURFACE first.',
      )
    }
    if (this.#registered.has(channel)) {
      throw new HandlerRegistrationError(
        `Cannot register '${channel}': something already handles that channel. Two ` +
          'handlers for one method means one of them never runs.',
      )
    }

    this.#registered.add(channel)
    const erased = spec as unknown as ErasedSpec
    this.#transport.handle(channel, (args) => this.#run(channel, erased, args))
  }

  /** Register a whole group at once. The group's shape is checked by the type system. */
  registerGroup<G extends ApiGroup>(group: G, handlers: GroupHandlers<G>): void {
    const declared = apiMethods(group)
    const supplied = Object.keys(handlers)

    for (const method of supplied) {
      if (!(declared as readonly string[]).includes(method)) {
        throw new HandlerRegistrationError(
          `Cannot register '${toChannelName(group, method)}': the contract declares no such ` +
            `method on '${group}'.`,
        )
      }
    }

    for (const method of declared) {
      const spec = (handlers as Record<string, unknown>)[method]
      if (spec === undefined) {
        throw new HandlerRegistrationError(
          `Cannot register group '${group}': no handler was supplied for '${method}'.`,
        )
      }
      this.register(group, method, spec as HandlerSpec<CofferApi[G][ApiMethod<G>]>)
    }
  }

  async #run(
    channel: ChannelName,
    spec: ErasedSpec,
    args: readonly unknown[],
  ): Promise<Result<unknown>> {
    try {
      const parsed = spec.parseArgs(args)
      const result = await spec.handle(...parsed)

      if (!isResultEnvelope(result)) {
        /* Not a user's problem and not something the renderer can be told about — the
         * handler is wrong. Raised here so it lands in the log with the channel name. */
        throw new Error(`Handler for '${channel}' did not return a Result envelope.`)
      }
      return result
    } catch (cause) {
      const recognised = mapError(cause, this.#errorMappers)

      /* Full detail on this side of the boundary, one generic sentence on the other.
       * The arguments are deliberately absent — see the note at the top of this file. */
      if (recognised !== null) {
        this.#logger.warn(`IPC ${channel} rejected: ${recognised.code}`, cause)
        return { ok: false, error: recognised }
      }

      this.#logger.error(`IPC ${channel} threw an unhandled error`, cause)
      return {
        ok: false,
        error: { code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE },
      }
    }
  }
}
