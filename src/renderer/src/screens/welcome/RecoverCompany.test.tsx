/*
 * Using a recovery code: one code spent, one new passphrase set, both in one step.
 *
 * What crosses the bridge is asserted — the code trimmed, the new passphrase as typed — and
 * that nothing is sent until the new passphrase is typed twice alike.
 */

import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JSX } from 'react'
import { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type {
  OpenCompanyResult,
  PassphraseStrength,
  RecoverCompanyInput,
  Result,
} from '@shared/dto'
import { DEFAULT_COMPANY, renderScreen } from '@renderer/test/harness'
import { makeRoute } from '@renderer/lib/routing'
import { useCompany } from '@renderer/store/company'
import { useNavigation } from '@renderer/store/navigation'
import { RecoverCompany } from './RecoverCompany'

const ok = <T,>(data: T): Promise<Result<T>> => Promise.resolve({ ok: true, data })

const STRONG: PassphraseStrength = {
  score: 4,
  label: 'Very strong',
  suggestion: null,
  isWeak: false,
}

function AtRecover(): JSX.Element {
  const { route, navigate } = useNavigation()
  const { company } = useCompany()
  useEffect(() => {
    if (route.screenId !== 'recover') navigate(makeRoute('welcome', 'recover', { id: 'acme' }))
  }, [route, navigate])
  return (
    <>
      <p>open: {company?.displayName ?? 'none'}</p>
      {route.screenId === 'recover' && <RecoverCompany />}
    </>
  )
}

function mount(recover: (input: RecoverCompanyInput) => void): void {
  renderScreen(<AtRecover />, {
    bridge: {
      companies: {
        list: () => ok([DEFAULT_COMPANY]),
        checkPassphrase: () => ok(STRONG),
        recover: (input) => {
          recover(input)
          return ok<OpenCompanyResult>({ company: DEFAULT_COMPANY, recoveryCodesRemaining: 4 })
        },
      },
    },
  })
}

describe('using a recovery code', () => {
  it('types the code in mono and explains beside the form that it is spent', async () => {
    mount(vi.fn())

    expect(await screen.findByRole('textbox', { name: 'Recovery code' })).toHaveClass(
      'field__input--identifier',
    )
    expect(
      screen.getByRole('heading', { name: 'The code you use is gone afterwards' }),
    ).toBeVisible()
  })

  it('sends nothing until the new passphrase is typed twice alike', async () => {
    const user = userEvent.setup()
    const recover = vi.fn()
    mount(recover)

    await user.type(
      await screen.findByRole('textbox', { name: 'Recovery code' }),
      'A1B2C-3D4E5-F6G7H-8J9K0',
    )
    await user.type(screen.getByLabelText('New passphrase'), 'brass ledger monsoon forty')
    await user.type(screen.getByLabelText('Type it again'), 'brass ledger')

    expect(screen.getByRole('button', { name: 'Recover and open' })).toBeDisabled()
    expect(recover).not.toHaveBeenCalled()
  })

  it('spends the code, sets the passphrase and opens the books', async () => {
    const user = userEvent.setup()
    const recover = vi.fn()
    mount(recover)

    await user.type(
      await screen.findByRole('textbox', { name: 'Recovery code' }),
      '  A1B2C-3D4E5-F6G7H-8J9K0  ',
    )
    await user.type(screen.getByLabelText('New passphrase'), 'brass ledger monsoon forty')
    await user.type(screen.getByLabelText('Type it again'), 'brass ledger monsoon forty')
    await user.click(screen.getByRole('button', { name: 'Recover and open' }))

    await waitFor(() =>
      expect(recover).toHaveBeenCalledWith({
        id: 'acme',
        recoveryCode: 'A1B2C-3D4E5-F6G7H-8J9K0',
        newPassphrase: 'brass ledger monsoon forty',
      }),
    )
    expect(await screen.findByText('open: Acme Pvt Ltd')).toBeVisible()
  })
})
