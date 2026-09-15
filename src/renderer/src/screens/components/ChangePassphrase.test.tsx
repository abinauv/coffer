/*
 * Changing the passphrase, from the palette.
 *
 * It moved off the Overview in 5b, so the tests moved with it. What is new is where it is
 * reached from: a command that exists for as long as a company is open, whichever screen
 * is showing, and not at all from the picker.
 */

import type { JSX } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { useCommands } from '@renderer/store/commands'
import type { PassphraseStrength, Result } from '@shared/dto'
import { DEFAULT_COMPANY, renderScreen, type BridgeStub } from '../../test/harness'
import { ChangePassphrase } from './ChangePassphrase'

const ok = <T,>(data: T): Promise<Result<T>> => Promise.resolve({ ok: true, data })
const fails = <T,>(code: string, message: string): Promise<Result<T>> =>
  Promise.resolve({ ok: false, error: { code, message } })

const STRONG: PassphraseStrength = { score: 3, label: 'Strong', suggestion: null, isWeak: false }

function bridge(changePassphrase: BridgeStub['companies'] = {}): BridgeStub {
  return {
    companies: {
      checkPassphrase: () => ok(STRONG),
      changePassphrase: () => ok(undefined),
      ...changePassphrase,
    },
  }
}

/** Lists the palette's command ids and runs one, as the palette would. */
function Palette(): JSX.Element {
  const { commands, run } = useCommands()
  return (
    <>
      <p>commands: {commands.map((command) => command.id).join(',')}</p>
      <button type="button" onClick={() => run('company.change-passphrase')}>
        run it
      </button>
    </>
  )
}

async function openDialog(stub: BridgeStub = bridge()) {
  const user = userEvent.setup()
  const rendered = renderScreen(
    <>
      <ChangePassphrase />
      <Palette />
    </>,
    { bridge: stub, company: DEFAULT_COMPANY },
  )
  await screen.findByText(/company\.change-passphrase/)
  await user.click(screen.getByRole('button', { name: 'run it' }))
  const dialog = await screen.findByRole('dialog', { name: 'Change the passphrase' })
  return { ...rendered, user, dialog }
}

async function fill(user: ReturnType<typeof userEvent.setup>, again = 'a longer newer one') {
  await user.type(screen.getByLabelText('Current passphrase'), 'the old one')
  await user.type(screen.getByLabelText('New passphrase'), 'a longer newer one')
  await user.type(screen.getByLabelText('New passphrase again'), again)
}

describe('the command', () => {
  it('is not offered while no company is open', async () => {
    renderScreen(
      <>
        <ChangePassphrase />
        <Palette />
      </>,
      { bridge: bridge() },
    )

    expect(await screen.findByText(/commands:/)).not.toHaveTextContent('change-passphrase')
  })
})

describe('the dialog', () => {
  it('sends both passphrases and nothing else', async () => {
    const { user, dialog, bridge: calls } = await openDialog()

    await fill(user)
    await user.click(within(dialog).getByRole('button', { name: 'Change passphrase' }))

    await waitFor(() => expect(calls.callsTo('companies:changePassphrase')).toHaveLength(1))
    expect(calls.lastCallTo('companies:changePassphrase')?.args[0]).toEqual({
      currentPassphrase: 'the old one',
      newPassphrase: 'a longer newer one',
    })
  })

  it('says afterwards that the recovery codes still work', async () => {
    const { user, dialog } = await openDialog()

    await fill(user)
    await user.click(within(dialog).getByRole('button', { name: 'Change passphrase' }))

    expect(await screen.findByText('Passphrase changed')).toBeVisible()
    expect(screen.getByText(/recovery codes are unaffected/)).toBeVisible()
  })

  it('refuses to submit until the confirmation matches', async () => {
    const { user, dialog, bridge: calls } = await openDialog()

    await fill(user, 'a different thing')
    await user.click(within(dialog).getByRole('button', { name: 'Change passphrase' }))

    expect(within(dialog).getByText('These two do not match.')).toBeVisible()
    expect(calls.callsTo('companies:changePassphrase')).toHaveLength(0)
  })

  it('keeps the dialog open and says why when main refuses', async () => {
    const { user, dialog } = await openDialog(
      bridge({
        changePassphrase: () => fails('PASSPHRASE_INVALID', 'That passphrase did not work.'),
      }),
    )

    await fill(user)
    await user.click(within(dialog).getByRole('button', { name: 'Change passphrase' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'That is not the current passphrase for this company.',
    )
    expect(screen.queryByText('Passphrase changed')).toBeNull()
  })
})
