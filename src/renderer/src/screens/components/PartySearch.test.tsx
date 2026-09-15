/*
 * Parties as palette results.
 *
 * Two things are worth asserting and both are about restraint: the party master is read
 * when the palette opens and not before, and a party is found by typing rather than listed
 * under an empty query.
 */

import type { JSX } from 'react'
import { act, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Command } from '@renderer/lib/command-registry'
import { searchCommands } from '@renderer/lib/command-registry'
import { useCommands } from '@renderer/store/commands'
import { useNavigation } from '@renderer/store/navigation'
import type { PartySummary, Result } from '@shared/dto'
import { DEFAULT_COMPANY, renderScreen, type BridgeStub } from '../../test/harness'
import { PartySearch } from './PartySearch'

function party(over: Partial<PartySummary> & Pick<PartySummary, 'id' | 'name'>): PartySummary {
  return {
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

const PARTIES: PartySummary[] = [
  party({
    id: 'p-1',
    name: 'Kaveri Polymers',
    city: 'Hubli',
    registrationNumber: '29AAFCK8821P1ZQ',
  }),
  party({ id: 'p-2', name: 'Tamil Coir', isCustomer: false, isVendor: true }),
]

const bridge = (): BridgeStub => ({
  parties: { list: () => Promise.resolve<Result<PartySummary[]>>({ ok: true, data: PARTIES }) },
})

let commands: readonly Command[] = []
let setOpen: (isOpen: boolean) => void = () => {}
let screenId = ''

function Probe(): JSX.Element {
  const state = useCommands()
  commands = state.commands
  setOpen = state.setPaletteOpen
  screenId = useNavigation().route.screenId
  return <></>
}

function mount() {
  return renderScreen(
    <>
      <PartySearch />
      <Probe />
    </>,
    { bridge: bridge(), company: DEFAULT_COMPANY },
  )
}

const partyCommands = (): readonly Command[] =>
  commands.filter((command) => command.id.startsWith('parties.open.'))

describe('reading the parties', () => {
  it('reads nothing until the palette opens', async () => {
    const { bridge: calls } = mount()
    await act(async () => {})

    expect(calls.callsTo('parties:list')).toHaveLength(0)
    expect(partyCommands()).toEqual([])
  })

  it('offers every party once the palette is open, and drops them when it closes', async () => {
    mount()
    act(() => setOpen(true))

    await waitFor(() => expect(partyCommands()).toHaveLength(2))
    act(() => setOpen(false))
    await waitFor(() => expect(partyCommands()).toEqual([]))
  })
})

describe('a party result', () => {
  it('says what the party is and where, and is found by typing', async () => {
    mount()
    act(() => setOpen(true))
    await waitFor(() => expect(partyCommands()).toHaveLength(2))

    const kaveri = partyCommands().find((command) => command.title === 'Kaveri Polymers')
    expect(kaveri?.location).toBe('Customer · Hubli')
    expect(searchCommands(partyCommands(), '')).toEqual([])
    expect(searchCommands(partyCommands(), 'kaveri')[0]?.command.title).toBe('Kaveri Polymers')
    expect(searchCommands(partyCommands(), '29AAFCK')[0]?.command.title).toBe('Kaveri Polymers')
  })

  it('opens a vendor under Vendors and anyone else under Customers', async () => {
    mount()
    act(() => setOpen(true))
    await waitFor(() => expect(partyCommands()).toHaveLength(2))

    act(
      () =>
        void partyCommands()
          .find((command) => command.title === 'Tamil Coir')
          ?.run(),
    )
    expect(screenId).toBe('vendors')

    act(
      () =>
        void partyCommands()
          .find((command) => command.title === 'Kaveri Polymers')
          ?.run(),
    )
    expect(screenId).toBe('customers')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
