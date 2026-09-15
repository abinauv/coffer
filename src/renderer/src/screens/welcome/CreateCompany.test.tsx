/*
 * Creating a company, in three steps.
 *
 * WHAT CROSSES THE BRIDGE IS WHAT IS ASSERTED. `companies.create` must receive the trimmed
 * name, the folder and the passphrase, and nothing may call it before the second step is
 * complete. The registration number is only ever put to `checkRegistration` here; it is
 * saved later, by the codes step, and a test there holds that.
 *
 * The weak-passphrase interruption is a warning and never a refusal: it is asserted in both
 * directions, choosing a stronger one and using this one anyway.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  CheckRegistrationInput,
  CreateCompanyInput,
  OpenCompanyResult,
  PassphraseStrength,
  RegistrationCheck,
  Result,
} from '@shared/dto'
import { DEFAULT_COMPANY, renderScreen, type BridgeStub } from '@renderer/test/harness'
import { CreateCompany } from './CreateCompany'

const ok = <T,>(data: T): Promise<Result<T>> => Promise.resolve({ ok: true, data })

const STRONG: PassphraseStrength = {
  score: 4,
  label: 'Very strong',
  suggestion: null,
  isWeak: false,
}
const WEAK: PassphraseStrength = {
  score: 0,
  label: 'Very weak',
  suggestion: 'Add another word or two.',
  isWeak: true,
}

function check(input: CheckRegistrationInput): RegistrationCheck {
  const blank: RegistrationCheck = {
    label: 'GSTIN / UIN',
    status: 'blank',
    normalised: null,
    jurisdictionCode: null,
    jurisdictionName: null,
    message: null,
  }
  const typed = input.registrationNumber.trim().toUpperCase()
  if (typed === '') return blank
  if (typed === '33AABCC1234D1ZI') {
    return {
      ...blank,
      status: 'valid',
      normalised: typed,
      jurisdictionCode: '33',
      jurisdictionName: 'Tamil Nadu',
    }
  }
  return { ...blank, status: 'invalid', message: 'A GSTIN is 15 characters.' }
}

const CREATED: OpenCompanyResult = {
  company: { ...DEFAULT_COMPANY, displayName: 'Sharma Traders' },
  recoveryCodes: ['A1B2C-3D4E5-F6G7H-8J9K0', 'ZYXWV-TSRQP-NMKJH-GFEDC'],
  recoveryCodesRemaining: 2,
}

function mount(
  options: { strength?: PassphraseStrength; create?: (input: CreateCompanyInput) => void } = {},
): ReturnType<typeof renderScreen> {
  const bridge: BridgeStub = {
    companies: {
      checkRegistration: (input) => ok(check(input)),
      checkPassphrase: () => ok(options.strength ?? STRONG),
      create: (input) => {
        options.create?.(input)
        return ok(CREATED)
      },
    },
    system: { chooseDirectory: () => ok('/books') },
  }
  return renderScreen(<CreateCompany />, { bridge })
}

function currentStep(): string | null {
  const nav = screen.getByRole('navigation', { name: 'Creating a company' })
  return (
    within(nav)
      .getAllByRole('listitem')
      .find((item) => item.getAttribute('aria-current') === 'step')?.textContent ?? null
  )
}

async function fillCompanyStep(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByRole('textbox', { name: 'Business name' }), '  Sharma Traders  ')
  await user.click(screen.getByRole('button', { name: 'Choose folder' }))
  await screen.findByText('/books')
}

describe('the company step', () => {
  it('is step one of three', () => {
    mount()

    expect(currentStep()).toContain('Step 1 of 3: The company')
    expect(screen.getByRole('heading', { level: 1, name: 'Create a company' })).toBeVisible()
  })

  it('will not continue without a name and a folder, and says so beside the button', async () => {
    const user = userEvent.setup()
    mount()

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    expect(screen.getByText('Needs a business name and a folder')).toBeVisible()

    await fillCompanyStep(user)

    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
    expect(screen.queryByText(/^Needs/)).toBeNull()
  })

  /* The label is the regime's word, asked for before anything is typed. */
  it('labels the registration box with what the regime calls the number', async () => {
    mount()

    expect(await screen.findByRole('textbox', { name: 'GSTIN / UIN (optional)' })).toBeVisible()
  })

  it('names the state a valid number encodes', async () => {
    const user = userEvent.setup()
    mount()

    await user.type(await screen.findByRole('textbox', { name: /GSTIN/ }), '33aabcc1234d1zi')

    expect(await screen.findByText(/Registered in Tamil Nadu \(33\)/)).toBeVisible()
  })

  it('refuses to continue with an invalid number, and allows it once cleared', async () => {
    const user = userEvent.setup()
    mount()
    await fillCompanyStep(user)
    const box = await screen.findByRole('textbox', { name: /GSTIN/ })

    await user.type(box, '33AAB')

    expect(await screen.findByText('A GSTIN is 15 characters.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()

    await user.clear(box)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled())
  })
})

