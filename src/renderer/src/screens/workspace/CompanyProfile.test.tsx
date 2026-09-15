/*
 * The business details, rendered.
 *
 * TWO ASSERTIONS CARRY THIS FILE AND THE REST ARE ORDINARY.
 *
 * The first is that a save sends EVERY field. `companyProfile.save` is a replace, unlike
 * `parties.update` — a field left out is a field cleared — so the payload is asserted
 * whole rather than with `toMatchObject`. A form that quietly stopped sending the phone
 * number would empty it in the books on the next save of anything else, and a partial
 * assertion would watch that happen.
 *
 * The second is that the form is redrawn from what MAIN stored rather than from what was
 * typed. Main fills the jurisdiction in from the registration number, and a form still
 * showing the blank the user left would hide that the question had been answered.
 */

import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { CompanyProfile as Profile, Result } from '@shared/dto'
import { DEFAULT_REGIME, renderScreen, type BridgeStub } from '../../test/harness'
import { CompanyProfile } from './CompanyProfile'

function profile(over: Partial<Profile> = {}): Profile {
  return {
    legalName: 'Acme Traders Private Limited',
    tradeName: 'Acme',
    registrationNumber: '33AABCC1234D1ZI',
    jurisdictionCode: '33',
    countryCode: 'in',
    addressLine1: '14 Anna Salai',
    addressLine2: 'Teynampet',
    city: 'Chennai',
    postalCode: '600018',
    email: 'accounts@acme.example',
    phone: '+91 44 4000 0000',
    createdAt: '2026-04-01T10:00:00.000Z',
    updatedAt: '2026-04-01T10:00:00.000Z',
    ...over,
  }
}

/** A bridge whose `get` answers with `stored` and whose `save` echoes what main made. */
function bridgeWith(stored: Profile | null, saved: Profile = profile()): BridgeStub {
  return {
    companyProfile: {
      get: () => Promise.resolve<Result<Profile | null>>({ ok: true, data: stored }),
      save: () => Promise.resolve<Result<Profile>>({ ok: true, data: saved }),
    },
  }
}

const field = (label: string): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement

describe('books nobody has filled in yet', () => {
  it('says what the details are for rather than showing an empty form with no explanation', async () => {
    renderScreen(<CompanyProfile />, { bridge: bridgeWith(null) })

    expect(await screen.findByText('Nothing here yet')).toBeInTheDocument()
    expect(screen.getByText(/needs a supplier before it can be taxed/)).toBeInTheDocument()
  })

  it('will not save without the two fields the books refuse to be without', async () => {
    const user = userEvent.setup()
    renderScreen(<CompanyProfile />, { bridge: bridgeWith(null, profile()) })

    await screen.findByText('Nothing here yet')
    const save = screen.getByRole('button', { name: 'Save' })

    /* Country is seeded from the regime, so only the name is missing. */
    expect(save).toBeDisabled()

    await user.type(field('Legal name'), 'Acme Traders Private Limited')
    expect(save).toBeEnabled()

    await user.selectOptions(field('Country'), '')
    expect(save).toBeDisabled()
  })

  /*
   * `RegimeId` is documented as an ISO 3166-1 alpha-2 code, so it is a usable default for
   * a field the user would otherwise have to know to fill in. Only when it looks like one
   * — see `blankDraft`.
   */
  it('seeds the country from the regime', async () => {
    renderScreen(<CompanyProfile />, { bridge: bridgeWith(null) })

    await screen.findByText('Nothing here yet')
    expect(field('Country').value).toBe('in')
  })

  it('leaves the country blank for a regime whose id is not a country code', async () => {
    renderScreen(<CompanyProfile />, {
      bridge: bridgeWith(null),
      regime: { ...DEFAULT_REGIME, id: 'eu-vat' },
    })

    await screen.findByText('Nothing here yet')
    expect(field('Country').value).toBe('')
  })

  /* B13: sample values in empty boxes read as details already entered, in dark above all. */
  it('puts no sample values in the empty boxes', async () => {
    renderScreen(<CompanyProfile />, { bridge: bridgeWith(null) })

    await screen.findByText('Nothing here yet')
    const withPlaceholder = [...document.querySelectorAll('input')].filter(
      (input) => input.placeholder !== '',
    )
    expect(withPlaceholder.map((input) => input.labels?.[0]?.textContent)).toEqual([])
  })

  /* B13: Country asked for "two-letter country code, lower case". It offers names now, and
   * the books still hold the code. */
  it('names the countries and sends the code', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<CompanyProfile />, { bridge: bridgeWith(null, profile()) })

    await screen.findByText('Nothing here yet')
    expect(screen.getByRole('option', { name: 'India', selected: true })).toBeInTheDocument()

    await user.type(field('Legal name'), 'Lisboa Metais')
    await user.selectOptions(field('Country'), 'Portugal')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(bridge.lastCallTo('companyProfile:save')?.args[0]).toMatchObject({
        countryCode: 'pt',
      }),
    )
  })
})

