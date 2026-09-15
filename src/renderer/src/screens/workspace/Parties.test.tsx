/*
 * Customers and vendors, rendered.
 *
 * `filterParties`, `partyKindLabel`, `leavesList`, `copyFor`, `defaultCountryCode`,
 * `parsePaymentTerms`, `isPlaceOfSupplyUnknown` and the draft conversions are covered as
 * pure functions next door. What is covered only here is the screen around them, and in
 * particular WHAT CROSSED THE BRIDGE: the role filter the list is loaded with, and the
 * fields a save actually sent. A dialog can read perfectly and send the wrong thing.
 *
 * THE JURISDICTION IS ASSERTED ON THE PAYLOAD, NEVER ON THE PICKER, and that is not a
 * style preference. A `<select>` whose value matches no option falls back to displaying
 * its first one all by itself, so `State or region` can read `Not set` while the state
 * behind it is `33`, and it can read `Karnataka` while nothing at all was sent. The state
 * that decides the tax is the one that crossed.
 */

import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  CompanyProfile,
  CreatePartyInput,
  Party,
  PartySummary,
  Result,
  UpdatePartyInput,
} from '@shared/dto'
import { DEFAULT_REGIME, renderScreen, type BridgeStub } from '../../test/harness'
import { Parties } from './Parties'

function summary(over: Partial<PartySummary> & Pick<PartySummary, 'name'>): PartySummary {
  return {
    id: over.name,
    registrationNumber: null,
    jurisdictionCode: null,
    countryCode: 'in',
    isCustomer: true,
    isVendor: false,
    city: null,
    isArchived: false,
    ...over,
  }
}

function full(over: Partial<Party> & Pick<Party, 'name'>): Party {
  return {
    ...summary(over),
    legalName: null,
    addressLine1: null,
    addressLine2: null,
    postalCode: null,
    email: null,
    phone: null,
    paymentTermsDays: null,
    creditLimit: null,
    notes: null,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    ...over,
  }
}

function profile(over: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    legalName: 'Acme Traders Private Limited',
    tradeName: null,
    registrationNumber: null,
    jurisdictionCode: null,
    countryCode: 'in',
    addressLine1: null,
    addressLine2: null,
    city: null,
    postalCode: null,
    email: null,
    phone: null,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    ...over,
  }
}

const LIST: PartySummary[] = [
  summary({ name: 'Bharat Steel', city: 'Coimbatore', registrationNumber: '33AABCC1234D1ZI' }),
  summary({ name: 'Sharma Enterprises', city: 'Chennai', isVendor: true }),
  summary({ name: 'Old Account', city: 'Madurai', isArchived: true }),
]

/**
 * The bridge every list test starts from. `over` replaces or adds party methods.
 *
 * `companyProfile.get` is stubbed for every test because the screen asks it on mount: a
 * new party's country is the company's own, and an unanswered channel fails the test by
 * name (see the harness).
 */
function listing(
  over: NonNullable<BridgeStub['parties']> = {},
  company: CompanyProfile | null = profile(),
): BridgeStub {
  return {
    parties: { list: () => Promise.resolve({ ok: true, data: LIST }), ...over },
    companyProfile: { get: () => Promise.resolve({ ok: true, data: company }) },
  }
}

async function rowFor(name: string): Promise<HTMLElement> {
  const cell = await screen.findByRole('button', { name })
  const row = cell.closest('tr')
  if (row === null) throw new Error(`${name} is not in a row`)
  return row
}

