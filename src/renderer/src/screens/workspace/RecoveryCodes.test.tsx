/*
 * Company → Recovery codes, rendered.
 *
 * `recovery-view.ts` is covered as pure functions next door. What is covered here is the
 * part that cannot be got wrong twice: the passphrase is asked for before anything is
 * issued, a refusal leaves the old codes alone and says so, and the new set cannot be
 * dismissed off the screen until one of the codes has been typed back.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderScreen, DEFAULT_COMPANY, type BridgeStub } from '../../test/harness'
import { RecoveryCodes } from './RecoveryCodes'

const NEW_CODES = [
  'K7M2X-9PQR4-TVW3H-6BNJ8',
  'A1B2C-3D4E5-F6G7H-8J9K0',
  'M4N5P-6Q7R8-S9T0V-1W2X3',
  'Y4Z5A-6B7C8-D9E0F-1G2H3',
  'J4K5M-6N7P8-Q9R0S-1T2V3',
]

const PASSPHRASE = 'a quiet ledger keeps its own counsel'

function bridge(over: BridgeStub = {}): BridgeStub {
  return {
    companies: {
      replaceRecoveryCodes: () =>
        Promise.resolve({
          ok: true,
          data: { recoveryCodes: [...NEW_CODES], recoveryCodesRemaining: 5 },
        }),
    },
    ...over,
  }
}

/** Opens the dialog, types the passphrase and confirms. */
async function issue(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Issue 5 new codes' }))
  const dialog = await screen.findByRole('dialog', { name: 'Issue 5 new recovery codes' })
  await user.type(within(dialog).getByLabelText('Your passphrase'), PASSPHRASE)
  await user.click(within(dialog).getByRole('button', { name: 'Issue 5 new codes' }))
}

describe('what it says about the codes it cannot show', () => {
  it('counts the unspent ones in the meter and in words', async () => {
    renderScreen(<RecoveryCodes />, { bridge: bridge(), company: DEFAULT_COMPANY })

    const meter = await screen.findByRole('meter', { name: 'Unused recovery codes' })
    expect(meter).toHaveAttribute('aria-valuenow', '3')
    expect(meter).toHaveAttribute('aria-valuetext', '3 of 5 unused')
    expect(screen.getByText('3 of 5 unused')).toBeInTheDocument()
  })

  it('says a new set kills the codes that have never been used', async () => {
    renderScreen(<RecoveryCodes />, { bridge: bridge(), company: DEFAULT_COMPANY })

    expect(await screen.findByText(/including the ones you have never used/)).toBeInTheDocument()
  })

  /* The one thing the screen is not entitled to claim: where the sheet is. */
  it('never claims the sheet still exists', async () => {
    renderScreen(<RecoveryCodes />, { bridge: bridge(), company: DEFAULT_COMPANY })
    await screen.findByRole('meter', { name: 'Unused recovery codes' })

    expect(document.body.textContent).not.toMatch(/your sheet is|safely stored|are safe/i)
  })
})

