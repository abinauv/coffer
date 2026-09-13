/*
 * The regime store.
 *
 * Three things are worth testing and only one of them is "it fetches".
 *
 * THE GATE: the workspace must not draw before the rules have arrived, because the
 * alternative to waiting is a default and the default was the bug. THE FAILURE: books
 * whose regime cannot be read are not books this build can show figures for, so the
 * message is fatal and permanent rather than a toast somebody dismisses. And THE RACE:
 * closing a company must not leave its rules published over whatever comes next — an
 * invoice formatted under the wrong regime looks entirely ordinary.
 *
 * THE REAL `CompanyProvider`, NOT A MOCKED `useCompany`. The first version of this file
 * mocked the module and the mock did not take; chasing that was the wrong instinct
 * anyway. What is being tested is that these two providers agree about when a company is
 * open, and a stand-in for one of them cannot show that. The company is opened through
 * `renderScreen`'s `company` option, which drives the real provider through the same
 * `adopt` the welcome screens call; `Closer` below drives the real `close`.
 *
 * AND `regime: null` ON EVERY MOUNT IS LOAD-BEARING, not tidiness. `renderScreen` puts a
 * `RegimeProvider` above whatever it renders, so `OpenCompanyRegime` — the thing under
 * test — is nested inside one. Left at the harness's default that outer provider would
 * publish India, and a mutation DELETING the inner `RegimeProvider` from
 * `OpenCompanyRegime` would leave `Probe` reading `regime: in` from above and every
 * assertion here still passing. Publishing null outside means the only way `regime: in`
 * reaches the probe is through the provider this file is about.
 */

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JSX, ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { RegimeDescription, Result } from '@shared/dto'
import {
  DEFAULT_COMPANY,
  DEFAULT_REGIME,
  renderScreen,
  type BridgeStub,
} from '@renderer/test/harness'
import { useCompany } from './company'
import { OpenCompanyRegime, RegimeProvider, useNumberFormat, useRegime } from './regime'

const SUMMARY = DEFAULT_COMPANY

/** Prints what the hooks see, so assertions are made on text rather than on state. */
function Probe(): JSX.Element {
  const regime = useRegime()
  return <p>regime: {regime === null ? 'none' : regime.id}</p>
}

function Money(): JSX.Element {
  const format = useNumberFormat()
  return <p>separator: {format.groupSeparator}</p>
}

/** A way to close the books, as the workspace offers one. Opening is the harness's job. */
function Closer(): JSX.Element {
  const { close } = useCompany()
  return (
    <button type="button" onClick={() => void close()}>
      close the books
    </button>
  )
}

const CLOSES: BridgeStub = {
  companies: { close: () => Promise.resolve<Result<void>>({ ok: true, data: undefined }) },
}

function mount(stub: BridgeStub, open: boolean, children: ReactNode = <Probe />): void {
  renderScreen(
    <>
      <Closer />
      <OpenCompanyRegime>{children}</OpenCompanyRegime>
    </>,
    { bridge: { ...CLOSES, ...stub }, company: open ? SUMMARY : null, regime: null },
  )
}

const answering = (data: RegimeDescription): BridgeStub => ({
  regime: { describe: () => Promise.resolve<Result<RegimeDescription>>({ ok: true, data }) },
})

/** A `regime.describe` that hangs until the test lets it answer. */
function pending(): { stub: BridgeStub; answer: (result: Result<RegimeDescription>) => void } {
  let release: (result: Result<RegimeDescription>) => void = () => {}
  const stub: BridgeStub = {
    regime: {
      describe: () =>
        new Promise<Result<RegimeDescription>>((resolve) => {
          release = resolve
        }),
    },
  }
  return { stub, answer: (result) => release(result) }
}

describe('with no company open', () => {
  it('publishes nothing and renders its children straight away', () => {
    mount({}, false)

    /* Synchronously: the welcome screens show no money and must not wait on a call that
     * is never going to be made. */
    expect(screen.getByText(/regime:/)).toHaveTextContent('regime: none')
  })

  it('never asks main for rules there are none of', () => {
    const { bridge } = renderScreen(
      <OpenCompanyRegime>
        <Probe />
      </OpenCompanyRegime>,
      { bridge: CLOSES, regime: null },
    )

    expect(bridge.callsTo('regime:describe')).toHaveLength(0)
  })
})