describe('books that have been filled in', () => {
  it('shows what is stored, and does not offer the empty-state explanation', async () => {
    renderScreen(<CompanyProfile />, { bridge: bridgeWith(profile()) })

    await waitFor(() => expect(field('Legal name').value).toBe('Acme Traders Private Limited'))
    expect(field('Trade name').value).toBe('Acme')
    expect(field('Registration number').value).toBe('33AABCC1234D1ZI')
    expect(field('City').value).toBe('Chennai')
    expect(screen.queryByText('Nothing here yet')).toBeNull()
  })

  it('shows an absent optional field as empty rather than as the word null', async () => {
    renderScreen(<CompanyProfile />, {
      bridge: bridgeWith(profile({ tradeName: null, email: null, jurisdictionCode: null })),
    })

    await waitFor(() => expect(field('Trade name').value).toBe(''))
    expect(field('Email').value).toBe('')
  })

  it('offers the jurisdictions the regime listed', async () => {
    renderScreen(<CompanyProfile />, { bridge: bridgeWith(profile()) })

    const picker = (await screen.findByLabelText('State or region')) as HTMLSelectElement
    expect([...picker.options].map((option) => option.text)).toEqual([
      'Not set',
      'Karnataka',
      'Tamil Nadu',
    ])
    expect(picker.value).toBe('33')
  })
})