describe('the passphrase step', () => {
  async function toPassphrase(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await fillCompanyStep(user)
    await user.click(screen.getByRole('button', { name: 'Continue' }))
  }

  it('is step two, and Back returns to the company with what was typed', async () => {
    const user = userEvent.setup()
    mount()
    await toPassphrase(user)

    expect(currentStep()).toContain('Step 2 of 3: The passphrase')
    expect(screen.getByRole('heading', { level: 1, name: 'Choose a passphrase' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Back' }))

    expect(screen.getByRole('textbox', { name: 'Business name' })).toHaveValue('  Sharma Traders  ')
  })

  it('says there is no back door before anything is created', async () => {
    const user = userEvent.setup()
    mount()
    await toPassphrase(user)

    expect(screen.getByRole('heading', { name: 'There is no back door' })).toBeVisible()
  })

  it('creates nothing until the passphrase is typed twice alike', async () => {
    const user = userEvent.setup()
    const create = vi.fn()
    mount({ create })
    await toPassphrase(user)

    await user.type(screen.getByLabelText('Passphrase'), 'brass ledger monsoon forty')
    await user.type(screen.getByLabelText('Type it again'), 'brass ledger monsoon')

    expect(
      screen.getByText(
        'These two do not match. Check both — nothing is stored to compare against.',
      ),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Create the company' })).toBeDisabled()
    expect(create).not.toHaveBeenCalled()
  })

  it('creates the company with the trimmed name, then shows the codes as step three', async () => {
    const user = userEvent.setup()
    const create = vi.fn()
    mount({ create })
    await toPassphrase(user)

    await user.type(screen.getByLabelText('Passphrase'), 'brass ledger monsoon forty')
    await user.type(screen.getByLabelText('Type it again'), 'brass ledger monsoon forty')
    await screen.findByText('Very strong')
    await user.click(screen.getByRole('button', { name: 'Create the company' }))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        displayName: 'Sharma Traders',
        directoryPath: '/books',
        passphrase: 'brass ledger monsoon forty',
      }),
    )
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Write these two codes down now' }),
    ).toBeVisible()
    expect(currentStep()).toContain('Step 3 of 3: Recovery codes')
  })

  it('warns once about a weak passphrase, and uses it when told to', async () => {
    const user = userEvent.setup()
    const create = vi.fn()
    mount({ strength: WEAK, create })
    await toPassphrase(user)

    await user.type(screen.getByLabelText('Passphrase'), '1234')
    await user.type(screen.getByLabelText('Type it again'), '1234')
    await screen.findByText('Very weak')
    await user.click(screen.getByRole('button', { name: 'Create the company' }))

    const dialog = await screen.findByRole('dialog', { name: 'That passphrase is easy to guess' })
    expect(create).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Use it anyway' }))

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
  })
})
