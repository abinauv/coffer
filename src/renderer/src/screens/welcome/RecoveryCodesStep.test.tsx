/*
 * The recovery codes: shown once, with no way past them except through the gate.
 *
 * THE GATE IS A TYPED CODE, NOT A TICK (design plan, D1). Both halves are asserted, in both
 * directions: ticking alone does not open the books, a wrong code does not, and the right
 * code with the tick does. The challenge is chosen with `Math.random`, pinned here so the
 * test knows which code is asked for.
 *
 * AND THE REGISTRATION NUMBER ON THE WAY OUT. It is saved into Business details before the
 * books open, and a save that fails must neither block the door nor pass silently.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenCompanyResult, Result, SaveCompanyProfileInput } from '@shared/dto'
import {
  DEFAULT_COMPANY,
  DEFAULT_REGIME,
  renderScreen,
  type BridgeStub,
} from '@renderer/test/harness'
import { useCompany } from '@renderer/store/company'
import { RecoveryCodesStep } from './RecoveryCodesStep'

const ok = <T,>(data: T): Promise<Result<T>> => Promise.resolve({ ok: true, data })

const CODES = [
  'A1B2C-3D4E5-F6G7H-8J9K0',
  'ZYXWV-TSRQP-NMKJH-GFEDC',
  'M4NPQ-R5STV-W6XYZ-01234',
  'QRSTV-WXYZ0-12345-6789A',
  'HJKMN-PQRST-VWXYZ-01234',
]

const CREATED: OpenCompanyResult = {
  company: { ...DEFAULT_COMPANY, displayName: 'Sharma Traders', filePath: '/books/sharma.coffer' },
  recoveryCodes: CODES,
  recoveryCodesRemaining: 5,
}

/** Says whether the shell has been handed the company, which is what opening the books is. */
function OpenProbe(): JSX.Element {
  const { company } = useCompany()
  return <p>open: {company?.displayName ?? 'none'}</p>
}

beforeEach(() => {
  /* Code 2 is asked for: `challengeIndex(5, 0.25)` is 1. */
  vi.spyOn(Math, 'random').mockReturnValue(0.25)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function mount(
  options: { registrationNumber?: string | null; bridge?: BridgeStub } = {},
): ReturnType<typeof renderScreen> {
  return renderScreen(
    <>
      <OpenProbe />
      <RecoveryCodesStep result={CREATED} registrationNumber={options.registrationNumber ?? null} />
    </>,
    { bridge: options.bridge ?? {} },
  )
}

function openButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Open the books' })
}

async function passGate(
  user: ReturnType<typeof userEvent.setup>,
  code = CODES[1] ?? '',
): Promise<void> {
  await user.type(screen.getByRole('textbox', { name: 'Code 2' }), code)
  await user.click(screen.getByRole('checkbox'))
}

describe('what it shows', () => {
  it('is step three, and says where the company was created', () => {
    mount()

    expect(
      screen.getByRole('heading', { level: 1, name: 'Write these five codes down now' }),
    ).toBeVisible()
    expect(screen.getByText('/books/sharma.coffer')).toBeVisible()
  })

  it('shows every code, numbered, in the printable sheet', () => {
    mount()

    const sheet = screen.getByRole('region', { name: 'Recovery codes' })
    const items = within(sheet).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual(CODES.map((code, i) => `${i + 1}${code}`))
  })

  it('offers the three ways of keeping them', () => {
    mount()

    expect(screen.getByRole('button', { name: 'Copy all five' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save as a text file' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Print' })).toBeVisible()
  })

  /* No Back, no Skip, no Escape: the only button in the footer goes forward. */
  it('has no way out but forward', () => {
    mount()

    const foot = screen.getByRole('contentinfo')
    expect(
      within(foot)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Open the books'])
    expect(screen.queryByRole('button', { name: /back|skip|later|cancel/i })).toBeNull()
  })

  it('sets the typed code in mono on the input alone, not on its label (B10)', () => {
    mount()

    const input = screen.getByRole('textbox', { name: 'Code 2' })
    expect(input).toHaveClass('field__input--identifier')
    expect(input.closest('.field')).not.toHaveClass('confirm__input')
  })
})

describe('the gate', () => {
  it('stays shut on the tick alone', async () => {
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole('checkbox'))

    expect(openButton()).toBeDisabled()
    expect(screen.getByText('Type code 2 and tick the box first')).toBeVisible()
  })

  it('stays shut on the wrong code', async () => {
    const user = userEvent.setup()
    mount()

    await passGate(user, CODES[0])

    expect(openButton()).toBeDisabled()
  })

  it('opens on the right code, typed loosely, with the tick', async () => {
    const user = userEvent.setup()
    mount()

    await passGate(user, (CODES[1] ?? '').toLowerCase().replaceAll('-', ' '))
    expect(openButton()).toBeEnabled()

    await user.click(openButton())

    expect(await screen.findByText('open: Sharma Traders')).toBeVisible()
  })
})

describe('the registration number', () => {
  it('saves nothing when none was given', async () => {
    const user = userEvent.setup()
    const { bridge } = mount()
    await passGate(user)

    await user.click(openButton())

    await screen.findByText('open: Sharma Traders')
    expect(bridge.callsTo('companyProfile:save')).toHaveLength(0)
  })

  it('saves it into Business details under the business name before the books open', async () => {
    const user = userEvent.setup()
    const saved: SaveCompanyProfileInput[] = []
    const { bridge } = mount({
      registrationNumber: '33AABCC1234D1ZI',
      bridge: {
        regime: { describe: () => ok(DEFAULT_REGIME) },
        companyProfile: {
          save: (input) => {
            saved.push(input)
            return Promise.resolve({ ok: true, data: undefined as never })
          },
        },
      },
    })
    await passGate(user)

    await user.click(openButton())

    await screen.findByText('open: Sharma Traders')
    expect(saved).toEqual([
      { legalName: 'Sharma Traders', countryCode: 'in', registrationNumber: '33AABCC1234D1ZI' },
    ])
    expect(bridge.callsTo('regime:describe')).toHaveLength(1)
  })

  it('opens the books anyway when the save fails, and says so until dismissed', async () => {
    const user = userEvent.setup()
    mount({
      registrationNumber: '33AABCC1234D1ZI',
      bridge: {
        regime: { describe: () => ok(DEFAULT_REGIME) },
        companyProfile: {
          save: () =>
            Promise.resolve({
              ok: false,
              error: { code: 'COMPANY_REGISTRATION_INVALID', message: 'Not valid.' },
            }),
        },
      },
    })
    await passGate(user)

    await user.click(openButton())

    expect(await screen.findByText('open: Sharma Traders')).toBeVisible()
    const toasts = screen.getByRole('region', { name: 'Notifications' })
    await waitFor(() =>
      expect(within(toasts).getByText('The registration number was not saved')).toBeVisible(),
    )
    expect(within(toasts).getByRole('button', { name: 'Business details' })).toBeVisible()
  })
})