describe('saving', () => {
  /*
   * THE ASSERTION THIS FILE EXISTS FOR. Every field, every time — `toEqual`, not
   * `toMatchObject`. A save is a replace, so a field this form stops sending is a field
   * cleared in the books, and a partial assertion would not notice.
   */
  it('sends the whole profile, because a save is a replace', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<CompanyProfile />, { bridge: bridgeWith(profile()) })

    await waitFor(() => expect(field('Legal name').value).toBe('Acme Traders Private Limited'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('companyProfile:save')).toHaveLength(1))
    expect(bridge.lastCallTo('companyProfile:save')?.args[0]).toEqual({
      legalName: 'Acme Traders Private Limited',
      countryCode: 'in',
      tradeName: 'Acme',
      registrationNumber: '33AABCC1234D1ZI',
      jurisdictionCode: '33',
      addressLine1: '14 Anna Salai',
      addressLine2: 'Teynampet',
      city: 'Chennai',
      postalCode: '600018',
      email: 'accounts@acme.example',
      phone: '+91 44 4000 0000',
    })
  })

  it('trims what was typed, so a stray space is not stored as a name', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<CompanyProfile />, { bridge: bridgeWith(null) })

    await screen.findByText('Nothing here yet')
    await user.type(field('Legal name'), '  Acme Traders Private Limited  ')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(bridge.callsTo('companyProfile:save')).toHaveLength(1))
    const sent = bridge.lastCallTo('companyProfile:save')?.args[0] as { legalName: string }
    expect(sent.legalName).toBe('Acme Traders Private Limited')
  })

  /*
   * THE SECOND ASSERTION THIS FILE EXISTS FOR. The user typed a GSTIN and left the state
   * picker alone; main derived the state from the number. The form must show what main
   * stored, not what was typed, or the derivation is invisible and the user is left
   * believing a field they can see is still unanswered.
   */
  it('redraws from what main stored, not from what was typed', async () => {
    const user = userEvent.setup()
    renderScreen(<CompanyProfile />, {
      bridge: bridgeWith(
        profile({ jurisdictionCode: null, registrationNumber: null }),
        profile({ jurisdictionCode: '33', registrationNumber: '33AABCC1234D1ZI' }),
      ),
    })

    await waitFor(() => expect(field('Registration number').value).toBe(''))
    const picker = screen.getByLabelText('State or region') as HTMLSelectElement
    expect(picker.value).toBe('')

    await user.type(field('Registration number'), '33AABCC1234D1ZI')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(picker.value).toBe('33'))
  })

  it('confirms in words that name the business', async () => {
    const user = userEvent.setup()
    renderScreen(<CompanyProfile />, { bridge: bridgeWith(profile()) })

    await waitFor(() => expect(field('Legal name').value).toBe('Acme Traders Private Limited'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(
      await screen.findByText(/These books belong to Acme Traders Private Limited/),
    ).toBeInTheDocument()
  })

  /*
   * A rejected registration number is the regime's sentence, and it has to reach the user
   * intact. `COMPANY_JURISDICTION_MISMATCH` is not "that did not work" — it names which
   * two things disagree, and the renderer's job is to not paraphrase it.
   */
  it('shows the reason main gave for refusing, in main own words', async () => {
    const user = userEvent.setup()
    renderScreen(<CompanyProfile />, {
      bridge: {
        companyProfile: {
          get: () => Promise.resolve<Result<Profile | null>>({ ok: true, data: profile() }),
          save: () =>
            Promise.resolve<Result<Profile>>({
              ok: false,
              error: {
                code: 'COMPANY_JURISDICTION_MISMATCH',
                message:
                  'That registration number is issued in Tamil Nadu, but the state selected is Karnataka.',
              },
            }),
        },
      },
    })

    await waitFor(() => expect(field('Legal name').value).toBe('Acme Traders Private Limited'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/issued in Tamil Nadu/)).toBeInTheDocument()
  })

  it('leaves the form as the user left it when the save was refused', async () => {
    const user = userEvent.setup()
    renderScreen(<CompanyProfile />, {
      bridge: {
        companyProfile: {
          get: () => Promise.resolve<Result<Profile | null>>({ ok: true, data: profile() }),
          save: () =>
            Promise.resolve<Result<Profile>>({
              ok: false,
              error: { code: 'COMPANY_REGISTRATION_INVALID', message: 'That is not a GSTIN.' },
            }),
        },
      },
    })

    await waitFor(() => expect(field('Registration number').value).toBe('33AABCC1234D1ZI'))
    await user.clear(field('Registration number'))
    await user.type(field('Registration number'), '33AABCC1234D1ZZ')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByText(/not a GSTIN/)
    /* Typing it again from scratch after a rejection is the fastest way to lose a user. */
    expect(field('Registration number').value).toBe('33AABCC1234D1ZZ')
  })
})

describe('when the profile cannot be read at all', () => {
  it('says so instead of showing a blank form that would replace it on save', async () => {
    renderScreen(<CompanyProfile />, {
      bridge: {
        companyProfile: {
          get: () =>
            Promise.resolve<Result<Profile | null>>({
              ok: false,
              error: { code: 'NO_COMPANY_OPEN', message: 'Open a company first.' },
            }),
        },
      },
    })

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(/Open a company first/)).toBeInTheDocument()
  })
})