describe('issuing a set', () => {
  it('asks for the passphrase before anything is issued', async () => {
    const user = userEvent.setup()
    const replace = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        data: { recoveryCodes: [...NEW_CODES], recoveryCodesRemaining: 5 },
      }),
    )
    renderScreen(<RecoveryCodes />, {
      bridge: bridge({ companies: { replaceRecoveryCodes: replace } }),
      company: DEFAULT_COMPANY,
    })

    await user.click(await screen.findByRole('button', { name: 'Issue 5 new codes' }))
    const dialog = await screen.findByRole('dialog', { name: 'Issue 5 new recovery codes' })

    expect(within(dialog).getByLabelText('Your passphrase')).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })

  it('sends the passphrase the user typed, and nothing else', async () => {
    const user = userEvent.setup()
    const replace = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        data: { recoveryCodes: [...NEW_CODES], recoveryCodesRemaining: 5 },
      }),
    )
    renderScreen(<RecoveryCodes />, {
      bridge: bridge({ companies: { replaceRecoveryCodes: replace } }),
      company: DEFAULT_COMPANY,
    })

    await issue(user)

    expect(replace).toHaveBeenCalledWith({ passphrase: PASSPHRASE })
  })

  it('shows the new codes once they exist', async () => {
    const user = userEvent.setup()
    renderScreen(<RecoveryCodes />, { bridge: bridge(), company: DEFAULT_COMPANY })

    await issue(user)

    expect(
      await screen.findByRole('heading', { name: /Write these 5 codes down now/ }),
    ).toBeInTheDocument()
    for (const code of NEW_CODES) expect(screen.getByText(code)).toBeInTheDocument()
  })

  /*
   * A REFUSAL MUST READ AS THE FEATURE WORKING. Nothing was issued, and the codes the
   * user has now are exactly as good as they were a moment ago.
   */
  it('says the old codes still work when the passphrase is wrong', async () => {
    const user = userEvent.setup()
    renderScreen(<RecoveryCodes />, {
      bridge: bridge({
        companies: {
          replaceRecoveryCodes: () =>
            Promise.resolve({
              ok: false,
              error: { code: 'PASSPHRASE_INVALID', message: 'That passphrase does not open it.' },
            }),
        },
      }),
      company: DEFAULT_COMPANY,
    })

    await issue(user)

    const dialog = await screen.findByRole('dialog', { name: 'Issue 5 new recovery codes' })
    expect(within(dialog).getByText(/the ones you have now still work/)).toBeInTheDocument()
    expect(screen.queryByText(NEW_CODES[0] ?? '')).not.toBeInTheDocument()
  })
})

describe('the gate on the new set', () => {
  it('will not put the codes away until one of them is typed back', async () => {
    const user = userEvent.setup()
    renderScreen(<RecoveryCodes />, { bridge: bridge(), company: DEFAULT_COMPANY })
    await issue(user)

    const away = await screen.findByRole('button', { name: 'Put them away' })
    expect(away).toBeDisabled()

    /* Which code is asked for is drawn at random, so the test reads the label. */
    const label = screen.getByText(/^Code \d$/)
    const position = Number(/Code (\d)/.exec(label.textContent ?? '')?.[1])
    await user.type(screen.getByLabelText(`Code ${position}`), NEW_CODES[position - 1] ?? '')
    expect(away).toBeDisabled()

    await user.click(screen.getByRole('checkbox'))
    await waitFor(() => expect(away).toBeEnabled())
  })

  it('keeps the codes on screen while the typed one is wrong', async () => {
    const user = userEvent.setup()
    renderScreen(<RecoveryCodes />, { bridge: bridge(), company: DEFAULT_COMPANY })
    await issue(user)

    const label = screen.getByText(/^Code \d$/)
    const position = Number(/Code (\d)/.exec(label.textContent ?? '')?.[1])
    await user.type(screen.getByLabelText(`Code ${position}`), 'K7M2X-9PQR4-TVW3H-00000')
    await user.click(screen.getByRole('checkbox'))

    expect(screen.getByRole('button', { name: 'Put them away' })).toBeDisabled()
    expect(screen.getByText(NEW_CODES[0] ?? '')).toBeInTheDocument()
  })

  it('goes back to the count once they are put away, with the new number', async () => {
    const user = userEvent.setup()
    renderScreen(<RecoveryCodes />, {
      bridge: bridge(),
      company: DEFAULT_COMPANY,
      recoveryCodesRemaining: 1,
    })
    await issue(user)

    const label = screen.getByText(/^Code \d$/)
    const position = Number(/Code (\d)/.exec(label.textContent ?? '')?.[1])
    await user.type(screen.getByLabelText(`Code ${position}`), NEW_CODES[position - 1] ?? '')
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Put them away' }))

    const meter = await screen.findByRole('meter', { name: 'Unused recovery codes' })
    expect(meter).toHaveAttribute('aria-valuetext', '5 of 5 unused')
    /* And the codes are gone from the page, not merely hidden behind a state flag. */
    expect(screen.queryByText(NEW_CODES[0] ?? '')).not.toBeInTheDocument()
  })
})