describe('the list', () => {
  it('asks for the side it was opened from', async () => {
    const { bridge } = renderScreen(<Parties role="vendor" />, { bridge: listing() })

    await screen.findByRole('button', { name: 'Bharat Steel' })
    expect(bridge.lastCallTo('parties:list')?.args[0]).toEqual({
      includeArchived: false,
      role: 'vendor',
    })
  })

  /* The unfiltered screen must send no role at all. Sending `role: null` would be a
   * different question, and the boundary would refuse it. */
  it('asks for everybody when it was opened from neither side', async () => {
    const { bridge } = renderScreen(<Parties />, { bridge: listing() })

    await screen.findByRole('button', { name: 'Bharat Steel' })
    expect(bridge.lastCallTo('parties:list')?.args[0]).toEqual({ includeArchived: false })
  })

  it('shows what each party is, and their registration', async () => {
    renderScreen(<Parties role="customer" />, { bridge: listing() })

    const row = await rowFor('Bharat Steel')
    expect(within(row).getByText('33AABCC1234D1ZI')).toBeInTheDocument()
    expect(within(row).getByText('Coimbatore')).toBeInTheDocument()
    expect(within(row).getByText('Customer')).toBeInTheDocument()

    /* Both boxes ticked reads as one record on two sides, not as two records. */
    expect(within(await rowFor('Sharma Enterprises')).getByText('Both')).toBeInTheDocument()
  })

  /* An unregistered party is ordinary — a dash rather than an empty cell, which would
   * read as a field somebody forgot. */
  it('says nothing is there rather than leaving a gap', async () => {
    renderScreen(<Parties role="customer" />, {
      bridge: listing({
        list: () => Promise.resolve({ ok: true, data: [summary({ name: 'Walk-in' })] }),
      }),
    })

    const row = await rowFor('Walk-in')
    expect(within(row).getAllByText('—')).toHaveLength(2)
  })

  it('reloads with archived records when asked', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Parties role="customer" />, { bridge: listing() })

    await screen.findByRole('button', { name: 'Bharat Steel' })
    await user.click(screen.getByLabelText('Show archived'))

    await waitFor(() => {
      expect(bridge.lastCallTo('parties:list')?.args[0]).toEqual({
        includeArchived: true,
        role: 'customer',
      })
    })
  })

  it('filters as you type, without asking again', async () => {
    const user = userEvent.setup()
    const { bridge } = renderScreen(<Parties role="customer" />, { bridge: listing() })

    await screen.findByRole('button', { name: 'Bharat Steel' })
    const before = bridge.callsTo('parties:list').length

    await user.type(screen.getByPlaceholderText(/Search by name/), 'chennai')

    expect(screen.queryByRole('button', { name: 'Bharat Steel' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sharma Enterprises' })).toBeInTheDocument()
    expect(bridge.callsTo('parties:list')).toHaveLength(before)
  })

  it('says so when a search matches nothing', async () => {
    const user = userEvent.setup()
    renderScreen(<Parties role="customer" />, { bridge: listing() })

    await screen.findByRole('button', { name: 'Bharat Steel' })
    await user.type(screen.getByPlaceholderText(/Search by name/), 'zzz')

    expect(await screen.findByText('Nothing matches that')).toBeInTheDocument()
  })
})

describe('adding', () => {
  const opened = async (
    role: 'customer' | 'vendor',
    create: NonNullable<BridgeStub['parties']> = {},
    company: CompanyProfile | null = profile(),
  ) => {
    const user = userEvent.setup()
    const rendered = renderScreen(<Parties role={role} />, {
      bridge: listing({ list: () => Promise.resolve({ ok: true, data: [] }), ...create }, company),
    })
    await screen.findByText(role === 'customer' ? 'No customers yet' : 'No vendors yet')
    await user.click(screen.getByRole('button', { name: `New ${role}` }))
    return { user, ...rendered }
  }

  const creating = () =>
    vi.fn((input: CreatePartyInput) =>
      Promise.resolve({ ok: true as const, data: full({ name: input.name }) }),
    )

  /*
   * The side the screen was opened from is the side the new record starts on. Defaulting
   * to neither would make the first save fail for everybody, because a party that is
   * neither is refused — and defaulting to customer on the Vendors screen would create
   * the wrong thing quietly.
   */
  it('starts a new record on the side the screen is for', async () => {
    const create = vi.fn((input: CreatePartyInput) =>
      Promise.resolve({ ok: true as const, data: full({ name: input.name, isVendor: true }) }),
    )
    const { user } = await opened('vendor', { create })

    await user.type(screen.getByLabelText('Name'), 'Southern Transport')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Southern Transport', isCustomer: false, isVendor: true }),
      )
    })
  })

  it('sends what was typed, trimmed', async () => {
    const create = creating()
    const { user } = await opened('customer', { create })

    await user.type(screen.getByLabelText('Name'), '  Bharat Steel  ')
    await user.type(screen.getByLabelText('Registration number'), ' 33AABCC1234D1ZI ')
    await user.type(screen.getByLabelText('City'), 'Coimbatore')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Bharat Steel',
          registrationNumber: '33AABCC1234D1ZI',
          city: 'Coimbatore',
          countryCode: 'in',
        }),
      )
    })
  })

  /*
   * THE WHOLE CONTRACT, ASSERTED AS ONE OBJECT rather than with `objectContaining`. This
   * screen wrote seven of the sixteen fields `CreatePartyInput` accepts and the other
   * nine were unreachable from anywhere in the product; a partial matcher is exactly the
   * assertion that could not see that. An exact payload fails when a field stops being
   * sent AND when one is sent that nobody filled in.
   */
  it('writes every field the contract accepts', async () => {
    const create = creating()
    const { user } = await opened('customer', { create })

    /* Short values on purpose. Each of these is a claim about WHICH KEY a box lands in
     * and every character is a separate act(), so prose here buys nothing and spends
     * the test's clock — this one already types sixteen fields. */
    await user.type(screen.getByLabelText('Name'), 'Bharat Steel')
    await user.type(screen.getByLabelText('Legal name'), 'BS Pvt Ltd')
    await user.type(screen.getByLabelText('Registration number'), '33AABCC1234D1ZI')
    await user.selectOptions(screen.getByLabelText('State or region'), '33')
    await user.selectOptions(screen.getByLabelText('Country'), 'in')
    await user.click(screen.getByLabelText(/We buy from them/))
    await user.type(screen.getByLabelText('Payment terms (days)'), '30')
    await user.type(screen.getByLabelText('Credit limit'), '1000')
    await user.type(screen.getByLabelText('Address'), '14 Salai')
    await user.type(screen.getByLabelText('Address, continued'), 'Tey')
    await user.type(screen.getByLabelText('City'), 'Chennai')
    await user.type(screen.getByLabelText('Postal code'), '600018')
    await user.type(screen.getByLabelText('Email'), 'a@b.example')
    await user.type(screen.getByLabelText('Phone'), '+9144')
    await user.type(screen.getByLabelText('Notes'), 'Cheque')

    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({
        name: 'Bharat Steel',
        legalName: 'BS Pvt Ltd',
        registrationNumber: '33AABCC1234D1ZI',
        jurisdictionCode: '33',
        countryCode: 'in',
        isCustomer: true,
        isVendor: true,
        addressLine1: '14 Salai',
        addressLine2: 'Tey',
        city: 'Chennai',
        postalCode: '600018',
        email: 'a@b.example',
        phone: '+9144',
        paymentTermsDays: 30,
        creditLimit: '1000',
        notes: 'Cheque',
      })
    })
  } /* Sixteen fields is a lot of keystrokes and the default five seconds is close enough
   * to what this costs on a loaded machine to fail on the load rather than on the code.
   * A test that goes red for a reason nobody can reproduce gets deleted. */, 20_000)

  /*
   * THE STATE THAT DECIDES THE TAX. Asserted on what crossed and not on the picker,
   * because a `<select>` displaying `Tamil Nadu` proves nothing about the string behind
   * it. Tamil Nadu is the LAST option the regime lists, under a `Not set` that is first,
   * so a screen sending whichever option happens to be at the top fails this.
   */
  it('sends the state that was picked', async () => {
    const create = creating()
    const { user } = await opened('customer', { create })

    await user.type(screen.getByLabelText('Name'), 'Walk-in')
    await user.selectOptions(screen.getByLabelText('State or region'), '33')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ jurisdictionCode: '33' }))
    })
  })

  /* And a state nobody picked crosses as nothing, rather than as the first option in the
   * list — which under this regime would be Karnataka and would be somebody else's tax. */
  it('sends no state when none was picked', async () => {
    const create = creating()
    const { user } = await opened('customer', { create })

    await user.type(screen.getByLabelText('Name'), 'Walk-in')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ jurisdictionCode: '' }))
    })
  })

  /*
   * The gap this batch exists to close: an unregistered customer with no state gives the
   * regime nothing to work a place of supply out from, on every document ever raised
   * against them, silently.
   */
  it('says when nothing in the record says where they are', async () => {
    const { user } = await opened('customer')

    expect(await screen.findByText('Nothing here says where they are')).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('State or region'), '29')
    await waitFor(() => {
      expect(screen.queryByText('Nothing here says where they are')).not.toBeInTheDocument()
    })
  })

  /* A registered party has a state already: main reads it off the number. Warning here
   * would be warning about a field that is about to be filled in. */
  it('does not say it about a party whose registration number carries the state', async () => {
    const { user } = await opened('customer')

    await screen.findByText('Nothing here says where they are')
    await user.type(screen.getByLabelText('Registration number'), '33AABCC1234D1ZI')

    await waitFor(() => {
      expect(screen.queryByText('Nothing here says where they are')).not.toBeInTheDocument()
    })
  })

  /* Nor about somebody in another country, where a sub-national code is not what the
   * supply turns on. */
  it('does not say it about a party in another country', async () => {
    const { user } = await opened('customer')

    await screen.findByText('Nothing here says where they are')
    await user.selectOptions(screen.getByLabelText('Country'), 'sg')

    await waitFor(() => {
      expect(screen.queryByText('Nothing here says where they are')).not.toBeInTheDocument()
    })
  })

  /*
   * WHERE A NEW PARTY'S COUNTRY COMES FROM. The profile says Portugal and the regime's
   * id says `in`, so the two disagree and only one of them can be what crossed. A
   * hard-coded `'in'` — which is what this screen had — fails here, and so does reading
   * the regime.
   */
  it('starts a new party in the company profile country, not in India', async () => {
    const create = creating()
    const { user } = await opened('customer', { create }, profile({ countryCode: 'pt' }))

    expect(screen.getByLabelText('Country')).toHaveValue('pt')

    await user.type(screen.getByLabelText('Name'), 'Lisbon Metals')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ countryCode: 'pt' }))
    })
  })

  /*
   * The same claim with the read held open. Awaiting the promise is not waiting for the
   * screen — the state it sets lands in a React update — so the release is wrapped in
   * `act`, and the dialog is only built when it opens, which is what makes a profile that
   * arrived after the screen did still the one a new party starts from.
   */
  it('uses a profile that arrives after the screen has drawn', async () => {
    const user = userEvent.setup()
    const create = creating()
    let release: (value: Result<CompanyProfile | null>) => void = () => {}
    const pending = new Promise<Result<CompanyProfile | null>>((resolve) => {
      release = resolve
    })

    renderScreen(<Parties role="customer" />, {
      bridge: {
        parties: { list: () => Promise.resolve({ ok: true, data: [] }), create },
        companyProfile: { get: () => pending },
      },
    })

    await screen.findByText('No customers yet')

    await act(async () => {
      release({ ok: true, data: profile({ countryCode: 'pt' }) })
      await pending
    })

    await user.click(screen.getByRole('button', { name: 'New customer' }))
    expect(screen.getByLabelText('Country')).toHaveValue('pt')

    await user.type(screen.getByLabelText('Name'), 'Lisbon Metals')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ countryCode: 'pt' }))
    })
  })

  /* Books whose profile nobody has filled in yet still take parties, and the regime's id
   * is the second-best answer — `pt` here, so a screen that fell back to India fails. */
  it('falls back to the regime when there is no profile yet', async () => {
    const user = userEvent.setup()
    const create = creating()
    renderScreen(<Parties role="customer" />, {
      bridge: listing({ list: () => Promise.resolve({ ok: true, data: [] }), create }, null),
      regime: { ...DEFAULT_REGIME, id: 'pt' },
    })

    await screen.findByText('No customers yet')
    await user.click(screen.getByRole('button', { name: 'New customer' }))
    expect(screen.getByLabelText('Country')).toHaveValue('pt')

    await user.type(screen.getByLabelText('Name'), 'Lisbon Metals')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ countryCode: 'pt' }))
    })
  })

  /* A regime is not a country. `eu-vat` in a two-letter column would be a default nobody
   * notices and everybody saves, so the field is left empty and the dialog asks. */
  it('asks for the country rather than guessing one from a regime that is not a country', async () => {
    const user = userEvent.setup()
    renderScreen(<Parties role="customer" />, {
      bridge: listing({ list: () => Promise.resolve({ ok: true, data: [] }) }, null),
      regime: { ...DEFAULT_REGIME, id: 'eu-vat' },
    })

    await screen.findByText('No customers yet')
    await user.click(screen.getByRole('button', { name: 'New customer' }))

    expect(screen.getByLabelText('Country')).toHaveValue('')
    await user.type(screen.getByLabelText('Name'), 'Somebody')
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
  })

  /*
   * ONE FIELD AT A TIME. Filling them together passes against a screen that checks only
   * one of them, which is what this was before the country became something a user can
   * see: name, a side of the trade, and a country the table declares NOT NULL.
   */
  it('will not save until the name, the country and a side are all there', async () => {
    const { user } = await opened('customer')

    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    await user.selectOptions(screen.getByLabelText('Country'), '')
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    await user.type(screen.getByLabelText('Name'), '   ')
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    await user.type(screen.getByLabelText('Name'), 'Bharat Steel')
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    await user.selectOptions(screen.getByLabelText('Country'), 'in')
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled()

    await user.click(screen.getByLabelText(/We sell to them/))
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    await user.click(screen.getByLabelText(/We buy from them/))
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled()
  })

  /* A party that is neither is refused by the database. Saying so in the dialog beats
   * letting somebody fill in six fields and then be told. */
  it('will not let a record be neither, and says why', async () => {
    const { user } = await opened('customer', {})

    await user.type(screen.getByLabelText('Name'), 'Nobody')
    await user.click(screen.getByLabelText(/We sell to them/))

    expect(await screen.findByText('Which way does the money go?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
  })

  /*
   * Every due date in the product is stamped from this figure, so a box of text has to
   * spell a whole number of days before it can be one. Nothing crosses the bridge — a
   * screen that sent `NaN` would have main store a due date nobody typed.
   */
  it('refuses payment terms that are not a whole number of days', async () => {
    const create = creating()
    const { user } = await opened('customer', { create })

    await user.type(screen.getByLabelText('Name'), 'Bharat Steel')
    await user.type(screen.getByLabelText('Payment terms (days)'), '-5')

    expect(await screen.findByText(/whole number of days/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    await user.clear(screen.getByLabelText('Payment terms (days)'))
    await user.type(screen.getByLabelText('Payment terms (days)'), '30')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ paymentTermsDays: 30 }))
    })
    expect(create).toHaveBeenCalledTimes(1)
  })

  /* Blank is nothing agreed, and that is a different answer from nought days. */
  it('sends no terms at all when the box is left empty', async () => {
    const create = creating()
    const { user } = await opened('customer', { create })

    await user.type(screen.getByLabelText('Name'), 'Walk-in')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ paymentTermsDays: null }))
    })
  })

  /*
   * THE RENDERER NEVER COMPUTES MONEY (CONVENTIONS §1.7). `1000` crosses as `1000` and
   * comes back `1000.00`, because parsing and scaling belong to main — a screen that sent
   * `1000.00` would be a second implementation of the money rules.
   */
  it('sends the credit limit as typed rather than scaling it', async () => {
    const create = creating()
    const { user } = await opened('customer', { create })

    await user.type(screen.getByLabelText('Name'), 'Bharat Steel')
    await user.type(screen.getByLabelText('Credit limit'), '1000')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ creditLimit: '1000' }))
    })
  })

  /*
   * Whether a GSTIN is real is the regime's question, answered in the main process with
   * a sentence written for the user. The screen must show that sentence and keep what
   * was typed — retyping it is exactly what somebody who mistyped one character must not
   * be made to do.
   */
  it('shows the reason a registration number was refused, and keeps the form', async () => {
    const { user } = await opened('customer', {
      create: () =>
        Promise.resolve({
          ok: false as const,
          error: {
            code: 'PARTY_REGISTRATION_INVALID',
            message: 'The last character does not match the rest of this GSTIN.',
          },
        }),
    })

    await user.type(screen.getByLabelText('Name'), 'Bharat Steel')
    await user.type(screen.getByLabelText('Registration number'), '33AABCC1234D1ZZ')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(
      await screen.findByText(/The last character does not match the rest of this GSTIN/),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Registration number')).toHaveValue('33AABCC1234D1ZZ')
  })

  /*
   * A NUMBER AND A STATE THAT DISAGREE ARE MAIN'S TO SETTLE, AND THE NUMBER WINS.
   * `books/registration.ts` refuses the pair rather than picking one, so what this screen
   * has to get right is sending BOTH fields exactly as they were given — a renderer that
   * quietly overwrote the picked state from the number, or dropped one of the two, would
   * make that refusal unreachable and put the wrong state in the books instead.
   */
  it('sends a state and a number that disagree, and shows the refusal', async () => {
    const create = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        error: {
          code: 'PARTY_JURISDICTION_MISMATCH',
          message:
            '33AABCC1234D1ZI is registered in Tamil Nadu, which is not the place given. The registration number decides where a party is, and that decides the tax.',
        },
      }),
    )
    const { user } = await opened('customer', { create })

    await user.type(screen.getByLabelText('Name'), 'Bharat Steel')
    await user.type(screen.getByLabelText('Registration number'), '33AABCC1234D1ZI')
    await user.selectOptions(screen.getByLabelText('State or region'), '29')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          registrationNumber: '33AABCC1234D1ZI',
          jurisdictionCode: '29',
        }),
      )
    })
    expect(
      await screen.findByText(/The registration number decides where a party is/),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Registration number')).toHaveValue('33AABCC1234D1ZI')
  })

  /* Sixteen fields appended one under another is a worse form than seven. The bands are
   * what a walk-in customer scrolls past rather than reads. */
  it('puts the fields in bands, with the common path first', async () => {
    await opened('customer')

    const headings = screen
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent)
    expect(headings).toEqual([
      'Who they are',
      'Registration and place of supply',
      'Terms',
      'Address and contact',
      'Anything else',
    ])
  })
})

