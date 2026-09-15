/*
 * The company picker, and the welcome it becomes when there is nothing to pick.
 *
 * THE WELCOME IS FOR AN EMPTY LIST AND NOTHING ELSE. A list that failed to load is not an
 * empty one — showing "Welcome" over a registry that could not be read would tell somebody
 * with ten companies that they have none — so both directions are asserted.
 *
 * AND THE REQUESTS OTHER SCREENS SEND HERE. The unlock screen cannot find a file or remove
 * an entry itself, so it sends the user to the picker with `action` in the route. Each is
 * acted on once, at arrival.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JSX } from 'react'
import { useEffect } from 'react'
import { describe, expect, it } from 'vitest'
import type { CompanySummary, Result } from '@shared/dto'
import { DEFAULT_COMPANY, renderScreen, type BridgeStub } from '@renderer/test/harness'
import { makeRoute } from '@renderer/lib/routing'
import { useNavigation } from '@renderer/store/navigation'
import { CompanyPicker } from './CompanyPicker'

const ok = <T,>(data: T): Promise<Result<T>> => Promise.resolve({ ok: true, data })

const ACME: CompanySummary = DEFAULT_COMPANY

/**
 * Places the route, then mounts the picker — a request is read at arrival, so the route has
 * to carry it before the picker exists. Prints where navigation went.
 */
function AtRoute({ params }: { params: Record<string, string> }): JSX.Element {
  const { route, navigate } = useNavigation()
  const isPlaced = Object.keys(params).every((key) => route.params[key] === params[key])
  useEffect(() => {
    if (!isPlaced) navigate(makeRoute('welcome', 'companies', params), 'replace')
  }, [isPlaced, navigate, params])
  return (
    <>
      <p>route: {`${route.screenId} ${JSON.stringify(route.params)}`}</p>
      {isPlaced && route.screenId === 'companies' && <CompanyPicker />}
    </>
  )
}

function mount(
  options: {
    companies?: CompanySummary[]
    bridge?: BridgeStub
    params?: Record<string, string>
  } = {},
): ReturnType<typeof renderScreen> {
  const { companies = [], bridge = {}, params = {} } = options
  return renderScreen(<AtRoute params={params} />, {
    bridge: { ...bridge, companies: { list: () => ok(companies), ...bridge.companies } },
  })
}

describe('the welcome', () => {
  it('greets a first launch by name, in place of an empty list', async () => {
    mount()

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Welcome to Coffer' }),
    ).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Your companies' })).toBeNull()
  })

  it('offers the two ways in and the two ways back', async () => {
    mount()
    await screen.findByRole('heading', { name: 'Welcome to Coffer' })

    expect(screen.getByRole('button', { name: 'Create a company' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Open an existing company file…' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Use a recovery code' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Restore from a backup' })).toBeVisible()
  })

  it('makes the four promises, and only those', async () => {
    mount()
    await screen.findByRole('heading', { name: 'Welcome to Coffer' })

    const promises = screen.getByRole('list', { name: 'What Coffer does without' })
    expect(
      within(promises)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['No account', 'No subscription', 'No telemetry', 'Works with the internet off'])
  })

  it('goes to create', async () => {
    const user = userEvent.setup()
    mount()

    await user.click(await screen.findByRole('button', { name: 'Create a company' }))

    await waitFor(() => expect(screen.getByText(/^route:/)).toHaveTextContent('route: create'))
  })

  /* With no list to pick from, a recovery code needs its file first. */
  it('asks for the file and then goes to recovery for it', async () => {
    const user = userEvent.setup()
    mount({
      bridge: {
        system: { chooseCompanyFile: () => ok('/books/acme.coffer') },
        companies: { addExisting: () => ok(ACME) },
      },
    })

    await user.click(await screen.findByRole('button', { name: 'Use a recovery code' }))

    await waitFor(() =>
      expect(screen.getByText(/^route:/)).toHaveTextContent('route: recover {"id":"acme"}'),
    )
  })

  it('opens the restore dialog', async () => {
    const user = userEvent.setup()
    mount()

    await user.click(await screen.findByRole('button', { name: 'Restore from a backup' }))

    expect(await screen.findByRole('dialog', { name: 'Restore from a backup' })).toBeVisible()
  })

  /* A first launch must not see a list screen flash up before the welcome replaces it. */
  it('draws neither the list nor the welcome until the list has answered', async () => {
    mount({ bridge: { companies: { list: () => new Promise(() => {}) } } })

    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).not.toBeNull())
    expect(screen.queryByRole('heading', { name: 'Your companies' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Welcome to Coffer' })).toBeNull()
  })

  /* A registry that could not be read is not an empty one. */
  it('is not shown when the list could not be read', async () => {
    mount({
      bridge: {
        companies: {
          list: () =>
            Promise.resolve({ ok: false, error: { code: 'IPC_FAILED', message: 'No answer.' } }),
        },
      },
    })

    expect(await screen.findByRole('heading', { name: 'Your companies' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Welcome to Coffer' })).toBeNull()
  })
})

describe('the list', () => {
  it('lists the companies once there are any', async () => {
    mount({ companies: [ACME] })

    expect(await screen.findByRole('heading', { level: 1, name: 'Your companies' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Acme Pvt Ltd' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Welcome to Coffer' })).toBeNull()
  })
})

describe('requests from other screens', () => {
  it('opens the removal for the company named, and removes nothing by itself', async () => {
    const { bridge } = mount({
      companies: [ACME],
      params: { action: 'forget', id: 'acme' },
      bridge: { companies: { forget: () => ok(undefined) } },
    })

    const dialog = await screen.findByRole('dialog', { name: 'Remove this company from the list?' })
    expect(within(dialog).getByText('Acme Pvt Ltd')).toBeVisible()
    expect(bridge.callsTo('companies:forget')).toHaveLength(0)
  })

  it('asks for the file when sent to find one', async () => {
    const { bridge } = mount({
      companies: [ACME],
      params: { action: 'add-existing' },
      bridge: { system: { chooseCompanyFile: () => ok(null) } },
    })

    await waitFor(() => expect(bridge.callsTo('system:chooseCompanyFile')).toHaveLength(1))
  })
})
