/*
 * Customers and vendors, rendered.
 *
 * `filterParties`, `partyKindLabel`, `leavesList` and `copyFor` are covered as pure
 * functions next door. What is covered only here is the screen around them, and in
 * particular WHAT CROSSED THE BRIDGE: the role filter the list is loaded with, and the
 * fields a save actually sent. A dialog can read perfectly and send the wrong thing.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CreatePartyInput, Party, PartySummary, UpdatePartyInput } from '@shared/dto'
import { renderScreen, type BridgeStub } from '../../test/harness'
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

const LIST: PartySummary[] = [
  summary({ name: 'Bharat Steel', city: 'Coimbatore', registrationNumber: '33AABCC1234D1ZI' }),
  summary({ name: 'Sharma Enterprises', city: 'Chennai', isVendor: true }),
  summary({ name: 'Old Account', city: 'Madurai', isArchived: true }),
]

/** The bridge every list test starts from. `over` replaces or adds party methods. */
function listing(over: NonNullable<BridgeStub['parties']> = {}): BridgeStub {
  return {
    parties: { list: () => Promise.resolve({ ok: true, data: LIST }), ...over },
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
  ) => {
    const user = userEvent.setup()
    const rendered = renderScreen(<Parties role={role} />, {
      bridge: listing({ list: () => Promise.resolve({ ok: true, data: [] }), ...create }),
    })
    await screen.findByText(role === 'customer' ? 'No customers yet' : 'No vendors yet')
    await user.click(screen.getByRole('button', { name: `New ${role}` }))
    return { user, ...rendered }
  }

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
    const create = vi.fn((input: CreatePartyInput) =>
      Promise.resolve({ ok: true as const, data: full({ name: input.name }) }),
    )
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

  /* A party with no name is not a party — the CHECK in 0005 refuses it and the unique
   * index has nothing to be unique about. The button says so by staying off. */
  it('will not save a record with no name', async () => {
    const { user } = await opened('customer')

    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    await user.type(screen.getByLabelText('Name'), '   ')
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    await user.type(screen.getByLabelText('Name'), 'Bharat Steel')
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
})

describe('editing', () => {
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