describe('editing', () => {
  /* The palette's party results land here with the record's id in the route. */
  it('opens the record the route names, once', async () => {
    const get = vi.fn((id: string) =>
      Promise.resolve({ ok: true as const, data: full({ name: id, city: 'Coimbatore' }) }),
    )
    renderScreen(<Parties role="customer" openId="Bharat Steel" />, { bridge: listing({ get }) })

    expect(await screen.findByLabelText('City')).toHaveValue('Coimbatore')
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('Bharat Steel')
  })

  it('reads the whole record before opening, and sends an id when saving', async () => {
    const user = userEvent.setup()
    const update = vi.fn((input: UpdatePartyInput) =>
      Promise.resolve({ ok: true as const, data: full({ name: input.name ?? 'Bharat Steel' }) }),
    )
    renderScreen(<Parties role="customer" />, {
      bridge: listing({
        get: (id: string) =>
          Promise.resolve({ ok: true, data: full({ name: id, city: 'Coimbatore' }) }),
        update,
      }),
    })

    await user.click(await screen.findByRole('button', { name: 'Bharat Steel' }))

    /* The editor is filled from `get`, not from the summary the list holds — the summary
     * has no email, phone or terms on it at all. */
    expect(await screen.findByLabelText('City')).toHaveValue('Coimbatore')

    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'Bharat Steel Works')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'Bharat Steel', name: 'Bharat Steel Works' }),
      )
    })
  })

  /*
   * THE ROUND TRIP EVERY DUE DATE IN THE PRODUCT HANGS ON. A party on thirty days has to
   * come back reading thirty and go out again as thirty; a form that showed a blank would
   * clear the terms on the next save of any other field, and every document issued
   * afterwards would fall due on the day it was raised.
   */
  it('shows the terms a party is on, and saves them back unchanged', async () => {
    const user = userEvent.setup()
    const update = vi.fn(() =>
      Promise.resolve({ ok: true as const, data: full({ name: 'Bharat Steel' }) }),
    )
    renderScreen(<Parties role="customer" />, {
      bridge: listing({
        get: (id: string) =>
          Promise.resolve({ ok: true, data: full({ name: id, paymentTermsDays: 30 }) }),
        update,
      }),
    })

    await user.click(await screen.findByRole('button', { name: 'Bharat Steel' }))
    expect(await screen.findByLabelText('Payment terms (days)')).toHaveValue('30')

    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ paymentTermsDays: 30 }))
    })
  })

  /*
   * The state is asserted on the payload and not on the picker, for the reason at the top
   * of this file: Tamil Nadu is the last option the regime lists, so a `<select>` falling
   * back to its first would read `Not set` and this would still be green if it only
   * looked at the DOM.
   */
  it('carries the state a party is already on back out again', async () => {
    const user = userEvent.setup()
    const update = vi.fn(() =>
      Promise.resolve({ ok: true as const, data: full({ name: 'Bharat Steel' }) }),
    )
    renderScreen(<Parties role="customer" />, {
      bridge: listing({
        get: (id: string) =>
          Promise.resolve({
            ok: true,
            data: full({ name: id, jurisdictionCode: '33', countryCode: 'in' }),
          }),
        update,
      }),
    })

    await user.click(await screen.findByRole('button', { name: 'Bharat Steel' }))
    await screen.findByLabelText('State or region')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ jurisdictionCode: '33', countryCode: 'in' }),
      )
    })
  })

  /* The eight fields nothing could reach before have to survive a round trip too, or
   * opening a record and saving it would quietly empty it. */
  it('does not empty the fields it now shows just because somebody opened the record', async () => {
    const user = userEvent.setup()
    const update = vi.fn(() =>
      Promise.resolve({ ok: true as const, data: full({ name: 'Bharat Steel' }) }),
    )
    renderScreen(<Parties role="customer" />, {
      bridge: listing({
        get: (id: string) =>
          Promise.resolve({
            ok: true,
            data: full({
              name: id,
              legalName: 'Bharat Steel Private Limited',
              addressLine1: '14 Anna Salai',
              addressLine2: 'Teynampet',
              postalCode: '600018',
              creditLimit: '1000.00',
              notes: 'Pays by cheque.',
            }),
          }),
        update,
      }),
    })

    await user.click(await screen.findByRole('button', { name: 'Bharat Steel' }))
    expect(await screen.findByLabelText('Legal name')).toHaveValue('Bharat Steel Private Limited')
    /* Displayed at the scale main stored it. `1000` was sent and `1000.00` came back. */
    expect(screen.getByLabelText('Credit limit')).toHaveValue('1000.00')

    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          legalName: 'Bharat Steel Private Limited',
          addressLine1: '14 Anna Salai',
          addressLine2: 'Teynampet',
          postalCode: '600018',
          creditLimit: '1000.00',
          notes: 'Pays by cheque.',
        }),
      )
    })
  })

  /*
   * Un-ticking `we sell to them` on the Customers screen makes the row vanish, which
   * reads as a delete. The confirmation has to say where it went.
   */
  it('says where a party went when the edit takes it off this list', async () => {
    const user = userEvent.setup()
    renderScreen(<Parties role="customer" />, {
      bridge: listing({
        get: (id: string) => Promise.resolve({ ok: true, data: full({ name: id }) }),
        update: () =>
          Promise.resolve({
            ok: true,
            data: full({ name: 'Bharat Steel', isCustomer: false, isVendor: true }),
          }),
      }),
    })

    await user.click(await screen.findByRole('button', { name: 'Bharat Steel' }))
    await screen.findByLabelText('Name')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/no longer a customer/)).toBeInTheDocument()
    expect(screen.getByText(/still in the books/)).toBeInTheDocument()
  })
})

