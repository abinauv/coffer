/*
 * What a renderer test needs in order to render a screen: the providers a screen
 * assumes are somewhere above it, and a bridge that answers IPC.
 *
 * THE BRIDGE IS BUILT WITH `createApiProxy` — the same function the preload uses. A
 * hand-written `{ ledger: { listAccounts: … } }` object would be a second implementation
 * of the contract, and the failure that follows is specific: rename a method or move it
 * between groups and production breaks while every test keeps passing, because the stub
 * still has the old shape and nothing derives the channel name from anything real. Here
 * the stub is looked up by the channel `createApiProxy` computes, so a method the screen
 * calls under a name no stub answers to is a miss, and a miss is a test failure.
 *
 * A MISS FAILS LOUDLY, and it has to be arranged rather than assumed. `callApi` catches
 * anything thrown across the bridge and turns it into an `IPC_FAILED` Result — which is
 * right in production and useless here, because a forgotten stub would render as an
 * ordinary error notice and the test would fail on some unrelated assertion about
 * missing content. So misses are recorded as well as thrown, and `setup.ts` fails the
 * test on any that were left behind, naming the channel.
 */

import { render, type RenderResult } from '@testing-library/react'
import type { JSX, ReactNode } from 'react'
import { ToastViewport } from '@renderer/components/toast/ToastViewport'
import { CommandProvider } from '@renderer/store/commands'
import { PlatformProvider } from '@renderer/store/platform'
import { RegimeProvider } from '@renderer/store/regime'
import { ThemeProvider } from '@renderer/store/theme'
import { ToastProvider } from '@renderer/store/toasts'
import type { AppInfo, RegimeDescription, Result } from '@shared/dto'
import { createApiProxy, type CofferApi } from '@shared/ipc'

// ---- The bridge ------------------------------------------------------------

/** Any subset of the real API. What a screen calls and the stub does not answer is a miss. */
export type BridgeStub = { [G in keyof CofferApi]?: Partial<CofferApi[G]> }

export interface BridgeCall {
  channel: string
  args: readonly unknown[]
}

export interface FakeBridge {
  /** Every call that crossed the bridge, in order. */
  readonly calls: readonly BridgeCall[]
  /** Calls to a channel, for asserting on the input a screen sent. */
  callsTo(channel: string): readonly BridgeCall[]
  /** The most recent call to a channel, or undefined. */
  lastCallTo(channel: string): BridgeCall | undefined
}

type AnyHandler = (...args: readonly unknown[]) => unknown

/* Channels every screen reaches for without knowing it: `ScreenFrame` renders
 * `TitleBarSync`, and the `PlatformProvider` asks who it is running on. Stubbing these
 * in every test would be noise, so they have defaults — overridable, because a test
 * about the macOS title bar is a legitimate thing to write. */
export const DEFAULT_APP_INFO: AppInfo = {
  name: 'Coffer',
  version: '0.0.0-test',
  platform: 'linux',
  isDevelopment: true,
}

function ok<T>(data: T): Promise<Result<T>> {
  return Promise.resolve({ ok: true, data })
}

/*
 * The regime a screen test runs under unless it says otherwise.
 *
 * India, because that is what the assertions in the existing screen tests were written
 * against and changing them would be changing what they test. It is a TEST default and
 * not a production one — `OpenCompanyRegime` fetches the real thing and refuses to draw
 * the workspace until it has it, so nothing here is standing in for a fallback that
 * exists in the app.
 *
 * Pass `regime` to `renderScreen` to render a screen under another one. There is at
 * least one test that does; without it, "the format comes from the regime" would be a
 * claim no assertion in the renderer could tell from the old hard-coded grouping.
 */
export const DEFAULT_REGIME: RegimeDescription = {
  id: 'in',
  label: 'India — GST',
  numberFormat: {
    groupSizes: [3, 2],
    decimalSeparator: '.',
    groupSeparator: ',',
    currencyCode: 'INR',
    currencySymbol: '₹',
  },
  jurisdictions: [
    { code: '29', name: 'Karnataka' },
    { code: '33', name: 'Tamil Nadu' },
  ],
  taxRates: [
    { ratePct: '0', label: 'Nil', note: 'Exempt, nil-rated and zero-rated supplies.' },
    { ratePct: '5', label: '5%', note: 'Essentials and most transport services.' },
    { ratePct: '18', label: '18%', note: 'The main slab — most goods and most services.' },
  ],
  taxComponents: [
    { code: 'CGST', label: 'Central GST', levy: 'both' },
    { code: 'SGST', label: 'State GST', levy: 'both' },
    { code: 'IGST', label: 'Integrated GST', levy: 'both' },
  ],
  classification: { code: 'HSN', label: 'HSN / SAC', validLengths: [4, 6, 8] },
}

