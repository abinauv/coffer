/*
 * Opening a company, and the four ways it fails.
 *
 * FOUR STATES, EACH WITH ITS OWN WAY OUT (design system §05). What is asserted is that each
 * failure says its own title, offers only its own actions, and — the part a lazy screen gets
 * wrong — that the passphrase field is offered again only when the passphrase was the
 * problem. A file that is not there cannot be typed back into existence.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JSX } from 'react'
import { useEffect } from 'react'
import { describe, expect, it } from 'vitest'
import type { AppError, CompanySummary, OpenCompanyResult, Result } from '@shared/dto'
import { DEFAULT_COMPANY, renderScreen } from '@renderer/test/harness'
import { makeRoute } from '@renderer/lib/routing'
import { useCompany } from '@renderer/store/company'
import { useNavigation } from '@renderer/store/navigation'
import { UnlockCompany } from './UnlockCompany'

const ok = <T,>(data: T): Promise<Result<T>> => Promise.resolve({ ok: true, data })
const fails = (code: string): Promise<Result<OpenCompanyResult>> =>
  Promise.resolve({ ok: false, error: { code, message: `${code} happened.` } satisfies AppError })

const ACME: CompanySummary = DEFAULT_COMPANY

/** Arrives at the unlock screen for Acme, and prints where navigation and the company went. */
function AtUnlock(): JSX.Element {
  const { route, navigate } = useNavigation()
  const { company } = useCompany()
  const isPlaced = route.screenId === 'unlock'
  useEffect(() => {
    if (route.screenId === 'companies' && route.params['action'] === undefined) {
      navigate(makeRoute('welcome', 'unlock', { id: 'acme' }), 'replace')
    }
  }, [route, navigate])
  return (
    <>
      <p>route: {`${route.screenId} ${JSON.stringify(route.params)}`}</p>
      <p>open: {company?.displayName ?? 'none'}</p>
      {isPlaced && <UnlockCompany />}
    </>
  )
}

function mount(
  options: {
    availability?: CompanySummary['availability']
    open?: () => Promise<Result<OpenCompanyResult>>
  } = {},
): ReturnType<typeof renderScreen> {
  const company = { ...ACME, availability: options.availability ?? 'ok' }
  return renderScreen(<AtUnlock />, {
    bridge: {
      companies: {
        list: () => ok([company]),
        open: options.open ?? (() => ok<OpenCompanyResult>({ company, recoveryCodesRemaining: 5 })),
      },
    },
  })
}

async function tryPassphrase(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(await screen.findByLabelText('Passphrase'), 'brass ledger monsoon forty')
  await user.click(screen.getByRole('button', { name: 'Unlock' }))
}

function failure(): HTMLElement {
  return screen.getByRole('alert')
}

describe('opening', () => {
  it('opens the company with the passphrase', async () => {
    const user = userEvent.setup()
    mount()

    await tryPassphrase(user)

    expect(await screen.findByText('open: Acme Pvt Ltd')).toBeVisible()
  })
})

describe('the passphrase does not fit', () => {
  it('says so, offers a recovery code, and keeps the field to try again', async () => {
    const user = userEvent.setup()
    mount({ open: () => fails('PASSPHRASE_INVALID') })

    await tryPassphrase(user)

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('The passphrase does not fit')).toBeVisible()
    expect(within(alert).getByRole('button', { name: 'Use a recovery code' })).toBeVisible()
    expect(screen.getByLabelText('Passphrase')).toBeVisible()
    expect(screen.getByText('open: none')).toBeVisible()
  })

  it('goes to the recovery screen for this company', async () => {
    const user = userEvent.setup()
    mount({ open: () => fails('PASSPHRASE_INVALID') })
    await tryPassphrase(user)

    await user.click(
      within(await screen.findByRole('alert')).getByRole('button', { name: 'Use a recovery code' }),
    )

    expect(screen.getByText(/^route:/)).toHaveTextContent('route: recover {"id":"acme"}')
  })
})

describe('the file is not where it was', () => {
  it('says so before anyone types, and offers no passphrase field', async () => {
    mount({ availability: 'database-missing' })

    await waitFor(() => expect(failure()).toBeVisible())
    expect(within(failure()).getByText('The file is not where it was')).toBeVisible()
    expect(within(failure()).getByText(/The books are not lost/)).toBeVisible()
    expect(screen.queryByLabelText('Passphrase')).toBeNull()
  })

  it('offers checking again, finding the file and removing the entry', async () => {
    mount({ availability: 'database-missing' })

    await waitFor(() => expect(failure()).toBeVisible())
    expect(
      within(failure())
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Check again', 'Find the file', 'Remove from this list'])
  })

  it('sends a removal to the list, which asks before removing anything', async () => {
    const user = userEvent.setup()
    mount({ availability: 'database-missing' })
    await waitFor(() => expect(failure()).toBeVisible())

    await user.click(within(failure()).getByRole('button', { name: 'Remove from this list' }))

    expect(screen.getByText(/^route:/)).toHaveTextContent(
      'route: companies {"action":"forget","id":"acme"}',
    )
  })
})

describe('the vault beside it is missing', () => {
  it('names both halves and offers a backup, with no passphrase field', async () => {
    mount({ availability: 'vault-missing' })

    await waitFor(() => expect(failure()).toBeVisible())
    expect(within(failure()).getByText('The vault beside it is missing')).toBeVisible()
    expect(within(failure()).getByText(/acme\.coffer\.vault/)).toBeVisible()
    expect(within(failure()).getByRole('button', { name: 'Restore from a backup' })).toBeVisible()
    expect(screen.queryByLabelText('Passphrase')).toBeNull()
  })
})

describe('these keys belong to another file', () => {
  /* The failure a lazy screen calls a wrong passphrase. */
  it('is not a passphrase problem: it offers no retry and no recovery code', async () => {
    const user = userEvent.setup()
    mount({ open: () => fails('COMPANY_KEYS_MISMATCHED') })

    await tryPassphrase(user)

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('These keys belong to another file')).toBeVisible()
    expect(within(alert).queryByRole('button', { name: 'Use a recovery code' })).toBeNull()
    expect(screen.queryByLabelText('Passphrase')).toBeNull()
  })
})

describe('any other failure', () => {
  it('is the general notice for its code, and the field stays', async () => {
    const user = userEvent.setup()
    mount({ open: () => fails('IPC_FAILED') })

    await tryPassphrase(user)

    await waitFor(() => expect(screen.getByRole('alert')).toBeVisible())
    expect(screen.queryByText('The passphrase does not fit')).toBeNull()
    expect(screen.getByLabelText('Passphrase')).toBeVisible()
  })
})