describe('archiving', () => {
  /* Archive, not delete. The confirmation says what survives, because "archived" on its
   * own sounds like something was taken away from the books. */
  it('archives and says what is left alone', async () => {
    const user = userEvent.setup()
    const archive = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        data: full({ name: 'Bharat Steel', isArchived: true }),
      }),
    )
    renderScreen(<Parties role="customer" />, {
      bridge: listing({ archive }),
    })

    const row = await rowFor('Bharat Steel')
    await user.click(within(row).getByRole('button', { name: 'Archive' }))

    await waitFor(() => {
      expect(archive).toHaveBeenCalledWith({ id: 'Bharat Steel', archived: true })
    })
    expect(
      await screen.findByText(/Everything already posted stays exactly as it is/),
    ).toBeInTheDocument()
  })

  it('offers to restore one that is already archived', async () => {
    const user = userEvent.setup()
    const archive = vi.fn(() =>
      Promise.resolve({ ok: true as const, data: full({ name: 'Old Account' }) }),
    )
    renderScreen(<Parties role="customer" />, {
      bridge: listing({ archive }),
    })

    const row = await rowFor('Old Account')
    await user.click(within(row).getByRole('button', { name: 'Restore' }))

    await waitFor(() => {
      expect(archive).toHaveBeenCalledWith({ id: 'Old Account', archived: false })
    })
  })
})