function defaultStub(): BridgeStub {
  return {
    system: {
      getAppInfo: () => ok(DEFAULT_APP_INFO),
      setTitleBarOverlay: () => ok(undefined),
    },
  }
}

/** Channels a test reached that nothing answered. Drained and asserted on in setup.ts. */
const missed: string[] = []

export function takeMissedChannels(): readonly string[] {
  return missed.splice(0, missed.length)
}

/**
 * Puts a stubbed `window.coffer` in place for the rest of the test.
 *
 * Returns the record of what crossed it, so a test can assert on the input a screen
 * sent as well as on what it did with the answer.
 */
export function installBridge(stub: BridgeStub = {}): FakeBridge {
  const merged: BridgeStub = { ...defaultStub(), ...stub }
  /* A test that overrides one `system` method must not lose the other's default. */
  if (stub.system) merged.system = { ...defaultStub().system, ...stub.system }

  const calls: BridgeCall[] = []

  const api = createApiProxy(async (channel, ...args) => {
    calls.push({ channel, args })
    const [group = '', method = ''] = channel.split(':')
    const group_ = merged[group as keyof CofferApi] as Record<string, AnyHandler> | undefined
    const handler = group_?.[method]

    if (typeof handler !== 'function') {
      missed.push(channel)
      throw new Error(`No stub answers '${channel}'.`)
    }
    return await handler(...args)
  })

  ;(globalThis as { coffer?: CofferApi }).coffer = api

  return {
    get calls() {
      return calls
    },
    callsTo: (channel) => calls.filter((call) => call.channel === channel),
    lastCallTo: (channel) => calls.filter((call) => call.channel === channel).at(-1),
  }
}

export function uninstallBridge(): void {
  delete (globalThis as { coffer?: CofferApi }).coffer
}

// ---- Rendering -------------------------------------------------------------

/*
 * The providers a screen expects, in the order the app nests them, plus the toast
 * viewport.
 *
 * The viewport is here because without it `show({ … })` succeeds and puts nothing on
 * screen — a test could then assert that a save worked while the user was never told
 * anything, which is the exact bug the toast exists to prevent.
 *
 * The real providers rather than stand-in context values: they are the code that reads
 * `localStorage`, calls `matchMedia` and installs the keydown listener, and a screen
 * test is the only place any of that runs together.
 */
function Providers({
  regime,
  children,
}: {
  regime: RegimeDescription | null
  children: ReactNode
}): JSX.Element {
  return (
    <ThemeProvider>
      <PlatformProvider>
        <ToastProvider>
          <RegimeProvider value={regime}>
            <CommandProvider>
              {children}
              <ToastViewport />
            </CommandProvider>
          </RegimeProvider>
        </ToastProvider>
      </PlatformProvider>
    </ThemeProvider>
  )
}

export interface RenderScreenOptions {
  /** Installed before the first render, so a mount-time call is already answered. */
  bridge?: BridgeStub
  /**
   * The regime the screen renders under. `DEFAULT_REGIME` — India — unless given.
   *
   * `null` is a company being closed, and a screen that formats money will throw. That
   * is the contract `useNumberFormat` states, and a test may assert it.
   */
  regime?: RegimeDescription | null
}

export interface RenderedScreen extends RenderResult {
  bridge: FakeBridge
}

/** Renders a screen inside the providers it expects, with a stubbed bridge behind it. */
export function renderScreen(ui: ReactNode, options: RenderScreenOptions = {}): RenderedScreen {
  const bridge = installBridge(options.bridge)
  const regime = options.regime === undefined ? DEFAULT_REGIME : options.regime
  const result = render(<Providers regime={regime}>{ui}</Providers>)
  return Object.assign(result, { bridge })
}
