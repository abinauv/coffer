/*
 * Where the IPC layer is assembled and where the contract is proved.
 *
 * `registerIpcHandlers` registers every group and then asserts that every method the
 * contract declares has a handler behind it. That assertion is what makes the contract
 * worth trusting: without it, adding a method to `CofferApi` gives the renderer a
 * fully-typed call that compiles, ships, and fails the first time a user clicks the
 * button. With it, the app refuses to start and the developer finds out in seconds.
 *
 * Nothing here imports Electron. The production wiring — `ipcMain`, `dialog`, `shell`,
 * `electron-log` — lives in ./electron.ts, so the assembly and the completeness check
 * are testable without an Electron process.
 */

import type { ChannelName } from '../../shared/ipc'
import type { ErrorMapper } from './errors'
import { type CompanyService, createCompaniesHandlers } from './handlers/companies'
import { type LedgerService, createLedgerHandlers } from './handlers/ledger'
import { type PartiesService, createPartiesHandlers } from './handlers/parties'
import { type ReportService, createReportHandlers } from './handlers/reports'
import { type SystemEnvironment, createSystemHandlers } from './handlers/system'
import { type PathAllowlist, createPathAllowlist } from './path-access'
import { HandlerRegistrationError, HandlerRegistry } from './registry'
import type { IpcLogger, IpcTransport } from './registry'
import { apiChannels } from './surface'

export type { ErrorMapper } from './errors'
export type { CompanyService } from './handlers/companies'
export type { LedgerService } from './handlers/ledger'
export type { PartiesService } from './handlers/parties'
export type { ReportService } from './handlers/reports'
export type { SystemEnvironment } from './handlers/system'
export type { IpcLogger, IpcTransport } from './registry'
export { HandlerRegistrationError, HandlerRegistry } from './registry'

export interface IpcDependencies {
  transport: IpcTransport
  logger: IpcLogger
  system: SystemEnvironment
  /**
   * THE INJECTION POINT for src/main/companies.
   *
   * Nothing under src/main/ipc imports that module; it arrives here and nowhere else.
   * See `CompanyService` in ./handlers/companies.ts for the shape expected.
   */
  companies: CompanyService
  /**
   * THE INJECTION POINT for src/main/ledger.
   *
   * Every method on it needs an open company, and the service is what knows which one —
   * nothing under src/main/ipc reaches for a database handle.
   */
  ledger: LedgerService
  /**
   * THE INJECTION POINT for src/main/parties.
   *
   * A service of its own rather than another face of `ledger`, because a party is a
   * master record and not a posting — and because it needs the regime, to say whether a
   * registration number is real.
   */
  parties: PartiesService
  /**
   * THE INJECTION POINT for the read-only side of src/main/ledger.
   *
   * A separate dependency from `ledger` because the contract keeps the groups apart, and
   * one implementation may satisfy both — which is what src/main/ledger does.
   */
  reports: ReportService
  /**
   * Directories `system.revealInFileManager` may open before the user has picked
   * anything. In production this is the application data directory and nothing else.
   */
  revealRoots?: readonly string[]
  /**
   * Error types this layer cannot recognise on its own, so that their stable codes
   * still reach the UI.
   *
   * `src/main/companies` raises `CompanyError`, whose codes the company screens branch
   * on, and nothing under src/main/ipc may import that module. Supply a mapper here:
   *
   *     errorMappers: [
   *       (cause) => (isCompanyError(cause) ? { code: cause.code, message: cause.message } : null),
   *     ]
   *
   * A mapper can add codes; it cannot override the built-in mappings or the generic
   * fallback, so nothing it does can widen what an unexpected exception reveals.
   */
  errorMappers?: readonly ErrorMapper[]
}

/**
 * Register every handler group, then refuse to continue if the contract is not covered.
 *
 * Throws `HandlerRegistrationError` on a missing handler, a duplicate registration, or a
 * channel the contract does not declare. All three are wiring mistakes, and all three
 * surface here at startup.
 */
export function registerIpcHandlers(dependencies: IpcDependencies): HandlerRegistry {
  const allowlist: PathAllowlist = createPathAllowlist(dependencies.revealRoots)
  const registry = new HandlerRegistry(
    dependencies.transport,
    dependencies.logger,
    dependencies.errorMappers,
  )

  registry.registerGroup('system', createSystemHandlers(dependencies.system, allowlist))
  registry.registerGroup('companies', createCompaniesHandlers(dependencies.companies, allowlist))
  registry.registerGroup('ledger', createLedgerHandlers(dependencies.ledger))
  registry.registerGroup('parties', createPartiesHandlers(dependencies.parties))
  registry.registerGroup('reports', createReportHandlers(dependencies.reports))

  assertApiSurfaceComplete(registry)

  return registry
}

/** What the completeness check needs to know about a registry. */
export interface ChannelCoverage {
  has(channel: ChannelName): boolean
}

/**
 * Assert that every method in `CofferApi` is answered by a handler.
 *
 * The check runs against the channel names the renderer will actually use, derived by
 * the same `toChannelName` the proxy uses — so a group registered under a name the
 * renderer never calls counts as missing, which is exactly right.
 */
export function assertApiSurfaceComplete(registry: ChannelCoverage): void {
  const missing = apiChannels().filter((channel) => !registry.has(channel))
  if (missing.length === 0) return

  throw new HandlerRegistrationError(
    `The IPC contract is not fully implemented. No handler is registered for: ` +
      `${missing.join(', ')}. Every method on CofferApi needs one in ` +
      'src/main/ipc/handlers/<group>.ts — see docs/CONVENTIONS.md §4.',
  )
}