/* B25: the header has always said a party nothing was posted against can be deleted. */
describe('deleting', () => {
  it('asks in a dialog that repeats the name, and deletes only on Delete', async () => {
    const user = userEvent.setup()
    const remove = vi.fn(() => Promise.resolve({ ok: true as const, data: undefined }))
    const { bridge } = renderScreen(<Parties role="customer" />, {
      bridge: listing({ delete: remove }),
    })

    const row = await rowFor('Bharat Steel')
    await user.click(within(row).getByRole('button', { name: 'Delete' }))

    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByRole('heading', { name: 'Delete Bharat Steel?' }),
    ).toBeInTheDocument()
    expect(remove).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith('Bharat Steel'))
    expect(await screen.findByText(/Bharat Steel is gone/)).toBeInTheDocument()
    await waitFor(() => expect(bridge.callsTo('parties:list')).toHaveLength(2))
  })

  it('keeps the dialog open with main’s refusal for a party with postings', async () => {
    const user = userEvent.setup()
    renderScreen(<Parties role="customer" />, {
      bridge: listing({
        delete: () =>
          Promise.resolve({
            ok: false,
            error: { code: 'PARTY_IN_USE', message: 'Bharat Steel has documents. Archive them.' },
          }),
      }),
    })

    await user.click(within(await rowFor('Bharat Steel')).getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    expect(await within(dialog).findByText(/has documents/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Keep it' })).toBeInTheDocument()
  })
})

describe('the list’s states', () => {
  /* No spinner on a list: bars at the table's columns, and one sentence for a screen reader. */
  it('holds the table’s shape while the list is read', async () => {
    renderScreen(<Parties role="customer" />, {
      bridge: listing({ list: () => new Promise<Result<PartySummary[]>>(() => undefined) }),
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Loading customers')
  })

  it('offers to clear a search that matches nothing', async () => {
    const user = userEvent.setup()
    renderScreen(<Parties role="customer" />, { bridge: listing() })
    await rowFor('Bharat Steel')

    await user.type(screen.getByPlaceholderText(/Search by name/), 'zzz')
    await user.click(await screen.findByRole('button', { name: 'Clear the search' }))

    expect(await screen.findByRole('button', { name: 'Bharat Steel' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/Search by name/)).toHaveValue('')
  })
})