describe('with a company open', () => {
  it('asks once and publishes what came back', async () => {
    mount(answering(DEFAULT_REGIME), true)

    expect(await screen.findByText(/regime:/)).toHaveTextContent('regime: in')
  })

  /*
   * THE GATE. Before the answer arrives there are no children at all — not children
   * holding a placeholder format, which is the version of this that would have brought
   * the old hard-coded grouping back under a different name.
   */
  it('draws nothing until the rules arrive', async () => {
    const { stub, answer } = pending()
    mount(stub, true)

    await waitFor(() => expect(screen.queryByText(/regime:/)).toBeNull())

    answer({ ok: true, data: DEFAULT_REGIME })
    expect(await screen.findByText(/regime:/)).toHaveTextContent('regime: in')
  })

  it('says so, permanently, when the rules cannot be read', async () => {
    mount(
      {
        regime: {
          describe: () =>
            Promise.resolve<Result<RegimeDescription>>({
              ok: false,
              error: {
                code: 'COMPANY_REGIME_UNKNOWN',
                message: "These books were set up under a tax regime called 'pt'.",
              },
            }),
        },
      },
      true,
    )

    expect(await screen.findByText(/could not be read/)).toBeInTheDocument()
    /* The reason, not merely that there was one — the message names the regime. */
    expect(screen.getByText(/'pt'/)).toBeInTheDocument()
    expect(screen.queryByText(/regime:/)).toBeNull()
  })

  /*
   * THE RACE. A slow answer for a company that has since been closed must not be
   * published. Without the guard this ends up showing 'regime: in' with no company open,
   * and whatever is opened next inherits the previous file's rules.
   */
  it('drops an answer that arrives after the company was closed', async () => {
    const user = userEvent.setup()
    const { stub, answer } = pending()
    mount(stub, true)

    await user.click(screen.getByRole('button', { name: 'close the books' }))

    /*
     * TWO THINGS HAD TO BE ARRANGED HERE, AND A MUTATION FOUND BOTH.
     *
     * First, wait for the close to land before releasing the answer. `close()` is
     * asynchronous and the click returns before it finishes, so releasing immediately
     * let the two settle in either order — and one of those orders ends at 'none'
     * whether or not the guard exists.
     *
     * Second, the release has to be inside `act`. A bare `await Promise.resolve()`
     * resolves the promise but does not let React flush the state update behind it, so
     * the final assertion ran against the previous render and passed against a store
     * with no guard at all. That is the more instructive of the two: the test was
     * asserting on a screen that had not been redrawn yet.
     */
    await waitFor(() => expect(screen.getByText(/regime:/)).toHaveTextContent('regime: none'))

    await act(async () => {
      answer({ ok: true, data: DEFAULT_REGIME })
    })

    expect(screen.getByText(/regime:/)).toHaveTextContent('regime: none')
  })

  /*
   * And closing a company DROPS its rules rather than leaving them up.
   *
   * Distinct from the race above, which never had an answer to keep: there the regime
   * was still null when the company closed, so "keep what we had" and "clear it" are the
   * same instruction. Here the rules are loaded first, so the two come apart — and a
   * store that kept them would hand the next company opened another file's grouping.
   */
  it('drops the rules when the company closes', async () => {
    const user = userEvent.setup()
    mount(answering(DEFAULT_REGIME), true)

    expect(await screen.findByText(/regime:/)).toHaveTextContent('regime: in')

    await user.click(screen.getByRole('button', { name: 'close the books' }))

    await waitFor(() => expect(screen.getByText(/regime:/)).toHaveTextContent('regime: none'))
  })
})

describe('useNumberFormat', () => {
  it('hands over the regime own grouping', () => {
    render(
      <RegimeProvider
        value={{
          ...DEFAULT_REGIME,
          numberFormat: { ...DEFAULT_REGIME.numberFormat, groupSeparator: '.' },
        }}
      >
        <Money />
      </RegimeProvider>,
    )

    expect(screen.getByText(/separator:/)).toHaveTextContent('separator: .')
  })

  /*
   * REFUSES TO GUESS. There is no correct number format for books that are not open, and
   * the alternative to throwing is picking one — which is how the renderer came to be
   * writing lakh/crore for everybody in the first place.
   */
  it('throws rather than defaulting when no company is open', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() =>
      render(
        <RegimeProvider value={null}>
          <Money />
        </RegimeProvider>,
      ),
    ).toThrow(/needs an open company/)

    quiet.mockRestore()
  })

  it('throws outside a provider, naming the provider', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => render(<Probe />)).toThrow(/RegimeProvider/)

    quiet.mockRestore()
  })
})
